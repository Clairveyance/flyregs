// Compare parseAC() output (OLD = git HEAD acFormat.ts, NEW = working-copy
// acFormat.ts with the section-vs-item SECDOT reclassification fix) across
// the real AC corpus. Purpose-built for THIS fix shape: reports every block
// whose KIND changed (section -> item, or any other kind flip), flags any
// block-COUNT change per AC as suspicious (this fix reclassifies blocks
// in place, 1:1 -- it should never add or remove a block), and confirms the
// full concatenated text content of every AC is byte-identical old vs new
// (kind/label/level can change; word content must not).
//
// Modeled on diff-parser-version.mjs's own loading technique (transpile both
// git-HEAD and working-copy acFormat.ts at runtime, re-parse every AC's real
// pdf_text with both). See PROJECT_NOTES/flyregs_pending.md's "reverted
// SECDOT attempt" entry for why this fix shape specifically needs a
// block-count-parity check as a safety net, not just a content diff.
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

// Comparable "flattened" text for a whole AC's blocks -- concatenation of
// each block's own text, independent of kind. Used to prove the fix never
// loses/duplicates real content, only reclassifies it.
function flatText(blocks) {
  return blocks
    .map((b) => {
      if (b.kind === 'chapter' || b.kind === 'para') return (b.text || '').trim()
      if (b.kind === 'section' || b.kind === 'item') return `${b.label || ''} ${b.title || ''} ${b.body || ''}`.trim()
      return ''
    })
    .join('\n')
}

let page = 0
const PAGE_SIZE = 100
let totalACs = 0
let acsWithKindChange = 0
let acsWithCountMismatch = 0
let acsWithContentMismatch = 0
let blocksChangedKind = 0
const kindChangeSamples = []
const countMismatchDocs = []
const contentMismatchDocs = []
// Track kind-flip direction to catch anything unexpected (should be 100% section->item)
const flipCounts = {}

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
      acsWithCountMismatch++
      countMismatchDocs.push({ doc: row.document_number, oldLen: oldBlocks.length, newLen: newBlocks.length })
      continue // can't do a positional kind diff if lengths differ
    }

    const oldFlat = flatText(oldBlocks)
    const newFlat = flatText(newBlocks)
    if (oldFlat !== newFlat) {
      acsWithContentMismatch++
      contentMismatchDocs.push(row.document_number)
    }

    let acHasKindChange = false
    for (let i = 0; i < oldBlocks.length; i++) {
      const ob = oldBlocks[i], nb = newBlocks[i]
      if (ob.kind === nb.kind) continue
      blocksChangedKind++
      acHasKindChange = true
      const key = `${ob.kind}->${nb.kind}`
      flipCounts[key] = (flipCounts[key] || 0) + 1
      kindChangeSamples.push({
        doc: row.document_number,
        oldKind: ob.kind,
        newKind: nb.kind,
        label: (nb.kind === 'section' || nb.kind === 'item') ? nb.label : undefined,
        oldTitle: ob.kind === 'section' || ob.kind === 'item' ? ob.title : undefined,
        oldBody: (ob.kind === 'section' || ob.kind === 'item') ? (ob.body || '').slice(0, 100) : undefined,
        newTitle: nb.kind === 'section' || nb.kind === 'item' ? nb.title : undefined,
        newBody: (nb.kind === 'section' || nb.kind === 'item') ? (nb.body || '').slice(0, 100) : undefined,
      })
    }
    if (acHasKindChange) acsWithKindChange++
  }
  process.stdout.write(`\rDiffed ${totalACs} ACs...`)
}

console.log(`\n\n=== SUMMARY ===`)
console.log(`ACs scanned: ${totalACs}`)
console.log(`ACs with block-COUNT mismatch (unexpected for this fix shape): ${acsWithCountMismatch}`)
console.log(`ACs with concatenated-content mismatch (possible real data loss): ${acsWithContentMismatch}`)
console.log(`ACs with at least one block kind change: ${acsWithKindChange}`)
console.log(`Blocks that changed kind: ${blocksChangedKind}`)
console.log(`Kind-flip breakdown:`, flipCounts)

const OUT = '/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/dda71396-47d8-4940-b2fe-bbaf460c155b/scratchpad'
fs.writeFileSync(`${OUT}/ac_secitem_kindchanges.json`, JSON.stringify(kindChangeSamples, null, 1))
fs.writeFileSync(`${OUT}/ac_secitem_count_mismatches.json`, JSON.stringify(countMismatchDocs, null, 1))
fs.writeFileSync(`${OUT}/ac_secitem_content_mismatches.json`, JSON.stringify(contentMismatchDocs, null, 1))
console.log(`\nWrote ${kindChangeSamples.length} kind-change records to ac_secitem_kindchanges.json`)
console.log(`Wrote ${countMismatchDocs.length} count-mismatch docs to ac_secitem_count_mismatches.json`)
console.log(`Wrote ${contentMismatchDocs.length} content-mismatch docs to ac_secitem_content_mismatches.json`)
