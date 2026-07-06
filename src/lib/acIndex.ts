/**
 * Local AC index — downloads all AC metadata once per day and caches it in
 * AsyncStorage. Lets search return instant local results while the full-text
 * RPC is in-flight, and skips the RPC entirely for AC-number queries.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'

const CACHE_KEY = '@flyregs/ac-index'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface ACIndexEntry {
  id: string
  document_number: string
  title: string
  subject_series: string | null
  date_issued: string | null
  description: string | null
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
    .select('id, document_number, title, subject_series, date_issued, description')
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
