// Scan ac_figures for the 17 docs just Vision-processed, flagging labels whose
// number looks out of sequence relative to neighboring rows on the same doc --
// a signal of the same I/1, S/5, l/1, O/0 character-confusion class of bug
// already found and fixed on AC 150/5060-5 (see fix_figure_mislabels.mjs).
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const DOCS = ['150/5060-5', '20-128A', '20-178', '21-24A', '23-2A', '25-12', '25-9A',
  '25.1357-1A', '25.1523-1', '25.807-1', '33-2C', '36-2C', '43-18', '437.73-1',
  '90-93B', '91-65', '91-81']

for (const doc of DOCS) {
  const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id').eq('document_number', doc).single()
  if (acErr || !ac) { console.log(`${doc}: AC not found`); continue }
  const { data: figs, error } = await supabase.from('ac_figures').select('label, page, sort_order').eq('ac_id', ac.id).order('sort_order')
  if (error) { console.log(`${doc}: query error`, error.message); continue }
  if (!figs || figs.length === 0) continue

  console.log(`\n=== ${doc} (${figs.length} figures) ===`)
  for (const f of figs) {
    console.log(`  page ${f.page}: ${f.label}`)
  }
}
