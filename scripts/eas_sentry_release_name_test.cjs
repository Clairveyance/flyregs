#!/usr/bin/env node
/**
 * The release name this hook constructs MUST equal the one the SDK reports
 * from a device. If it does not, the hook creates a release nothing ever
 * reports into -- which logs "success" and is worse than doing nothing.
 *
 * Ground truth for the expected string is not invented here: it is the name
 * Sentry already holds for build 40, `com.clairveyance.flyregs@1.0.0+40`,
 * reported by a real device on 2026-09-05. If this test passes, the hook would
 * have named build 40 exactly as the device did.
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { buildNumberFromIosDir, releaseNameFrom } = require('./eas-sentry-set-commits.js')

let pass = 0
const fails = []
function check(name, fn) {
  try {
    fn()
    console.log(`  PASS ${name}`)
    pass++
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`)
    fails.push(name)
  }
}

function plist(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${body}</dict></plist>`
}

function fixture(targets) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-fixture-'))
  for (const [name, body] of Object.entries(targets)) {
    fs.mkdirSync(path.join(root, name), { recursive: true })
    fs.writeFileSync(path.join(root, name, 'Info.plist'), plist(body))
  }
  return root
}

// The real generated plist, as Expo prebuild writes it for this app.
const APP_PLIST =
  '<key>CFBundleName</key><string>FlyRegs</string>' +
  '<key>CFBundleShortVersionString</key><string>1.0.0</string>' +
  '<key>CFBundleVersion</key><string>40</string>'

const EXPO = { version: '1.0.0', ios: { bundleIdentifier: 'com.clairveyance.flyregs' } }

console.log('=== release name construction ===')

check('names build 40 exactly as the device did', () => {
  const dir = fixture({ FlyRegs: APP_PLIST })
  const got = releaseNameFrom(EXPO, dir)
  assert.strictEqual(
    got && got.version,
    'com.clairveyance.flyregs@1.0.0+40',
    `got ${got && got.version}`,
  )
})

check('a test target is not mistaken for the app', () => {
  const dir = fixture({
    FlyRegsTests: '<key>CFBundleVersion</key><string>1</string>',
    FlyRegs: APP_PLIST,
  })
  const got = releaseNameFrom(EXPO, dir)
  assert.strictEqual(got && got.version, 'com.clairveyance.flyregs@1.0.0+40', `got ${got && got.version}`)
})

check('an unsubstituted Xcode variable is refused, not interpolated', () => {
  const dir = fixture({
    FlyRegs: '<key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
  })
  assert.strictEqual(buildNumberFromIosDir(dir), null, 'must refuse a literal variable')
})

check('no ios/ directory -> null, so the caller takes the fallback', () => {
  assert.strictEqual(buildNumberFromIosDir(path.join(os.tmpdir(), 'definitely-not-here')), null)
  assert.strictEqual(releaseNameFrom(EXPO, path.join(os.tmpdir(), 'definitely-not-here')), null)
})

check('a missing bundleIdentifier or version -> null, never a half-formed name', () => {
  const dir = fixture({ FlyRegs: APP_PLIST })
  assert.strictEqual(releaseNameFrom({ version: '1.0.0', ios: {} }, dir), null)
  assert.strictEqual(releaseNameFrom({ ios: { bundleIdentifier: 'x' } }, dir), null)
})

check('a multi-part build number survives (1.2.3 style)', () => {
  const dir = fixture({
    FlyRegs: '<key>CFBundleVersion</key><string>41.2</string>',
  })
  const got = releaseNameFrom(EXPO, dir)
  assert.strictEqual(got && got.version, 'com.clairveyance.flyregs@1.0.0+41.2', `got ${got && got.version}`)
})

check('the real app.json still supplies both halves of the name', () => {
  const expo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')).expo
  assert.ok(expo.ios && expo.ios.bundleIdentifier, 'app.json lost ios.bundleIdentifier')
  assert.ok(expo.version, 'app.json lost version')
  const dir = fixture({ FlyRegs: APP_PLIST })
  const got = releaseNameFrom(expo, dir)
  assert.strictEqual(
    got.version,
    `${expo.ios.bundleIdentifier}@${expo.version}+40`,
    'name no longer matches the SDK formula',
  )
})

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
