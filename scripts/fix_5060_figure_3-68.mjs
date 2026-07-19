// Fix AC 150/5060-5's third real gap, found via cross-referencing inline body
// prose ("Obtain values for G* and S from figure 3-68") against ac_figures --
// the gate-capacity chart on page 62 was transcribed as a duplicate "FIGURE
// 3-58" (an S/6 misread; a real, different Figure 3-58 already exists on
// page 55 covering runway-use diagrams) and never got its own ac_figures row.
// Same failure mode as Figure 3-62/3-26 (see add_missing_3-62.mjs).
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
const FROM = 'FIGURE 3-58. HOURLY CAPACITY OF GATES.'
const TO = 'FIGURE 3-68. HOURLY CAPACITY OF GATES.'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(FROM).length - 1
if (count !== 1) { console.error(`ABORT: expected 1 occurrence, found ${count}`); process.exit(1) }
const newText = ac.pdf_text.replace(FROM, TO)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('pdf_text update failed', updErr); process.exit(1) }
console.log('pdf_text patched: FIGURE 3-58 (Hourly Capacity of Gates) -> FIGURE 3-68')

const NEW_SORT_ORDER = 92
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', NEW_SORT_ORDER).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 1 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 1 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_062.png')
const pngBytes = fs.readFileSync(pagePath)
const fname = `150_5060-5/figure-3-68.png`
const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
  method: 'PUT', body: pngBytes,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
})
if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

const { error: insErr } = await supabase.from('ac_figures').insert({
  ac_id: ac.id,
  label: 'Figure 3-68',
  caption: 'HOURLY CAPACITY OF GATES.',
  page: 62,
  image_url: imageUrl,
  sort_order: NEW_SORT_ORDER,
})
if (insErr) { console.error('insert failed', insErr); process.exit(1) }
console.log('Inserted Figure 3-68 (page 62).')
