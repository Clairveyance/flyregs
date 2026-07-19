// Hand-transcribe AC 150/5060-5 page 33 (0 chars in the original Vision batch,
// same failure mode as page 28/84 -- confirmed via /tmp/vision_batch_run3.log).
// Contains Figure 3-13 and Figure 3-14. Several Exit Factor / Touch & Go table
// cells are genuinely illegible on this specific page's scan (poor print
// quality, one cell obscured by an ink mark) -- marked [illegible] rather
// than guessed.
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
const ANCHOR = 'Chap 3                                                                        27\n\n\n\n12/1/95\t\t\t\t\tAC 150/5060-5 CHG 2'
const insertion = fs.readFileSync(path.resolve(process.argv[2]), 'utf8').replace(/\n$/, '')

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(ANCHOR).length - 1
if (count !== 1) { console.error(`ABORT: expected 1 occurrence of anchor, found ${count}`); process.exit(1) }

const replacement = 'Chap 3                                                                        27\n\n\n\n' + insertion + '\n\n12/1/95\t\t\t\t\tAC 150/5060-5 CHG 2'
const newText = ac.pdf_text.replace(ANCHOR, replacement)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('pdf_text update failed', updErr); process.exit(1) }
console.log(`Inserted page 33 transcription (${insertion.length} chars) into pdf_text.`)

const { data: anchorRows, error: sortErr } = await supabase
  .from('ac_figures').select('id, label, sort_order').eq('ac_id', ac.id).in('label', ['Figure 3-12', 'Figure 3-19'])
if (sortErr) { console.error(sortErr); process.exit(1) }
const fig312 = anchorRows.find(r => r.label === 'Figure 3-12')
console.log('Figure 3-12 sort_order:', fig312?.sort_order)

const BASE_SORT = fig312.sort_order + 1
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', BASE_SORT).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 2 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 2 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_033.png')
const pngBytes = fs.readFileSync(pagePath)

for (const [label, caption, sortOrder] of [
  ['Figure 3-13', 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS. 18, 21, 22 FOR VFR CONDITIONS.', BASE_SORT],
  ['Figure 3-14', 'HOURLY CAPACITY OF RUNWAY-USE DIAGRAM NOS. 19, 23, 77, 78, 92, 93 FOR VFR CONDITIONS.', BASE_SORT + 1],
]) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const fname = `150_5060-5/${slug}.png`
  const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
    method: 'PUT', body: pngBytes,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
  })
  if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
  const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

  const { error: insErr } = await supabase.from('ac_figures').insert({
    ac_id: ac.id, label, caption, page: 33, image_url: imageUrl, sort_order: sortOrder,
  })
  if (insErr) { console.error(`insert failed for ${label}`, insErr); process.exit(1) }
  console.log(`Inserted ${label} (page 33).`)
}
