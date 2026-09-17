#!/usr/bin/env node
// A session ending must not be reported as a defect. A real fault must be.
//
// WHY THIS EXISTS
// Found 2026-09-17 by revoking a live session server-side -- the real-world
// "I changed my password on my other phone", or a session simply expiring.
// Every sync call in flight then fails with an auth error, and all 15
// reportSyncError call sites fired a Sentry exception, producing a burst of
//     "sync push failed (sync preference disable): Session from session_id
//      claim in JWT does not exist"
// for an event that is entirely normal and which the app already handles
// correctly (it clears the token and drops to signed-out -- verified).
//
// The risk in fixing it is the opposite mistake: silencing REAL faults. This
// function exists precisely so the next RLS gap or constraint violation fails
// loudly. So this test pins both directions, against the REAL function body
// (type-stripped by Babel), not a copy of the regex.
const babel = require('@babel/core')
const fs = require('fs'), path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'lib', 'syncPush.ts')
let code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
  filename: 'syncPush.ts', presets: [['@babel/preset-typescript', {}]], babelrc: false, configFile: false,
}).code

// Keep only what the function under test needs; the rest of this module pulls
// in AsyncStorage, supabase and more.
const start = code.indexOf('const SESSION_ENDED')
const fnStart = code.indexOf('function reportSyncError')
const fnEnd = code.indexOf('\n}', fnStart) + 2
if (start === -1 || fnStart === -1) {
  console.log('FAIL sync_error_triage_test\n  - could not find SESSION_ENDED / reportSyncError in the real file')
  process.exit(1)
}
const slice = code.slice(start, code.indexOf('\n', start)) + '\n' + code.slice(fnStart, fnEnd)

const sent = []
const warned = []
const errored = []
const fn = new Function('Sentry', 'console', slice + '\n;return reportSyncError;')(
  { captureException: (e) => sent.push(String(e.message || e)) },
  { warn: (...a) => warned.push(a.join(' ')), error: (...a) => errored.push(a.join(' ')) },
)

const fail = (m) => { console.log('FAIL sync_error_triage_test\n  - ' + m); process.exit(1) }

// 1. A session ending must be quiet.
const sessionEnded = [
  'Session from session_id claim in JWT does not exist',
  'JWT expired',
  'token is expired',
  'invalid claim: missing sub claim',
  'Refresh Token Not Found',
  'Session not found',
]
for (const msg of sessionEnded) {
  sent.length = 0
  fn('some context', { message: msg })
  if (sent.length) fail(`a session-ended error was reported to Sentry: ${msg}`)
}

// 2. A REAL fault must still be reported. This is the half that matters most --
//    over-broad silencing would hide the bugs this function was added to catch.
const realFaults = [
  'new row violates row-level security policy for table "synced_bookmarks"',
  'duplicate key value violates unique constraint',
  'permission denied for table synced_notes',
  'insert or update on table violates foreign key constraint',
  'column "block_text" of relation "synced_bookmarks" does not exist',
  'Internal Server Error',
]
for (const msg of realFaults) {
  sent.length = 0
  fn('some context', { message: msg })
  if (!sent.length) fail(`a REAL fault was silently dropped: ${msg}`)
}

// 3. No error at all must do nothing.
sent.length = 0; errored.length = 0; warned.length = 0
fn('some context', null)
if (sent.length || errored.length || warned.length) fail('a null error produced output')

console.log(`PASS sync_error_triage_test -- ${sessionEnded.length} session-ended messages stay quiet, ` +
            `${realFaults.length} real faults still report, null is a no-op`)
