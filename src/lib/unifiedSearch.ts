import { supabase } from '@/lib/supabase'

// Cross-type search — FAR/AIM/P-CG/Figures & Tables, alongside (not
// replacing) the existing AC-specific search in (tabs)/index.tsx and
// search.tsx. Kept as its own module rather than folded into the existing
// AC search logic there: that logic is heavily tuned (dictation-duplicate
// handling, numeric-prefix tiering, phrase search, race guards) and none of
// those AC-number-specific rules generalize to a FAR section number, an
// AIM paragraph number, or a figure caption — safer to add a parallel path
// than to bend AC-specific logic to also cover four unrelated shapes.

// aim_scraper.py's synthetic paragraph_number for h4-less pages (the front-
// matter "Explanation of Changes" page and all 5 appendices — see the
// scraper's docstring for why those needed a fallback id) is a raw slug
// like "appendix_3" or "chap0_section_0". Fine as a route param, but reads
// as an internal implementation detail in a search result — confirmed live
// ("AIM appendix_3" showed up verbatim in a real search). Route id stays
// the raw slug; only the display string gets cleaned up.
function formatAimParagraphNumber(raw: string): string {
  const appendixMatch = raw.match(/^appendix_(\d+)$/)
  if (appendixMatch) return `Appendix ${appendixMatch[1]}`
  const chapterMatch = raw.match(/^chap(\d+)_section_\d+$/)
  if (chapterMatch) return `Ch. ${chapterMatch[1]}`
  return raw
}

export type UnifiedResultType = 'far' | 'aim' | 'pcg' | 'ad' | 'figure_ac' | 'figure_aim' | 'dictionary'

export interface UnifiedResult {
  type: UnifiedResultType
  id: string // route param — section_number / paragraph_number / slug / parent doc id
  primary: string // e.g. "§ 61.107", "4-1-1", "LIGHT GUN", "Table 1"
  secondary: string // title / caption / definition snippet
  rank: number
  /** True when a curated concept anchor matched this document for this
   * query (search_concept_anchors). It means "this document IS the answer
   * to the question that was asked", which is a stronger claim than any
   * lexical score, so the merge ranks it above everything else. */
  anchored?: boolean
  /** Which search term actually produced this hit — the literal query, or
   * one of the SmartSearch expansions. Ranking must score against THIS, not
   * only the raw query: a result found via the bridge term "alcohol" shares
   * no words with what the user typed ("flying drunk"), so scoring it
   * against the raw query alone dropped § 91.17 to the bottom. */
  matchedTerm?: string
  // Figure/table results only — lets the caller open the image directly
  // (FigureViewer) instead of navigating to the parent document first. See
  // routeForUnifiedResult()'s docstring for why that extra tap was real.
  // id matches the real ac_figures/aim_figures row id — same cache key
  // useCachedImage() would use via the normal detail-page path, so a
  // figure opened from search and one opened from its parent document
  // share one offline cache entry instead of two.
  figure?: { id: string; label: string | null; caption: string | null; image_url: string }
}

interface FarRow { section_number: string; part: string; title: string | null; out_rank: number; is_anchor?: boolean }
interface AimRow { paragraph_number: string; title: string | null; out_rank: number; is_anchor?: boolean }
interface PcgRow { slug: string; term: string; definition: string | null; out_rank: number }
interface DictRow { slug: string; term: string; definition: string | null; out_rank: number }
interface AdRow { ad_number: string; subject_heading: string; out_rank: number }
interface FigureRow {
  source_type: 'ac' | 'aim'
  figure_id: string
  parent_id: string
  parent_number: string | null
  parent_title: string | null
  label: string | null
  caption: string | null
  image_url: string
  out_rank: number
}

