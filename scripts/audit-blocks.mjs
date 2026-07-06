// Audit all ACs for parser anomalies: false-positive sections, empty blocks, TOC leaks, etc.
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

const tsSrc = fs.readFileSync(path.resolve('src/lib/acFormat.ts'), 'utf8')
const js = ts.transpileModule(tsSrc, { compilerOptions: { module: 'ES2020', target: 'ES2020' } }).outputText
const tmp = path.join(os.tmpdir(), `acFormat.${Date.now()}.mjs`)
fs.writeFileSync(tmp, js)
const { parseAC } = await import(pathToFileURL(tmp).href)

let page = 0
const PAGE_SIZE = 100
let totalACs = 0
const anomalies = []

while (true) {
  const { data, error } = await supabase
    .from('advisory_circulars')
    .select('document_number, pdf_text, pdf_blocks')
    .eq('status', 'active')
    .not('pdf_text', 'is', null)
    .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)
  if (error || !data || data.length === 0) break
  page++
  totalACs += data.length

  for (const ac of data) {
    const blocks = ac.pdf_blocks || []
    const issues = []

    // Check for 0.x false-positive sections
    const zeroSections = blocks.filter(b => b.kind === 'section' && /^0\./.test(b.label || ''))
    if (zeroSections.length > 0) issues.push(`0.x sections: ${zeroSections.map(b => b.label).join(', ')}`)

    // Check for CFR-sized decimal sections (like 29.853)
    const cfrSections = blocks.filter(b => b.kind === 'section' && /^\d+\.\d{3,}/.test(b.label || ''))
    if (cfrSections.length > 0) issues.push(`CFR-sized sections: ${cfrSections.slice(0,3).map(b => b.label).join(', ')}`)

    // Check for phone/large number section labels via SEC regex (like 776-0790)
    const largeSEC = blocks.filter(b => b.kind === 'section' && /^\d{4,}-/.test(b.label || ''))
    if (largeSEC.length > 0) issues.push(`Large SEC labels: ${largeSEC.slice(0,3).map(b => b.label).join(', ')}`)

    // Check for duplicate section headings under the SAME parent chapter
    // (cross-chapter duplicates, e.g. appendix restarting at "1.", are expected)
    let currentChapter = '__root__'
    const labelCountsByChapter = {}
    for (const b of blocks) {
      if (b.kind === 'chapter') { currentChapter = b.text; continue }
      if (b.kind === 'section' && b.label) {
        const key = currentChapter + '|' + b.label + (b.title || '')
        labelCountsByChapter[key] = (labelCountsByChapter[key] || 0) + 1
      }
    }
    const dupes = Object.entries(labelCountsByChapter)
      .filter(([, c]) => c >= 2)
      .map(([k]) => k.split('|').slice(1).join('|'))
    if (dupes.length > 0) issues.push(`Duplicate sections: ${dupes.slice(0,3).map(([k]) => k).join(', ')}`)

    // Check for very few blocks relative to text size (TOC over-stripping)
    const textLines = (ac.pdf_text || '').split('\n').length
    if (blocks.length > 0 && blocks.length < 5 && textLines > 200) {
      issues.push(`Suspicious: only ${blocks.length} blocks for ${textLines}-line text`)
    }

    if (issues.length > 0) {
      anomalies.push({ doc: ac.document_number, issues })
    }
  }
  process.stdout.write(`\rAudited ${totalACs} ACs...`)
}

console.log(`\n\n=== AUDIT COMPLETE: ${totalACs} ACs checked ===`)
console.log(`${anomalies.length} ACs with anomalies:\n`)

// Group by issue type
const byType = {}
for (const a of anomalies) {
  for (const issue of a.issues) {
    const type = issue.split(':')[0]
    if (!byType[type]) byType[type] = []
    byType[type].push(a.doc)
  }
}

for (const [type, docs] of Object.entries(byType)) {
  console.log(`${type} (${docs.length} ACs):`)
  console.log('  ' + docs.slice(0, 20).join(', ') + (docs.length > 20 ? '...' : ''))
}

console.log('\nDetailed list:')
for (const a of anomalies.slice(0, 50)) {
  console.log(`  ${a.doc}: ${a.issues.join(' | ')}`)
}
