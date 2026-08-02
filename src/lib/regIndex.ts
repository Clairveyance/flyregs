import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'

// FAR/AIM/AD/P-CG equivalents of acIndex.ts's own AC auto-link index --
// same "cache a lightweight local index, detect candidates by regex, only
// keep ones that exactly match a real entry" pattern, generalized past
// AC-only per the standing ask (Notes auto-chip/hyperlink previously only
// ever worked for AC numbers, confirmed live -- typing a FAR or AD number
// into a note did nothing).

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

// PostgREST caps an unfiltered .select() at 1000 rows with no error (see
// memory/gotcha_postgrest_1000_row_cap.md -- already bit far/index.tsx's AC
// count, pcg/[id].tsx's sibling-nav query, and refPackets.ts's own doc-code
// fetch). far_sections (4272 rows) and pcg_terms (1332 rows) both cross the
// cap; aim_paragraphs (438) and airworthiness_directives don't individually
// but this is used for all four for consistency. Confirmed live: without
// this, "91.3" silently never chipped since the unpaginated fetch's default
// ordering put it past row 1000.
async function fetchAllRowObjects(table: string, select: string): Promise<any[]> {
  const out: any[] = []
  const page = 1000
  let start = 0
  while (true) {
    const { data, error } = await supabase.from(table).select(select).range(start, start + page - 1)
    if (error) break
    const rows = (data ?? []) as any[]
    out.push(...rows)
    if (rows.length < page) break
    start += page
  }
  return out
}

async function fetchAllRows<T>(table: string, column: string): Promise<T[]> {
  const rows = await fetchAllRowObjects(table, column)
  return rows.map((r) => r[column] as T)
}

async function cachedIndex<T>(cacheKey: string, fetcher: () => Promise<T[]>): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey)
    if (raw) {
      const { entries, ts } = JSON.parse(raw) as { entries: T[]; ts: number }
      if (Date.now() - ts < CACHE_TTL_MS && Array.isArray(entries) && entries.length > 0) {
        return entries
      }
    }
  } catch {}
  const entries = await fetcher()
  AsyncStorage.setItem(cacheKey, JSON.stringify({ entries, ts: Date.now() })).catch(() => {})
  return entries
}

// ─── FAR ─────────────────────────────────────────────────────────────────

let _farIndex: string[] | null = null
export async function getFarIndex(): Promise<string[]> {
  if (_farIndex) return _farIndex
  _farIndex = await cachedIndex('@flyregs/far-index-v2', () => fetchAllRows<string>('far_sections', 'section_number'))
  return _farIndex
}

// "91.3", "61.98a" -- most sections are digits.digits, a handful carry a
// single trailing revision letter ("121.344a"). Exact-match validated
// against the real index below, so a stray "3.14" in a note only chips if
// "3.14" happens to actually be a real FAR section (it isn't).
const FAR_PATTERN = /\b(\d{1,3}\.\d{1,4}[a-z]?)\b/gi
export function detectFARs(text: string, index: string[]): string[] {
  if (index.length === 0) return []
  const set = new Set(index.map((s) => s.toLowerCase()))
  const candidates = [...text.matchAll(FAR_PATTERN)].map((m) => m[1])
  const found = candidates.filter((c) => set.has(c.toLowerCase()))
  return [...new Set(found)]
}

// ─── AIM ─────────────────────────────────────────────────────────────────

let _aimIndex: string[] | null = null
export async function getAimIndex(): Promise<string[]> {
  if (_aimIndex) return _aimIndex
  _aimIndex = await cachedIndex('@flyregs/aim-index-v1', () => fetchAllRows<string>('aim_paragraphs', 'paragraph_number'))
  return _aimIndex
}

// "4-3-13", "1-1-1" -- AIM paragraph numbers are always exactly 3 dash-
// separated groups. Distinct enough from FAR's dot-separated format and
// from AD's 4-2-2-digit date shape that the same free-text scan can't
// confuse them.
const AIM_PATTERN = /\b(\d{1,2}-\d{1,2}-\d{1,3})\b/g
export function detectAIMs(text: string, index: string[]): string[] {
  if (index.length === 0) return []
  const set = new Set(index)
  const candidates = [...text.matchAll(AIM_PATTERN)].map((m) => m[1])
  const found = candidates.filter((c) => set.has(c))
  return [...new Set(found)]
}

// ─── AD ──────────────────────────────────────────────────────────────────

let _adIndex: string[] | null = null
export async function getAdIndex(): Promise<string[]> {
  if (_adIndex) return _adIndex
  _adIndex = await cachedIndex('@flyregs/ad-index-v1', () => fetchAllRows<string>('airworthiness_directives', 'ad_number'))
  return _adIndex
}

// "2018-02-04" -- AD numbers are always YYYY-NN-NN, which also happens to
// look exactly like a calendar date written in a note ("meeting on
// 2026-08-01"). Exact-match validation against real AD numbers is the only
// real defense here -- a note date that happens to collide with a real AD
// number is a rare, accepted false positive, same tradeoff AC's own
// revision-letter matching already makes.
const AD_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/g
export function detectADs(text: string, index: string[]): string[] {
  if (index.length === 0) return []
  const set = new Set(index)
  const candidates = [...text.matchAll(AD_PATTERN)].map((m) => m[1])
  const found = candidates.filter((c) => set.has(c))
  return [...new Set(found)]
}

// ─── P/CG ────────────────────────────────────────────────────────────────

export interface PcgIndexEntry { slug: string; term: string }

let _pcgIndex: PcgIndexEntry[] | null = null
export async function getPcgIndex(): Promise<PcgIndexEntry[]> {
  if (_pcgIndex) return _pcgIndex
  _pcgIndex = await cachedIndex('@flyregs/pcg-index-v2', async () => (await fetchAllRowObjects('pcg_terms', 'slug, term')) as PcgIndexEntry[])
  return _pcgIndex
}

// P/CG has no number to anchor on -- the term itself IS the identifier
// ("ABEAM", "LIGHT GUN"), which makes free-text detection much riskier
// than the number-based types above: short/common terms would chip
// constantly on unrelated text (the catalog has a real term literally
// named "AC", which would match inside "the AC I read" on every note).
// Restricted to terms of at least 5 characters, matched as a whole word/
// phrase (word-boundary on both ends) case-insensitively -- cuts out the
// short-acronym false-positive risk while still catching genuine term
// mentions ("...per the definition of AIRMET...").
export function detectPCGs(text: string, index: PcgIndexEntry[]): PcgIndexEntry[] {
  if (index.length === 0) return []
  const found: PcgIndexEntry[] = []
  const lowerText = text.toLowerCase()
  for (const entry of index) {
    if (entry.term.length < 5) continue
    const escaped = entry.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b`, 'i')
    if (re.test(lowerText)) found.push(entry)
  }
  return found
}
