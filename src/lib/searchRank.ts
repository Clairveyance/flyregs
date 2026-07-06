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

export interface RankableResult {
  document_number: string
  title?: string | null
}

// Loosen whitespace/case so "weight and balance" matches a title stored as
// "Weight and Balance" — and ignore a trailing period a title might carry.
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/\.$/, '').trim()

export function rankSearchResults<T extends RankableResult>(query: string, results: T[]): T[] {
  const q = query.toLowerCase().trim()
  const nq = norm(query)
  const terms = q.split(/\s+/).filter(Boolean)

  const scored = results.map((item, idx) => {
    const num = item.document_number.toLowerCase()
    const title = (item.title ?? '').toLowerCase()

    let tier: number
    let titleHits = 0
    if (num === q || norm(item.document_number) === nq || norm(item.title ?? '') === nq) {
      tier = 0 // exact AC-number or exact-title match
    } else if (num.startsWith(q)) {
      tier = 1
    } else if (num.includes(q)) {
      tier = 2
    } else {
      titleHits = terms.filter((t) => title.includes(t)).length
      if (titleHits === terms.length) tier = 3
      else if (titleHits > 0) tier = 4
      else tier = 5
    }
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
