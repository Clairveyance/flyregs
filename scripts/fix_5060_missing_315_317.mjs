// Add missing ac_figures rows for Figure 3-15 (page 34) and Figure 3-17 (page
// 35) -- both were transcribed correctly into pdf_text by the Vision batch
// (real captions, real chart content) but never got a figure-detection row.
// No pdf_text changes needed here, unlike page 28/33/84's full page misses.
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

const { data: anchorRows, error: sortErr } = await supabase
  .from('ac_figures').select('id, label, sort_order').eq('ac_id', ac.id).in('label', ['Figure 3-14', 'Figure 3-19'])
if (sortErr) { console.error(sortErr); process.exit(1) }
const fig314 = anchorRows.find(r => r.label === 'Figure 3-14')
console.log('Figure 3-14 sort_order:', fig314?.sort_order)

const BASE_SORT = fig314.sort_order + 1
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', BASE_SORT).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 2 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 2 sort_order.`)

for (const [label, caption, page, sortOrder] of [
  ['Figure 3-15', 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS. 24, 27 FOR VFR CONDITIONS.', 34, BASE_SORT],
  ['Figure 3-17', 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS. 28, 82, 97 FOR VFR CONDITIONS.', 35, BASE_SORT + 1],
]) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const fname = `150_5060-5/${slug}.png`
  const pagePath = path.resolve(`scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_0${page}.png`)
  const pngBytes = fs.readFileSync(pagePath)
  const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
    method: 'PUT', body: pngBytes,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
  })
  if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
  const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

  const { error: insErr } = await supabase.from('ac_figures').insert({
    ac_id: ac.id, label, caption, page, image_url: imageUrl, sort_order: sortOrder,
  })
  if (insErr) { console.error(`insert failed for ${label}`, insErr); process.exit(1) }
  console.log(`Inserted ${label} (page ${page}).`)
}
