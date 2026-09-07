import { supabase } from '@/lib/supabase'
import { TABLE_HEADER_MARK } from '@/lib/regTextFormat'

// content_revisions is written at ingest time whenever a real content
// revision is detected. Started AC-only (scripts/backfill-blocks.mjs,
// hooked at the exact spot that already computes changed_block_indices
// for the NEW/UPD badge) -- same "prove it on one type first" pattern
// already used for MagicLink and Ref Packets. FAR/AIM/P-CG/AD now log too,
// via the shared sync/revision_log.py (see that file's docstring). No
// historical backfill is possible for any type: prior text was never
// retained before this table existed, so each type's timeline starts from
// whenever its own logging shipped, not retroactively.

export type RevisionDocType = 'ac' | 'far' | 'aim' | 'pcg' | 'ad' | 'cfr49' | 'loi'

export interface ContentRevision {
  id: string
  docType: RevisionDocType
  docKey: string
  docId: string | null
  title: string | null
  addedText: string | null
  removedText: string | null
  revisedAt: string
  // Present only on rows from getRevisions(), which deliberately does NOT
  // fetch the diff text -- see that function. The collapsed list row shows
  // "+N -N" from these; the text itself arrives from getRevisionDiff() when
  // the user actually expands a row.
  addedCount?: number
  removedCount?: number
}

export function routeForRevision(r: ContentRevision): string {
  const key = r.docId ?? r.docKey
  switch (r.docType) {
    case 'far': return `/far/${r.docKey}`
    case 'aim': return `/aim/${r.docKey}`
    case 'pcg': return `/pcg/${r.docKey}`
    case 'ad': return `/ad/${r.docKey}`
    case 'cfr49': return `/cfr49/${r.docKey}`
    case 'loi': return `/loi/${r.docKey}`
    default: return `/ac/${key}`
  }
}

