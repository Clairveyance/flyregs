#!/usr/bin/env node
/**
 * Create this build's Sentry release and attach its commits.
 *
 * WHY
 * Sentry can resolve an issue automatically when a commit message says
 * `Fixes REACT-NATIVE-x` -- but only if it knows which commits belong to the
 * release. Associating commits also gives Sentry "suspect commit" attribution
 * on every new issue, and makes regressions reopen against the right release.
 *
 * WHY THIS WAS REWRITTEN (2026-09-08)
 * The first version of this script asked Sentry for its newest release and
 * assumed that was this build, on the reasoning that "the sourcemap upload has
 * already created the real release by the time this hook runs."
 *
 * That is false, and the live data says so plainly. Every release in this
 * project was created by the FIRST EVENT FROM A DEVICE, 40 minutes to 13 hours
 * after its build finished:
 *
 *     release  artifacts  commits  dateCreated == firstEvent
 *     +40      0          0        2026-09-05T03:23:28  (build finished 02:41)
 *     +39      0          0        2026-09-03T23:47:20  (build finished 17:28)
 *     +38      0          0        2026-08-31T18:44:32  (build finished 05:19)
 *
 * `artifacts=0` is the tell: modern @sentry/react-native uploads sourcemaps
 * keyed by DEBUG ID, as artifact bundles, which never create a release. So at
 * on-success time there is no release for this build to find -- the newest one
 * belongs to the PREVIOUS build, the 180-minute freshness guard correctly
 * refused to mis-attribute to it, and the script exited 0 having done nothing.
 * Every build since the hook was added reported commitCount=0.
 *
 * So this version CONSTRUCTS the release name and CREATES it. The name must
 * match what the SDK will report from the device exactly, or we would create a
 * release nothing ever reports into -- which looks like success and is worse
 * than doing nothing. @sentry/react-native derives it natively as
 * `<CFBundleIdentifier>@<CFBundleShortVersionString>+<CFBundleVersion>`, which
 * is why the build number is read from the GENERATED Info.plist rather than
 * app.json: this project uses appVersionSource "remote" with autoIncrement, so
 * app.json has no buildNumber at all and the only truthful source is the plist
 * that was just compiled into the binary.
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

/**
 * CFBundleVersion out of the Info.plist that prebuild just generated.
 *
 * Exported for the unit test, which feeds it a fixture directory -- the real
 * ios/ tree only exists on the EAS worker (managed workflow, ios/ is not
 * committed), so this is the only part of the naming that can be checked from
 * a developer machine.
 */
function buildNumberFromIosDir(iosDir) {
  if (!iosDir || !fs.existsSync(iosDir)) return null
  for (const entry of fs.readdirSync(iosDir)) {
    // Skip the test targets -- they carry their own Info.plist with a
    // CFBundleVersion that is not the app's.
    if (/tests?$/i.test(entry)) continue
    const p = path.join(iosDir, entry, 'Info.plist')
    if (!fs.existsSync(p)) continue
    const m = fs
      .readFileSync(p, 'utf8')
      .match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/)
    const v = m && m[1].trim()
    // A literal build number only. Expo leaves `$(CURRENT_PROJECT_VERSION)` in
    // some templates; substituting that into a release name would invent one.
    if (v && /^[0-9][0-9.]*$/.test(v)) return { buildNumber: v, plist: p }
  }
  return null
}

