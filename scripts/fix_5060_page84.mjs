// Hand-transcribe AC 150/5060-5 page 84 (0 chars in the original Vision batch,
// confirmed via /tmp/vision_batch_run3.log -- same class of miss as page 28/33).
// Contains Figure 4-1, the master runway-use-diagram-to-figure-number lookup
// table referenced repeatedly throughout Chapter 4 ("select the runway-use
// configuration in figure 4-1 which best represents the airport..."). The
// source table itself has genuinely overlapping/degraded print in several
// cells (confirmed by direct image inspection) -- marked [illegible] rather
// than guessed. Verified true page adjacency directly via the rendered page
// images (083=internal pg 79, 084=internal pg 80/this page, 085=internal pg 81
// with the confirmed Figure 4-2/4-3/4-4/4-5 captions) before picking the anchor.
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
const ANCHOR = '2300 feet\n\nChap 4\nPara 4-6                                                          79\n\n\n\n9/23/83'
const insertion = fs.readFileSync(path.resolve(process.argv[2]), 'utf8').replace(/\n$/, '')

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(ANCHOR).length - 1
if (count !== 1) { console.error(`ABORT: expected 1 occurrence of anchor, found ${count}`); process.exit(1) }

const replacement = '2300 feet\n\nChap 4\nPara 4-6                                                          79\n\n\n\n' + insertion + '\n\n9/23/83'
const newText = ac.pdf_text.replace(ANCHOR, replacement)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('pdf_text update failed', updErr); process.exit(1) }
console.log(`Inserted page 84 transcription (${insertion.length} chars) into pdf_text.`)

const { data: anchorRows, error: sortErr } = await supabase
  .from('ac_figures').select('id, label, sort_order').eq('ac_id', ac.id).in('label', ['Figure 4-2'])
if (sortErr) { console.error(sortErr); process.exit(1) }
const fig42 = anchorRows.find(r => r.label === 'Figure 4-2')
console.log('Figure 4-2 sort_order:', fig42?.sort_order)

const BASE_SORT = fig42.sort_order
const { data: toShift, error: shiftErr } = await supabase
  .from('ac_figures').select('id, sort_order').eq('ac_id', ac.id).gte('sort_order', BASE_SORT).order('sort_order', { ascending: false })
if (shiftErr) { console.error(shiftErr); process.exit(1) }
for (const row of toShift) {
  const { error } = await supabase.from('ac_figures').update({ sort_order: row.sort_order + 1 }).eq('id', row.id)
  if (error) { console.error(`shift failed for ${row.id}`, error); process.exit(1) }
}
console.log(`Shifted ${toShift.length} row(s) up by 1 sort_order.`)

const pagePath = path.resolve('scratch/ocr_rebuild_with_figures/150_5060-5/pages/page_084.png')
const pngBytes = fs.readFileSync(pagePath)
const fname = `150_5060-5/figure-4-1.png`
const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
  method: 'PUT', body: pngBytes,
  headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
})
if (!uploadResp.ok) { console.error('upload failed', await uploadResp.text()); process.exit(1) }
const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

const { error: insErr } = await supabase.from('ac_figures').insert({
  ac_id: ac.id, label: 'Figure 4-1', caption: 'Special applications', page: 84, image_url: imageUrl, sort_order: BASE_SORT,
})
if (insErr) { console.error('insert failed', insErr); process.exit(1) }
console.log('Inserted Figure 4-1 (page 84).')
