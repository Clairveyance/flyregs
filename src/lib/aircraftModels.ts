import { supabase } from '@/lib/supabase'
import { subsequenceTightness } from '@/lib/fuzzyMatch'

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
  caravan: '208',
  // RC pushed back on dropping this one, correctly -- the Skycatcher is a
  // real Cessna model, "162" is its real FAA type-certificate designator
  // (notable in its own right: Cessna pursued a full Part 23 TC for it
  // rather than the ASTM-only path most other LSAs took). It came back
  // empty against `aircraft_type_designators` because that table is the
  // Releasable AIRCRAFT REGISTRY -- currently N-registered airframes, not
  // every type ever certificated -- and very few 162s are still on the US
  // registry after the 2014 wing-rib-defect recall grounded/scrapped much
  // of the ~200-unit production run. Absence from a registry of what's
  // FLYING today isn't evidence the designator itself is wrong, just that
  // this app's typeahead won't offer it as a suggestion (a separate,
  // harmless gap) -- restored on the strength of the designator being real,
  // well-documented public knowledge, not a guess.
  skycatcher: '162',

  // Piper (PA-28 family carries the most trim names)
  cherokee: 'PA-28', warrior: 'PA-28', archer: 'PA-28', cadet: 'PA-28',
  dakota: 'PA-28', arrow: 'PA-28R', 'turbo arrow': 'PA-28R',
  saratoga: 'PA-32', lance: 'PA-32', 'cherokee six': 'PA-32',
  seneca: 'PA-34', seminole: 'PA-44', malibu: 'PA-46', mirage: 'PA-46',
  matrix: 'PA-46', meridian: 'PA-46', aztec: 'PA-23', apache: 'PA-23',
  comanche: 'PA-24', 'twin comanche': 'PA-30', pawnee: 'PA-25', tomahawk: 'PA-38', 'super cub': 'PA-18',
  'cherokee 140': 'PA-28-140', 'cherokee 180': 'PA-28-180',
  // RC, 2026-08-14: "do the small [lookup] work by hand for the TCDS, keep
  // cost down" -- added post-launch after confirming TCDS itself carries
  // zero marketing names (only 2 of 365 distinct AD `model` strings do
  // either), so this table's own hand-curated approach is the only real
  // source; expanded it, not replaced it. Real, common gaps a GA
  // owner/renter plausibly has: Piper's pre-Cherokee tube-and-fabric line
  // (Pacer/Tri-Pacer/Colt/Vagabond, all still flying and commonly
  // rented/owned) and the Navajo-family cabin twins.
  pacer: 'PA-20', 'tri-pacer': 'PA-22', colt: 'PA-22-108', vagabond: 'PA-15',
  navajo: 'PA-31', chieftain: 'PA-31-350', 'navajo chieftain': 'PA-31-350',

  // Beechcraft
  // "Bonanza" alone is NOT one designator the way every other marketing
  // name in this table is -- it spans ~50 real, distinct FAA type
  // certificates across 70 years (35/A35.../H35, 33/A33.../G33,
  // A36/A36TC/B36TC/G36...), each with its own AD-applicability scope.
  // A single 'bonanza: 36' alias used to exist here; found and removed
  // 2026-08-19 after confirming live it was a real false-positive source:
  // several older Beechcraft ADs' applicability TEXT includes the bare
  // token "36" as shorthand for the whole 33/35/36 lineage (e.g. AD
  // 2019-21-08 lists "...S35, V35, V35A, and 36..." while explicitly
  // carving OUT A36 by serial range) -- a saved aircraft whose model
  // resolved to bare "36" substring-matched that text and got flagged for
  // ADs that don't apply to it. Per this file's own "a wrong designator is
  // worse than none" stance (see header comment), removed the ambiguous
  // catch-all rather than picking one designator to stand in for all of
  // them, and added the specific, still-commonly-flying variants instead
  // (confirmed real via aircraft_type_designators) so an owner who knows
  // their actual model gets an exact match instead of a guess. A bare
  // "Bonanza" with no variant now correctly falls through to no
  // suggestion at all -- same as any other not-yet-covered marketing name.
  // Keyed by the bare variant name (not "bonanza g36") -- these are
  // themselves real, distinctive Beechcraft product names a pilot is just
  // as likely to type alone ("G36") or in either order ("G36 Bonanza")
  // as after "Bonanza", same as every other bare marketing-name key in
  // this table (skyhawk/warrior/etc. never require the manufacturer name
  // either). Checked for collisions against every other key here first --
  // none.
  g36: 'G36', a36: 'A36', 'v35': 'V35B', f33: 'F33A',
  debonair: '33', baron: '58', duchess: '76',
  'travel air': '95', musketeer: '23', sundowner: '23', sierra: '24',
  sport: '19', duke: '60', 'queen air': '65', 'king air': '90', skipper: '77',

  // Champion / Bellanca / American Champion tailwheel trainers -- still a
  // common rental/owner fleet, and (unlike most of the rest of this table)
  // genuinely different technical designators per trim name, not just a
  // shared family prefix.
  champ: '7AC', citabria: '7GCAA', decathlon: '8KCAB', scout: '8GCBC',

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

