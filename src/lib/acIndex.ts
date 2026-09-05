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

  // advisory_circulars_gated, not the raw table -- `authenticated` has no
  // column-level SELECT grant on changed_block_indices, so this 403'd every
  // time (falls into the `error || !data` branch below, returning [] --
  // the local AC index was silently empty this whole time, degrading every
  // AC-number search to the full RPC path with no instant local results).
  // Found live, 2026-08-23 QA sweep; see series/[prefix].tsx's fix for the
  // full repro.
  const { data, error } = await supabase
    .from('advisory_circulars_gated')
    .select('id, document_number, title, subject_series, date_issued, description, cancels, changed_block_indices')
    .eq('status', 'active')
    .order('document_number')

  if (error || !data) return []
  const entries = data as ACIndexEntry[]
  _index = entries
  AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ entries, ts: Date.now() })).catch(() => {})
  return entries
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
