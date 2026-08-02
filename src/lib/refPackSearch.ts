import { supabase } from '@/lib/supabase'
import { searchOtherSources, type UnifiedResult } from '@/lib/unifiedSearch'
import { expandQuery } from '@/lib/searchSynonyms'
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

/** The FAR parts an ACS task actually cites, from its own references_text.
 *
 * The ACS names them explicitly — "14 CFR parts 61, 68, 91, 119.1(e)" — and
 * none of it was being used, so the topic search was a bare keyword match on
 * the task title. Observed on Commercial Pilot Task I.A "Pilot
 * Qualifications": the top hits were § 91.1089 (fractional-ownership check
 * pilots) and § 135.23 (air carrier manual contents), both matching only the
 * word "qualifications", while Part 61's actual eligibility sections were
 * nowhere. Constraining to the cited parts drops the Part 135 result outright.
 *
 * Handles "part 61", "parts 61, 68, 91", and "119.1(e)" (part 119).
 */
export function citedFarParts(referencesText?: string | null): string[] {
  if (!referencesText) return []
  const parts = new Set<string>()
  // "14 CFR part(s) 61, 68, 91, 119.1(e)" — take the whole run after the
  // keyword, then pull every leading part number out of it.
  const re = /14\s*CFR\s*parts?\s+([0-9;,.\s()a-z-]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(referencesText)) !== null) {
    for (const tok of m[1].split(/[,;]/)) {
      const n = tok.trim().match(/^(\d{1,3})/)
      if (n) parts.add(n[1])
    }
  }
  return [...parts]
}

/** ACs the ACS task names outright ("AC 68-1"), which are exact citations
 * rather than search guesses and belong at the top of the AC group. */
export function citedAcNumbers(referencesText?: string | null): string[] {
  if (!referencesText) return []
  return [...new Set(
    [...referencesText.matchAll(/\bAC\s+(\d[\w.\/-]*)/gi)].map((m) => m[1].replace(/[.,;]$/, ''))
  )]
}

export async function searchRefPackTopic(
  query: string,
  limitPerType = 5,
  referencesText?: string | null,
): Promise<RefPackSearchGroup[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) return []

  // Everyday-language expansion (SmartSearch) -- this search bar previously
  // ran a bare literal-keyword query with none of the bridge/corpus-
  // association/morphology expansion the main Search tab has had for a
  // while, a real inconsistency confirmed live (RC asked directly whether
  // this field is "SS capable" -- it wasn't). Same pattern as
  // (tabs)/index.tsx: expand once, search the literal query and every
  // expansion term, merge with first-seen-wins so the literal query's own
  // hits are never buried behind a synonym's.
  const expansion = await expandQuery(trimmed)
  const searchTerms = [trimmed, ...expansion.terms]
  const [otherResultSets, acResults] = await Promise.all([
    Promise.all(searchTerms.map((t) => searchOtherSources(t, limitPerType * 3))),
    searchAcs(trimmed, limitPerType),
  ])
  const seenOther = new Set<string>()
  const otherResults: UnifiedResult[] = []
  for (const set of otherResultSets) {
    for (const r of set) {
      const key = `${r.type}-${r.id}`
      if (!seenOther.has(key)) { seenOther.add(key); otherResults.push(r) }
    }
  }

  const farParts = citedFarParts(referencesText)
  const namedAcs = citedAcNumbers(referencesText)

  let far = otherResults.filter((r) => r.type === 'far').map(fromUnified)
  if (farParts.length) {
    // Keep only sections in the parts the ACS itself cites. If that filters
    // everything out the task's own references are unusable for this query,
    // so fall back rather than showing an empty group.
    const inCited = far.filter((r) => farParts.includes(String(r.id).split('.')[0]))
    if (inCited.length) far = inCited

    // Then rank by the ORDER the ACS lists its parts in. The FAA writes the
    // governing part first — Task I.A "Pilot Qualifications" cites
    // "14 CFR parts 61, 68, 91, 119.1(e)", and Part 61 is where a commercial
    // applicant's eligibility actually lives. Without this, the plain
    // keyword score still floated § 91.1089 (fractional-ownership check
    // pilots) above Part 61 purely on the word "qualifications".
    // Ranks are small keyword scores, so a per-position step of 10 dominates
    // them while preserving keyword order WITHIN a part.
    for (const r of far) {
      const idx = farParts.indexOf(String(r.id).split('.')[0])
      if (idx >= 0) r.rank += (farParts.length - idx) * 10
    }
    far.sort((a, b) => b.rank - a.rank)
  }
  far = far.slice(0, limitPerType)

  const flat: RefPackSearchResult[] = [
    ...far,
    ...otherResults.filter((r) => r.type === 'aim' || r.type === 'pcg').map(fromUnified).slice(0, limitPerType * 2),
    ...acResults,
  ]

  // Pin the explicitly-cited ACs above keyword hits.
  if (namedAcs.length) {
    for (const r of flat) {
      if (r.type === 'ac' && namedAcs.some((n) => String(r.id).toUpperCase().startsWith(n.toUpperCase()))) {
        r.rank += 1000
      }
    }
  }

  // AC's Postgres tsquery degrades gracefully instead of returning nothing
  // when the query's real subject has zero genuine matches -- confirmed
  // live, ACS Task "Chandelles (ASEL, ASES)" (no AC covers this maneuver at
  // all; its own references_text cites only handbooks): search_acs()
  // returned 10 completely unrelated ACs (Sport Pilot certification,
  // RVSM airspace, a bilateral Canada agreement) at rank 0.04-0.13,
  // presented with no visual distinction from a real match. Calibrated
  // against known-good matches for other maneuver-type tasks ("stall" ->
  // 0.72, "steep turns" -> as low as 0.176 for a genuinely relevant but
  // secondary AC) -- 0.15 sits cleanly between the false positives above
  // and the weakest real match below. Applied AFTER the citation-pin boost
  // above so an AC the task's own references_text actually names is never
  // filtered just because it keyword-matches the query poorly -- an
  // authoritative citation, not a guess, doesn't need to clear this bar.
  const MIN_AC_RANK = 0.15
  const filtered = flat.filter((r) => r.type !== 'ac' || r.rank >= MIN_AC_RANK)

  const order: RegType[] = ['far', 'aim', 'ac', 'pcg']
  const groups: RefPackSearchGroup[] = order
    .map((type) => ({ type, results: filtered.filter((r) => r.type === type).sort((a, b) => b.rank - a.rank) }))
    .filter((g) => g.results.length > 0)

  return groups
}
