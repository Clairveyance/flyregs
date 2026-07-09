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
const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
const js = ts.transpileModule(tsSrc, {
  compilerOptions: { module: 'ES2020', target: 'ES2020' },
}).outputText
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC, AC_FORMAT_VERSION, blockText } = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)
console.log(`Using parser v${AC_FORMAT_VERSION}`)

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
    const blocks = row.pdf_text ? parseAC(row.pdf_text) : []
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
