// Dump raw pdf_text for an AC to stdout for inspection
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const supabase = createClient(get('SUPABASE_URL'), get('SUPABASE_SERVICE_KEY'))

const doc = process.argv[2]
const startLine = parseInt(process.argv[3] || '1')
const numLines = parseInt(process.argv[4] || '100')

const { data } = await supabase
  .from('advisory_circulars')
  .select('pdf_text')
  .eq('document_number', doc)
  .single()

if (!data?.pdf_text) { console.log('No text'); process.exit(1) }

const lines = data.pdf_text.split('\n')
console.log(`Total lines: ${lines.length}`)
lines.slice(startLine - 1, startLine - 1 + numLines).forEach((l, i) =>
  console.log(`${String(startLine + i).padStart(5)}: ${l}`)
)
