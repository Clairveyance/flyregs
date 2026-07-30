import { supabase } from '@/lib/supabase'

// The 5 content types the ad hoc Filter sheet covers -- AD is deliberately
// excluded (see flyregs_expansion_plan.md's "Filter button — v1 scope"):
// this filters the structured regulatory catalog, not the AD alert stream.
export type FilterableType = 'far' | 'aim' | 'pcg' | 'ac' | 'loi'

export interface FilterParams {
  contentTypes?: FilterableType[]
  farParts?: string[] | null
  acSeries?: string | null
  audience?: string[] | null
  citesType?: FilterableType | null
  citesId?: string | null
  dateFrom?: string | null // 'YYYY-MM-DD'
  dateTo?: string | null
  hasFigures?: boolean | null
}

export interface FilterResultRow {
  itemType: FilterableType
  itemId: string
  primaryLabel: string
  secondaryLabel: string | null
  totalCount: number
}

export async function filterDocuments(params: FilterParams, limit = 50, offset = 0): Promise<FilterResultRow[]> {
  const { data, error } = await supabase.rpc('filter_documents', {
    p_content_types: params.contentTypes && params.contentTypes.length > 0 ? params.contentTypes : null,
    p_far_parts: params.farParts && params.farParts.length > 0 ? params.farParts : null,
    p_ac_series: params.acSeries ?? null,
    p_audience: params.audience && params.audience.length > 0 ? params.audience : null,
    p_cites_type: params.citesType ?? null,
    p_cites_id: params.citesId ?? null,
    p_date_from: params.dateFrom ?? null,
    p_date_to: params.dateTo ?? null,
    p_has_figures: params.hasFigures ?? null,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    itemType: r.item_type,
    itemId: r.item_id,
    primaryLabel: r.primary_label,
    secondaryLabel: r.secondary_label,
    totalCount: r.total_count,
  }))
}

// Just the live count, for the sheet's "N results" readout while chips are
// still being toggled -- same RPC, limit 1, cheap since count(*) OVER() is
// computed regardless of the page size requested.
export async function filterResultCount(params: FilterParams): Promise<number> {
  const rows = await filterDocuments(params, 1, 0)
  return rows[0]?.totalCount ?? 0
}

export function routeForFilterResult(row: FilterResultRow): string {
  switch (row.itemType) {
    case 'far': return `/far/${row.itemId}`
    case 'aim': return `/aim/${row.itemId}`
    case 'pcg': return `/pcg/${row.itemId}`
    case 'ac': return `/ac/${row.itemId}`
    case 'loi': return `/loi/${row.itemId}`
  }
}

export interface FilterOption {
  value: string
  label: string
}

let farPartsCache: FilterOption[] | null = null
export async function getFarPartOptions(): Promise<FilterOption[]> {
  if (farPartsCache) return farPartsCache
  const { data, error } = await supabase.from('far_sections').select('part').not('part', 'is', null)
  if (error) throw error
  const parts = Array.from(new Set((data ?? []).map((r: any) => r.part as string)))
  parts.sort((a, b) => parseFloat(a) - parseFloat(b))
  farPartsCache = parts.map((p) => ({ value: p, label: `Part ${p}` }))
  return farPartsCache
}

let acSeriesCache: FilterOption[] | null = null
export async function getAcSeriesOptions(): Promise<FilterOption[]> {
  if (acSeriesCache) return acSeriesCache
  const { data, error } = await supabase.from('ac_series').select('series_prefix,display_name').order('sort_order')
  if (error) throw error
  acSeriesCache = (data ?? []).map((r: any) => ({ value: r.series_prefix, label: `${r.series_prefix} — ${r.display_name}` }))
  return acSeriesCache
}

export const AUDIENCE_OPTIONS: FilterOption[] = [
  { value: 'pilots', label: 'Pilots' },
  { value: 'mechanics', label: 'Mechanics/A&P' },
  { value: 'operators', label: 'Operators' },
  { value: 'manufacturers', label: 'Manufacturers' },
]

export interface CitableDoc {
  type: FilterableType
  id: string
  label: string
}

// Lightweight type-ahead for the "Cites this document" picker -- reuses
// plain ilike lookups (each table already has the relevant text column
// indexed for its own detail-screen number-jump / search box) rather than
// standing up a new RPC just for a 5-table OR'd autocomplete.
export async function searchCitableDocuments(query: string, limitPerType = 4): Promise<CitableDoc[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const like = `%${q}%`

  const [far, aim, pcg, ac, loi] = await Promise.all([
    supabase.from('far_sections').select('section_number,title').or(`section_number.ilike.${like},title.ilike.${like}`).limit(limitPerType),
    supabase.from('aim_paragraphs').select('paragraph_number,title').or(`paragraph_number.ilike.${like},title.ilike.${like}`).limit(limitPerType),
    supabase.from('pcg_terms').select('slug,term').ilike('term', like).limit(limitPerType),
    supabase.from('advisory_circulars').select('document_number,title').eq('status', 'active').or(`document_number.ilike.${like},title.ilike.${like}`).limit(limitPerType),
    supabase.from('legal_interpretations').select('slug,title').ilike('title', like).limit(limitPerType),
  ])

  const out: CitableDoc[] = []
  for (const r of far.data ?? []) out.push({ type: 'far', id: r.section_number, label: `FAR ${r.section_number}${r.title ? ` — ${r.title}` : ''}` })
  for (const r of aim.data ?? []) out.push({ type: 'aim', id: r.paragraph_number, label: `AIM ${r.paragraph_number}${r.title ? ` — ${r.title}` : ''}` })
  for (const r of pcg.data ?? []) out.push({ type: 'pcg', id: r.slug, label: `P/CG — ${r.term}` })
  for (const r of ac.data ?? []) out.push({ type: 'ac', id: r.document_number, label: `AC ${r.document_number}${r.title ? ` — ${r.title}` : ''}` })
  for (const r of loi.data ?? []) out.push({ type: 'loi', id: r.slug, label: `LOI — ${r.title}` })
  return out
}
