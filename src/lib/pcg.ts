// Canonical raw-term -> pcg_terms.slug normalization ("Light Gun" ->
// "LIGHT_GUN") — shared so every place that builds a /pcg/[id] route from
// free text (see_refs links, inline cross-reference links in body text)
// stays in sync with the actual slug format instead of each re-deriving
// its own slightly different version.
export function slugifyPcgTerm(term: string): string {
  return term.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}