// Search T&Fs alongside documents — a figure/table's caption text (e.g.
// "AIR TRAFFIC CONTROL TOWER LIGHT GUN SIGNALS") is itself a first-class
// search target, not just something you stumble onto after opening a
// document. This is what makes "light gun signals" surface the actual
// signal-meanings table directly, not just the AIM paragraph that mentions it.
// `types`: when provided (non-empty), scopes which of far/aim/pcg get
// queried at all -- previously this ran unconditionally regardless of the
// Filter sheet's own content-type selection, confirmed live as a real bug
// ("filter for AIM, then start a search, it still gives you corpus wide
// results"). AD and figures aren't dimensions the Filter sheet offers at
// all (see FilterableType's own comment: "AD is deliberately excluded"),
// so both stay unscoped regardless of `types` -- there's no filter
// selection that could have meant "hide these," since the sheet never
// presented them as a choice.
// `types` undefined means unrestricted (search all three); an empty array
// is a real, explicit "none of these" (e.g. the Filter sheet is scoped to
// AC only) and must not be treated the same as undefined -- collapsing
// those two cases was the actual first draft of this fix and would have
// re-included far/aim/pcg any time the filter resolved to an empty subset.
export async function searchOtherSources(
  query: string,
  limitPerSource = 6,
  types?: ('far' | 'aim' | 'pcg')[],
  // RC, 2026-08-04: "ADs don't need to surface in free tier search" -- AD
  // body text has been Plus-gated with zero preview since the tier-boundary
  // pass (c440af8), so a free user hitting an AD from a general search only
  // ever reaches a locked page; keeping it out of Home's results entirely
  // is a cleaner free-tier experience than a result that just gates on tap.
  // Defaults true so every OTHER caller (RefPack task search, which is
  // already a Plus+-only area) is unaffected -- only Home's own call site
  // passes hasPlusAccess through.
  includeAd = true,
  // Same reasoning, same shape, added for the 2026-08-10 Dictionary re-gate
  // (base A/D moved from free to Plus, whole-screen lock, zero preview --
  // same "dead end at a lock screen" problem AD already had). Before this,
  // a free Home searcher saw a real-looking "A/D <TERM>" row (search_dictionary
  // still returns slug/term/rank for a gated caller, only `definition` nulls
  // out) that rendered with an effectively blank secondary line and led
  // straight to the new whole-screen Plus lock on tap.
  includeDictionary = true
): Promise<UnifiedResult[]> {
  const want = (t: 'far' | 'aim' | 'pcg') => types === undefined || types.includes(t)
  const empty = Promise.resolve({ data: [] as any[] })
  // Aviation Dictionary and figures aren't a dimension the Filter sheet
  // offers a chip for (see the comment above on `types`), so they always
  // search regardless of the far/aim/pcg scoping -- RC: "make sure our SS
  // is on top of it and smartly sorts and combines searches." AD is a
  // separate, tier-driven exclusion (see `includeAd` above), not tied to
  // that scoping either.
  const [farRes, aimRes, pcgRes, adRes, figRes, dictRes] = await Promise.all([
    want('far') ? supabase.rpc('search_far', { query, result_limit: limitPerSource }) : empty,
    want('aim') ? supabase.rpc('search_aim', { query, result_limit: limitPerSource }) : empty,
    want('pcg') ? supabase.rpc('search_pcg', { query, result_limit: limitPerSource }) : empty,
    includeAd ? supabase.rpc('search_ads', { query, result_limit: limitPerSource }) : empty,
    supabase.rpc('search_figures', { query, result_limit: limitPerSource }),
    includeDictionary ? supabase.rpc('search_dictionary', { query, result_limit: limitPerSource }) : empty,
  ])

  const results: UnifiedResult[] = []

  // Every result's `primary` string leads with its type — "FAR 91.107",
  // "AIM 4-3-13", "AIM Fig 2-1-12" — matching the clarity ACs already have
  // for free (an AC's own document_number, e.g. "90-67B", is self-
  // identifying). Nothing else here carries that built-in signal, and it
  // matters most for T&Fs specifically: a user searching for a visual
  // reference needs to know at a glance that a hit IS one, not text that
  // happens to mention the topic.
  for (const r of (farRes.data ?? []) as FarRow[]) {
    results.push({ type: 'far', id: r.section_number, primary: `FAR ${r.section_number}`, secondary: r.title ?? '', rank: r.out_rank, anchored: r.is_anchor === true })
  }
  for (const r of (aimRes.data ?? []) as AimRow[]) {
    results.push({ type: 'aim', id: r.paragraph_number, primary: `AIM ${formatAimParagraphNumber(r.paragraph_number)}`, secondary: r.title ?? '', rank: r.out_rank, anchored: r.is_anchor === true })
  }
  for (const r of (pcgRes.data ?? []) as PcgRow[]) {
    results.push({ type: 'pcg', id: r.slug, primary: `P/CG ${r.term}`, secondary: r.definition ?? '', rank: r.out_rank })
  }
  for (const r of (dictRes.data ?? []) as DictRow[]) {
    results.push({ type: 'dictionary', id: r.slug, primary: `A/D ${r.term}`, secondary: r.definition ?? '', rank: r.out_rank })
  }
  for (const r of (adRes.data ?? []) as AdRow[]) {
    results.push({ type: 'ad', id: r.ad_number, primary: `AD ${r.ad_number}`, secondary: r.subject_heading ?? '', rank: r.out_rank })
  }
  for (const r of (figRes.data ?? []) as FigureRow[]) {
    const sourceLabel = r.source_type === 'ac' ? 'AC' : 'AIM'
    // r.parent_number is the document's own number — "90-67B" for an AC,
    // the paragraph number itself for AIM — the piece that was missing
    // before: a figure result read as "AC Table 1" with no way to tell
    // WHICH AC it came from. Live example that's fixed by this: "AC Table
    // 1" -> "AC 90-67B — Table 1".
    const docNumber = r.parent_number ?? r.parent_id
    results.push({
      type: r.source_type === 'ac' ? 'figure_ac' : 'figure_aim',
      id: r.parent_id,
      primary: `${sourceLabel} ${docNumber} — ${r.label ?? r.caption ?? 'Figure'}`,
      secondary: r.caption && r.label ? r.caption : (r.parent_title ?? ''),
      rank: r.out_rank,
      figure: { id: r.figure_id, label: r.label, caption: r.caption, image_url: r.image_url },
    })
  }

  return results.sort((a, b) => b.rank - a.rank)
}

// Fallback route for figure_ac/figure_aim results — used only if a caller
// doesn't check r.figure first (see UnifiedResult.figure). Prefer opening
// FigureViewer directly with r.figure's data; this route lands on the
// parent document instead, which is one extra tap to then find the T&F —
// confirmed live as an unwanted extra step, not the intended v1 behavior.
export function routeForUnifiedResult(r: UnifiedResult): string {
  switch (r.type) {
    case 'far': return `/far/${r.id}`
    case 'aim': return `/aim/${r.id}`
    case 'pcg': return `/pcg/${r.id}`
    case 'ad': return `/ad/${r.id}`
    case 'figure_ac': return `/ac/${r.id}`
    case 'figure_aim': return `/aim/${r.id}`
    case 'dictionary': return `/dictionary/${r.id}`
  }
}

export function labelForUnifiedType(t: UnifiedResultType): string {
  switch (t) {
    case 'far': return 'FAR'
    case 'aim': return 'AIM'
    case 'pcg': return 'P/CG'
    case 'ad': return 'AD'
    case 'figure_ac': return 'T&F'
    case 'figure_aim': return 'T&F'
    case 'dictionary': return 'A/D'
  }
}
