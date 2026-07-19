// One-off: correct 6 confirmed OCR character-confusion mislabels in ac_figures
// for AC 150/5060-5, found by visually comparing the Vision-transcribed label
// against the actual rendered page image (scratch/ocr_rebuild_with_figures).
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '150/5060-5'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const fixes = [
  { page: 16, from: 'Figure 2-I', to: 'Figure 2-1' },
  { page: 61, from: 'Figure 3-57A', to: 'Figure 3-67A' },
  { page: 61, from: 'Figure 3-57B', to: 'Figure 3-67B' },
  { page: 61, from: 'Figure 3-57C', to: 'Figure 3-67C' },
  { page: 61, from: 'Figure 3-57D', to: 'Figure 3-67D' },
  { page: 73, from: 'Figure 5-88', to: 'Figure 3-88' },
  { page: 97, from: 'Figure Al-1', to: 'Figure A1-1' },
  { page: 141, from: 'Figure AS-2', to: 'Figure A5-2' },
  { page: 144, from: 'Figure AS-S', to: 'Figure A5-5' },
]

for (const fix of fixes) {
  const { data: rows, error } = await supabase
    .from('ac_figures')
    .select('id, label, page')
    .eq('ac_id', ac.id)
    .eq('page', fix.page)
    .eq('label', fix.from)
  if (error) { console.error(`  ✗ query failed for ${fix.from} (page ${fix.page}):`, error.message); continue }
  if (!rows || rows.length === 0) { console.log(`  - not found (already fixed or absent): "${fix.from}" page ${fix.page}`); continue }
  for (const row of rows) {
    const { error: updErr } = await supabase.from('ac_figures').update({ label: fix.to }).eq('id', row.id)
    if (updErr) { console.error(`  ✗ update failed for id ${row.id}:`, updErr.message); continue }
    console.log(`  ✓ "${fix.from}" -> "${fix.to}" (page ${fix.page})`)
  }
}
