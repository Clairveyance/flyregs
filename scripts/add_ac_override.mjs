// Author a manual per-AC block override -- for parser gaps that can't be
// fixed by a general rule without breaking other ACs (see flyregs_parser.md
// v29 notes on AC 89-3's "7. Aeronautical Information Manual (AIM)." item).
// Inserts one row into ac_block_overrides, then immediately re-parses that
// single AC and re-applies ALL its overrides so the fix is live right away --
// no AC_FORMAT_VERSION bump or full-corpus backfill needed, since only this
// one AC's override set changed, not the general parser.
//
// Usage:
//   node scripts/add_ac_override.mjs <document_number> <anchor_start_file> <anchor_end_file> <override_blocks.json> ["note"]
//
// anchor_start/anchor_end are short raw pdf_text snippets (a few words each)
// marking the first and last line of the passage being replaced -- read from
// files so shell-quoting odd PDF punctuation isn't a problem. override_blocks
// is a JSON file containing an ACBlock[] (see src/lib/acFormat.ts's type) --
// exactly what will be spliced in place of every parsed block from the one
// matching anchor_start through the one matching anchor_end (inclusive).

import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const [documentNumber, startFile, endFile, blocksFile, note] = process.argv.slice(2)
if (!documentNumber || !startFile || !endFile || !blocksFile) {
  console.error('Usage: node scripts/add_ac_override.mjs <document_number> <anchor_start_file> <anchor_end_file> <override_blocks.json> ["note"]')
  process.exit(1)
}

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const anchorStart = fs.readFileSync(startFile, 'utf8').trim()
const anchorEnd = fs.readFileSync(endFile, 'utf8').trim()
const overrideBlocks = JSON.parse(fs.readFileSync(blocksFile, 'utf8'))

const { data: acRow, error: acErr } = await sb
  .from('advisory_circulars')
  .select('id, pdf_text, pdf_blocks')
  .eq('document_number', documentNumber)
  .single()
if (acErr || !acRow) {
  console.error(`AC ${documentNumber} not found:`, acErr?.message)
  process.exit(1)
}

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
if (!norm(acRow.pdf_text).includes(norm(anchorStart))) {
  console.error(`anchor_start not found in ${documentNumber}'s pdf_text -- check the snippet.`)
  process.exit(1)
}
if (!norm(acRow.pdf_text).includes(norm(anchorEnd))) {
  console.error(`anchor_end not found in ${documentNumber}'s pdf_text -- check the snippet.`)
  process.exit(1)
}

const { data: inserted, error: insErr } = await sb
  .from('ac_block_overrides')
  .insert({
    ac_id: acRow.id,
    anchor_start: anchorStart,
    anchor_end: anchorEnd,
    override_blocks: overrideBlocks,
    note: note || null,
  })
  .select()
  .single()
if (insErr) {
  console.error('Insert failed:', insErr.message)
  process.exit(1)
}
console.log(`Inserted override ${inserted.id} for ${documentNumber}.`)

// Re-parse this one AC with the real client parser and re-apply every
// override on file for it (including the one just inserted), so the fix is
// live immediately instead of waiting for the next full backfill run.
const depSrc = fs.readFileSync(path.resolve('src/lib/ocrScannedACs.ts'), 'utf8')
const depJs = ts.transpileModule(depSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
const tmpDep = path.join(os.tmpdir(), `ocrScannedACs.${Date.now()}.mjs`)
fs.writeFileSync(tmpDep, depJs)
const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
let js = ts.transpileModule(tsSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
js = js.replace("from './ocrScannedACs'", `from ${JSON.stringify(pathToFileURL(tmpDep).href)}`)
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC, blockText } = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)
fs.unlinkSync(tmpDep)

const { data: allOverrides } = await sb
  .from('ac_block_overrides')
  .select('id, anchor_start, anchor_end, override_blocks')
  .eq('ac_id', acRow.id)

function applyOverrides(blocks, pdfText, overrides) {
  let result = blocks
  for (const ov of overrides) {
    const normStart = norm(ov.anchor_start)
    const normEnd = norm(ov.anchor_end)
    const startIdx = result.findIndex((b) => norm(blockText(b)).includes(normStart))
    if (startIdx === -1) continue
    let endIdx = -1
    for (let i = startIdx; i < result.length; i++) {
      if (norm(blockText(result[i])).includes(normEnd)) { endIdx = i; break }
    }
    if (endIdx === -1) continue
    result = [...result.slice(0, startIdx), ...ov.override_blocks, ...result.slice(endIdx + 1)]
  }
  return result
}

const freshParse = parseAC(acRow.pdf_text, documentNumber)
const withOverrides = applyOverrides(freshParse, acRow.pdf_text, allOverrides || [])
const { error: upErr } = await sb
  .from('advisory_circulars')
  .update({ pdf_blocks: withOverrides })
  .eq('id', acRow.id)
if (upErr) {
  console.error('Failed to update pdf_blocks:', upErr.message)
  process.exit(1)
}
console.log(`${documentNumber}'s pdf_blocks updated with ${(allOverrides || []).length} override(s) applied. Live now.`)
