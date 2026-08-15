import { supabase } from '@/lib/supabase'

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
// already carry a real `label` semantic hits never do. Order doesn't
// matter for correctness beyond that; citations first just means fewer
// swaps in the common case where most items are citation-only anyway.
export function mergeRelated(citations: RelatedRef[], semantic: RelatedRef[]): RelatedRef[] {
  const seen = new Set(citations.map((c) => `${c.cited_type}-${c.cited_id}`))
  const extra = semantic.filter((s) => !seen.has(`${s.cited_type}-${s.cited_id}`))
  return [...citations, ...extra]
}
