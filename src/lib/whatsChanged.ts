import { supabase } from '@/lib/supabase'

// content_revisions is written at ingest time whenever a real content
// revision is detected -- currently only the AC pipeline (scripts/
// backfill-blocks.mjs, hooked at the exact spot that already computes
// changed_block_indices for the NEW/UPD badge) writes rows here. FAR/AIM/
// P-CG/AD scrapers don't yet log revisions -- same "prove it on one type
// first" pattern already used for MagicLink and Ref Packets this session.
// No historical backfill is possible: prior AC text was never retained
// before this table existed, so the timeline starts from whenever this
// shipped, not retroactively.

export type RevisionDocType = 'ac' | 'far' | 'aim' | 'pcg' | 'ad'

export interface ContentRevision {
  id: string
  docType: RevisionDocType
  docKey: string
  docId: string | null
  title: string | null
  addedText: string | null
  removedText: string | null
  revisedAt: string
}

export function routeForRevision(r: ContentRevision): string {
  const key = r.docId ?? r.docKey
  switch (r.docType) {
    case 'far': return `/far/${r.docKey}`
    case 'aim': return `/aim/${r.docKey}`
    case 'pcg': return `/pcg/${r.docKey}`
    case 'ad': return `/ad/${r.docKey}`
    default: return `/ac/${key}`
  }
}

export function labelForDocType(t: RevisionDocType): string {
  switch (t) {
    case 'far': return 'FAR'
    case 'aim': return 'AIM'
    case 'pcg': return 'P/CG'
    case 'ad': return 'AD'
    default: return 'AC'
  }
}

// Paragraphs were joined with '\n\n' at insert time (see backfill-blocks.mjs)
// -- split back out for a "+N -M" count and for rendering each as its own row.
export function splitParagraphs(text: string | null): string[] {
  if (!text) return []
  return text.split('\n\n').filter((p) => p.trim())
}

export async function getRevisions(limit = 100): Promise<ContentRevision[]> {
  const { data } = await supabase
    .from('content_revisions')
    .select('id, doc_type, doc_key, doc_id, title, added_text, removed_text, revised_at')
    .order('revised_at', { ascending: false })
    .limit(limit)
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    docType: r.doc_type,
    docKey: r.doc_key,
    docId: r.doc_id,
    title: r.title,
    addedText: r.added_text,
    removedText: r.removed_text,
    revisedAt: r.revised_at,
  }))
}