/** `<bundleId>@<version>+<buildNumber>` -- byte-for-byte what the SDK reports. */
function releaseNameFrom(expo, iosDir) {
  const bundleId = expo && expo.ios && expo.ios.bundleIdentifier
  const version = expo && expo.version
  if (!bundleId || !version) return null
  const found = buildNumberFromIosDir(iosDir)
  if (!found) return null
  return { version: `${bundleId}@${version}+${found.buildNumber}`, from: found.plist }
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
  if (!token && !DRY) {
    log('SENTRY_AUTH_TOKEN is not set. On EAS this is a production secret; if')
    log('this build has no access to it, commits cannot be associated. Skipping.')
    return
  }

  // 1. NAME THE RELEASE from the artifact we just built.
  const iosDir = process.env.SENTRY_IOS_DIR || path.join(__dirname, '..', 'ios')
  const named = releaseNameFrom(expo, iosDir)
  let version
  if (named) {
    version = named.version
    log(`release: ${version}`)
    log(`  (build number read from ${path.relative(path.join(__dirname, '..'), named.from)})`)
  } else {
    // FALLBACK, kept deliberately. If prebuild ever stops leaving an Info.plist
    // where this expects one, guessing a build number would be worse than
    // reverting to the old discovery -- so fall back, but say so loudly,
    // because this path cannot work on a build whose release does not exist yet.
    log('could not read CFBundleVersion from the generated ios/ directory.')
    log('Falling back to newest-recent-release discovery, which only works if')
    log('something else already created this build\'s release.')
    const { status, json, raw } = await get(
      `https://sentry.io/api/0/projects/${org}/${project}/releases/?per_page=5`,
      token,
    )
    if (status !== 200 || !Array.isArray(json) || json.length === 0) {
      log(`could not list releases (HTTP ${status}) ${raw || ''} -- skipping`)
      return
    }
    const rel = json[0]
    const ageMin = (Date.now() - new Date(rel.dateCreated).getTime()) / 60000
    const maxAgeMin = Number(process.env.SENTRY_SET_COMMITS_MAX_AGE_MIN || 180)
    if (ageMin > maxAgeMin) {
      log(`newest release ${rel.version} was created ${Math.round(ageMin)} min ago,`)
      log(`older than the ${maxAgeMin} min window, so it is not this build. Skipping.`)
      return
    }
    version = rel.version
    log(`release (discovered): ${version}`)
  }

  const cli = path.join(__dirname, '..', 'node_modules', '.bin', 'sentry-cli')
  if (!fs.existsSync(cli)) {
    log('sentry-cli not found in node_modules -- skipping')
    return
  }

  // Two ways to set commits, and which one works depends on something not worth
  // assuming: whether the EAS worker has the .git directory. `--auto` reads
  // local history; if there is none, fall back to naming the repo and this
  // build's commit explicitly, which EAS always provides as
  // EAS_BUILD_GIT_COMMIT_HASH. Sentry then derives the range from the previous
  // release itself.
  const hasGit = fs.existsSync(path.join(__dirname, '..', '.git')) ||
    fs.existsSync(path.join(__dirname, '..', '..', '.git'))
  const sha = process.env.EAS_BUILD_GIT_COMMIT_HASH
  const repo = process.env.SENTRY_REPO || 'Clairveyance/flyregs'

  let setCommits
  if (hasGit) {
    setCommits = ['releases', 'set-commits', version, '--auto', '--ignore-missing']
    log('using --auto (a .git directory is present)')
  } else if (sha) {
    setCommits = ['releases', 'set-commits', version, '--commit', `${repo}@${sha}`, '--ignore-missing']
    log(`no .git on this worker -- naming ${repo}@${sha.slice(0, 9)} explicitly`)
  } else {
    log('no .git directory and no EAS_BUILD_GIT_COMMIT_HASH -- cannot associate commits')
    return
  }

  // 2. CREATE THE RELEASE. `releases new` is idempotent, so this is safe
  //    whether or not a device has already reported into it.
  const newRelease = ['releases', 'new', version]

  const env = { ...process.env, SENTRY_ORG: org, SENTRY_PROJECT: project, SENTRY_AUTH_TOKEN: token }
  if (DRY) {
    log(`DRY RUN -- would run: sentry-cli ${newRelease.join(' ')}`)
    log(`DRY RUN -- would run: sentry-cli ${setCommits.join(' ')}`)
    return
  }
  try {
    execFileSync(cli, newRelease, { env, encoding: 'utf8', stdio: 'pipe' })
    log(`created (or confirmed) release ${version}`)
  } catch (e) {
    log(`releases new failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}`)
    log('Continuing to set-commits anyway -- the release may already exist.')
  }
  try {
    const out = execFileSync(cli, setCommits, { env, encoding: 'utf8', stdio: 'pipe' })
    log(out.trim() || 'set-commits completed')
    const after = await get(
      `https://sentry.io/api/0/organizations/${org}/releases/${encodeURIComponent(version)}/`,
      token,
    )
    // Report what actually landed. "The command exited 0" is not the same as
    // "Sentry now has the commits", and this project has been bitten by that
    // distinction more than once -- including by this very script.
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

module.exports = { buildNumberFromIosDir, releaseNameFrom }

if (require.main === module) {
  main()
    .catch((e) => log(`unexpected: ${e && e.message}`))
    // Always 0. See the header: this must never fail a build.
    .finally(() => process.exit(0))
}
