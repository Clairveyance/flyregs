#!/usr/bin/env node
/**
 * Attach this build's commits to its Sentry release.
 *
 * WHY
 * Sentry can resolve an issue automatically when a commit message says
 * `Fixes REACT-NATIVE-x` -- but only if it knows which commits belong to the
 * release. Every release in this project reported `commitCount: 0`, which is
 * why two commits carrying exactly that line (2026-09-06) resolved nothing.
 * Associating commits also gives Sentry "suspect commit" attribution on every
 * new issue, and makes regressions reopen against the right release.
 *
 * WHERE IT RUNS
 * `eas-build-on-success`, so it happens on every build with nothing for anyone
 * to remember. It uses SENTRY_AUTH_TOKEN, the secret EAS already holds for
 * sourcemap upload -- which necessarily has the `project:releases` scope this
 * needs. No new credential, and nothing granted to anybody's personal token.
 *
 * IT MUST NEVER FAIL A BUILD.
 * This is bookkeeping that runs AFTER a successful compile. A missing token, a
 * network blip or an unexpected Sentry response must not turn a good build
 * into a failed one, so every path exits 0. It is loud in the log instead --
 * a silent no-op here is exactly the class of bug this project keeps finding.
 *
 * Local:  node scripts/eas-sentry-set-commits.js --dry-run
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')

const DRY = process.argv.includes('--dry-run')

function log(msg) {
  console.log(`[sentry-set-commits] ${msg}`)
}

function readAppJson() {
  const p = path.join(__dirname, '..', 'app.json')
  return JSON.parse(fs.readFileSync(p, 'utf8')).expo
}

function get(url, token) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { Authorization: `Bearer ${token}` } }, (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) })
          } catch {
            resolve({ status: res.statusCode, json: null, raw: body.slice(0, 300) })
          }
        })
      })
      .on('error', (e) => resolve({ status: 0, json: null, raw: String(e) }))
  })
}

async function main() {
  // The Sentry org/project live in app.json's plugin config -- the same two
  // values the sourcemap upload already uses. Reading them from there rather
  // than adding two more EAS env vars keeps one source of truth.
  const expo = readAppJson()
  const sentryPlugin = (expo.plugins || []).find(
    (p) => Array.isArray(p) && String(p[0]).includes('sentry'),
  )
  const org = process.env.SENTRY_ORG || (sentryPlugin && sentryPlugin[1] && sentryPlugin[1].organization)
  const project = process.env.SENTRY_PROJECT || (sentryPlugin && sentryPlugin[1] && sentryPlugin[1].project)
  const token = process.env.SENTRY_AUTH_TOKEN

  if (!org || !project) {
    log('no Sentry organization/project in app.json -- nothing to do')
    return
  }
  if (!token) {
    log('SENTRY_AUTH_TOKEN is not set. On EAS this is a production secret; if')
    log('this build has no access to it, commits cannot be associated. Skipping.')
    return
  }

  // ASK SENTRY which release this is, rather than reconstructing the name.
  //
  // The release is `<bundleId>@<version>+<buildNumber>`, and buildNumber is
  // auto-incremented by EAS -- so rebuilding that string here means guessing
  // at a value this script cannot see reliably, and a wrong guess targets a
  // release that does not exist. The sourcemap upload has already created the
  // real release by the time this hook runs, so the newest one IS this build.
  const url = `https://sentry.io/api/0/projects/${org}/${project}/releases/?per_page=5`
  const { status, json, raw } = await get(url, token)
  if (status !== 200 || !Array.isArray(json) || json.length === 0) {
    log(`could not list releases (HTTP ${status}) ${raw || ''} -- skipping`)
    return
  }

  const release = json[0]
  const version = release.version
  const createdMinutesAgo = (Date.now() - new Date(release.dateCreated).getTime()) / 60000
  // A release created long ago is not this build's. Attaching commits to it
  // would be worse than doing nothing -- it would claim this build's history
  // belongs to something else.
  // Overridable so this can be dry-run against an existing release, and so a
  // one-off backfill of an older release is possible without editing the file.
  const maxAgeMin = Number(process.env.SENTRY_SET_COMMITS_MAX_AGE_MIN || 180)
  if (createdMinutesAgo > maxAgeMin) {
    log(`newest release ${version} was created ${Math.round(createdMinutesAgo)} min ago,`)
    log(`which is older than the ${maxAgeMin} min window, so it is not this build.`)
    log('Skipping rather than mis-attributing this history to another release.')
    return
  }
  log(`release: ${version} (created ${Math.round(createdMinutesAgo)} min ago)`)

  const cli = path.join(__dirname, '..', 'node_modules', '.bin', 'sentry-cli')
  if (!fs.existsSync(cli)) {
    log('sentry-cli not found in node_modules -- skipping')
    return
  }

  // Two ways to do this, and which one works depends on something not worth
  // assuming: whether the EAS worker has the .git directory. `--auto` reads
  // local history; if there is none, fall back to naming the repo and this
  // build's commit explicitly, which EAS always provides as
  // EAS_BUILD_GIT_COMMIT_HASH. Sentry then derives the range from the previous
  // release itself.
  const hasGit = fs.existsSync(path.join(__dirname, '..', '.git')) ||
    fs.existsSync(path.join(__dirname, '..', '..', '.git'))
  const sha = process.env.EAS_BUILD_GIT_COMMIT_HASH
  const repo = process.env.SENTRY_REPO || 'Clairveyance/flyregs'

  let args
  if (hasGit) {
    args = ['releases', 'set-commits', version, '--auto', '--ignore-missing']
    log('using --auto (a .git directory is present)')
  } else if (sha) {
    args = ['releases', 'set-commits', version, '--commit', `${repo}@${sha}`, '--ignore-missing']
    log(`no .git on this worker -- naming ${repo}@${sha.slice(0, 9)} explicitly`)
  } else {
    log('no .git directory and no EAS_BUILD_GIT_COMMIT_HASH -- cannot associate commits')
    return
  }

  const env = { ...process.env, SENTRY_ORG: org, SENTRY_PROJECT: project, SENTRY_AUTH_TOKEN: token }
  if (DRY) {
    log(`DRY RUN -- would run: sentry-cli ${args.join(' ')}`)
    return
  }
  try {
    const out = execFileSync(cli, args, { env, encoding: 'utf8', stdio: 'pipe' })
    log(out.trim() || 'set-commits completed')
    const after = await get(
      `https://sentry.io/api/0/organizations/${org}/releases/${encodeURIComponent(version)}/`,
      token,
    )
    // Report what actually landed. "The command exited 0" is not the same as
    // "Sentry now has the commits", and this project has been bitten by that
    // distinction more than once.
    const count = after.json && after.json.commitCount
    log(`Sentry now reports commitCount=${count} for ${version}`)
    if (!count) {
      log('WARNING: commitCount is still 0 -- resolve-via-commit will NOT work')
      log('for this release. Check the repository integration in Sentry.')
    }
  } catch (e) {
    log(`set-commits failed: ${(e.stderr || e.message || '').toString().slice(0, 400)}`)
    log('Build is unaffected -- this step is bookkeeping only.')
  }
}

main()
  .catch((e) => log(`unexpected: ${e && e.message}`))
  // Always 0. See the header: this must never fail a build.
  .finally(() => process.exit(0))
