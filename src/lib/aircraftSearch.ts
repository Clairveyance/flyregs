// AD search previously only queried subject_heading, and only as one
// literal substring -- confirmed live as a real bug: searching "Cessna
// 172" or "c172s" (the two most common ways a pilot would type this
// specific aircraft) both returned zero results, because the FAA's
// subject_heading text almost never contains a plain model number in a
// form that matches ("Airworthiness Directives; Textron Aviation Inc.
// (Type Certificate Previously Held by Cessna Aircraft Company)
// Airplanes" has no "172" in it at all -- the model lives in the
// separate `model` column, e.g. "172S S/Ns 8001 and up"). The `make` and
// `model` columns already exist on airworthiness_directives and were
// simply never queried.
//
// This module turns a free-text query into a set of required search
// terms, each matched against make OR model OR subject_heading, ANDed
// together -- so "Cessna 172" requires (make/model/subject contains
// "cessna") AND (make/model/subject contains "172"), rather than one
// literal multi-word substring match.
//
// It also recognizes the common single-token "manufacturer-prefix glued
// to model number" shorthand pilots actually type (C172S, PA28, SR22,
// M20J, BE36...) and expands the prefix to the manufacturer's real name
// as an ADDITIONAL required term, on top of trying the raw token as-is
// (so a query this doesn't recognize still falls back to a plain
// substring search instead of silently matching nothing).

const MANUFACTURER_PREFIXES: Record<string, string> = {
  c: 'cessna',
  pa: 'piper',
  be: 'beech',
  b: 'beech',
  m: 'mooney',
  sr: 'cirrus',
  da: 'diamond',
  r: 'robinson',
  r44: 'robinson',
  ec: 'eurocopter',
  as: 'airbus',
  bd: 'bombardier',
  g: 'gulfstream',
  lj: 'learjet',
  pc: 'pilatus',
  tb: 'socata',
  am: 'american champion',
  rv: 'vans',
}

export interface AdSearchPlan {
  /** Each entry is a set of terms that satisfy one required token (OR'd
   * together); every entry in the outer array must be satisfied (AND'd). */
  requiredTermGroups: string[][]
  /** A single best-guess normalized term for a "did you mean" fallback
   * lookup if the primary search returns nothing. */
  fallbackTerm: string | null
}

function expandToken(token: string): string[] {
  const terms = [token]
  const m = /^([a-z]{1,3})(\d[\da-z]*)$/.exec(token)
  if (m) {
    const [, prefix, rest] = m
    const manufacturer = MANUFACTURER_PREFIXES[prefix]
    if (manufacturer) {
      // Splitting into two independently-satisfiable required terms (not
      // one OR-group) is what lets "c172s" match a make="...Cessna..."
      // row whose model is a different but still-172S-containing string.
      return [manufacturer, rest]
    }
  }
  return terms
}

export function buildAdSearchPlan(rawQuery: string): AdSearchPlan {
  const cleaned = rawQuery.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const tokens = cleaned.split(/\s+/).filter(Boolean)

  const requiredTermGroups: string[][] = []
  const candidateFallbacks: string[] = []

  for (const token of tokens) {
    const expanded = expandToken(token)
    if (expanded.length > 1) {
      // A recognized prefix+model token becomes two separate required
      // groups (manufacturer name, model number) rather than one OR-group.
      for (const term of expanded) requiredTermGroups.push([term])
      candidateFallbacks.push(expanded[expanded.length - 1])
    } else {
      requiredTermGroups.push([token])
      candidateFallbacks.push(token)
    }
  }

  // Prefer a digit-containing token for the fallback ("did you mean")
  // lookup over a pure-alpha one -- a manufacturer name is far more likely
  // to be typo'd into something unrecognizable ("sessna" for "cessna")
  // than a model number is, so anchoring the fallback on the model number
  // gives a much better shot at a real "similar aircraft" match.
  const fallbackTerm = candidateFallbacks.find((t) => /\d/.test(t)) ?? candidateFallbacks[0] ?? null

  return { requiredTermGroups, fallbackTerm }
}