// The reverse lookup -- typing/selecting a Type Designator should suggest
// Model name(s) too, not just the other direction (RC: "filling in the
// Type should auto suggest Model names to go with it and v/v"). One
// designator commonly carries SEVERAL marketing names over the PA-28
// family's own trim-name history alone (Cherokee/Warrior/Archer/Cadet/
// Dakota all -> "PA-28") -- returns every match rather than guessing which
// one the owner means; callers auto-fill only when there's exactly one
// candidate and leave Model untouched when there's more than one, same "a
// wrong guess is worse than none" stance suggestTypeDesignator's own
// comment already takes for the forward direction.
export function suggestModelNames(typeDesignator: string): string[] {
  const t = typeDesignator.trim().toLowerCase()
  if (!t) return []
  const names = Object.entries(AIRCRAFT_MODEL_ALIASES)
    .filter(([, designator]) => designator.toLowerCase() === t)
    .map(([name]) => name.replace(/\b\w/g, (c) => c.toUpperCase()))
  return names
}

export interface TypeDesignatorSuggestion {
  manufacturer: string
  type_designator: string
}

// Pure legal-entity-name drift for the SAME real manufacturer over time --
// verified live against the aircraft_type_designators table (not guessed):
// "182T" alone is filed under CESSNA / CESSNA AIRCRAFT CO / CESSNA AIRCRAFT
// INC, three literally different strings for one real company, and this
// pattern repeats across every major manufacturer below. RC: "are they all
// nec? how is that list compiled? if diff, clarify." Deliberately does NOT
// touch the much longer tail of one-off field-modification/STC
// registrations ("CESSNA WREN," "PIPER/DUKE," "BEECH-PARKS," etc.) -- those
// ARE genuinely distinct real registrations, not spelling variants of the
// same company, and already rank far below the real manufacturer by count
// in searchManufacturers' own popularity sort. Bounded to the
// manufacturers a typical GA/business-aircraft owner is most likely to
// search for -- same scoping precedent as AIRCRAFT_MODEL_ALIASES above.
// Expand this table (from real queried data, not a guessed spelling)
// rather than reaching for a general corporate-suffix-stripping heuristic,
// which risks silently merging companies that were never actually the same
// (e.g. TEXTRON AVIATION INC now builds Cessna-designed aircraft but is a
// distinct real registrant from plain CESSNA -- left ungrouped on purpose).
const MANUFACTURER_ALIASES: Record<string, string> = {
  cessna: 'CESSNA', 'cessna aircraft co': 'CESSNA', 'cessna aircraft inc': 'CESSNA',
  piper: 'PIPER', 'piper aircraft inc': 'PIPER', 'piper aircraft corp': 'PIPER',
  'piper aircraft corporation': 'PIPER', 'new piper': 'PIPER', 'new piper aircraft inc': 'PIPER',
  beech: 'BEECHCRAFT', beechcraft: 'BEECHCRAFT', 'beechcraft corp': 'BEECHCRAFT',
  'beech aircraft corp': 'BEECHCRAFT', 'beech aircraft corporation': 'BEECHCRAFT',
  'beech acft corp': 'BEECHCRAFT', 'beechcraft aircraft corp': 'BEECHCRAFT',
  'hawker beechcraft corp': 'BEECHCRAFT', 'beechcraft hawker corp': 'BEECHCRAFT',
  'beechcraft-hawker corp.': 'BEECHCRAFT',
  mooney: 'MOONEY', 'mooney aircraft corp': 'MOONEY', 'mooney aircraft corp.': 'MOONEY',
  'mooney international corp': 'MOONEY', 'mooney airplane co inc': 'MOONEY',
  'diamond aircraft ind gmbh': 'DIAMOND AIRCRAFT', 'diamond aircraft ind inc': 'DIAMOND AIRCRAFT',
  'diamond aircraft industries': 'DIAMOND AIRCRAFT',
  grumman: 'GRUMMAN', 'grumman aircraft eng corp': 'GRUMMAN', 'grumman aircraft eng. corp.': 'GRUMMAN',
  'grumman american avn. corp.': 'GRUMMAN AMERICAN', 'grumman american avn. corp': 'GRUMMAN AMERICAN',
  'grumman american avn corp': 'GRUMMAN AMERICAN',
  socata: 'SOCATA', 'eads socata': 'SOCATA', 'socata group aerospatiale': 'SOCATA',
  'robinson helicopter': 'ROBINSON HELICOPTER', 'robinson helicopter company': 'ROBINSON HELICOPTER',
  'robinson helicopter co': 'ROBINSON HELICOPTER',
  'gulfstream aerospace': 'GULFSTREAM AEROSPACE', 'gulfstream aerospace corp': 'GULFSTREAM AEROSPACE',
  'gulfstream aerospace lp': 'GULFSTREAM AEROSPACE', 'gulfstream aerospacecorp': 'GULFSTREAM AEROSPACE',
  'gulfstream american corp': 'GULFSTREAM AMERICAN', 'gulfstream american corp.': 'GULFSTREAM AMERICAN',
  'gulfstream am corp comm div': 'GULFSTREAM AMERICAN',
  'learjet inc': 'LEARJET', 'learjet corp': 'LEARJET',
  'gates learjet corp': 'GATES LEARJET', 'gates learjet': 'GATES LEARJET',
  'gates learjet corp.': 'GATES LEARJET', 'gates learjet inc': 'GATES LEARJET',
  'bombardier inc': 'BOMBARDIER', 'bombardier aerospace inc': 'BOMBARDIER', 'bombardier aerospace': 'BOMBARDIER',
}

