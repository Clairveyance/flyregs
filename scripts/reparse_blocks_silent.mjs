// Companion to scripts/fix_header_leak.py: regenerates pdf_blocks for exactly
// the ACs that script just cleaned, from their new pdf_text — WITHOUT ever
// touching pdf_blocks_version or changed_block_indices.
//
// backfill-blocks.mjs treats pdf_blocks_version === null as "the FAA
// published a real revision" and computes a diff against the old blocks to
// drive the NEW/UPD badge + What's New feature. Our cleanup is an internal
// text-quality fix, not a real FAA revision, so running that script (or
// setting pdf_blocks_version to null ourselves) would falsely flag every
// cleaned AC as recently revised. This script only ever writes the
// pdf_blocks column — nothing else on the row changes.
//
// Run from the ac-app/ directory:
//   node scripts/reparse_blocks_silent.mjs
// Reads the doc list from header_leak_fixed_docs.json (written by
// fix_header_leak.py) by default; pass --docs=43-4B,90-23H to override.

import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

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

const depSrc = fs.readFileSync(path.resolve('src/lib/ocrScannedACs.ts'), 'utf8')
const depJs = ts.transpileModule(depSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
const tmpDep = path.join(os.tmpdir(), `ocrScannedACs.${Date.now()}.mjs`)
fs.writeFileSync(tmpDep, depJs)
const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
let js = ts.transpileModule(tsSrc, {
  compilerOptions: { module: 'ES2020', target: 'ES2020' },
}).outputText
js = js.replace("from './ocrScannedACs'", `from ${JSON.stringify(pathToFileURL(tmpDep).href)}`)
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC, AC_FORMAT_VERSION } = await import(pathToFileURL(tmp).href)
fs.unlinkSync(tmp)
fs.unlinkSync(tmpDep)
console.log(`Using parser v${AC_FORMAT_VERSION}`)

const docsArg = process.argv.find((a) => a.startsWith('--docs='))
const defaultListPath = path.resolve('header_leak_fixed_docs.json')
let docNumbers
if (docsArg) {
  docNumbers = docsArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)
} else {
  if (!fs.existsSync(defaultListPath)) {
    console.error(`No --docs= given and ${defaultListPath} doesn't exist. Run fix_header_leak.py first.`)
    process.exit(1)
  }
  docNumbers = JSON.parse(fs.readFileSync(defaultListPath, 'utf8'))
}
if (docNumbers.length === 0) {
  console.log('Nothing to reparse.')
  process.exit(0)
}
console.log(`Reparsing pdf_blocks for ${docNumbers.length} AC(s)...`)

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
let done = 0

for (const docNum of docNumbers) {
  const { data, error } = await sb
    .from('advisory_circulars')
    .select('id, document_number, pdf_text')
    .eq('document_number', docNum)
    .single()

  if (error || !data) {
    console.error(`  ✗ ${docNum}: ${error?.message || 'not found'}`)
    continue
  }

  const blocks = data.pdf_text ? parseAC(data.pdf_text, data.document_number) : []

  // Only pdf_blocks is written -- pdf_blocks_version and changed_block_indices
  // are left exactly as they were, so no false "AC updated" signal fires.
  const { error: upErr } = await sb
    .from('advisory_circulars')
    .update({ pdf_blocks: blocks })
    .eq('id', data.id)

  if (upErr) {
    console.error(`  ✗ ${docNum}: ${upErr.message}`)
    continue
  }
  done++
  console.log(`  [${done}/${docNumbers.length}] ${docNum}: ${blocks.length} block(s)`)
}

console.log(`\nDone. Reparsed pdf_blocks for ${done}/${docNumbers.length} AC(s). pdf_blocks_version untouched.`)
