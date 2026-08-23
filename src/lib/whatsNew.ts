import { supabase } from '@/lib/supabase'

// Shared "what's genuinely new" fetch -- same 3-query shape Home's own
// What's New strip already used inline, pulled out so /updates's "New" tab
// can fetch the identical data independently (reached by navigation, not
// passed state) without re-deriving the query from scratch. Home's own
// strip is left untouched -- this is a NEW, separate call, not a refactor
// of already-shipped, working code.
//
// AC/AD/LOI only -- FAR/AIM/PCG have no real per-item issue date (a single
// uniform bulk-scrape timestamp, not a genuine "the FAA published this on
// this date" signal), so including them here would show an arbitrary
// slice of "everything we last scraped" as if it were recently published.
// See index.tsx's WhatsNewOther comment for the same reasoning.
export type WhatsNewKind = 'ac' | 'ad' | 'loi'

export interface WhatsNewItem {
  kind: WhatsNewKind
  id: string
  documentNumber: string
  title: string
  date: string | null
  changedBlockIndices: number[] | null
  /** AC only -- feeds getBadgeKind()'s NEW/UPD/VER distinction, same as Home's own card. */
  cancels: string[] | null
}

export async function getWhatsNewItems(badgeDays: number): Promise<WhatsNewItem[]> {
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - badgeDays)
  const cutoff = cutoffDate.toISOString().split('T')[0]

  const [acRes, adRes, loiRes] = await Promise.all([
    // advisory_circulars_gated, not the raw table -- `authenticated` has no
    // column-level SELECT grant on advisory_circulars.changed_block_indices
    // (found live, 2026-08-23 QA sweep: confirmed via direct PostgREST call,
    // see series/[prefix].tsx's identical fix for the full repro). Since
    // changed_block_indices is selected here, the whole query 403'd on
    // every call -- this screen's What's New strip / /updates "New" tab
    // silently got nothing back (caught by the existing error handling
    // below, not a crash, but genuinely zero real data every time).
    supabase
      .from('advisory_circulars_gated')
      .select('id, document_number, title, date_issued, changed_block_indices, cancels')
      .eq('status', 'active')
      .gte('date_issued', cutoff)
      .order('date_issued', { ascending: false })
      .limit(20),
    supabase
      .from('airworthiness_directives')
      .select('id, ad_number, subject_heading, citation_publish_date')
      .gte('citation_publish_date', cutoff)
      .order('citation_publish_date', { ascending: false })
      .limit(20),
    supabase
      .from('legal_interpretations')
      .select('slug, title, issued_date')
      .gte('issued_date', cutoff)
      .order('issued_date', { ascending: false })
      .limit(20),
  ])

  const items: WhatsNewItem[] = [
    ...((acRes.data ?? []) as any[]).map((r) => ({
      kind: 'ac' as const,
      id: r.id,
      documentNumber: r.document_number,
      title: r.title,
      date: r.date_issued,
      changedBlockIndices: r.changed_block_indices,
      cancels: r.cancels,
    })),
    ...((adRes.data ?? []) as any[]).map((r) => ({
      kind: 'ad' as const,
      id: r.id,
      documentNumber: r.ad_number,
      title: r.subject_heading,
      date: r.citation_publish_date,
      changedBlockIndices: null,
      cancels: null,
    })),
    ...((loiRes.data ?? []) as any[]).map((r) => ({
      kind: 'loi' as const,
      id: r.slug,
      documentNumber: (r.title as string).replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' '),
      title: (r.title as string).replace(/_/g, ' '),
      date: r.issued_date,
      changedBlockIndices: null,
      cancels: null,
    })),
  ]

  return items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
}

export function routeForWhatsNewItem(item: WhatsNewItem): string {
  switch (item.kind) {
    case 'ac': return `/ac/${item.id}`
    case 'ad': return `/ad/${item.documentNumber}`
    case 'loi': return `/loi/${item.id}`
  }
}
