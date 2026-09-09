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

// explanationText() leans on a module-level STOP_WORDS set, so the extraction
// has to bring it along or the compile fails with TS2304. Pulled by the same
// brace-matching rather than duplicated here, for the same reason as the
// function itself: a copy in this file could drift from what ships.
const sw = src.indexOf('const STOP_WORDS')
assert.ok(sw > -1, 'STOP_WORDS is gone from lib/study.ts')
const swEnd = src.indexOf('\n)', sw) + 2
const stopSrc = src.slice(sw, swEnd)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'expl-'))
fs.writeFileSync(path.join(tmp, 'f.ts'),
  'export interface StudyFact { question: string; answer: string; explanation?: string; sourceQuote?: string }\n' +
  stopSrc + '\n' + fnSrc)
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

// The exact card RC objected to, with its REAL question and answer text rather
// than placeholders -- an earlier version of this test used {question:'q',
// answer:'a'}, which made the quote look informative and passed while the
// shipped card was still padding. The quote here restates the answer, so the
// only right behaviour is to show nothing.
check("RC's 91.193 card: a quote that restates the answer is suppressed", () => {
  const got = explanationText({
    question: 'Does a § 91.193 certificate of authorization permit carrying persons or property for hire?',
    answer: 'No, it does not permit compensation or hire operations',
    sourceQuote: 'Such authorization does not permit operation of the aircraft carrying persons or property for compensation or hire.',
  })
  assert.strictEqual(got, undefined, `should show nothing, got ${got}`)
})

check('a quote carrying real extra content is still shown', () => {
  const got = explanationText({
    question: 'To what altitude must the takeoff path be considered?',
    answer: '1,500 feet AGL',
    sourceQuote: 'up to 1,500 feet above ground level, but not less than V1 minimum for airplanes and the associated climb gradient',
  })
  assert.ok(got && got.startsWith('Source: \u201c'), `should be shown and labelled, got ${got}`)
  assert.ok(got.includes('V1 minimum'), 'must carry the part the answer omitted')
})

check('the labelled quote keeps the mid-word ellipsis', () => {
  const got = explanationText({
    question: 'What must the certificate holder disseminate?',
    answer: 'Runway data',
    sourceQuote: 'each certificate holder shall provide a system acceptable to the Administrator for disseminating information to the pilot in comm',
  })
  assert.ok(got.endsWith('\u2026\u201d'), `mid-word cut should end in an ellipsis, got ${got}`)
})

check('a complete sentence gets no spurious ellipsis', () => {
  const got = explanationText({ question: 'Which code is used?', answer: 'PBN/L1',
    sourceQuote: 'Item 18 must include either PBN/A1 for RNP 10 authorization or PBN/L1 for RNP 4, and the flight plan must show the equipment suffix.' })
  assert.ok(got && got.endsWith('.\u201d'), `got ${got}`)
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
  const got = explanationText({ question: 'Who issues it?', answer: 'The Administrator', explanation: '   ',
    sourceQuote: 'The Administrator may issue a certificate of authorization if the proposed operation can be safely conducted under the terms of that certificate.' })
  assert.ok(got && got.includes('safely conducted'), `got ${got}`)
})

console.log(`\n${pass} passed, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
