// Fix AC 150/5060-5's second real gap found by the duplicate-caption scan:
// page 39 has two figures (diagram 41 and diagram 42) but the Vision batch
// transcribed both captions as "FIGURE 3-25" instead of incrementing the
// second to "FIGURE 3-26" -- same failure mode as the Figure 3-62 case
// (see add_missing_3-62.mjs). Patches pdf_text and adds the missing
// ac_figures row.
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
const FROM = 'FIGURE 3-25. HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NO. 42 FOR VFR CONDITIONS.'
const TO = 'FIGURE 3-26. HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NO. 42 FOR VFR CONDITIONS.'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(FROM).length - 1
if (count !== 1) { console.error(`ABORT: expected 1 occurrence, found ${count}`); process.exit(1) }
const newText = ac.pdf_text.replace(FROM, TO)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('pdf_text update failed', updErr); process.exit(1) }
console.log('pdf_text patched: FIGURE 3-25 (diagram 42) -> FIGURE 3-26')

const NEW_SORT_ORDER = 30
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', NEW_SORT_ORDER).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 1 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 1 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_039.png')
const pngBytes = fs.readFileSync(pagePath)
const fname = `150_5060-5/figure-3-26.png`
const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
  method: 'PUT', body: pngBytes,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
})
if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

const { error: insErr } = await supabase.from('ac_figures').insert({
  ac_id: ac.id,
  label: 'Figure 3-26',
  caption: 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NO. 42 FOR VFR CONDITIONS.',
  page: 39,
  image_url: imageUrl,
  sort_order: NEW_SORT_ORDER,
})
if (insErr) { console.error('insert failed', insErr); process.exit(1) }
console.log('Inserted Figure 3-26 (page 39).')
