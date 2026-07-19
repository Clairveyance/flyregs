// One-off: patch the AC 25.1357-1A pdf_text placeholder for page 6 (Appendix A,
// duplicated text of § 25.1357) with a hand-transcription. That page tripped
// the Vision pipeline's content-filter twice (benign circuit-protection
// language: "hazard", "malfunction", "fault", "distress" in FAA regulatory
// text) so llm_rebuild_with_figures.py inserted a placeholder instead.
// Does NOT touch pdf_blocks_version / changed_block_indices.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOC = '25.1357-1A'
const PLACEHOLDER = '[transcription failed for this page -- content filter or API error, needs manual re-run]'
const replacement = fs.readFileSync(path.resolve(process.argv[2]), 'utf8').replace(/\n$/, '')

const { data, error } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (error || !data) { console.error('fetch failed', error); process.exit(1) }

if (!data.pdf_text.includes(PLACEHOLDER)) {
  console.error('Placeholder not found in current pdf_text -- aborting, nothing changed.')
  process.exit(1)
}
const count = data.pdf_text.split(PLACEHOLDER).length - 1
if (count !== 1) {
  console.error(`Expected exactly 1 placeholder occurrence, found ${count} -- aborting.`)
  process.exit(1)
}

const newText = data.pdf_text.replace(PLACEHOLDER, replacement)
const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: newText }).eq('id', data.id)
if (updErr) { console.error('update failed', updErr); process.exit(1) }
console.log(`Patched pdf_text for ${DOC}: replaced placeholder with ${replacement.length} chars.`)
