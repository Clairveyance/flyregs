// Shared relevance-scoring primitives for this app's several typeahead/
// search engines. Extracted from adParts.ts (2026-08-14) so
// aircraftModels.ts's type-designator search could reuse the same fix
// without a circular import (adParts.ts already depends on
// aircraftModels.ts for subsequencePattern) -- any future search engine
// that fetches a wider candidate pool via a loose DB-level pattern and
// needs to rank what actually matched TIGHTLY should reach for this file
// rather than re-deriving its own copy.
//
// Original context (adParts.ts's own header, kept for the reasoning): RC,
// live, on a "52241" search surfacing unrelated CF34/CF6 turbofan engine
// rows ahead of clean matches -- a loose DB-level fetch pattern (subsequence
// match, gaps allowed) will coincidentally match long free-text fields by
// chance; literal-substring-vs-not isn't a strong enough signal either,
// since the correct real match can itself be a subsequence match (one
// inserted letter/hyphen), not a literal substring. The real signal is
// SPAN: how many characters of the target string sit between the first and
// last matched query character. A tight match (query "52241" against
// "52A241") spans 6 characters for a 5-character query (score ~0.83); a
// coincidental match scattered across an 80-character multi-variant listing
// scores near 0. Greedy leftmost-match span, not a true minimal-window
// search -- cheap, and good enough for short structured queries like part
// numbers and type designators.
export function matchSpan(target: string, query: string): { first: number; last: number } | null {
  if (query.length === 0) return null
  let qi = 0
  let first = -1
  let last = -1
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (first === -1) first = ti
      last = ti
      qi++
    }
  }
  if (qi < query.length) return null // not even a subsequence match
  return { first, last }
}

export function subsequenceTightness(target: string, query: string): number {
  const span = matchSpan(target, query)
  if (!span) return 0
  return query.length / (span.last - span.first + 1)
}

// `field` is frequently a delimited LIST of several designators/numbers in
// one string (adParts.ts's own catalog rows commonly list a dozen+ engine
// variants; aircraft_type_designators doesn't have this shape today, but a
// future multi-variant row could) -- splitting into individual tokens and
// scoring each independently keeps a match honest to a single real
// designator, rather than letting a query scatter its tight span across
// SEVERAL different list entries and read as deceptively tight overall.
export function bestTokenTightness(field: string, query: string): number {
  const tokens = field.split(/[,;/]/)
  let best = 0
  for (const token of tokens) best = Math.max(best, subsequenceTightness(token, query))
  return best
}
