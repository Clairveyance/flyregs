import { supabase } from '@/lib/supabase'
import type { KnowledgeLevel } from '@/lib/challenges'

// Ref Packets are FlyRegs' curated certificate/rating study-and-reference
// guides -- built directly from the FAA's own ACS/PTS documents (see
// sync/acs_scraper.py), not a third-party book's compiled list. Each
// acs_documents row IS a packet (one certificate/rating), already carrying
// its own Area of Operation > Task > Knowledge/Risk/Skill structure, so no
// separate packet-definition table is needed for v1 -- the ACS data model
// already shaped exactly like a Ref Packet.

export interface RefPacket {
  code: string
  title: string
  slug: string
  docType: string
  category: 'Airplane' | 'Rotorcraft' | 'Powered-Lift' | 'Other'
  areaCount: number
  taskCount: number
}

export interface RefPacketArea {
  areaNumber: string
  title: string
  tasks: RefPacketTaskSummary[]
}

export interface RefPacketTaskSummary {
  id: string
  taskLetter: string
  title: string
}

export interface RefPacketTask {
  id: string
  docCode: string
  docTitle: string
  areaNumber: string
  areaTitle: string
  taskLetter: string
  title: string
  objective: string | null
  referencesText: string | null
  knowledge: RefPacketElement[]
  riskManagement: RefPacketElement[]
  skills: RefPacketElement[]
  // PTS documents predate ACS's Knowledge/Risk Management/Skill split --
  // their outline is one flat numbered list covering all three at once,
  // with no way to tell which item is which (see sync/pts_topics_backfill.py).
  // Kept as its own group rather than forced into a K/R/S bucket, which
  // would misrepresent the source document.
  topics: RefPacketElement[]
}

export interface RefPacketElement {
  code: string
  bodyText: string
}

// Multi-category source PDFs (sync/pts_multisection_scraper.py) split into
// one acs_documents row per section, title suffixed " — <label>" where
// label is either a real detected category (from an "Addition of a/an X
// Rating" marker in the source) or a generic "Section N" fallback --
// confirmed live: only doc_type='pts' rows are ever split this way, never
// 'acs' (whose own trailing "-N" in some codes, e.g. FAA-S-ACS-12, is that
// document's own sequential number in the modern ACS numbering scheme, NOT
// a section suffix -- grouping on code pattern would wrongly conflate the
// two, so this only ever looks at the title's own " — " marker).
export function splitPacketTitle(title: string): { mainTitle: string; suffix: string | null } {
  const base = title.replace(/ ACS$/, '')
  const dashIdx = base.lastIndexOf(' — ')
  return {
    mainTitle: dashIdx > -1 ? base.slice(0, dashIdx) : base,
    suffix: dashIdx > -1 ? base.slice(dashIdx + 3) : null,
  }
}

// RefPack title -> knowledge-level (see far_knowledge_levels() in the DB,
// mirrored client-side as challenges.ts's KnowledgeLevel), so a "Study This
// Rating" button on the pack can jump straight into a correctly-scoped
// Study Mode session instead of the user re-selecting the same level by
// hand. Deliberately returns null (no pre-filter, defaults to ALL levels)
// for certs that don't map onto the 6-level taxonomy at all (Aircraft
// Dispatcher, Parachute Rigger, Flight Engineer, Remote Pilot/Part 107,
// bare Instrument Rating docs) rather than guessing -- same "don't be
// wrong, be honest about limits" rule as the FAR-part classification.
export function refPackKnowledgeLevel(title: string): KnowledgeLevel | null {
  if (/aviation mechanic/i.test(title)) return 'mechanic'
  if (/flight instructor/i.test(title)) return 'cfi'
  if (/airline transport pilot/i.test(title)) return 'atp'
  if (/commercial pilot/i.test(title)) return 'commercial'
  if (/private pilot/i.test(title)) return 'private'
  if (/recreational pilot|sport pilot/i.test(title)) return 'student'
  return null
}

// Title keywords -> category, since doc_type is 'acs'/'pts' for every row
// right now (not yet split by aircraft category) -- the title itself always
// names the category ("...for Airplane Category...", "...Rotorcraft Category
// Helicopter...", "...Powered-Lift Category...").
function categorize(title: string): RefPacket['category'] {
  if (/powered-lift/i.test(title)) return 'Powered-Lift'
  if (/rotorcraft|helicopter/i.test(title)) return 'Rotorcraft'
  if (/airplane/i.test(title)) return 'Airplane'
  return 'Other'
}

