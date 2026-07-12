// Quick test: re-parse specific ACs with the updated parser and show structure
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

const docs = process.argv.slice(2)
for (const doc of docs) {
  const { data } = await supabase.from('advisory_circulars').select('pdf_text').eq('document_number', doc).single()
  if (!data?.pdf_text) { console.log(`${doc}: no text`); continue }
  const blocks = parseAC(data.pdf_text, doc)
  console.log(`\n=== ${doc} — ${blocks.length} blocks ===`)
  for (const b of blocks) {
    if (b.kind === 'chapter') console.log(`  CH  ${b.text.slice(0, 80)}`)
    else if (b.kind === 'section') console.log(`  SEC [${b.label}] ${b.title?.slice(0,30) || ''} | ${b.body?.slice(0,40) || ''}`)
    else if (b.kind === 'item') console.log(`  ITM(${b.level}) ${b.label} ${b.title?.slice(0,30) || ''} | ${b.body?.slice(0,40) || ''}`)
    else console.log(`  PAR ${b.text?.slice(0,60) || ''}`)
  }
}
