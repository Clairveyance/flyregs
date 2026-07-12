// Permanent diagnostic tool — re-parses every active AC with the CURRENT
// acFormat.ts and flags structural anomalies in the resulting Contents/TOC:
//
//   1. Cross-reference collisions: a section label that is itself a real
//      OTHER AC's document number (e.g. "120-118." appearing as a section
//      inside 20-191's own Contents) — almost always a body-text citation
//      that wrapped onto a new line and got misread as a heading.
//   2. Chapter-number mismatches: a decimal/flat section label whose leading
//      chapter digit doesn't match the CHAPTER it's nested under (e.g. "1.3"
//      inside "CHAPTER 2"). NOTE: many FAA ACs legitimately use independent
//      numbering (spec/checklist tables, flat-continuous item numbering) that
//      isn't tied to the chapter number — treat this signal as a lead to
//      manually check, not proof of a bug. Read the reported title snippets
//      before concluding something is wrong.
//   3. Suspiciously short/empty section titles paired with a body that starts
//      mid-sentence (lowercase) — a heuristic for "the label ate part of a
//      sentence" cases similar to #1 but not necessarily a cross-reference.
//   4. Duplicate section labels within the same chapter (exact label+title
//      repeated) — usually a stray re-match of the same content.
//
// Read-only. Run any time with: node scripts/audit-parser.mjs
// Add --doc=<document_number> to audit a single AC verbosely.
import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const depSrc = fs.readFileSync(path.resolve('src/lib/ocrScannedACs.ts'), 'utf8')
const depJs = ts.transpileModule(depSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
const tmpDep = path.join(os.tmpdir(), `ocrScannedACs.${Date.now()}.mjs`)
fs.writeFileSync(tmpDep, depJs)
const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
let js = ts.transpileModule(tsSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
js = js.replace("from './ocrScannedACs'", `from ${JSON.stringify(pathToFileURL(tmpDep).href)}`)
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC } = await import(pathToFileURL(tmp).href)

const onlyDoc = process.argv.find((a) => a.startsWith('--doc='))?.split('=')[1]
// --docs-file=<path>: audit only the document numbers listed (one per line) in
// this file, instead of the whole catalog. sync.sh uses this to check just the
// ACs a weekly incremental scrape + backfill actually touched — see
// backfill-blocks.mjs's --touched-out flag, which produces this file.
const docsFileArg = process.argv.find((a) => a.startsWith('--docs-file='))?.split('=')[1]
const docsFromFile = docsFileArg
  ? fs.readFileSync(docsFileArg, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : null

// ── Fetch the full catalog of real document numbers once, for cross-reference
//    collision detection ────────────────────────────────────────────────────
async function fetchAllDocNumbers() {
  const set = new Set()
  let page = 0
  const PAGE_SIZE = 500
  while (true) {
    const { data, error } = await supabase
      .from('advisory_circulars')
      .select('document_number')
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
    if (error) { console.error(error); break }
    if (!data || data.length === 0) break
    for (const d of data) set.add(d.document_number.toLowerCase())
    if (data.length < PAGE_SIZE) break
    page++
  }
  return set
}

function findChapterMismatches(blocks) {
  let currentChapterNum = null
  const out = []
  for (const b of blocks) {
    if (b.kind === 'chapter') {
      const m = b.text.match(/^(?:CHAPTER|Chapter)\s+(\d+)/)
      currentChapterNum = m ? m[1] : null
      continue
    }
    if (b.kind === 'section' && currentChapterNum && /^\d/.test(b.label || '')) {
      const secChapter = (b.label.match(/^(\d+)\./) || [])[1]
      if (secChapter && secChapter !== currentChapterNum) {
        out.push(`${b.label} in Ch.${currentChapterNum} (title: "${(b.title || '').slice(0, 45)}")`)
      }
    }
  }
  return out
}

// A section label that IS a real other AC's document number, own AC excluded.
function findCrossRefCollisions(blocks, ownDocNumber, allDocNumbers) {
  const out = []
  for (const b of blocks) {
    if (b.kind !== 'section' || !b.label) continue
    const label = b.label.replace(/\.$/, '').toLowerCase()
    if (label === ownDocNumber.toLowerCase()) continue
    if (!allDocNumbers.has(label)) continue
    // A legitimate "N-N." chapter/section label almost always has a SMALL
    // second component (real document structure rarely goes past ~30
    // sections deep) — e.g. "3-1.", "25-29." are common, plausible sections
    // in flat/dash-numbered ACs and just coincidentally collide with a real
    // (small, unusually-numbered) other AC. A genuine cross-reference number
    // typically has a large, distinctive second component ("120-118",
    // "150-5220") that isn't a plausible depth for a document's own section
    // numbering. Only flag the high-confidence case.
    const secondPart = parseInt((label.match(/-(\d+)$/) || [])[1] || '0', 10)
    if (secondPart < 50) continue
    out.push(`${b.label} "${(b.title || '').slice(0, 50)}"`)
  }
  return out
}

// A section whose title is empty/very short and whose body starts lowercase
// — a heading that likely ate the start of a mid-sentence continuation.
function findSuspiciousLowercaseBody(blocks) {
  const out = []
  for (const b of blocks) {
    if (b.kind !== 'section') continue
    if ((b.title || '').length > 0) continue // has a real title, skip
    if (b.body && /^[a-z]/.test(b.body)) {
      out.push(`${b.label} body starts lowercase: "${b.body.slice(0, 45)}"`)
    }
  }
  return out
}

function findDuplicateLabels(blocks) {
  let currentChapter = '__root__'
  const seen = {}
  const dupes = []
  for (const b of blocks) {
    if (b.kind === 'chapter') { currentChapter = b.text; continue }
    if (b.kind === 'section' && b.label) {
      const key = currentChapter + '|' + b.label + '|' + (b.title || '')
      seen[key] = (seen[key] || 0) + 1
      if (seen[key] === 2) dupes.push(`${b.label} "${(b.title || '').slice(0, 40)}"`)
    }
  }
  return dupes
}

async function main() {
  if (docsFromFile && docsFromFile.length === 0) {
    console.log('audit-parser: --docs-file was empty — nothing changed, nothing to audit.')
    return
  }

  console.log('Fetching document number catalog...')
  const allDocNumbers = await fetchAllDocNumbers()
  console.log(`Loaded ${allDocNumbers.size} document numbers.\n`)

  let page = 0
  const PAGE_SIZE = 100
  let totalACs = 0
  const findings = []

  // --docs-file: fetch only the listed docs, chunked to stay well under
  // Supabase's practical .in() row limits (a weekly incremental sync touches
  // a handful of ACs, but chunk defensively in case of a large backlog).
  const fileChunks = docsFromFile
    ? Array.from({ length: Math.ceil(docsFromFile.length / 200) }, (_, i) =>
        docsFromFile.slice(i * 200, i * 200 + 200))
    : null

  while (true) {
    let query = supabase
      .from('advisory_circulars')
      .select('document_number, pdf_text')
      .eq('status', 'active')
      .not('pdf_text', 'is', null)
    if (onlyDoc) query = query.eq('document_number', onlyDoc)
    else if (fileChunks) {
      if (page >= fileChunks.length) break
      query = query.in('document_number', fileChunks[page])
    } else query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    const { data, error } = await query
    if (error) { console.error(error); break }
    if (!data || data.length === 0) break
    page++
    totalACs += data.length

    for (const ac of data) {
      const blocks = parseAC(ac.pdf_text, ac.document_number)
      const crossRef = findCrossRefCollisions(blocks, ac.document_number, allDocNumbers)
      const chapterMismatch = findChapterMismatches(blocks)
      const lowercaseBody = findSuspiciousLowercaseBody(blocks)
      const dupes = findDuplicateLabels(blocks)

      if (crossRef.length || chapterMismatch.length || lowercaseBody.length || dupes.length) {
        findings.push({ doc: ac.document_number, crossRef, chapterMismatch, lowercaseBody, dupes })
      }

      if (onlyDoc || docsFromFile) {
        console.log(`=== ${ac.document_number} (${blocks.length} blocks) ===`)
        console.log('Cross-ref collisions:', crossRef.length ? crossRef : 'none')
        console.log('Chapter mismatches:  ', chapterMismatch.length ? chapterMismatch : 'none')
        console.log('Lowercase-body:      ', lowercaseBody.length ? lowercaseBody : 'none')
        console.log('Duplicate labels:    ', dupes.length ? dupes : 'none')
      }
    }
    if (!onlyDoc && !docsFromFile) process.stdout.write(`\rAudited ${totalACs} ACs...`)
    if (onlyDoc) break
  }

  if (onlyDoc) return

  if (docsFromFile) {
    console.log(`\n${findings.length ? '⚠ ' : '✓ '}${totalACs} touched ACs audited — ${findings.length} with findings to review above.`)
    return
  }

  console.log(`\n\n=== PARSER AUDIT: ${totalACs} ACs ===`)
  const withCrossRef = findings.filter((f) => f.crossRef.length)
  const withLowercase = findings.filter((f) => f.lowercaseBody.length)
  const withDupes = findings.filter((f) => f.dupes.length)
  const withMismatch = findings.filter((f) => f.chapterMismatch.length)

  console.log(`\nCROSS-REFERENCE COLLISIONS (highest priority — ${withCrossRef.length} ACs):`)
  for (const f of withCrossRef) console.log(`  ${f.doc}: ${f.crossRef.join('; ')}`)

  console.log(`\nSUSPICIOUS LOWERCASE-BODY HEADINGS (${withLowercase.length} ACs):`)
  for (const f of withLowercase.slice(0, 30)) console.log(`  ${f.doc}: ${f.lowercaseBody.join('; ')}`)
  if (withLowercase.length > 30) console.log(`  ...and ${withLowercase.length - 30} more`)

  console.log(`\nDUPLICATE LABELS WITHIN A CHAPTER (${withDupes.length} ACs):`)
  for (const f of withDupes.slice(0, 30)) console.log(`  ${f.doc}: ${f.dupes.join('; ')}`)
  if (withDupes.length > 30) console.log(`  ...and ${withDupes.length - 30} more`)

  console.log(`\nCHAPTER-NUMBER MISMATCHES (${withMismatch.length} ACs — many are false positives, see header comment):`)
  for (const f of withMismatch.slice(0, 40)) console.log(`  ${f.doc}: ${f.chapterMismatch.slice(0, 5).join('; ')}${f.chapterMismatch.length > 5 ? ' ...' : ''}`)
  if (withMismatch.length > 40) console.log(`  ...and ${withMismatch.length - 40} more`)
}

main()