// PostgREST caps an unfiltered .select() at 1000 rows with no error --
// confirmed live: acs_tasks crossed 1000 rows once the PTS multi-section +
// edge-case docs loaded, and getRefPackets() silently started reporting
// "0 tasks" for whichever packs' rows fell outside the truncated window
// (Flight Instructor for Airplane Category among them) even though their
// real data was intact. Same class of bug already hit far/index.tsx's AC
// count and pcg/[id].tsx's sibling-nav query -- see memory/
// gotcha_postgrest_1000_row_cap.md. Paginate with .range() instead of a
// bare .select() for any table that can plausibly cross 1000 rows.
async function fetchAllDocCodes(table: string): Promise<string[]> {
  const out: string[] = []
  const page = 1000
  let start = 0
  while (true) {
    const { data, error } = await supabase.from(table).select('doc_code').range(start, start + page - 1)
    if (error) throw error
    const rows = (data ?? []) as { doc_code: string }[]
    out.push(...rows.map((r) => r.doc_code))
    if (rows.length < page) break
    start += page
  }
  return out
}

export async function getRefPackets(): Promise<RefPacket[]> {
  const [docsRes, areaDocCodes, taskDocCodes] = await Promise.all([
    supabase.from('acs_documents').select('code, title, slug, doc_type').order('title'),
    fetchAllDocCodes('acs_areas_of_operation'),
    fetchAllDocCodes('acs_tasks'),
  ])
  const docs = (docsRes.data ?? []) as { code: string; title: string; slug: string; doc_type: string }[]
  const areaCounts: Record<string, number> = {}
  for (const code of areaDocCodes) {
    areaCounts[code] = (areaCounts[code] ?? 0) + 1
  }
  const taskCounts: Record<string, number> = {}
  for (const code of taskDocCodes) {
    taskCounts[code] = (taskCounts[code] ?? 0) + 1
  }
  return docs.map((d) => ({
    code: d.code,
    title: d.title,
    slug: d.slug,
    docType: d.doc_type,
    category: categorize(d.title),
    areaCount: areaCounts[d.code] ?? 0,
    taskCount: taskCounts[d.code] ?? 0,
  }))
}

export async function getRefPacket(code: string): Promise<{ title: string; areas: RefPacketArea[] } | null> {
  const [docRes, areasRes, tasksRes] = await Promise.all([
    supabase.from('acs_documents').select('title').eq('code', code).single(),
    supabase.from('acs_areas_of_operation').select('area_number, title, sort_order').eq('doc_code', code).order('sort_order'),
    supabase.from('acs_tasks').select('id, area_number, task_letter, title, sort_order').eq('doc_code', code).order('sort_order'),
  ])
  if (!docRes.data) return null
  const areas = (areasRes.data ?? []) as { area_number: string; title: string }[]
  const tasks = (tasksRes.data ?? []) as { id: string; area_number: string; task_letter: string; title: string }[]
  return {
    title: (docRes.data as { title: string }).title,
    areas: areas.map((a) => ({
      areaNumber: a.area_number,
      title: a.title,
      tasks: tasks
        .filter((t) => t.area_number === a.area_number)
        .map((t) => ({ id: t.id, taskLetter: t.task_letter, title: t.title })),
    })),
  }
}

export async function getRefPacketTask(taskId: string): Promise<RefPacketTask | null> {
  const taskRes = await supabase.from('acs_tasks').select('id, doc_code, area_number, task_letter, title, objective, references_text').eq('id', taskId).single()
  if (!taskRes.data) return null
  const t = taskRes.data as {
    id: string; doc_code: string; area_number: string; task_letter: string
    title: string; objective: string | null; references_text: string | null
  }
  const [elementsRes, docRes, areaRes] = await Promise.all([
    supabase.from('acs_elements').select('element_code, element_type, body_text, sort_order').eq('task_id', taskId).order('sort_order'),
    supabase.from('acs_documents').select('title').eq('code', t.doc_code).single(),
    supabase.from('acs_areas_of_operation').select('title').eq('doc_code', t.doc_code).eq('area_number', t.area_number).single(),
  ])
  const elements = (elementsRes.data ?? []) as { element_code: string; element_type: string; body_text: string }[]
  const byType = (type: string) =>
    elements.filter((e) => e.element_type === type).map((e) => ({ code: e.element_code, bodyText: e.body_text }))
  return {
    id: t.id,
    docCode: t.doc_code,
    docTitle: docRes.data?.title ?? '',
    areaNumber: t.area_number,
    areaTitle: areaRes.data?.title ?? '',
    taskLetter: t.task_letter,
    title: t.title,
    objective: t.objective,
    referencesText: t.references_text,
    knowledge: byType('knowledge'),
    riskManagement: byType('risk_management'),
    skills: byType('skill'),
    topics: byType('topic'),
  }
}

