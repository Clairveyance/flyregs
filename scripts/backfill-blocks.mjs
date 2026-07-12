// One-time (re-runnable) backfill: parse every AC's pdf_text into structured
// pdf_blocks so the app can render formatted text instantly with no client
// parsing. Reuses the EXACT client parser (src/lib/acFormat.ts) by transpiling
// it at runtime, so server and client output can never diverge.
//
// Prereqs: run migrations/add_pdf_blocks.sql in the Supabase SQL editor first.
// Run from the ac-app/ directory:   node scripts/backfill-blocks.mjs
//
// Reads SUPABASE_URL + SUPABASE_SERVICE_KEY from .env.scraper. The service
// key bypasses RLS for the UPDATE. Keys are never printed.
//
// Optional: --touched-out=<path> writes the document_number of every row this
// run actually processed, one per line. sync.sh uses this to hand off exactly
// the newly-touched ACs to audit-parser.mjs afterward — auditing only what
// changed instead of re-scanning the whole catalog on every weekly sync.

import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

// ── Load credentials (never logged) ─────────────────────────────────────────
const envPath = path.resolve(process.cwd(), '.env.scraper')
if (!fs.existsSync(envPath)) {
  console.error('Missing .env.scraper (needs SUPABASE_URL + SUPABASE_SERVICE_KEY)')
  process.exit(1)
}
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_KEY not found in .env.scraper')
  process.exit(1)
}

// ── Load the real client parser by transpiling the TS source ────────────────
// acFormat.ts imports ocrScannedACs.ts (to scope the OCR-artifact-repair
// heuristic to only the known-scanned ACs) -- transpile that dependency into
// the same tmp dir too, and rewrite the extension-less relative import to
// point at it, since native ESM (unlike CJS) requires explicit file
// extensions on relative specifiers.
const depSrc = fs.readFileSync(path.resolve('src/lib/ocrScannedACs.ts'), 'utf8')
const depJs = ts.transpileModule(depSrc, {
  compilerOptions: { module: 'ES2020', target: 'ES2020' },
}).outputText
const tmpDep = path.join(os.tmpdir(), `ocrScannedACs.${Date.now()}.mjs`)
fs.writeFileSync(tmpDep, depJs)

const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
let js = ts.transpileModule(tsSrc, {
  compilerOptions: { module: 'ES2020', target: 'ES2020' },
}).outputText
js = js.replace("from './ocrScannedACs'", `from ${JSON.stringify(pathToFileURL(tmpDep).href)}`)
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC, AC_FORMAT_VERSION, blockText } = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)
fs.unlinkSync(tmpDep)
console.log(`Using parser v${AC_FORMAT_VERSION}`)

// ── Manual per-AC overrides ──────────────────────────────────────────────
// Some parser gaps can't be fixed by a general rule without breaking other
// ACs (see e.g. AC 89-3's "7. Aeronautical Information Manual (AIM)." list
// item, which is undecidable from shape alone -- flyregs_parser.md v29 notes).
// For those, `ac_block_overrides` lets us hand-author the correct blocks for
// one specific passage instead of leaving it broken. This is applied AFTER
// parseAC() runs, every single backfill, so the rest of the document keeps
// benefiting from every future parser improvement -- only the anchored
// region is replaced. `anchor_start`/`anchor_end` are short raw-text snippets
// marking the first and last line the override covers; both are checked
// against the CURRENT pdf_text (whitespace-normalized, since PDF line-wraps
// don't line up with the reformatted block text) before applying, so if the
// FAA revises that passage the override auto-disables instead of silently
// serving stale patched text -- the fresh auto-parse is used instead and a
// warning is logged for manual re-review.
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

function applyOverrides(blocks, pdfText, overrides, docNumber) {
  if (!overrides || overrides.length === 0) return blocks
  let result = blocks
  for (const ov of overrides) {
    const normText = norm(pdfText)
    const normStart = norm(ov.anchor_start)
    const normEnd = norm(ov.anchor_end)
    if (!normText.includes(normStart) || !normText.includes(normEnd)) {
      console.warn(`  ! Override stale for ${docNumber} (id ${ov.id}) -- anchor text not found, skipping. Needs re-review.`)
      continue
    }
    const startIdx = result.findIndex((b) => norm(blockText(b)).includes(normStart))
    if (startIdx === -1) {
      console.warn(`  ! Override for ${docNumber} (id ${ov.id}) -- anchor_start present in pdf_text but not in any parsed block, skipping.`)
      continue
    }
    let endIdx = -1
    for (let i = startIdx; i < result.length; i++) {
      if (norm(blockText(result[i])).includes(normEnd)) { endIdx = i; break }
    }
    if (endIdx === -1) {
      console.warn(`  ! Override for ${docNumber} (id ${ov.id}) -- anchor_end present in pdf_text but not found in any parsed block at/after anchor_start, skipping.`)
      continue
    }
    result = [...result.slice(0, startIdx), ...ov.override_blocks, ...result.slice(endIdx + 1)]
  }
  return result
}

