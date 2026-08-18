import { supabase } from '@/lib/supabase'
import { naturalCompare } from '@/lib/naturalSort'

// MagicLink's second relatedness signal -- see sync/migrations_related_by_
// topic.sql for the full "why" (RC's RNP example: citation extraction only
// ever catches an EXPLICIT textual mention, so a paragraph that's deeply
// about a topic but never happens to write another document's number down
// gets zero credit for it). Shared by every content-type detail screen
// rather than each calling supabase.rpc directly, so the six call sites
// (far/aim/ac/ad/loi/pcg) stay in sync if the RPC's shape ever changes.
export interface RelatedRef {
  cited_type: string
  cited_id: string
  label: string | null
}

// Only types MagicLinkPod actually has a bar for -- content_chunks also
// covers 'dictionary', which has no cited_type category anywhere in the
// UI and no route to send a tap to, so it's deliberately excluded here
// rather than surfacing a type nothing downstream knows what to do with.
const BAR_TYPES = ['far', 'aim', 'ac', 'ad', 'loi', 'pcg']

export async function getSemanticRelated(
  sourceType: string,
  sourceId: string,
  matchCount = 12,
  minSimilarity = 0.45
): Promise<RelatedRef[]> {
  const { data, error } = await supabase.rpc('related_by_topic', {
    p_source_type: sourceType,
    p_source_id: sourceId,
    p_target_types: BAR_TYPES,
    p_match_count: matchCount,
    p_min_similarity: minSimilarity,
  })
  if (error || !data) return []
  return (data as { target_type: string; target_id: string }[]).map((r) => ({
    cited_type: r.target_type,
    cited_id: r.target_id,
    label: null,
  }))
}

// Citation-derived entries win on a duplicate -- they're the more precise
// signal (an explicit textual reference, not a similarity score), and some
// already carry a real `label` semantic hits never do.
//
// Every one of the 6 detail screens (far/aim/ac/ad/loi/pcg) splits this
// merged array into per-type bars via `related.filter((r) => r.cited_type
// === X)`, which preserves array order -- so sorting once, here, is the
// single point that fixes ordering for every MagicLink bar app-wide.
// Previously unsorted (this function's own old comment said "order doesn't
// matter"), which was true for correctness but not for the reading
// experience: as extraction coverage genuinely improves (more real
// citations found, not more noise -- see the 2026-08-17 MagicLink audit),
// a bar's item list grows, and an arbitrary/database-order list gets
// harder to scan exactly when it has the most content. `naturalCompare`
// (already proven live for FAR section numbers and AC document numbers --
// see its own header) reads sensibly for every cited_type here: numeric
// for far/far_part/aim/cfr49/ad, alphanumeric-with-digit-runs for ac, and
// plain alphabetical for pcg/loi (opaque slug/term strings), which is
// still the expected default for a list with no other natural order. Ties
// (same cited_id from both sources, shouldn't happen post-dedup) fall back
// to citation-before-semantic via the original array position, which
// Array.prototype.sort's stable sort already preserves for equal keys.
export function mergeRelated(citations: RelatedRef[], semantic: RelatedRef[]): RelatedRef[] {
  const seen = new Set(citations.map((c) => `${c.cited_type}-${c.cited_id}`))
  const extra = semantic.filter((s) => !seen.has(`${s.cited_type}-${s.cited_id}`))
  return [...citations, ...extra].sort((a, b) => naturalCompare(a.cited_id, b.cited_id))
}
