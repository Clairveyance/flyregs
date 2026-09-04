// Returns true when the user wrapped the query in double-quotes ("exact phrase").
export function isPhrasedQuery(q: string): boolean {
  const t = q.trim()
  return t.length > 4 && t.startsWith('"') && t.endsWith('"')
}

// Strips outer double-quotes and trims inner whitespace.
export function extractPhrase(q: string): string {
  return q.trim().slice(1, -1).trim()
}

// Shared search-result ranking, used by both the Home quick-search dropdown and
// the Search tab so an AC-number query always surfaces the right AC first.
//
// Tiers (best first):
//   0 — EXACT match: AC number OR title equals the query (numbers or words)
//   1 — AC number starts with query ("91-7" → 91-71, 91-70… sorted numerically)
//   2 — AC number contains query (sorted numerically)
//   3 — all query words in title (full-text relevance order preserved)
//   4 — some query words in title (more matching terms first, then relevance)
//   5 — full-text body match only (relevance order preserved)
//
// An exact match — whether the user typed an AC number or the literal title — is
// always surfaced first. Within the AC-number tiers we sort NUMERICALLY (20-1,
// 20-2, 20-10 — not the DB's lexical 20-1, 20-10, 20-2) so close numbers read in
// natural order; this also fixes the lexical default where "120-27F" sorts above
// "20-27G" for "20-27".


// Words that carry no relevance signal in a spoken query. Without dropping
// them, a question like "do I need oxygen at 13000 feet" is scored on "do",
// "i", "need" and "at" as much as on "oxygen".
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
  'by', 'with', 'is', 'are', 'be', 'do', 'does', 'did', 'i', 'my', 'me',
  'can', 'may', 'must', 'need', 'needs', 'what', 'when', 'where', 'who',
  'why', 'how', 'if', 'it', 'this', 'that', 'you', 'your', 'have', 'has',
  'am', 'was', 'were', 'about', 'into', 'over', 'under', 'much', 'many',
])

/** Query terms worth scoring: no stopwords, nothing shorter than 3 chars
 * (except a pure number, which is often the whole point -- "8 hours"). */
function contentTerms(q: string): string[] {
  const all = q.split(/\s+/).filter(Boolean)
  // A single letter used to be dropped as noise (same as "a"/"i") -- but
  // aviation has real, meaning-carrying single-letter vocabulary: airspace
  // classes (A/B/C/D/E/G), among others. "class G airspace" scored only on
  // "class" and "airspace" -- the ONE word that says WHICH class was
  // silently discarded, so Class B/C/D sections (which share those same two
  // words) ranked exactly as well as anything about Class G specifically.
  // Safe to allow generally: "a" and "i", the only single-letter ENGLISH
  // stopwords, are already excluded by STOPWORDS above regardless of length.
  const kept = all.filter((w) => !STOPWORDS.has(w) && (w.length === 1 || w.length >= 3 || /^\d+$/.test(w)))
  // If a query is nothing BUT stopwords, fall back rather than score nothing.
  return kept.length > 0 ? kept : all
}

/** Whole-word containment. `t.includes(x)` counted "at" as a hit inside
 * "operations", "data" and "aviation", which inflated titleHits for
 * essentially every document and buried the one that actually matched. */
function wordInText(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text)
}

export interface RankableResult {
  document_number: string
  title?: string | null
}

// Loosen whitespace/case so "weight and balance" matches a title stored as
// "Weight and Balance" — and ignore a trailing period a title might carry.
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim()

// The tier calculation on its own, so the SAME relevance scale can be applied
// to non-AC results (FAR/AIM/P-CG/AD/figures) and the two can be merged into
// one ordered list. Previously the Home dropdown concatenated all AC hits
// ahead of all other hits, which read as "segregated by reg type" rather than
// ordered by relevance -- a body-text-only AC match outranked an exact FAR
// section-number match purely because of which pipeline produced it.
export function relevanceTier(query: string, identifier: string, title?: string | null): { tier: number; titleHits: number } {
  const q = query.toLowerCase().trim()
  const nq = norm(query)
  const terms = contentTerms(q)
  const num = (identifier ?? '').toLowerCase()
  const t = (title ?? '').toLowerCase()

  let tier: number
  let titleHits = 0
  if (num === q || norm(identifier ?? '') === nq || norm(title ?? '') === nq) {
    tier = 0
  } else if (num.startsWith(q)) {
    tier = 1
  } else if (num.includes(q)) {
    tier = 2
  } else {
    titleHits = terms.filter((x) => wordInText(t, x)).length
    if (terms.length > 0 && titleHits === terms.length) tier = 3
    else if (titleHits > 0) tier = 4
    else tier = 5
  }
  return { tier, titleHits }
}

export function rankSearchResults<T extends RankableResult>(query: string, results: T[]): T[] {
  const scored = results.map((item, idx) => {
    const { tier, titleHits } = relevanceTier(query, item.document_number, item.title)
    return { item, tier, idx, titleHits }
  })

  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.tier <= 2) {
      return a.item.document_number.localeCompare(
        b.item.document_number, undefined, { numeric: true, sensitivity: 'base' }
      )
    }
    if (a.tier === 3) return a.idx - b.idx
    if (a.tier === 4) return b.titleHits - a.titleHits || a.idx - b.idx
    return a.idx - b.idx
  })

  return scored.map(({ item }) => item)
}