// ── Backfill ────────────────────────────────────────────────────────────────
const touchedOutArg = process.argv.find((a) => a.startsWith('--touched-out='))
const touchedOutPath = touchedOutArg ? touchedOutArg.split('=')[1] : null
const touchedDocs = []

// Indices (into `newBlocks`) whose content doesn't appear anywhere in
// `oldBlocks` -- i.e. genuinely new or edited text, not just reordered.
function computeChangedIndices(oldBlocks, newBlocks) {
  const oldTexts = new Set(oldBlocks.map(blockText).filter(Boolean))
  const changed = []
  newBlocks.forEach((b, i) => {
    const t = blockText(b)
    if (t && !oldTexts.has(t)) changed.push(i)
  })
  return changed
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
const PAGE = 50
let processed = 0
let withBlocks = 0

const { data: overrideRows, error: overrideErr } = await sb
  .from('ac_block_overrides')
  .select('id, ac_id, anchor_start, anchor_end, override_blocks')
if (overrideErr) {
  console.error('Failed to load ac_block_overrides:', overrideErr.message)
  process.exit(1)
}
const overridesByAcId = new Map()
for (const ov of overrideRows || []) {
  if (!overridesByAcId.has(ov.ac_id)) overridesByAcId.set(ov.ac_id, [])
  overridesByAcId.get(ov.ac_id).push(ov)
}
if (overridesByAcId.size) console.log(`Loaded ${overrideRows.length} manual override(s) across ${overridesByAcId.size} AC(s)`)

for (;;) {
  // Rows not yet built, or built by an older parser version.
  const { data, error } = await sb
    .from('advisory_circulars')
    .select('id, document_number, pdf_text, pdf_blocks, pdf_blocks_version')
    .or(`pdf_blocks_version.is.null,pdf_blocks_version.lt.${AC_FORMAT_VERSION}`)
    .order('document_number')
    .limit(PAGE)

  if (error) {
    console.error('Fetch failed:', error.message)
    process.exit(1)
  }
  if (!data || data.length === 0) break

  for (const row of data) {
    const parsed = row.pdf_text ? parseAC(row.pdf_text, row.document_number) : []
    const blocks = applyOverrides(parsed, row.pdf_text, overridesByAcId.get(row.id), row.document_number)
    const updatePayload = { pdf_blocks: blocks, pdf_blocks_version: AC_FORMAT_VERSION }

    // pdf_blocks_version === null is the scraper's specific signal for "this
    // AC's pdf_text actually changed" (see faa_scraper.py) -- as opposed to
    // just being reprocessed because AC_FORMAT_VERSION was bumped, which
    // shouldn't overwrite the diff from the last real content change. Only
    // compute a fresh diff for genuine revisions, and only when there was a
    // previous version to diff against (not the AC's first-ever parse).
    const oldBlocks = row.pdf_blocks || []
    if (row.pdf_blocks_version === null && oldBlocks.length > 0) {
      updatePayload.changed_block_indices = computeChangedIndices(oldBlocks, blocks)
    }

    const { error: upErr } = await sb
      .from('advisory_circulars')
      .update(updatePayload)
      .eq('id', row.id)
    if (upErr) {
      console.error(`  ✗ ${row.document_number}: ${upErr.message}`)
      continue
    }
    processed++
    if (blocks.length) withBlocks++
    touchedDocs.push(row.document_number)
  }
  console.log(`  …processed ${processed} (${withBlocks} with content)`)
}

console.log(`\nDone. ${processed} ACs backfilled, ${withBlocks} have formatted blocks.`)

if (touchedOutPath) {
  fs.writeFileSync(touchedOutPath, touchedDocs.join('\n') + (touchedDocs.length ? '\n' : ''))
  console.log(`Wrote ${touchedDocs.length} touched document numbers to ${touchedOutPath}`)
}
