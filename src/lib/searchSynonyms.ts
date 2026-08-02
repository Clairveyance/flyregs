import { supabase } from '@/lib/supabase'
import { bridgeTerms } from '@/lib/searchBridge'

// SmartSearch query expansion.
//
// Replaced a hand-written 35-group synonym list, which could never reach the
// "1000s of words and word combos" this needs to cover. Three layers now
// chain together, each solving something the others structurally cannot:
//
//   1. BRIDGE (src/lib/searchBridge.ts, in-app, instant)
//      Everyday word -> FAA word. Corpus statistics are blind here by
//      construction: measured on the real corpus, "gas" and "skydiving"
//      produced ZERO associations because Title 14 says "fuel" and
//      "parachute operations" and never says those words at all.
//
//   2. CORPUS ASSOCIATIONS (Postgres, ~9.9k pairs over ~3.2k terms)
//      Terms that appear in the same regulatory contexts. Built offline by
//      scripts/build_search_associations.py, so there is no per-search API
//      cost or latency the way query-time vector embedding would have.
//
//   3. MORPHOLOGY (Postgres search_vocabulary prefix match)
//      Real corpus words starting with the query ("ice" -> "icing"), which
//      distributional similarity can't produce since they're distinct tokens.
//
// The chaining is where the power is: "gas" --bridge--> "fuel" --corpus-->
// tank, ignition, explosion, fueling. One everyday word reaches a whole
// cluster of real regulatory language.

export interface ExpandedQuery {
  /** Extra terms to also search, best-first. Never includes the original. */
  terms: string[]
  /** True when expansion actually found something -- lets the UI say so. */
  expanded: boolean
}

const EMPTY: ExpandedQuery = { terms: [], expanded: false }

// Bounded on purpose. Every extra term is another set of search RPCs, and
// past ~6 the marginal term is weak enough that it dilutes precision more
// than it adds recall.
const MAX_TERMS = 6

const cache = new Map<string, ExpandedQuery>()

export async function expandQuery(query: string): Promise<ExpandedQuery> {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (q.length < 3) return EMPTY
  const hit = cache.get(q)
  if (hit) return hit

  // Layer 1 runs locally and instantly, and its output is fed INTO layer 2
  // as additional lookup keys -- that's the chain.
  const bridged = bridgeTerms(q)
  const lookupKeys = [q, ...bridged]

  let related: string[] = []
  try {
    const { data, error } = await supabase.rpc('expand_search_terms', {
      p_terms: lookupKeys,
      p_limit: 12,
    })
    if (!error && data) {
      related = (data as { related: string }[]).map((r) => r.related)
    }
  } catch {
    // Expansion is an enhancement, never a dependency -- a failure here must
    // still leave the user's literal query searching normally.
  }

  // Bridge terms rank above corpus associations: they're a curated, exact
  // mapping of what the user meant, whereas an association is statistical.
  const seen = new Set<string>([q])
  const ordered: string[] = []
  for (const t of [...bridged, ...related]) {
    const k = t.toLowerCase()
    if (k === q || seen.has(k)) continue
    seen.add(k)
    ordered.push(t)
    if (ordered.length >= MAX_TERMS) break
  }

  const result: ExpandedQuery = { terms: ordered, expanded: ordered.length > 0 }
  cache.set(q, result)
  return result
}
