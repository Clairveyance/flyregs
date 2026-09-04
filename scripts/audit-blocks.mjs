// Audit all ACs for parser anomalies: false-positive sections, empty blocks, TOC leaks, etc.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

// This audit reads the STORED pdf_blocks -- it does not re-parse anything.
// It used to transpile acFormat.ts and ocrScannedACs.ts into a temp dir and
// dynamic-import parseAC, which was never called. Removed 2026-09-04 (RC:
// "no extraneous junk in the code to slow it down").
//
// The bigger cost was pdf_text: the query pulled it for all 780 ACs -- 67 MB
// over the wire -- and used it for exactly one thing, a line count, and only
// for ACs that have between 1 and 4 blocks. Those are now fetched in a
// second pass, for just the handful that qualify. Same checks, same output;
// 132s -> a fraction of it.

let page = 0
const PAGE_SIZE = 100
let totalACs = 0
const anomalies = []
const thinBlockACs = []

while (true) {
  const { data, error } = await supabase
    .from('advisory_circulars')
    .select('document_number, pdf_blocks')
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

    // Check for very few blocks relative to text size (TOC over-stripping).
    // Needs pdf_text, which is only fetched for the ACs that can possibly
    // trigger it -- see the second pass below.
    if (blocks.length > 0 && blocks.length < 5) {
      thinBlockACs.push({ doc: ac.document_number, blockCount: blocks.length, issues })
    }

    if (issues.length > 0) {
      anomalies.push({ doc: ac.document_number, issues })
    }
  }
  process.stdout.write(`\rAudited ${totalACs} ACs...`)
}

// Second pass: pdf_text, but only for the ACs whose block count is low
// enough for the TOC-over-stripping check to fire at all. Typically a
// handful of documents instead of all 780.
if (thinBlockACs.length) {
  const { data: texts } = await supabase
    .from('advisory_circulars')
    .select('document_number, pdf_text')
    .in('document_number', thinBlockACs.map((a) => a.doc))
  const byDoc = new Map((texts || []).map((t) => [t.document_number, t.pdf_text || '']))
  for (const a of thinBlockACs) {
    const textLines = (byDoc.get(a.doc) || '').split('\n').length
    if (textLines > 200) {
      const issue = `Suspicious: only ${a.blockCount} blocks for ${textLines}-line text`
      const existing = anomalies.find((x) => x.doc === a.doc)
      if (existing) existing.issues.push(issue)
      else anomalies.push({ doc: a.doc, issues: [issue] })
    }
  }
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