function canonicalManufacturer(name: string): string {
  const key = name.trim().toLowerCase()
  return MANUFACTURER_ALIASES[key] ?? name.trim()
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
// `manufacturer`, when passed, is whatever's currently in the Make field --
// scopes the search to that company (via prefix match on the raw text PLUS
// every known alias variant, see MANUFACTURER_ALIASES) instead of the bare
// unscoped subsequence-across-both-fields search below. RC, live: with
// Make already set to "CIRRUS DESIGN CORP," typing "sr" into Type
// Designator returned a page of unrelated manufacturers sorted
// alphabetically and NOT ONE real Cirrus type (SR20/SR22/SR22T/SF50 are
// all genuinely on file) -- the designator match was never actually
// constrained to the selected Make at all. Two small queries run in
// parallel and get merged/deduped client-side rather than one hand-built
// PostgREST OR-string, so there's no filter-syntax escaping to get wrong.
export async function searchTypeDesignators(query: string, manufacturer?: string): Promise<TypeDesignatorSuggestion[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const pattern = subsequencePattern(q)
  const mfr = manufacturer?.trim()

  let rows: TypeDesignatorSuggestion[]
  if (mfr && mfr.length >= 2) {
    const canonicalMfr = canonicalManufacturer(mfr)
    const aliasVariants = Object.entries(MANUFACTURER_ALIASES)
      .filter(([, canon]) => canon === canonicalMfr)
      .map(([raw]) => raw.toUpperCase())
    const knownVariants = [...new Set([canonicalMfr.toUpperCase(), mfr.toUpperCase(), ...aliasVariants])]
    const [{ data: prefixRows }, { data: aliasRows }] = await Promise.all([
      supabase.from('aircraft_type_designators').select('manufacturer, type_designator')
        .ilike('manufacturer', `${mfr}%`).ilike('type_designator', pattern).limit(40),
      supabase.from('aircraft_type_designators').select('manufacturer, type_designator')
        .in('manufacturer', knownVariants).ilike('type_designator', pattern).limit(40),
    ])
    rows = [...(prefixRows ?? []), ...(aliasRows ?? [])] as TypeDesignatorSuggestion[]
  } else {
    const { data } = await supabase
      .from('aircraft_type_designators')
      .select('manufacturer, type_designator')
      .or(`manufacturer.ilike.${pattern},type_designator.ilike.${pattern}`)
      .order('manufacturer')
      .limit(40)
    rows = (data ?? []) as TypeDesignatorSuggestion[]
  }

  // De-dup so one real type isn't shown once per legal-entity spelling
  // variant on file (see MANUFACTURER_ALIASES above) -- prefer the
  // canonical/shortest spelling as the representative label, same
  // heuristic searchManufacturers already uses for the Make field's own
  // near-duplicate spellings.
  const byKey = new Map<string, TypeDesignatorSuggestion>()
  for (const r of rows) {
    const canon = canonicalManufacturer(r.manufacturer)
    const key = `${r.type_designator.toUpperCase()}::${canon.toLowerCase()}`
    const existing = byKey.get(key)
    if (!existing || canon.length < existing.manufacturer.length) {
      byKey.set(key, { manufacturer: canon, type_designator: r.type_designator })
    }
  }
  // Rank by match TIGHTNESS before the top-8 cap, not plain alphabetical --
  // same fix already shipped for parts search (see fuzzyMatch.ts's header),
  // now confirmed as a real gap here too. Live-verified before this fix:
  // searching "SR22" with no manufacturer put "DHC-1 SERIES 22" and
  // "JETSTREAM 3212" (loose, wide-span subsequence coincidences) ahead of
  // the actual "SR22"/"SR22T" rows in the alphabetical top 8 -- the exact
  // match a pilot is looking for was pushed OUT of the visible window by
  // unrelated types that merely happen to sort earlier. Same shape with
  // "28" under Piper: "PA 28-180"/"PA 28-181" (an inconsistent space-not-
  // hyphen spelling variant) and unrelated "PA-22-108"/"PA-24-180" (contain
  // 2 and 8 as a loose subsequence) crowded out "PA-28"/"PA-28-140" and
  // its real, common variants. Query is uppercased once, matching how
  // subsequencePattern() built the DB-level fetch pattern in the first
  // place, so tightness scoring compares against the same normalized form.
  const qUpper = q.toUpperCase()
  return [...byKey.values()]
    .sort((a, b) => {
      const scoreDiff = subsequenceTightness(b.type_designator.toUpperCase(), qUpper) - subsequenceTightness(a.type_designator.toUpperCase(), qUpper)
      return scoreDiff !== 0 ? scoreDiff : a.type_designator.localeCompare(b.type_designator)
    })
    .slice(0, 8)
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
// all literally distinct strings in the FAA's own registry) -- canonicalized
// through MANUFACTURER_ALIASES first (case/whitespace-only variants would
// never have caught "NEW PIPER AIRCRAFT INC" as the same company; that
// needs the explicit alias table above), THEN deduped by the resulting
// name, preferring the SHORTEST spelling as the one actually worth showing.
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
    const name = canonicalManufacturer(row.manufacturer)
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
