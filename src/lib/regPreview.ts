import { supabase } from '@/lib/supabase'

// Resolves a crossRefLinks/linkifyReferences route ("/ac/61-98E",
// "/far/91.107", "/aim/4-3-13", "/pcg/light-gun", "/ad/2018-02-04") to a
// lightweight preview: label, title, body text, and the real route to open
// the full detail screen. Used by RegPreviewPane to show reg content
// inline (e.g. inside a Ref Packet) without leaving the current screen.
//
// Deliberately narrow: only single-document routes are previewable. A
// browse/list route ("/far/part/61", bare "/aim") isn't a single body of
// text to preview -- parsePreviewRoute returns null for those, and callers
// should fall back to normal navigation.

export type PreviewKind = 'ac' | 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'cfr49'

export interface RegPreviewData {
  kind: PreviewKind
  id: string
  label: string
  title: string
  body: string
  fullRoute: string
}

export function parsePreviewRoute(route: string): { kind: PreviewKind; id: string } | null {
  let m: RegExpMatchArray | null
  // decodeURIComponent like the other six branches. Without it an encoded
  // slash-form AC ('/ac/150%2F5300-13B', which crossRefLinks correctly emits)
  // reached .ilike('document_number', `${id}%`) still percent-encoded -- and
  // the literal % is also a SQL wildcard, so it never matched. The peek said
  // only 'Not found.' for every 150-series AC reference.
  if ((m = route.match(/^\/ac\/(.+)$/))) return { kind: 'ac', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/far\/(?!part\/)([^/]+)$/))) return { kind: 'far', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/aim\/([^/]+)$/))) return { kind: 'aim', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/pcg\/([^/]+)$/))) return { kind: 'pcg', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/ad\/([^/]+)$/))) return { kind: 'ad', id: decodeURIComponent(m[1]) }
  // Found 2026-08-24: this pane silently fell back to full navigation for
  // any /loi/ or /cfr49/ route (RegPreviewPane's own caller already handles
  // a null return that way), degrading gracefully but never actually
  // previewing either content type inline the way the other 5 do.
  if ((m = route.match(/^\/loi\/([^/]+)$/))) return { kind: 'loi', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/cfr49\/([^/]+)$/))) return { kind: 'cfr49', id: decodeURIComponent(m[1]) }
  return null
}

export async function fetchRegPreview(kind: PreviewKind, id: string): Promise<RegPreviewData | null> {
  switch (kind) {
    case 'ac': {
      const { data } = await supabase
        .from('advisory_circulars')
        .select('id, document_number, title, description')
        .ilike('document_number', `${id}%`)
        .order('document_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!data) return null
      return { kind, id: data.id, label: `AC ${data.document_number}`, title: data.title, body: data.description ?? '', fullRoute: `/ac/${data.id}` }
    }
    case 'far': {
      const { data } = await supabase
        .from('far_sections')
        .select('section_number, title, body_text')
        .eq('section_number', id)
        .single()
      if (!data) return null
      return { kind, id: data.section_number, label: `§ ${data.section_number}`, title: data.title, body: data.body_text ?? '', fullRoute: `/far/${data.section_number}` }
    }
    case 'aim': {
      const { data } = await supabase
        .from('aim_paragraphs')
        .select('paragraph_number, title, body_text')
        .eq('paragraph_number', id)
        .single()
      if (!data) return null
      return { kind, id: data.paragraph_number, label: `¶ ${data.paragraph_number}`, title: data.title, body: data.body_text ?? '', fullRoute: `/aim/${data.paragraph_number}` }
    }
    case 'pcg': {
      const { data } = await supabase
        .from('pcg_terms')
        .select('slug, term, definition')
        .eq('slug', id)
        .single()
      if (!data) return null
      return { kind, id: data.slug, label: data.term, title: data.term, body: data.definition ?? '', fullRoute: `/pcg/${data.slug}` }
    }
    case 'ad': {
      // _gated view redacts body_text server-side for non-Plus tiers -- see
      // gotcha_tier_gate_client_side_only.md. RegPreviewPane (this
      // function's only caller) has no hasPlusAccess gate on the body it
      // renders at all, unlike ad/[id].tsx's own already-correct paywall --
      // this was a real, unguarded leak of an AD's full text via any
      // MagicLink hover/long-press preview.
      const { data } = await supabase
        .from('airworthiness_directives_gated')
        .select('ad_number, subject_heading, summary, body_text')
        .eq('ad_number', id)
        .single()
      if (!data) return null
      return {
        kind,
        id: data.ad_number,
        label: `AD ${data.ad_number}`,
        title: data.subject_heading ?? '',
        body: data.summary || data.body_text || '',
        fullRoute: `/ad/${data.ad_number}`,
      }
    }
    case 'loi': {
      // legal_interpretations_gated, not the raw table -- same reasoning as
      // the 'ad' case above: this pane has no hasPlusAccess/hasProAccess
      // gate of its own, so the raw table would leak a Pro-gated LOI's full
      // body_text through any MagicLink hover/long-press preview.
      const { data } = await supabase
        .from('legal_interpretations_gated')
        .select('slug, title, summary, body_text')
        .eq('slug', id)
        .single()
      if (!data) return null
      const cleanTitle = (data.title as string).replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' ')
      return { kind, id: data.slug, label: cleanTitle, title: cleanTitle, body: data.summary || data.body_text || '', fullRoute: `/loi/${data.slug}` }
    }
    case 'cfr49': {
      // cfr49_sections_gated, not the raw table -- same reasoning as 'ad'/
      // 'loi' above (see sync/migrations_cfr49_sections_gated_view.sql for
      // the real leak this exact raw-table shape had on the detail screen
      // itself, fixed 2026-08-23 -- this pane is a second, separate read
      // path into the same column that needed the same protection).
      const { data } = await supabase
        .from('cfr49_sections_gated')
        .select('section_number, title, body_text')
        .eq('section_number', id)
        .single()
      if (!data) return null
      return { kind, id: data.section_number, label: `§ ${data.section_number}`, title: data.title, body: data.body_text ?? '', fullRoute: `/cfr49/${data.section_number}` }
    }
  }
}

