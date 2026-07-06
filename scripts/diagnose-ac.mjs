// Diagnostic script — prints raw pdf_text and parsed pdf_blocks for specified ACs
// Usage: node scripts/diagnose-ac.mjs "20-42D" "61-67C"
import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
const js = ts.transpileModule(tsSrc, {
  compilerOptions: { module: 'ES2020', target: 'ES2020' },
}).outputText
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC } = await import(pathToFileURL(tmp).href)

const docNums = process.argv.slice(2)
if (!docNums.length) {
  console.error('Usage: node scripts/diagnose-ac.mjs "20-42D" "61-67C"')
  process.exit(1)
}

for (const doc of docNums) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`AC: ${doc}`)
  console.log('='.repeat(70))

  const { data, error } = await supabase
    .from('advisory_circulars')
    .select('id, document_number, pdf_text, pdf_blocks')
    .eq('document_number', doc)
    .single()

  if (error || !data) {
    console.log('NOT FOUND:', error?.message)
    continue
  }

  // Show stored blocks summary
  const stored = data.pdf_blocks || []
  console.log(`\n--- STORED pdf_blocks (${stored.length} blocks) ---`)
  for (const b of stored) {
    if (b.kind === 'chapter') console.log(`  CHAPTER: ${b.text}`)
    else if (b.kind === 'section') console.log(`  SECTION ${b.label} ${b.title || ''} | body=${b.body?.slice(0,60)}`)
    else if (b.kind === 'item') console.log(`  ITEM(${b.level}) ${b.label} ${b.title || ''} | body=${b.body?.slice(0,60)}`)
    else if (b.kind === 'para') console.log(`  PARA: ${b.text?.slice(0,80)}`)
  }

  if (!data.pdf_text) {
    console.log('\n[No pdf_text available]')
    continue
  }

  // Re-parse live and compare
  const fresh = parseAC(data.pdf_text)
  console.log(`\n--- FRESH PARSE (${fresh.length} blocks) ---`)
  for (const b of fresh) {
    if (b.kind === 'chapter') console.log(`  CHAPTER: ${b.text}`)
    else if (b.kind === 'section') console.log(`  SECTION ${b.label} ${b.title || ''} | body=${b.body?.slice(0,60)}`)
    else if (b.kind === 'item') console.log(`  ITEM(${b.level}) ${b.label} ${b.title || ''} | body=${b.body?.slice(0,60)}`)
    else if (b.kind === 'para') console.log(`  PARA: ${b.text?.slice(0,80)}`)
  }

  // Show first 200 lines of raw pdf_text
  console.log(`\n--- RAW PDF TEXT (first 200 lines) ---`)
  const rawLines = data.pdf_text.split('\n').slice(0, 200)
  rawLines.forEach((l, i) => console.log(`${String(i+1).padStart(4)}: ${l}`))
}
