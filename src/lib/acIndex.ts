/**
 * Local AC index — downloads all AC metadata once per day and caches it in
 * AsyncStorage. Lets search return instant local results while the full-text
 * RPC is in-flight, and skips the RPC entirely for AC-number queries.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'

const CACHE_KEY = '@flyregs/ac-index-v2'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface ACIndexEntry {
  id: string
  document_number: string
  title: string
  subject_series: string | null
  date_issued: string | null
  description: string | null
  cancels: string[]
  changed_block_indices: number[] | null
}

let _index: ACIndexEntry[] | null = null
let _pending: Promise<ACIndexEntry[]> | null = null

/** Returns the cached index, loading from AsyncStorage or Supabase as needed. */
export async function getACIndex(): Promise<ACIndexEntry[]> {
  if (_index) return _index
  if (_pending) return _pending
  _pending = _load().finally(() => { _pending = null })
  return _pending
}

async function _load(): Promise<ACIndexEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY)
    if (raw) {
      const { entries, ts } = JSON.parse(raw) as { entries: ACIndexEntry[]; ts: number }
      if (Date.now() - ts < CACHE_TTL_MS && Array.isArray(entries) && entries.length > 0) {
        _index = entries
        return entries
      }
    }
  } catch {}

  const { data, error } = await supabase
    .from('advisory_circulars')
    .select('id, document_number, title, subject_series, date_issued, description, cancels, changed_block_indices')
    .eq('status', 'active')
    .order('document_number')

  if (error || !data) return []
  const entries = data as ACIndexEntry[]
  _index = entries
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ entries, ts: Date.now() })).catch(() => {})
  return entries
}

/** Fast in-memory search over the local index. Returns up to 30 results. */
export function searchLocal(query: string, index: ACIndexEntry[]): ACIndexEntry[] {
  const q = query.toLowerCase().trim()
  if (q.length < 2 || index.length === 0) return []

  const words = q.split(/\s+/).filter((w) => w.length >= 2)
  const scored: { entry: ACIndexEntry; score: number }[] = []

  for (const entry of index) {
    const dn = entry.document_number.toLowerCase()
    const ti = entry.title.toLowerCase()
    const ds = (entry.description ?? '').toLowerCase()
    let score = 0

    if (dn === q)                                                    score = 100
    else if (dn.startsWith(q))                                       score = 90
    else if (dn.includes(q))                                         score = 72
    else if (ti === q)                                               score = 68
    else if (ti.startsWith(q))                                       score = 62
    else if (ti.includes(q))                                         score = 48
    else if (words.length > 1 && words.every((w) => ti.includes(w))) score = 38
    else if (ds.includes(q))                                         score = 24
    else if (words.length > 1 && words.every((w) => ds.includes(w))) score = 14

    if (score > 0) scored.push({ entry, score })
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((s) => s.entry)
}

/**
 * Returns true when the query looks like an AC number (starts with a digit).
 * For these, prefix/contains queries are sufficient; the full-text RPC adds nothing.
 */
export function isACQuery(query: string): boolean {
  return /^\d/.test(query.trim())
}

// ─── Note body AC auto-linking ──────────────────────────────────────────────
// Originally local to notes.tsx; moved here so any other read-only note view
// (e.g. the shared-folder collaborator view) can auto-link the same way
// instead of only ever seeing the single linked_ac field.

// Candidate shape only — e.g. "61-65K", "20-172", "135-17". Real ACs are
// validated afterwards against the live AC index so arbitrary number pairs
// (phone numbers, dates, ratios) never get linked.
const AC_PATTERN = /\b(\d{1,3}-\d{1,4}[A-Za-z]{0,2})\b/g

// A candidate is only a real AC reference when it's a *complete* number, not a
// truncation of a longer one. "120-9" is a literal string-prefix of "120-90",
// "120-92", etc., but those are different ACs — so a plain startsWith() check
// would wrongly link "120-9". We require the real document_number to either
// equal the candidate exactly, or continue with a revision letter (not another
// digit) right after it — that's what distinguishes "120-90" (which should
// match "120-90"/"120-90A"/...) from "120-9" (which should match nothing).
function isValidACCandidate(candidate: string, index: ACIndexEntry[]): boolean {
  const lc = candidate.toLowerCase()
  return index.some((e) => {
    const doc = e.document_number.toLowerCase()
    if (doc === lc) return true
    if (!doc.startsWith(lc)) return false
    const nextChar = doc[lc.length]
    return nextChar === undefined || !/[0-9]/.test(nextChar)
  })
}

export function detectACs(text: string, index: ACIndexEntry[]): string[] {
  if (index.length === 0) return []
  const candidates = [...text.matchAll(AC_PATTERN)].map((m) => m[1])
  const found = candidates.filter((c) => isValidACCandidate(c, index))
  return [...new Set(found)]
}
