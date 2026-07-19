// Add the missing ac_figures row for Figure 3-2 ("Runway-use diagrams") --
// the master diagram-number-to-figure-number lookup table referenced
// constantly throughout Chapter 3/4 ("select the runway-use configuration in
// figure 3-2 which best represents the airport..."). Confirmed via direct
// page image inspection that this is a SINGLE wide foldout page (physical
// page 27, printed page "21 (and 22)"), not a multi-page spread as initially
// assumed from scattered body-text fragments -- its own caption ("Figure 3-2.
// Runway-use diagrams") is printed at the bottom of the page. The Vision
// batch transcribed the page's text correctly (2639 chars, confirmed in
// /tmp/vision_batch_run3.log) but never flagged it as a figure. No pdf_text
// changes needed -- same failure mode as Figure 3-15/3-17 (see
// fix_5060_missing_315_317.mjs).
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const DOC = '150/5060-5'
const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

// Belongs right after Figure 3-1 (page 20) and before Table 3-1 (page 22).
const { data: anchorRows, error: sortErr } = await supabase
  .from('ac_figures').select('id, label, sort_order').eq('ac_id', ac.id).in('label', ['Figure 3-1', 'Table 3-1'])
if (sortErr) { console.error(sortErr); process.exit(1) }
const fig31 = anchorRows.find(r => r.label === 'Figure 3-1')
console.log('Figure 3-1 sort_order:', fig31?.sort_order)

const BASE_SORT = fig31.sort_order + 1
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', BASE_SORT).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 1 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 1 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_027.png')
const pngBytes = fs.readFileSync(pagePath)
const fname = `150_5060-5/figure-3-2.png`
const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
  method: 'PUT', body: pngBytes,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
})
if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

const { error: insErr } = await supabase.from('ac_figures').insert({
  ac_id: ac.id, label: 'Figure 3-2', caption: 'Runway-use diagrams', page: 27, image_url: imageUrl, sort_order: BASE_SORT,
})
if (insErr) { console.error('insert failed', insErr); process.exit(1) }
console.log('Inserted Figure 3-2 (page 27).')
