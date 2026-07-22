// AC 60-22 had ZERO ac_figures rows despite containing 7 real figures (a
// document that previously had 0 parsed content at all -- see
// llm_rebuild_ocr_docs.py / fix_60_22_blocked_pages.py / fix_60_22_split_columns.py
// for the text-recovery side of this fix).
//
// 3 of the 7 (Figures 1, 2, 5) are genuine box-and-arrow flowchart/graph
// diagrams -- their raw transcribed box-label text was dumped inline in
// pdf_text as if it were flowing prose, which also caused the parser to
// misread several of those box labels as spurious chapter headings
// (e.g. "PILOT AIRCRAFT ENVIRONMENT OPERATION", "RECOGNIZE CHANGE").
// This script removes that raw dump from pdf_text (replacing it with just
// the "FIGURE N. CAPTION" reference line, matching how every other figure
// in the app is represented) and adds a real ac_figures image row instead.
// Figures 3, 4, 6, 7 are plain text lists/tables with no graphic content and
// no parsing side effects -- they get an ac_figures row for consistency
// with how every other AC's figures/tables are presented, but their
// pdf_text needs no cleanup.
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import path from 'path'

const envPath = path.resolve(process.cwd(), '.env.scraper')
const env = fs.readFileSync(envPath, 'utf8')
const get = (k) => (env.match(new RegExp(`^\\s*(?:export\\s+)?${k}=(.+)$`, 'm')) || [])[1]?.trim()
const SUPABASE_URL = get('SUPABASE_URL')
const SERVICE_KEY = get('SUPABASE_SERVICE_KEY')
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const DOC = '60-22'
const PAGES_DIR = path.resolve('scratch/ocr_rebuild/60-22/pages')

const { data: ac, error: acErr } = await supabase.from('advisory_circulars').select('id, pdf_text').eq('document_number', DOC).single()
if (acErr || !ac) { console.error('AC not found', acErr); process.exit(1) }

// ── Step 1: clean up pdf_text for the 3 diagram figures ─────────────────────
const cleanups = [
  {
    from: `one's ADM skills.\n\n---\n\nPILOT     AIRCRAFT     ENVIRONMENT     OPERATION\n\nSITUATION\n\nCHANGE / EVENT OCCURS\n\nRECOGNIZE CHANGE\n\nSELECT RESPONSE TYPE\n\nSKILLS & PROCEDURES          HEADWORK REQUIRED\n\nINADEQUATE                              INADEQUATE\n\nMISHAPS!\n\nFIGURE 1. CONVENTIONAL DECISION MAKING PROCESS`,
    to: `one's ADM skills.\n\nFIGURE 1. CONVENTIONAL DECISION MAKING PROCESS`,
    label: 'Figure 1',
  },
  {
    from: `importance of attitudes in decision making, a\n\nPILOT    AIRCRAFT    ENVIRONMENT    MISSION\n\nSITUATION\n\nE                C\nV                H\nE                A\nN                N\nT                G\n                 E\n\nSKILLS &\nPROCEDURES\n\nSELECT\nRESPONSE            HEADWORK\nTYPE                 REQUIRED\n\nATTITUDE\nMANAGEMENT\n\nHEADWORK          CREW (If present)      STRESS\nRESPONSE          MANAGEMENT           MANAGEMENT\nPROCESS\n\nCRITIQUE\nACTIONS              RISK\n(Post-Situation)     MANAGEMENT\n\nFIGURE 2. AERONAUTICAL DECISION MAKING PROCESS`,
    to: `importance of attitudes in decision making, a\n\nFIGURE 2. AERONAUTICAL DECISION MAKING PROCESS`,
    label: 'Figure 2',
  },
  {
    from: `Chap 4\nPar 18\n\n17\n\nAC 60-22                                                                    12/13/91\n\nPILOT CAPABILITIES\n\nMARGIN OF\nSAFETY\n\nTASK\nREQUIREMENTS\n\nEFFORT\n\nPRE FLIGHT   HOVER   TAKE OFF   CRUISE   APPROACH & LANDING   HOVER\n\nTIME\n\nFIGURE 5.  THE MARGIN OF SAFETY`,
    to: `Chap 4\nPar 18\n\nFIGURE 5.  THE MARGIN OF SAFETY`,
    label: 'Figure 5',
  },
]

let text = ac.pdf_text
for (const { from, to, label } of cleanups) {
  const count = text.split(from).length - 1
  if (count !== 1) { console.error(`ABORT: expected exactly 1 occurrence for ${label}, found ${count}`); process.exit(1) }
  text = text.replace(from, to)
  console.log(`Cleaned raw diagram text for ${label}`)
}

const { error: updErr } = await supabase.from('advisory_circulars').update({ pdf_text: text }).eq('id', ac.id)
if (updErr) { console.error('pdf_text update failed', updErr); process.exit(1) }
console.log('pdf_text updated with cleaned figure references')

// ── Step 2: upload page images + insert ac_figures rows for all 7 figures ──
const FIGURES = [
  { page: 6, label: 'Figure 1', caption: 'CONVENTIONAL DECISION MAKING PROCESS' },
  { page: 7, label: 'Figure 2', caption: 'AERONAUTICAL DECISION MAKING PROCESS' },
  { page: 9, label: 'Figure 3', caption: 'SAMPLE SET OF RANK ORDERED ANSWERS' },
  { page: 15, label: 'Figure 4', caption: 'THE FIVE ANTIDOTES' },
  { page: 20, label: 'Figure 5', caption: 'THE MARGIN OF SAFETY' },
  { page: 22, label: 'Figure 6', caption: 'The DECIDE MODEL' },
  { page: 24, label: 'Figure 7', caption: 'The "I\'M SAFE" Checklist' },
]

let sortOrder = 1
for (const fig of FIGURES) {
  const pagePath = path.join(PAGES_DIR, `page_${String(fig.page).padStart(3, '0')}.png`)
  const pngBytes = fs.readFileSync(pagePath)
  const fname = `60-22/figure-${sortOrder}.png`
  const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/ac-figures/${fname}`, {
    method: 'PUT', body: pngBytes,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'image/png', 'x-upsert': 'true' },
  })
  if (!uploadResp.ok) { console.error(`upload failed for ${fig.label}`, await uploadResp.text()); process.exit(1) }
  const imageUrl = `${SUPABASE_URL}/storage/v1/object/public/ac-figures/${fname}`

  const { error: insErr } = await supabase.from('ac_figures').insert({
    ac_id: ac.id,
    label: fig.label,
    caption: fig.caption,
    page: fig.page,
    image_url: imageUrl,
    sort_order: sortOrder,
  })
  if (insErr) { console.error(`insert failed for ${fig.label}`, insErr); process.exit(1) }
  console.log(`Inserted ${fig.label} (page ${fig.page})`)
  sortOrder++
}

console.log(`\nDone. ${FIGURES.length} figures added, pdf_text cleaned for the 3 diagram figures.`)