export function labelForDocType(t: RevisionDocType): string {
  switch (t) {
    case 'far': return 'FAR'
    case 'aim': return 'AIM'
    case 'pcg': return 'P/CG'
    case 'ad': return 'AD'
    case 'cfr49': return '49 CFR'
    case 'loi': return 'LOI'
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

// RC: "I can't believe all that is new in the last 6 months... go through
// this whole setup meticulously." getRevisions() used to have NO time
// window at all (just the 100 most recent ever) and the screen gave no
// indication of how far back that went -- unlike What's New, which is
// always scoped to the user's own Badge Duration setting. sinceDate scopes
// it the same way, so "Changed" reads as "recent, bounded" instead of
// "however far back logging happens to go."
export async function getRevisions(sinceDate?: string, limit = 100): Promise<ContentRevision[]> {
  // content_revisions_gated, not the raw table -- ac/ad/cfr49 revisions are
  // Plus-tier content and loi revisions are PRO-tier (added_text/removed_text
  // redact to null server-side below those tiers); far/aim/pcg stay ungated.
  // LOI is the stricter one because legal_interpretations_gated puts LOI
  // body_text behind has_pro_access(), and a revision's added/removed text is
  // that same body text, diffed. See
  // migrations_fix_content_revisions_ungated_leak.sql and
  // migrations_content_revisions_loi_doctype.sql.
  // NO added_text / removed_text HERE, DELIBERATELY.
  //
  // Measured against the live database 2026-09-06: with the text, the 90-day
  // window is **12.4 MB of JSON and ~10 seconds** on a fast desktop
  // connection, because one AC revision (29-2C, 2026-09-03) carries 2.9 MB of
  // diff text on its own. Without it the same request is **8.8 KB and ~0.5 s**
  // -- 1,412x smaller, 22x faster. On a phone the old shape is RC's
  // "spinning the wheel and the whole app locked up" (reported 2026-09-06).
  //
  // The code did not regress; the DATA did. On 2026-08-03 the same window held
  // 31 KB of revision text. A 2026-09-03 scrape made it 12 MB. B40 shipped two
  // days later, which is why a screen that had always been written this way
  // suddenly read as "B40 is massively slower."
  //
  // revision_added_count / revision_removed_count are computed columns on the
  // GATED view (sync/migrations_revision_para_counts.sql) that mirror
  // splitParagraphs() exactly -- verified equal on all 29 rows in the live
  // window -- so the collapsed "+N -N" is unchanged while the text stays on
  // the server until getRevisionDiff() asks for one specific row.
  let query = supabase
    .from('content_revisions_gated')
    .select('id, doc_type, doc_key, doc_id, title, revised_at, revision_added_count, revision_removed_count')
    .order('revised_at', { ascending: false })
    .limit(limit)
  if (sinceDate) query = query.gte('revised_at', sinceDate)
  // Flagged in the 2026-08-14 night-rules QA sweep: dropping `error` here
  // meant a real network/RLS failure rendered identically to "genuinely
  // no revisions" -- the Updates screen's Changed tab would show a quiet
  // empty state instead of surfacing that something actually went wrong.
  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as any[]).map((r) => ({
    id: r.id,
    docType: r.doc_type,
    docKey: r.doc_key,
    docId: r.doc_id,
    title: r.title,
    addedText: null,
    removedText: null,
    revisedAt: r.revised_at,
    addedCount: r.revision_added_count ?? 0,
    removedCount: r.revision_removed_count ?? 0,
  }))
}

/** The diff text for ONE revision, fetched when the user expands that row.
 *
 * Split out from getRevisions() so the list does not have to carry megabytes
 * of text nobody has asked to read yet. Throws on a real fetch error for the
 * same reason getRevisions() does: a swallowed error here would render as
 * "this revision has no changes," which is a lie the user cannot tell from
 * the truth. */
export async function getRevisionDiff(
  id: string,
): Promise<{ addedText: string | null; removedText: string | null }> {
  const { data, error } = await supabase
    .from('content_revisions_gated')
    .select('added_text, removed_text')
    .eq('id', id)
    .limit(1)
  if (error) throw error
  const r = (data ?? [])[0] as any
  return { addedText: r?.added_text ?? null, removedText: r?.removed_text ?? null }
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
  // Same error-dropping gap as getRevisions() above -- a real fetch
  // failure here would have silently rendered as "no revision," hiding
  // the FAR/AIM detail page's "updated" banner instead of surfacing that
  // something actually went wrong.
  const { data, error } = await supabase
    .from('content_revisions_gated')
    .select('id, doc_type, doc_key, doc_id, title, added_text, removed_text, revised_at')
    .eq('doc_type', docType)
    .eq('doc_key', docKey)
    .order('revised_at', { ascending: false })
    .limit(1)
  if (error) throw error
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

// RC, 2026-09-01 (real device): "this last box in the what's new area has text
// that somehow is unbounded and extending past the boundaries of its own box.
// Make sure that's not happening elsewhere."
//
// React Native's <Text> wraps on whitespace only -- it will NOT break a single
// long token, so one unbreakable string overflows its container no matter what
// flex rules the parent has. Real content that triggers it, still present in
// live revisions after the false-positive purge: AD diffs quote
// "www.archives.gov/federal-register/cfr/ibr-locations" (51 chars, no spaces).
//
// Fix is to add BREAK OPPORTUNITIES rather than to change the text: U+200B
// (zero-width space) renders as nothing and is not selectable as a character,
// so the visible string is unchanged and copy/paste keeps working, but the
// layout engine is now allowed to wrap there. Separator characters first
// (which is where a URL naturally wants to break), then a hard chunk fallback
// for a genuinely unbroken run such as a long identifier.
const ZWSP = '\u200B'

export function softWrapLongTokens(text: string, maxToken = 24): string {
  if (!text) return text
  return text.replace(/\S+/g, (tok) => {
    if (tok.length <= maxToken) return tok
    // break after URL/path separators and punctuation
    let out = tok.replace(/([/\-._,;:?&=])/g, `$1${ZWSP}`)
    // anything still longer than maxToken between breaks gets chunked
    return out
      .split(ZWSP)
      .map((run) =>
        run.length <= maxToken
          ? run
          : (run.match(new RegExp(`.{1,${maxToken}}`, 'g')) ?? [run]).join(ZWSP)
      )
      .join(ZWSP)
  })
}
