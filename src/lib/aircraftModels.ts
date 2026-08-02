import { supabase } from '@/lib/supabase'

// Common marketing-name -> FAA type-certificate designator bridge for My
// Aircraft.
//
// AD matching (scripts/send-ad-alerts.mjs) checks whether an AD's own
// `model` text CONTAINS the user's saved model string. Real AD applicability
// text is written against the FAA type certificate designator ("PA-28-181",
// "LA-4-200", "35" for the Bonanza), not the marketing name a pilot
// actually knows their plane by ("Warrior", "Buccaneer", "Bonanza"). A
// saved aircraft whose model field is the marketing name can silently NEVER
// match a real applicable AD -- confirmed live, RC: "the 'model' needs a
// clear scope, or we need to provide options... the Lake amphib has a
// model called the Buccaneer, but its technical type is LA4. So how system
// needs to know both terms."
//
// This is a curated seed, NOT an attempt at the full ~1,173 distinct model
// strings already in the AD corpus (let alone the full GA fleet) -- that's
// a real sourcing project (FAA Type Certificate Data Sheets are the
// authoritative source), logged as a follow-up. What's here covers the
// aircraft families a typical GA owner/renter is most likely to save:
// Cessna, Piper, Beechcraft, Mooney, Cirrus, Diamond, Grumman/American, and
// Lake singles/twins. Add to this list rather than guessing at matches for
// anything not covered -- a wrong designator is worse than none (it could
// make a genuinely-inapplicable AD look applicable).
export const AIRCRAFT_MODEL_ALIASES: Record<string, string> = {
  // Cessna
  skyhawk: '172', skylane: '182', stationair: '206', centurion: '210',
  skymaster: '337', cardinal: '177', skywagon: '180', skylark: '175',

  // Piper (PA-28 family carries the most trim names)
  cherokee: 'PA-28', warrior: 'PA-28', archer: 'PA-28', cadet: 'PA-28',
  dakota: 'PA-28', arrow: 'PA-28R', 'turbo arrow': 'PA-28R',
  saratoga: 'PA-32', lance: 'PA-32', 'cherokee six': 'PA-32',
  seneca: 'PA-34', seminole: 'PA-44', malibu: 'PA-46', mirage: 'PA-46',
  matrix: 'PA-46', meridian: 'PA-46', aztec: 'PA-23', apache: 'PA-23',
  comanche: 'PA-24', pawnee: 'PA-25', tomahawk: 'PA-38', 'super cub': 'PA-18',
  'cherokee 140': 'PA-28-140', 'cherokee 180': 'PA-28-180',

  // Beechcraft
  bonanza: '36', debonair: '33', baron: '58', duchess: '76',
  'travel air': '95', musketeer: '23', sundowner: '23', sierra: '24',
  sport: '19', duke: '60', 'queen air': '65', 'king air': '90',

  // Mooney (M20 series, many trim names over the years)
  ranger: 'M20', chaparral: 'M20', executive: 'M20', statesman: 'M20',
  eagle: 'M20', ovation: 'M20', bravo: 'M20', acclaim: 'M20', encore: 'M20',

  // Cirrus / Diamond
  katana: 'DA20', eclipse: 'DA20', 'diamond star': 'DA40', 'twin star': 'DA42',

  // Grumman / American Aviation
  traveler: 'AA-5', cheetah: 'AA-5', tiger: 'AA-5', yankee: 'AA-1', lynx: 'AA-1',

  // Lake (the exact case RC flagged live)
  buccaneer: 'LA-4', renegade: 'LA-4',

  // Socata / TBM
  tampico: 'TB-9', tobago: 'TB-10', trinidad: 'TB-20',
}

// Longest key first so "cherokee six" matches before the bare "cherokee"
// substring inside it.
const SORTED_KEYS = Object.keys(AIRCRAFT_MODEL_ALIASES).sort((a, b) => b.length - a.length)

// Looks up a typed model string against the bridge -- exact match first,
// then "the typed text contains a known marketing name" (handles "Lake
// Buccaneer 200" typed as the model, not just the bare "Buccaneer").
export function suggestTypeDesignator(model: string): string | null {
  const m = model.trim().toLowerCase()
  if (!m) return null
  if (AIRCRAFT_MODEL_ALIASES[m]) return AIRCRAFT_MODEL_ALIASES[m]
  for (const key of SORTED_KEYS) {
    if (m.includes(key)) return AIRCRAFT_MODEL_ALIASES[key]
  }
  return null
}

export interface TypeDesignatorSuggestion {
  manufacturer: string
  type_designator: string
}

// Turns a typed query into a Postgres ILIKE pattern that matches it as a
// SUBSEQUENCE of the target -- every character present, in order, gaps
// allowed -- not a contiguous substring. RC: "'172' finds 'C172' and 'P46'
// also finds 'PA46' and 'LA4' finds 'LA-4'... It needs to be flexible and
// truly SS." A plain `%p46%` substring search never finds "PA-46" (the "A"
// and "-" sit between the characters the pilot typed) -- interspersing a
// wildcard between every character of the sanitized query is what makes
// ILIKE itself do subsequence matching: `%P%4%6%` reads as "a P, then
// anything, then a 4, then anything, then a 6," which "PA-46" satisfies
// (P, skip "A-", 4, skip nothing, 6). Strips non-alphanumerics from the
// query first (both to build a clean pattern and so a typed "LA-4"
// matches identically to a typed "LA4") -- the target string's own
// punctuation is never stripped, only skipped over by the wildcards.
export function subsequencePattern(query: string): string {
  const chars = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').split('')
  if (chars.length === 0) return '%'
  return `%${chars.join('%')}%`
}

