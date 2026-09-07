#!/usr/bin/env node
// Exercises the REAL rescuePlainObjectErrors from src/lib/sentry.ts.
//
// Why this exists: REACT-NATIVE-5 is three production Sentry events whose
// entire title is "Object captured as exception with keys: code, details,
// hint, message" -- a PostgrestError handed to captureException, with the
// actual database message silently dropped. The beforeSend hook recovers it.
// A hook that mangles a normal Error, or throws on an odd event shape, would
// be worse than the bug, so every branch is checked here.
//
// The function body under test is the real file's, type-stripped by Babel;
// only its two import lines are replaced with stubs.
const babel = require('@babel/core')
const fs = require('fs'), path = require('path'), os = require('os')

const SRC = path.join(__dirname, '..', 'src', 'lib', 'sentry.ts')
let code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
  filename: 'sentry.ts', presets: [['@babel/preset-typescript', {}]], babelrc: false, configFile: false,
}).code

const before = code
// The Sentry stub is a Proxy, not a fixed object literal: sentry.ts calls
// integration factories at module top level (reactNavigationIntegration), and
// a literal stub has to be extended by hand every time one is added. This one
// answers any property with a no-op that returns an empty object.
const SENTRY_STUB =
  'const Sentry = new Proxy({}, { get: () => (() => ({})) });'
code = code
  .replace(/^import \{ Platform \}.*$/m, 'const Platform = { OS: "ios" };')
  .replace(/^import \* as Sentry from .*$/m, SENTRY_STUB)
  // Strip `export ` from ANY top-level declaration rather than naming the two
  // we happen to know about. Enumerating them meant that adding a third --
  // `export const routingInstrumentation`, part of the navigation-timing fix --
  // left a bare `export` in the CJS output and the whole audit died with
  // "SyntaxError: Unexpected token 'export'". The test's job is to exercise the
  // real file; it should not also be a list of that file's exports.
  .replace(/^export (?=(?:async )?function |const |let |var |class )/gm, '')
if (code === before) { console.log('FAIL: source shape changed, stubbing matched nothing'); process.exit(1) }
if (/^\s*export[ {]/m.test(code)) {
  console.log('FAIL: an ESM export survived type-stripping -- CJS require would throw')
  process.exit(1)
}
code += '\nmodule.exports = { rescuePlainObjectErrors };\n'

const tmp = path.join(os.tmpdir(), 'fr_sentry_under_test.cjs')
fs.writeFileSync(tmp, code)
const { rescuePlainObjectErrors: rescue } = require(tmp)
if (typeof rescue !== 'function') { console.log('FAIL: not exported'); process.exit(1) }

let pass = 0, fail = 0
const check = (name, cond, got) => {
  if (cond) { pass++; console.log('  PASS ' + name) }
  else { fail++; console.log('  FAIL ' + name + ' -> ' + JSON.stringify(got)) }
}

// 1. The real case: a PostgrestError, as Sentry serializes it.
const pgErr = { code: '42501', details: null, hint: null,
  message: 'new row violates row-level security policy for table "synced_folder_items"' }
let ev = { exception: { values: [{ type: 'Error', value: 'Object captured as exception with keys: code, details, hint, message' }] }, extra: { stage: 'push' } }
let out = rescue(ev, { originalException: pgErr })
check('message recovered', out.exception.values[0].value === pgErr.message, out.exception.values[0].value)
check('type carries the code', out.exception.values[0].type === 'DbError 42501', out.exception.values[0].type)
check('db_code added to extra', out.extra.db_code === '42501', out.extra)
check('pre-existing extra preserved', out.extra.stage === 'push', out.extra)

// 2. A real Error must pass through completely untouched.
ev = { exception: { values: [{ type: 'TypeError', value: 'boom' }] } }
out = rescue(ev, { originalException: new Error('boom') })
check('real Error keeps its type', out.exception.values[0].type === 'TypeError', out.exception.values[0].type)
check('real Error gets no db_ extra', !out.extra || out.extra.db_code === undefined, out.extra)

// 3. A genuine description must never be overwritten by the object's message.
ev = { exception: { values: [{ type: 'Error', value: 'a real description from a real stack' }] } }
out = rescue(ev, { originalException: { message: 'do not use me' } })
check('genuine value preserved', out.exception.values[0].value === 'a real description from a real stack', out.exception.values[0].value)

// 4. Odd inputs must not throw -- a beforeSend that throws loses the event.
const odd = [
  ['object with no message', { originalException: { code: 'x' } }],
  ['no hint at all', undefined],
  ['a thrown string', { originalException: 'nope' }],
  ['a thrown null', { originalException: null }],
]
for (const [name, hint] of odd) {
  ev = { exception: { values: [{ type: 'Error', value: 'Object captured as exception with keys: code' }] } }
  try { rescue(ev, hint); check(name + ' survives', true) }
  catch (e) { check(name + ' survives', false, e.message) }
}

// 5. An event with no exception array (captureMessage) must survive.
try { rescue({ extra: {} }, { originalException: pgErr }); check('exception-less event survives', true) }
catch (e) { check('exception-less event survives', false, e.message) }

// 6. The event is returned, never dropped.
ev = { exception: { values: [{ type: 'Error', value: 'Object captured as exception with keys: message' }] } }
check('event is returned, not dropped', rescue(ev, { originalException: { message: 'x' } }) === ev)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
