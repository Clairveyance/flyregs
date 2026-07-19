// Patch in the missing "Figure 3-2. Runway-use diagrams" caption line at the
// true end of page 27's content in pdf_text -- the Vision batch transcribed
// this page's table data (2639 chars) but omitted its own printed caption,
// which is why it was never flagged as a figure. Companion to
// fix_5060_figure_3-2.mjs (the ac_figures row).
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '150/5060-5'
const ANCHOR = '79 | NA | 3-12 | 5-16 |\n\n\n\nAC 150/5060-5'
const CAPTION = 'Figure 3-2.  Runway-use diagrams'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(ANCHOR).length - 1
if (count !== 1) { console.error(`ABORT: expected 1 occurrence of anchor, found ${count}`); process.exit(1) }

const replacement = `79 | NA | 3-12 | 5-16 |\n\n${CAPTION}\n\nAC 150/5060-5`
const newText = ac.pdf_text.replace(ANCHOR, replacement)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('update failed', updErr); process.exit(1) }
console.log('Inserted missing "Figure 3-2. Runway-use diagrams" caption into pdf_text.')