// Real-fleet autocomplete, backed by the FAA's own Releasable Aircraft
// Registry (sync/migrations_aircraft_type_designators.sql -- 9,229 distinct
// Type-Certificated (manufacturer, designator) pairs, not the ~50-entry
// curated seed above). This is the "real sourcing project" that seed's own
// comment flagged as a follow-up. Complementary to
// AIRCRAFT_MODEL_ALIASES, not a replacement -- that map still does the
// marketing-name -> designator translation (this table has no marketing
// names at all, only the FAA's own technical designation); this backs
// typeahead + validation once the user has a designator-shaped string
// typed, whether from the alias suggestion or typed directly.
//
// Matches on EITHER field so "cessna" surfaces every Cessna type and
// "172" surfaces every model containing it, regardless of which box the
// pilot is typing into. Capped at 8 -- this is a typeahead dropdown, not a
// results page.
export async function searchTypeDesignators(query: string): Promise<TypeDesignatorSuggestion[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const pattern = subsequencePattern(q)
  const { data } = await supabase
    .from('aircraft_type_designators')
    .select('manufacturer, type_designator')
    .or(`manufacturer.ilike.${pattern},type_designator.ilike.${pattern}`)
    .order('manufacturer')
    .limit(8)
  return (data ?? []) as TypeDesignatorSuggestion[]
}

// Distinct manufacturer names for the Make field's own typeahead --
// deliberately PREFIX matching ("C" -> Cessna, Cirrus), not the subsequence
// matching type_designator search uses. Confirmed live: a bare-letter query
// against subsequence matching is far too loose (any manufacturer with a
// "C" ANYWHERE in its name qualifies), and sorting the flood of matches by
// shortest-name-first surfaced obscure names ("AEROCAR", "AERONCA") ahead
// of the well-known ones RC's own example named ("type 'C' in Make... it
// starts to populate things like 'Cessna' and 'Cirrus'") -- a real
// manufacturer name is something a pilot recognizes the START of, not a
// designator string where the interesting content can trail after a
// manufacturer-code prefix (LA-4, PA-46) the way it does for type
// designators. The source data has many near-duplicate spellings for one
// real manufacturer (PIPER / PIPER AIRCRAFT INC / NEW PIPER AIRCRAFT INC,
// all literally distinct strings in the FAA's own registry) -- deduped by
// a normalized key (case/whitespace-insensitive), preferring the SHORTEST
// spelling as the one actually worth showing.
export async function searchManufacturers(query: string): Promise<string[]> {
  const q = query.trim()
  if (q.length < 1) return []
  // Deterministic ordering before the row cap, and a cap wide enough to
  // reliably include a genuinely major manufacturer -- confirmed live as a
  // real problem without both: an unordered `limit(200)` against a prefix
  // with hundreds of obscure one-off registrants (kit builders, defunct
  // shops) could fill its 200 rows without "CESSNA" ever appearing in the
  // sample at all.
  const { data } = await supabase
    .from('aircraft_type_designators')
    .select('manufacturer')
    .ilike('manufacturer', `${q}%`)
    .order('manufacturer')
    .limit(600)
  const byKey = new Map<string, { name: string; count: number }>()
  for (const row of (data ?? []) as { manufacturer: string }[]) {
    const name = row.manufacturer.trim()
    const key = name.toLowerCase()
    const existing = byKey.get(key)
    if (!existing) byKey.set(key, { name, count: 1 })
    else {
      existing.count++
      if (name.length < existing.name.length) existing.name = name
    }
  }
  // Top POPULAR_COUNT by how many distinct type designators this spelling
  // has on file -- a real, data-driven proxy for "well-known" (no
  // popularity signal exists in the FAA's own registry): Cessna/Piper/
  // Beechcraft each have dozens of registered models, a one-off kit
  // builder has one or two -- confirmed live as the fix RC's own example
  // needed, plain shortest-name-first sorting surfaced obscure names
  // ("AEROCAR", "CAMAIR") ahead of "Cessna" and "Cirrus." Then the
  // REMAINDER strictly alphabetical, not also count-ranked -- RC, live,
  // after seeing that first fix: "if our system can do it, we can put the
  // top 5-10 results as 'most popular' before going alphabetical." Popular
  // picks are excluded from the alphabetical tail so nothing repeats.
  const ranked = [...byKey.values()].sort((a, b) => b.count - a.count || a.name.length - b.name.length)
  const popular = ranked.slice(0, POPULAR_COUNT)
  const popularKeys = new Set(popular.map((v) => v.name.toLowerCase()))
  const rest = ranked
    .filter((v) => !popularKeys.has(v.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...popular, ...rest].slice(0, 8).map((v) => v.name)
}

const POPULAR_COUNT = 5

// Marketing-name typeahead for the Model field ("S" -> Skyhawk, Saratoga,
// ...), backed by the curated AIRCRAFT_MODEL_ALIASES bridge above -- PREFIX
// matching, same reasoning as searchManufacturers right above (a marketing
// name is something a pilot recognizes the START of; subsequence matching
// on a bare 1-2 letter query is too loose and buries the obvious answer
// under unrelated names that happen to contain that letter). There is no
// DB table of marketing names to query (the FAA registry only ever
// records the technical designation), so this is a small, synchronous,
// client-side filter over that map's own keys -- multi-word keys like
// "cherokee six" match on the START OF ANY WORD, not just the first, so
// typing "six" still finds "Cherokee Six".
export function searchMarketingNames(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (q.length < 1) return []
  return Object.keys(AIRCRAFT_MODEL_ALIASES)
    .filter((name) => name.split(' ').some((word) => word.startsWith(q)))
    .sort((a, b) => a.length - b.length)
    .slice(0, 8)
    .map((name) => name.replace(/\b\w/g, (c) => c.toUpperCase()))
}
