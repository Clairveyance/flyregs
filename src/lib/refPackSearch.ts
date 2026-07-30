import { supabase } from '@/lib/supabase'
import { searchOtherSources, type UnifiedResult } from '@/lib/unifiedSearch'
import type { RegType } from '@/lib/regTypes'

// Powers RefPacks' "guide me to the actual reg text" redesign ask: no
// per-task curated citations exist yet (see PROJECT_NOTES/
// flyregs_link_integrity_audit.md §19 for why -- ACS/PTS references_text
// only ever names document TYPES, e.g. "14 CFR part 91; AIM", never
// specific sections), so this is the live-search-based v1 the user chose
// over a paid extraction pass: search FAR/AIM/P-CG/AC (matching the same
// 4-type set Study Mode/Duels settled on -- AD/LOI don't fit a knowledge-
// test study context) and group the hits by reg body. AD/figures are
// stripped out of searchOtherSources' broader result set rather than
// duplicating its far/aim/pcg query logic here.

export interface RefPackSearchResult {
  type: RegType
  id: string
  route: string
  primary: string
  secondary: string
  rank: number
}

export interface RefPackSearchGroup {
  type: RegType
  results: RefPackSearchResult[]
}

async function searchAcs(query: string, limit: number): Promise<RefPackSearchResult[]> {
  const { data } = await supabase.rpc('search_acs', { query, result_limit: limit })
  // Route by document_number ("141-1B"), not the row's uuid -- fetchRegPreview's
  // 'ac' case looks documents up by an ilike on document_number, so a route
  // built from r.id silently resolved to nothing ("Not Found") for every AC
  // search hit. Confirmed live via RefPacks Task D.
  return (data ?? []).map((r: any) => ({
    type: 'ac' as const,
    id: r.document_number,
    route: `/ac/${r.document_number}`,
    primary: `AC ${r.document_number}${r.title ? ` — ${r.title}` : ''}`,
    secondary: r.description ?? '',
    rank: r.rank ?? 0,
  }))
}

function fromUnified(r: UnifiedResult): RefPackSearchResult {
  return {
    type: r.type as RegType,
    id: r.id,
    route: r.type === 'far' ? `/far/${r.id}` : r.type === 'aim' ? `/aim/${r.id}` : `/pcg/${r.id}`,
    primary: r.primary,
    secondary: r.secondary,
    rank: r.rank,
  }
}

export async function searchRefPackTopic(query: string, limitPerType = 5): Promise<RefPackSearchGroup[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  const [otherResults, acResults] = await Promise.all([
    searchOtherSources(trimmed, limitPerType),
    searchAcs(trimmed, limitPerType),
  ])

  const flat: RefPackSearchResult[] = [
    ...otherResults.filter((r) => r.type === 'far' || r.type === 'aim' || r.type === 'pcg').map(fromUnified),
    ...acResults,
  ]

  const order: RegType[] = ['far', 'aim', 'ac', 'pcg']
  const groups: RefPackSearchGroup[] = order
    .map((type) => ({ type, results: flat.filter((r) => r.type === type).sort((a, b) => b.rank - a.rank) }))
    .filter((g) => g.results.length > 0)

  return groups
}
