// Fix the same OCR character-confusion mislabels in AC 150/5060-5's pdf_text
// itself (not just ac_figures) -- the body text captions must match the
// ac_figures labels or the inline Figure/Table hyperlinking in ACBody.tsx
// breaks. Companion to fix_figure_mislabels.mjs. Each anchor below was
// confirmed unique in the corpus before this script was written.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '150/5060-5'

const fixes = [
  ['Figure 2-I. Capacity and ASV for long range planning (cont.)', 'Figure 2-1. Capacity and ASV for long range planning (cont.)'],
  ['FIGURE 3-57A     RUNWAY OPERATIONS RATE', 'FIGURE 3-67A     RUNWAY OPERATIONS RATE'],
  ['FIGURE 3-57B     RUNWAY OPERATIONS RATE', 'FIGURE 3-67B     RUNWAY OPERATIONS RATE'],
  ['FIGURE 3-57C     RUNWAY OPERATIONS RATE', 'FIGURE 3-67C     RUNWAY OPERATIONS RATE'],
  ['FIGURE 3-57D     RUNWAY OPERATIONS RATE', 'FIGURE 3-67D     RUNWAY OPERATIONS RATE'],
  ['FIGURE 3-57. HOURLY CAPACITY OF A TAXIWAY CROSSING AN ACTIVE RUNWAY WITHOUT ARRIVALS.', 'FIGURE 3-67. HOURLY CAPACITY OF A TAXIWAY CROSSING AN ACTIVE RUNWAY WITHOUT ARRIVALS.'],
  ['FIGURE 5-88. DELAY INDICES FOR RUNWAY-USE DIAGRAM NOS.: 80,81,95. FOR VFR CONDITIONS.', 'FIGURE 3-88. DELAY INDICES FOR RUNWAY-USE DIAGRAM NOS.: 80,81,95. FOR VFR CONDITIONS.'],
  ['Figure Al-1. Investigate runway capability', 'Figure A1-1. Investigate runway capability'],
  ['Figure AS-2. Hourly capacity runway component', 'Figure A5-2. Hourly capacity runway component'],
  ['Figure AS-S.  Airport hourly capacity', 'Figure A5-5.  Airport hourly capacity'],
  ['FIGURE 3-52.  HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS.: 46,52,58 FOR IFR CONDITIONS.', 'FIGURE 3-62.  HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS.: 46,52,58 FOR IFR CONDITIONS.'],
]

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

let text = ac.pdf_text
for (const [from, to] of fixes) {
  const count = text.split(from).length - 1
  if (count !== 1) {
    console.error(`  ✗ ABORT: expected exactly 1 occurrence of "${from}", found ${count}`)
    process.exit(1)
  }
  text = text.replace(from, to)
  console.log(`  ✓ "${from}" -> "${to}"`)
}

const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: text }).eq('id', ac.id)
if (updErr) { console.error('update failed', updErr); process.exit(1) }
console.log(`\nDone. Patched pdf_text for ${DOC}.`)
