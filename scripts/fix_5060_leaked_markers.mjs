// Strip 5 leaked "===TRANSCRIPTION===" prompt-delimiter artifacts from AC
// 150/5060-5's pdf_text -- these are internal parsing markers from
// llm_rebuild_with_figures.py's prompt format that should never reach real
// output; found via a corpus-wide grep, isolated to this one doc. Each is a
// standalone line, always followed by the next page's real header text.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '150/5060-5'
const MARKER = '===TRANSCRIPTION===\n'

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

const count = ac.pdf_text.split(MARKER).length - 1
if (count !== 5) { console.error(`ABORT: expected 5 occurrences, found ${count}`); process.exit(1) }
const newText = ac.pdf_text.split(MARKER).join('')
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', ac.id)
if (updErr) { console.error('update failed', updErr); process.exit(1) }
console.log(`Stripped ${count} leaked "===TRANSCRIPTION===" marker(s) from pdf_text.`)
