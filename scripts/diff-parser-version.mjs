// Compare parseAC() output (OLD = git HEAD acFormat.ts, NEW = working-copy
// acFormat.ts with the splitHeading fix) across the real AC corpus. Reports
// how many item blocks change title/body split, and prints samples for
// manual sanity-checking before touching production data.
import { createClient } from '@supabase/supabase-js'
import ts from 'typescript'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { pathToFileURL } from 'url'

const REPO = '/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app'
process.chdir(REPO)

const envPath = path.resolve('.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

function loadParser(tsSrc, depSrc) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acdiff-'))
  const depJs = ts.transpileModule(depSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
  fs.writeFileSync(path.join(tmpDir, 'ocrScannedACs.mjs'), depJs)
  let js = ts.transpileModule(tsSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
  js = js.replace("from './ocrScannedACs'", "from './ocrScannedACs.mjs'")
  const tmp = path.join(tmpDir, 'acFormat.mjs')
  fs.writeFileSync(tmp, js)
  return tmp
}

const oldTsSrc = execSync('git show HEAD:src/lib/acFormat.ts', { encoding: 'utf8', maxBuffer: 1e8 })
const oldDepSrc = execSync('git show HEAD:src/lib/ocrScannedACs.ts', { encoding: 'utf8', maxBuffer: 1e8 })
const newTsSrc = fs.readFileSync('src/lib/acFormat.ts', 'utf8')
const newDepSrc = fs.readFileSync('src/lib/ocrScannedACs.ts', 'utf8')

const oldMod = await import(pathToFileURL(loadParser(oldTsSrc, oldDepSrc)).href)
const newMod = await import(pathToFileURL(loadParser(newTsSrc, newDepSrc)).href)
console.log(`OLD parser v${oldMod.AC_FORMAT_VERSION}, NEW parser v${newMod.AC_FORMAT_VERSION}`)

let page = 0
const PAGE_SIZE = 100
let totalACs = 0
let acsWithChanges = 0
let itemsChanged = 0
let itemsUnchanged = 0
const samples = []
const suspiciousSamples = [] // new body now starts lowercase or mid-word -- possible regression

while (true) {
  const { data, error } = await supabase
    .from('advisory_circulars')
    .select('document_number, pdf_text')
    .eq('status', 'active')
    .not('pdf_text', 'is', null)
    .order('document_number')
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
  if (error) { console.error(error); process.exit(1) }
  if (!data || data.length === 0) break
  page++

  for (const row of data) {
    totalACs++
    let oldBlocks, newBlocks
    try {
      oldBlocks = oldMod.parseAC(row.pdf_text, row.document_number)
      newBlocks = newMod.parseAC(row.pdf_text, row.document_number)
    } catch (e) {
      console.error(`PARSE ERROR ${row.document_number}: ${e.message}`)
      continue
    }
    if (oldBlocks.length !== newBlocks.length) {
      console.error(`  ! Block count changed for ${row.document_number}: ${oldBlocks.length} -> ${newBlocks.length} (unexpected -- fix should only redistribute title/body within a block)`)
      continue
    }
    let acChanged = false
    for (let i = 0; i < oldBlocks.length; i++) {
      const ob = oldBlocks[i], nb = newBlocks[i]
      if (ob.kind !== 'item' || nb.kind !== 'item') continue
      if (ob.title === nb.title && ob.body === nb.body) { itemsUnchanged++; continue }
      itemsChanged++
      acChanged = true
      const rec = { doc: row.document_number, label: nb.label, oldTitle: ob.title, oldBody: (ob.body||'').slice(0,80), newTitle: nb.title, newBody: (nb.body||'').slice(0,80) }
      samples.push(rec)
      // Flag genuine possible regressions: new parser still produced a
      // non-empty title (fix's code path should never do this -- the only
      // behavior change is title-nonempty,body-empty -> title-empty,body-set)
      if (nb.title !== '') suspiciousSamples.push(rec)
    }
    if (acChanged) acsWithChanges++
  }
  process.stdout.write(`\rDiffed ${totalACs} ACs...`)
}

console.log(`\n\n=== SUMMARY ===`)
console.log(`ACs scanned: ${totalACs}`)
console.log(`ACs with at least one changed item block: ${acsWithChanges}`)
console.log(`Item blocks changed: ${itemsChanged}`)
console.log(`Item blocks unchanged: ${itemsUnchanged}`)

const OUT = '/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/dda71396-47d8-4940-b2fe-bbaf460c155b/scratchpad'
fs.writeFileSync(`${OUT}/ac_splitheading_all.json`, JSON.stringify(samples, null, 1))
console.log(`\nWrote all ${samples.length} changed items to ac_splitheading_all.json`)
// Evenly-spaced sample across the WHOLE run (not just the first few docs)
const spread = []
const step = Math.max(1, Math.floor(samples.length / 60))
for (let i = 0; i < samples.length; i += step) spread.push(samples[i])
fs.writeFileSync(`${OUT}/ac_splitheading_spread_sample.json`, JSON.stringify(spread, null, 1))
console.log(`Wrote ${spread.length} evenly-spread samples to ac_splitheading_spread_sample.json`)
console.log(`Suspicious (possible regression -- new title non-empty) samples: ${suspiciousSamples.length}`)
fs.writeFileSync(`${OUT}/ac_splitheading_suspicious.json`, JSON.stringify(suspiciousSamples, null, 1))
