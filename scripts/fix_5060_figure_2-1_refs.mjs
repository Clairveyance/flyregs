// Fix 3 inline body-prose references to "figure 2-l" (lowercase L standing in
// for digit 1) in AC 150/5060-5's pdf_text, found via a broader scan after
// fixing the figure's own caption (Figure 2-I -> Figure 2-1). These occur in
// paragraph 2-2, 2-3, and Table 2-1's own caption text -- left uncorrected,
// Table 2-1's caption ("Assumptions incorporated in figure 2-l") would keep
// showing the OCR artifact to users even though the actual Figure 2-1 caption
// is now fixed.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '150/5060-5'
const FROM = 'figure 2-l'
const TO = 'figure 2-1'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(FROM).length - 1
if (count !== 3) { console.error(`ABORT: expected exactly 3 occurrences, found ${count}`); process.exit(1) }
const newText = ac.pdf_text.split(FROM).join(TO)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('update failed', updErr); process.exit(1) }
console.log(`Patched pdf_text: replaced ${count} occurrence(s) of "${FROM}" -> "${TO}"`)

// Table 2-1's own ac_figures.caption field was extracted from the same source text
const { data: figRows, error: figErr } = await supabase.from('ac_figures').select('id, caption').eq('ac_id', ac.id).eq('label', 'Table 2-1')
if (figErr) { console.error(figErr); process.exit(1) }
for (const row of figRows) {
  if (row.caption && row.caption.includes(FROM)) {
    const { error } = await supabase.from('ac_figures').update({ caption: row.caption.replace(FROM, TO) }).eq('id', row.id)
    if (error) { console.error('caption update failed', error); process.exit(1) }
    console.log(`Patched ac_figures caption for Table 2-1 (id ${row.id})`)
  }
}
