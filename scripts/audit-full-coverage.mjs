// Permanent, catalog-wide diagnostic answering exactly what got missed with
// AC 60-22: which active ACs are missing basic setup entirely, and which
// have figures/tables *referenced in their own body text* with no matching
// ac_figures row. Complements audit-parser.mjs (which only checks TOC/heading
// anomalies in ACs that already have SOME parsed content) and audit-blocks.mjs
// (which explicitly skips any AC with pdf_text IS NULL) -- neither of those
// tools would ever have caught 60-22, since it had zero pdf_text at all.
//
// Three checks, each catalog-wide, no NULL-text exclusion anywhere:
//   1. Zero blocks -- an active AC with no parsed body at all (60-22's exact
//      symptom before this fix). Reports whether a source PDF is even on file,
//      since that changes what the actual fix looks like.
//   2. Suspiciously thin parse -- an active AC with pdf_text present but very
//      few blocks relative to its own text length, a proxy for "the parse
//      probably failed or was cut short" rather than "this is a short AC."
//   3. Missing figures -- every "FIGURE N." / "Table N" caption found in an
//      AC's own pdf_text, cross-referenced against its ac_figures rows by
//      label. A caption with no matching row means the text mentions a
//      figure/table that has no actual image behind it in the app.
//
// Read-only. Run any time with: node scripts/audit-full-coverage.mjs
// Add --doc=<document_number> to check a single AC verbosely.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const onlyDoc = process.argv.find((a) => a.startsWith('--doc='))?.split('=')[1]

console.log('Fetching all active ACs...')
let allACs = []
{
  let from = 0
  const PAGE = 500
  while (true) {
    let q = supabase
      .from('advisory_circulars')
      .select('id, document_number, title, pdf_text, pdf_blocks, pdf_url_cached, pdf_url_faa')
      .eq('status', 'active')
      .order('document_number')
      .range(from, from + PAGE - 1)
    if (onlyDoc) q = q.eq('document_number', onlyDoc)
    const { data, error } = await q
    if (error) { console.error(error); process.exit(1) }
    allACs = allACs.concat(data)
    if (data.length < PAGE) break
    from += PAGE
  }
}
console.log(`Loaded ${allACs.length} active AC(s).\n`)

// ── Check 1: zero blocks ──────────────────────────────────────────────────
const zeroBlocks = allACs.filter((ac) => !ac.pdf_blocks || ac.pdf_blocks.length === 0)
console.log(`=== Check 1: Active ACs with ZERO parsed blocks (${zeroBlocks.length}) ===`)
for (const ac of zeroBlocks) {
  const hasPdf = !!(ac.pdf_url_cached || ac.pdf_url_faa)
  console.log(`  ${ac.document_number} -- "${ac.title}" -- source PDF on file: ${hasPdf}`)
}
console.log()

// ── Check 2: suspiciously thin parse ─────────────────────────────────────
// Flags an AC whose block count is very low relative to its own text length
// -- a real (if imperfect) proxy for "parsing likely failed partway" rather
// than "this AC is genuinely short." Threshold: fewer than 1 block per 800
// chars of text, only for docs with at least 3000 chars of text (skips
// genuinely tiny 1-page ACs where this ratio is naturally noisy).
const thin = allACs.filter((ac) => {
  const textLen = (ac.pdf_text || '').length
  const blockCount = ac.pdf_blocks?.length || 0
  return textLen >= 3000 && blockCount > 0 && blockCount < textLen / 800
})
console.log(`=== Check 2: Active ACs with a suspiciously thin parse (${thin.length}) ===`)
for (const ac of thin) {
  const textLen = (ac.pdf_text || '').length
  console.log(`  ${ac.document_number} -- ${ac.pdf_blocks.length} blocks for ${textLen} chars (${(ac.pdf_blocks.length / (textLen / 800)).toFixed(2)}x threshold ratio) -- "${ac.title}"`)
}
console.log()

// ── Check 3: figures/tables referenced in text but missing an ac_figures row
const FIGURE_RE = /\b(FIGURE|Figure|TABLE|Table)\s+([0-9][0-9A-Za-z.\-]*)\b/g

console.log('=== Check 3: Figures/Tables referenced in text with no matching ac_figures row ===')
let docsWithGaps = 0
for (const ac of allACs) {
  if (!ac.pdf_text) continue
  const seen = new Map() // normalized label -> raw match
  let m
  FIGURE_RE.lastIndex = 0
  while ((m = FIGURE_RE.exec(ac.pdf_text))) {
    const kind = m[1][0].toUpperCase() === 'F' ? 'Figure' : 'Table'
    const num = m[2].replace(/\.$/, '')
    seen.set(`${kind} ${num}`, `${kind} ${num}`)
  }
  if (seen.size === 0) continue

  const { data: figRows, error } = await supabase.from('ac_figures').select('label').eq('ac_id', ac.id)
  if (error) { console.error(`  ${ac.document_number}: ac_figures query failed`, error); continue }
  const existingLabels = new Set((figRows || []).map((r) => (r.label || '').trim()))

  const missing = [...seen.keys()].filter((label) => {
    // Tolerant match: exact label, or same label ignoring case/whitespace.
    const norm = label.toLowerCase().replace(/\s+/g, ' ')
    return ![...existingLabels].some((e) => e.toLowerCase().replace(/\s+/g, ' ') === norm)
  })
  if (missing.length > 0) {
    docsWithGaps++
    console.log(`  ${ac.document_number} -- mentions [${missing.join(', ')}] with no matching ac_figures row (has ${existingLabels.size} row(s) total) -- "${ac.title}"`)
  }
}
console.log(`\n${docsWithGaps} doc(s) reference at least one figure/table missing its own row.`)
console.log('\nDone. This is a heuristic pass -- always view the actual page image before assuming a gap is real (see flyregs_gotchas.md for known false-positive classes: cross-doc citations, duplicate-caption mislabels, etc.).')
