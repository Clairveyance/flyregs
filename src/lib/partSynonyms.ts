import type { PartComponentType } from '@/lib/adParts'

// Common-language -> component_type bridge for Parts search.
//
// ad_parts is deliberately bounded to parts actually named in a real AD's
// applicability text (see adParts.ts) -- it is not a universal parts
// database, so a literal word like "spinner" can legitimately have zero
// catalog rows (confirmed against the live DB: 0 of 3,076 active parts
// mention "spinner" in name/manufacturer/component_type, and only one
// unrelated AD body even uses the word). That's a correct answer for an
// EXACT match, but a dead "No matching parts" end is not what a pilot
// typing everyday shop vocabulary expects -- RC, live: "not possible...
// you HAVE to find a way to increase the SS capability to understand
// common language as well as aviation language and make comparisons to
// help users find their parts."
//
// This map answers "what family of catalog parts is this everyday word
// part of?" so a zero-exact-match search can fall back to showing real
// catalog entries for the right component_type instead of nothing --
// framed as related results, never as if the word itself matched.
export const PART_TERM_TO_COMPONENT_TYPE: Record<string, PartComponentType> = {
  // propeller family
  spinner: 'propeller', prop: 'propeller', blade: 'propeller', hub: 'propeller',
  governor: 'propeller', pitch: 'propeller', feathering: 'propeller',

  // engine family
  magneto: 'engine', mag: 'engine', cylinder: 'engine', piston: 'engine',
  carburetor: 'engine', carb: 'engine', turbocharger: 'engine', turbo: 'engine',
  supercharger: 'engine', exhaust: 'engine', muffler: 'engine', crankshaft: 'engine',
  crankcase: 'engine', camshaft: 'engine', valve: 'engine', injector: 'engine',
  alternator: 'engine', generator: 'engine', starter: 'engine', oil: 'engine',
  cooler: 'engine', gasket: 'engine', turbine: 'engine', compressor: 'engine',
  cowling: 'engine', cowl: 'engine', mount: 'engine', mounts: 'engine',
  sparkplug: 'engine', plug: 'engine', plugs: 'engine', fuelpump: 'engine',

  // airframe family
  wing: 'airframe', spar: 'airframe', rib: 'airframe', wheel: 'airframe',
  tire: 'airframe', brake: 'airframe', strut: 'airframe', gear: 'airframe',
  rudder: 'airframe', aileron: 'airframe', elevator: 'airframe', flap: 'airframe',
  flaps: 'airframe', fuselage: 'airframe', tail: 'airframe', stabilizer: 'airframe',
  door: 'airframe', window: 'airframe', windshield: 'airframe', canopy: 'airframe',
  fitting: 'airframe', hinge: 'airframe', bushing: 'airframe', bolt: 'airframe',
  skin: 'airframe', frame: 'airframe', bulkhead: 'airframe', truss: 'airframe',
  skid: 'airframe', float: 'airframe', pontoon: 'airframe',

  // avionics family
  transponder: 'avionics', autopilot: 'avionics', altimeter: 'avionics',
  gps: 'avionics', radio: 'avionics', comm: 'avionics', nav: 'avionics',
  adsb: 'avionics', pitot: 'avionics', static: 'avionics', gyro: 'avionics',
  attitude: 'avionics', indicator: 'avionics', antenna: 'avionics',
  vacuum: 'avionics', compass: 'avionics', headset: 'avionics', display: 'avionics',
  adf: 'avionics', dme: 'avionics',

  // appliance family
  seat: 'appliance', belt: 'appliance', harness: 'appliance', elt: 'appliance',
  oxygen: 'appliance', extinguisher: 'appliance', vest: 'appliance',
  battery: 'appliance', light: 'appliance', lighting: 'appliance', beacon: 'appliance',
  strobe: 'appliance', heater: 'appliance', deicer: 'appliance', deicing: 'appliance',
}

export function relatedComponentType(words: string[]): PartComponentType | null {
  for (const w of words) {
    const hit = PART_TERM_TO_COMPONENT_TYPE[w.toLowerCase()]
    if (hit) return hit
  }
  return null
}

// Model-number bridge for catalog rows named after a real AD's own GENERIC
// applicability language rather than a specific product number. RC, live:
// searched "garmin 450" and got zero results despite a real catalog row
// existing -- confirmed the row's name is "Garmin GNS- or GTN-series GPS"
// because that's verbatim what AD 2014-26-02's applicability text says
// ("a Garmin GNS- or GTN-series global positioning system (GPS)
// installed"), never naming a specific model. That's an accurate
// extraction of the real FAA text, not a bad extraction -- but it means
// the row has NO digit anywhere in name/manufacturer/component_type, so
// the digit-triggered subsequence match this app's own part-number search
// has nothing to match against for a pilot who (correctly, for how they'd
// actually search) types the model number they know their radio by. A
// full-corpus check found 34 of 149 avionics catalog rows have no digit at
// all, but most of those (Autopilot, Radio Altimeter, TCAS II, Air Data
// Computer...) are genuinely generic system names nobody searches by
// number -- GNS-/GTN-series is the one standout where real, well-known
// product numbers exist that the source text just didn't spell out.
// Keyed by a substring of the row's own `name` (not its id, which isn't
// stable against reseeding) -> the real model numbers/nicknames a pilot
// would actually type for that family.
export const PART_NAME_MODEL_ALIASES: { nameIncludes: string; aliases: string[] }[] = [
  {
    nameIncludes: 'garmin gns- or gtn-series',
    aliases: ['430', '430w', '530', '530w', '650', '750', 'gns430', 'gns530', 'gtn650', 'gtn750'],
  },
]

// True if `word` is a known alias for `partName` per the table above --
// i.e. this word SHOULD count as a match for this row even though it
// doesn't literally appear in the row's own text.
export function matchesModelAlias(partName: string, word: string): boolean {
  const lowerName = partName.toLowerCase()
  const lowerWord = word.toLowerCase()
  return PART_NAME_MODEL_ALIASES.some(
    (entry) => lowerName.includes(entry.nameIncludes) && entry.aliases.includes(lowerWord)
  )
}

// The `nameIncludes` substrings this word is a recognized alias for -- used
// to widen the DB-level filter so a row like "Garmin GNS- or GTN-series
// GPS" is even FETCHED for a query word ("430") that doesn't literally
// appear in it, before scoring/matchesModelAlias ever gets a chance to run
// client-side.
export function aliasNameIncludesForWord(word: string): string[] {
  const lowerWord = word.toLowerCase()
  return PART_NAME_MODEL_ALIASES.filter((entry) => entry.aliases.includes(lowerWord)).map((entry) => entry.nameIncludes)
}
