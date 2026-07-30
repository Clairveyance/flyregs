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

export type PreviewKind = 'ac' | 'far' | 'aim' | 'pcg' | 'ad'

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
  if ((m = route.match(/^\/ac\/(.+)$/))) return { kind: 'ac', id: m[1] }
  if ((m = route.match(/^\/far\/(?!part\/)([^/]+)$/))) return { kind: 'far', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/aim\/([^/]+)$/))) return { kind: 'aim', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/pcg\/([^/]+)$/))) return { kind: 'pcg', id: decodeURIComponent(m[1]) }
  if ((m = route.match(/^\/ad\/([^/]+)$/))) return { kind: 'ad', id: decodeURIComponent(m[1]) }
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
      const { data } = await supabase
        .from('airworthiness_directives')
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
  }
}
