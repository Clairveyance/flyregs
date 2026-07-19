// Add the ac_figures row for AC 150/5060-5's "Figure 3-62" (page 57), which
// the Vision batch missed entirely -- it mis-transcribed the caption as a
// duplicate "FIGURE 3-52" (already fixed in pdf_text/fix_5060_pdf_text_labels.mjs)
// and only recorded one of the page's two figures (3-61) in ac_figures.
// Shifts every later sort_order up by 1 to make room, then inserts the new row
// using the same full-page-render image convention as the rest of the pipeline
// (each figure's image_url is the whole rendered page, not a crop).
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
const NEW_SORT_ORDER = 75

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', NEW_SORT_ORDER).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }

for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 1 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 1 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_057.png')
const pngBytes = fs.readFileSync(pagePath)
const fname = `150_5060-5/figure-3-62.png`
const uploadUrl = `${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`
const uploadResp = await fetch(uploadUrl, {
  method: 'PUT', body: pngBytes,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
})
if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

const { error: insErr } = await supabase.from('ac_figures').insert({
  ac_id: ac.id,
  label: 'Figure 3-62',
  caption: 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS.: 46,52,58 FOR IFR CONDITIONS.',
  page: 57,
  image_url: imageUrl,
  sort_order: NEW_SORT_ORDER,
})
if (insErr) { console.error('insert failed', insErr); process.exit(1) }
console.log('Inserted Figure 3-62 (page 57).')
