import { supabase } from '@/lib/supabase'
import { TABLE_HEADER_MARK } from '@/lib/regTextFormat'

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
//
// Strips TABLE_HEADER_MARK -- a real table-header line straight from an AIM
// paragraph's stored body_text carries this invisible Private Use Area
// sentinel (PlainTextBody's own convention for "style this line as a real
// header"), and unlike PlainTextBody, this screen renders each split
// paragraph as plain <Text> with no marker-aware handling at all. Confirmed
// live 2026-08-02 (RC-reported "glyph artifact" in a What's Changed diff
// row): the raw sentinel rendered as a visible tofu/box glyph right before
// the table's first header cell instead of being invisibly stripped.
export function splitParagraphs(text: string | null): string[] {
  if (!text) return []
  return text
    .split('\n\n')
    .map((p) => p.split(TABLE_HEADER_MARK).join(''))
    .filter((p) => p.trim())
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

// The most recent revision for one document, used by the FAR/AIM detail
// screens to show an "updated" banner and highlight the changed paragraphs
// inline -- the same affordance AC already had via changed_block_indices.
// FAR/AIM have no per-document changed-index column, so the changed
// paragraphs are resolved by matching the revision's own added_text
// paragraphs against the live body text.
export async function getLatestRevision(
  docType: RevisionDocType,
  docKey: string,
): Promise<ContentRevision | null> {
  const { data } = await supabase
    .from('content_revisions')
    .select('id, doc_type, doc_key, doc_id, title, added_text, removed_text, revised_at')
    .eq('doc_type', docType)
    .eq('doc_key', docKey)
    .order('revised_at', { ascending: false })
    .limit(1)
  const r = (data ?? [])[0] as any
  if (!r) return null
  return {
    id: r.id, docType: r.doc_type, docKey: r.doc_key, docId: r.doc_id,
    title: r.title, addedText: r.added_text, removedText: r.removed_text,
    revisedAt: r.revised_at,
  }
}

// Maps a revision's added paragraphs onto indices in the document body as
// PlainTextBody splits it (/\n\n+/, blank-only entries dropped) -- the two
// MUST stay in sync or the rail lands on the wrong paragraph. Compared on
// collapsed whitespace so a scraper reflow doesn't silently drop the match.
export function changedParagraphIndices(bodyText: string, addedText: string | null): number[] {
  const added = splitParagraphs(addedText)
  if (added.length === 0) return []
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
  const wanted = new Set(added.map(norm))
  const paras = bodyText.split(/\n\n+/).filter((p) => p.trim())
  const out: number[] = []
  paras.forEach((p, i) => { if (wanted.has(norm(p))) out.push(i) })
  return out
}
