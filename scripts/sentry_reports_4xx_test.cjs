#!/usr/bin/env node
// Sentry must actually report 4xx failures, not just claim to.
//
// WHY THIS EXISTS
// `enableCaptureFailedRequests: true` reads like it turns on failed-request
// reporting. It does not, for the failures this app can actually have. The RN
// SDK enables the integration with NO arguments
// (@sentry/react-native/dist/js/integrations/default.js:
//     if (options.enableCaptureFailedRequests) integrations.push(httpClientIntegration());
// ) so it takes the library default of `failedRequestStatusCodes: [[500, 599]]`,
// and there is no top-level option to widen it.
//
// Everything this app fails with is 4xx: an RLS denial, a 401/403, a PostgREST
// 400 from an RPC that raised. Verified 2026-09-17 -- the flag had been on for
// weeks and the live Sentry issue list contained not one such event, while
// get_folder_collaborators was 400ing on every shared-folder open.
//
// So the config passes its own httpClientIntegration with an explicit range.
// This test asserts that range still covers 4xx, by reading the REAL options
// object the real file hands to Sentry.init -- not by grepping for a string,
// which would pass on a commented-out line.
const babel = require('@babel/core')
const fs = require('fs'), path = require('path')

const SRC = path.join(__dirname, '..', 'src', 'lib', 'sentry.ts')
let code = babel.transformSync(fs.readFileSync(SRC, 'utf8'), {
  filename: 'sentry.ts', presets: [['@babel/preset-typescript', {}]], babelrc: false, configFile: false,
}).code

let captured = null
// Same Proxy-stub approach as sentry_beforesend_test.cjs: integration factories
// are called at module scope, so a fixed literal stub needs hand-editing every
// time one is added. This records what init() was given and returns a callable
// for anything else.
const makeStub = () => new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === 'init') return (opts) => { captured = opts }
    if (prop === 'httpClientIntegration') return (o) => ({ name: 'HttpClient', options: o })
    return makeStub()
  },
  apply: () => makeStub(),
})

code = code
  .replace(/import\s+\*\s+as\s+Sentry\s+from\s+'@sentry\/react-native'/, 'const Sentry = __stub')
  .replace(/import\s+\{[^}]*\}\s+from\s+'react-native'/, 'const Platform = { OS: "ios" }')
  .replace(/^export\s+/gm, '')

const fn = new Function('__stub', 'process', '__DEV__', code + '\n;return { initSentry };')
const { initSentry } = fn(makeStub(), { env: { EXPO_PUBLIC_SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1' } }, false)

initSentry()

const fail = (m) => { console.log('FAIL sentry_reports_4xx_test\n  - ' + m); process.exit(1) }

if (!captured) fail('Sentry.init was never called -- cannot verify anything')
if (captured.enableCaptureFailedRequests !== true) {
  fail('enableCaptureFailedRequests is not true, so failed requests are not reported at all')
}

const http = (captured.integrations || []).find((i) => i && i.name === 'HttpClient')
if (!http) {
  fail('no httpClientIntegration passed explicitly. The RN SDK then adds its own ' +
       'with NO options, which defaults to 500-599 and silently excludes every 4xx.')
}
const ranges = http.options && http.options.failedRequestStatusCodes
if (!Array.isArray(ranges)) {
  fail('httpClientIntegration was passed without failedRequestStatusCodes, so it ' +
       'falls back to the 500-599 default and 4xx is excluded')
}
const covers = (code) => ranges.some((r) =>
  Array.isArray(r) ? code >= r[0] && code <= r[1] : code === r)

const mustCover = [400, 401, 403, 404, 409, 422, 500, 503]
const missing = mustCover.filter((c) => !covers(c))
if (missing.length) {
  fail(`failedRequestStatusCodes ${JSON.stringify(ranges)} does not cover ${missing.join(', ')} ` +
       `-- these are the statuses this app's own failures actually use`)
}

console.log(`PASS sentry_reports_4xx_test -- failed requests are reported, and the range ` +
            `${JSON.stringify(ranges)} covers 4xx as well as 5xx`)