export interface ResolvedAimFigure {
  id: string
  label: string | null
  caption: string | null
  image_url: string
}

// A "(See FIG x-x-x.)" or "Figure x-x-x is an example of..." mention is
// USUALLY a self-reference to a figure already on the current paragraph
// (handled locally in PlainTextBody), but corpus-wide auditing found this
// isn't always true: AIM's own captioning sometimes files a figure under a
// DIFFERENT paragraph than the one(s) that mention it -- confirmed live,
// e.g. AIM 1-1-9's prose says "FIG 1-1-8" but that figure is catalogued
// under paragraph 1-1-10, not 1-1-9 itself; same pattern for FIG 2-1-1
// (mentioned in 2-1-1, filed under 2-1-2), FIG 4-3-1 (mentioned in
// chap0_section_0 and 4-3-2 itself, filed under 4-3-2), and others. Called
// as a FALLBACK only, after the current paragraph's own figures have
// already been checked and come up empty -- a plain global lookup by
// normalized label (matching either the FIG/FIGURE or TBL/TABLE spelling).
// Confirmed live cases where the AIM's own prose cites a figure by a number
// that no longer matches the figure's real, current PDF number -- verified
// individually against the official AIM PDF (not guessed): the cited
// number genuinely doesn't exist as its own figure, but the SAME real
// content the prose is clearly describing exists correctly labeled just a
// slot or two away. RC: "check and compare figs to see if the 'missing'
// ones actually appear somewhere else so we can clarify and point to
// them." Deliberately a small, individually-verified map rather than any
// kind of fuzzy/proximity guessing -- an unconfirmed near-match would risk
// showing the WRONG figure with false confidence, worse than the honest
// "not available" disclaimer.
const STALE_CITATION_ALIASES: Record<string, string> = {
  '4-5-3': '4-5-4', // AIM 4-5-6 cites "FIG 4-5-3, TIS Proximity Coverage Volume" -- that title is really FIG 4-5-4 in the current PDF.
  '5-4-27': '5-4-29', // AIM 5-4-20/5-4-7 cite "FIG 5-4-27" for circling approach protected-area radii -- that's really FIG 5-4-29 (Standard and Expanded Circling Approach Radii).
  // AIM 7-4-2/7-4-3/7-4-4's entire wake-vortex figure sequence ("FIG 7-4-1"
  // through "FIG 7-4-7") is a clean, verified 1:1 shift: the real PDF's
  // wake-vortex figures are FIG 7-3-1 through FIG 7-3-7, same order, same
  // count, same captions (Wake Vortex Generation, Wake Encounter Counter
  // Control, Wake Ends/Wake Begins, Vortex Flow Field, ...). The whole
  // block moved section in a past AIM revision; the citing prose never got
  // updated to match.
  '7-4-1': '7-3-1',
  '7-4-2': '7-3-2',
  '7-4-3': '7-3-3',
  '7-4-4': '7-3-4',
  '7-4-5': '7-3-5',
  '7-4-6': '7-3-6',
  '7-4-7': '7-3-7',
}

export async function resolveAimFigureGlobally(mentionText: string): Promise<ResolvedAimFigure | null> {
  const num = mentionText.trim().replace(/^(?:FIG(?:URE)?|TBL|TABLE)\s*/i, '').toUpperCase()
  if (!num) return null
  const { data } = await supabase
    .from('aim_figures')
    .select('id, label, caption, image_url')
    .or(`label.eq.FIG ${num},label.eq.TBL ${num}`)
    .limit(1)
  if (data && data.length > 0) return data[0]
  const alias = STALE_CITATION_ALIASES[num]
  if (!alias) return null
  const { data: aliased } = await supabase
    .from('aim_figures')
    .select('id, label, caption, image_url')
    .or(`label.eq.FIG ${alias},label.eq.TBL ${alias}`)
    .limit(1)
  return aliased && aliased.length > 0 ? aliased[0] : null
}
