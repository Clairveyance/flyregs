#!/usr/bin/env node
/**
 * Every revealed answer should say something under it.
 *
 * RC, B42: "though some answers don't have that explanation ... it would be
 * great to add those to each Q if poss." His example was FAR 91.193, whose
 * answer read only "No, it does not".
 *
 * This does NOT re-implement explanationText(). It extracts the real function
 * out of src/lib/study.ts, compiles it with the project's own tsc, and tests
 * that -- so the test cannot drift away from what actually ships.
 */
const assert = require('assert')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'study.ts'), 'utf8')

// Pull the function out by brace matching from its export line.
const start = src.indexOf('export function explanationText')
assert.ok(start > -1, 'explanationText() is gone from lib/study.ts')
let i = src.indexOf('{', start), depth = 0, end = -1
for (; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
}
const fnSrc = src.slice(start, end)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'expl-'))
fs.writeFileSync(path.join(tmp, 'f.ts'),
  'export interface StudyFact { question: string; answer: string; explanation?: string; sourceQuote?: string }\n' + fnSrc)
// cwd is the temp dir on purpose: tsc refuses (TS5112) to take files on the
// command line while the project's own tsconfig.json is in scope.
execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'),
  ['--target', 'es2020', '--module', 'commonjs', 'f.ts'],
  { stdio: 'pipe', cwd: tmp })
const { explanationText } = require(path.join(tmp, 'f.js'))

let pass = 0
const fails = []
const check = (name, fn) => {
  try { fn(); console.log(`  PASS ${name}`); pass++ }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fails.push(name) }
}

const base = { question: 'q', answer: 'a' }

check('an authored explanation is used verbatim and wins over the quote', () => {
  const got = explanationText({ ...base, explanation: '91.155(a). At night it becomes 3 miles.', sourceQuote: 'ignored' })
  assert.strictEqual(got, '91.155(a). At night it becomes 3 miles.')
})

check("RC's own 91.193 case now says something", () => {
  const got = explanationText({ ...base,
    sourceQuote: 'Such authorization does not permit operation of the aircraft carrying persons or property for compen' })
  assert.ok(got && got.includes('does not permit'), `got ${got}`)
  assert.ok(got.startsWith('Source: “'), 'should be labelled as a quote')
  assert.ok(got.endsWith('…”'), 'a mid-word cut should end in an ellipsis')
})

check('a complete sentence gets no spurious ellipsis', () => {
  const got = explanationText({ ...base, sourceQuote: 'Item 18 must include either PBN/A1 or PBN/L1.' })
  assert.ok(got.endsWith('.”'), `got ${got}`)
})

check('scraped newlines and column breaks collapse to one line', () => {
  const got = explanationText({ ...base, sourceQuote: 'NRP aircraft are not\n\nsubject to route   limiting\nrestrictions.' })
  assert.ok(!/\s{2}|\n/.test(got), `whitespace survived: ${JSON.stringify(got)}`)
  assert.ok(got.includes('are not subject to route limiting restrictions.'))
})

check('a useless fragment yields nothing rather than noise', () => {
  assert.strictEqual(explanationText({ ...base, sourceQuote: 'Steady white | 20' }), undefined)
  assert.strictEqual(explanationText({ ...base, sourceQuote: '  ' }), undefined)
  assert.strictEqual(explanationText({ ...base }), undefined)
})

check('undefined fact is safe (card renders before facts land)', () => {
  assert.strictEqual(explanationText(undefined), undefined)
})

check('an empty authored explanation falls through to the quote', () => {
  const got = explanationText({ ...base, explanation: '   ',
    sourceQuote: 'The Administrator may issue a certificate of authorization.' })
  assert.ok(got && got.includes('Administrator'), `got ${got}`)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
