// The "everyday word -> FAA word" layer of SmartSearch.
//
// Why this exists as a separate, hand-written layer: the corpus-derived
// association table (see scripts/build_search_associations.py) is powerful
// but structurally blind to words the FAA never writes. Measured on the real
// corpus: "gas" produced ZERO associations and "skydiving" produced ZERO,
// because Title 14 says "fuel" and "parachute operations". No amount of
// statistics over FAA text can bridge a word that isn't in FAA text -- that
// bridge has to come from general English knowledge, which is what this map
// supplies.
//
// The two layers chain, and that chaining is where the real power is:
//   "gas" --bridge--> "fuel" --corpus--> tank, ignition, vapor, engine
// so one everyday word reaches a whole cluster of real regulatory language.
//
// Entries are lowercase. Keys may be multi-word. Values should be terms that
// actually occur in the corpus, since they get fed back into full-text
// search -- a bridge to a word the FAA also never uses buys nothing.
export const USER_TO_FAA: Record<string, string[]> = {
  // ── Fuel & fluids ────────────────────────────────────────────────────────
  gas: ['fuel', 'avgas', 'gasoline'],
  gasoline: ['fuel', 'avgas'],
  petrol: ['fuel', 'gasoline'],
  'gas up': ['fuel', 'refueling'],
  'fill up': ['fuel', 'refueling'],
  'gas station': ['fueling', 'refueling'],
  jetfuel: ['fuel', 'turbine'],
  'jet fuel': ['fuel', 'kerosene', 'turbine'],
  juice: ['fuel'],
  oil: ['lubricating', 'lubrication', 'engine'],
  fluid: ['hydraulic', 'lubricating'],
  coolant: ['cooling', 'engine'],
  water: ['contamination', 'drain'],

  // ── Weather & sky ────────────────────────────────────────────────────────
  sky: ['sky', 'cloud', 'ceiling', 'overcast', 'obscuration', 'visibility', 'weather'],
  'sky condition': ['ceiling', 'cloud', 'overcast', 'obscuration'],
  clouds: ['cloud', 'ceiling', 'overcast', 'broken', 'scattered'],
  cloudy: ['overcast', 'cloud', 'ceiling'],
  overcast: ['ceiling', 'cloud'],
  foggy: ['fog', 'visibility', 'obscuration'],
  fog: ['visibility', 'obscuration', 'ceiling'],
  haze: ['visibility', 'obscuration'],
  rain: ['precipitation', 'weather'],
  snow: ['precipitation', 'icing', 'contaminated'],
  sleet: ['precipitation', 'icing'],
  hail: ['precipitation', 'thunderstorm'],
  storm: ['thunderstorm', 'convective', 'weather'],
  thunderstorm: ['convective', 'turbulence', 'weather'],
  lightning: ['thunderstorm', 'static'],
  wind: ['crosswind', 'windshear', 'gust'],
  windy: ['wind', 'gust', 'turbulence'],
  gusty: ['gust', 'wind'],
  ice: ['icing', 'ice', 'deicing', 'accretion'],
  icy: ['icing', 'contaminated'],
  freezing: ['icing', 'freezing'],
  bumpy: ['turbulence'],
  rough: ['turbulence'],
  visibility: ['visibility', 'ceiling', 'obscuration'],
  forecast: ['forecast', 'taf', 'prognostic'],
  weather: ['weather', 'meteorological', 'metar', 'forecast', 'ceiling', 'visibility'],

  // ── Skydiving / parachuting ──────────────────────────────────────────────
  skydiving: ['parachute', 'parachuting', 'parachutist', 'jump'],
  skydive: ['parachute', 'parachuting', 'parachutist'],
  skydiver: ['parachutist', 'parachute'],
  jumping: ['parachute', 'parachutist', 'jump'],
  'jump plane': ['parachute', 'parachutist'],
  chute: ['parachute', 'rigger'],
  freefall: ['parachute', 'parachutist'],

  // ── Aircraft & parts ─────────────────────────────────────────────────────
  plane: ['airplane', 'aircraft'],
  airplane: ['airplane', 'aircraft'],
  jet: ['turbojet', 'turbofan', 'turbine'],
  chopper: ['helicopter', 'rotorcraft', 'rotor'],
  copter: ['helicopter', 'rotorcraft'],
  heli: ['helicopter', 'rotorcraft'],
  glider: ['glider', 'sailplane'],
  sailplane: ['glider'],
  balloon: ['balloon', 'lighter-than-air'],
  blimp: ['airship'],
  drone: ['unmanned', 'uas'],
  quadcopter: ['unmanned', 'uas'],
  prop: ['propeller'],
  propeller: ['propeller', 'blade'],
  rotor: ['rotor', 'rotorcraft', 'blade'],
  motor: ['engine', 'powerplant'],
  engine: ['engine', 'powerplant', 'turbine'],
  powerplant: ['engine', 'powerplant'],
  wing: ['wing', 'airfoil'],
  tail: ['empennage', 'stabilizer', 'rudder'],
  rudder: ['rudder', 'yaw'],
  flaps: ['flap', 'lift'],
  gear: ['landing', 'gear'],
  'landing gear': ['gear', 'retractable'],
  wheel: ['gear', 'tire', 'brake'],
  tire: ['tire', 'gear'],
  tyre: ['tire', 'gear'],
  brakes: ['brake'],
  seat: ['seat', 'restraint'],
  seatbelt: ['restraint', 'belt', 'harness'],
  'seat belt': ['restraint', 'belt', 'harness'],
  belt: ['restraint', 'harness'],
  window: ['windshield', 'window'],
  windshield: ['windshield'],
  door: ['door', 'exit'],
  battery: ['battery', 'electrical'],
  wiring: ['wiring', 'electrical'],
  antenna: ['antenna'],
  radio: ['radio', 'communication', 'transceiver'],
  transponder: ['transponder', 'squawk'],
  altimeter: ['altimeter', 'altitude'],
  autopilot: ['autopilot', 'automatic'],

  // ── Flight phases & maneuvers ────────────────────────────────────────────
  takeoff: ['takeoff', 'departure'],
  'take off': ['takeoff', 'departure'],
  departure: ['departure', 'takeoff'],
  landing: ['landing', 'approach'],
  land: ['landing', 'approach'],
  touchdown: ['landing', 'touchdown'],
  'go around': ['missed', 'approach'],
  goaround: ['missed', 'approach'],
  climb: ['climb', 'ascent'],
  descend: ['descent'],
  descent: ['descent'],
  turn: ['turn', 'bank'],
  bank: ['bank', 'turn'],
  cruise: ['cruise', 'enroute'],
  taxi: ['taxi', 'taxiway', 'ground'],
  park: ['parking', 'ramp'],
  hover: ['hover', 'helicopter'],
  stall: ['stall', 'spin', 'recovery'],
  spin: ['spin', 'stall', 'recovery'],
  slip: ['slip', 'sideslip'],
  glide: ['glide', 'gliding'],

  // ── Emergencies ──────────────────────────────────────────────────────────
  crash: ['accident', 'collision'],
  accident: ['accident', 'incident'],
  emergency: ['emergency', 'distress', 'urgency'],
  mayday: ['distress', 'emergency'],
  'engine out': ['failure', 'engine', 'emergency'],
  'engine failure': ['failure', 'engine', 'emergency'],
  fire: ['fire', 'extinguisher', 'smoke'],
  smoke: ['smoke', 'fire'],
  ditching: ['ditching', 'flotation', 'water'],
  evacuate: ['evacuation', 'exit'],
  survival: ['survival', 'emergency'],

  // ── People & certificates ────────────────────────────────────────────────
  license: ['certificate', 'rating'],
  licence: ['certificate', 'rating'],
  cert: ['certificate'],
  certificate: ['certificate', 'rating'],
  rating: ['rating', 'certificate'],
  student: ['student', 'solo', 'training'],
  instructor: ['instructor', 'flight'],
  cfi: ['instructor'],
  examiner: ['examiner', 'practical'],
  checkride: ['practical', 'test', 'examiner'],
  'check ride': ['practical', 'test'],
  logbook: ['logbook', 'record'],
  'flight time': ['flight', 'time', 'logging'],
  currency: ['recent', 'experience', 'currency'],
  medical: ['medical', 'certificate', 'airman'],
  passenger: ['passenger', 'occupant'],
  crew: ['crewmember', 'crew'],
  mechanic: ['mechanic', 'maintenance', 'technician'],
  controller: ['controller', 'atc'],
  dispatcher: ['dispatcher', 'dispatch'],

  // ── Medical / fitness ────────────────────────────────────────────────────
  drunk: ['alcohol', 'intoxicated'],
  alcohol: ['alcohol', 'intoxicated'],
  booze: ['alcohol'],
  drinking: ['alcohol'],
  drugs: ['drug', 'substance'],
  marijuana: ['drug', 'substance'],
  tired: ['fatigue', 'rest', 'duty'],
  fatigue: ['fatigue', 'rest', 'duty'],
  sick: ['medical', 'illness'],
  illness: ['medical', 'illness'],
  vision: ['vision', 'visual', 'medical'],
  eyes: ['vision', 'visual'],
  hearing: ['hearing', 'audio'],
  ears: ['hearing', 'ear'],
  hypoxia: ['hypoxia', 'oxygen'],
  oxygen: ['oxygen', 'hypoxia', 'pressurization'],

  // ── Airspace, airports, nav ──────────────────────────────────────────────
  airport: ['airport', 'aerodrome'],
  field: ['airport', 'runway'],
  strip: ['runway', 'airport'],
  runway: ['runway', 'threshold', 'centerline'],
  taxiway: ['taxiway', 'taxi'],
  apron: ['ramp', 'apron'],
  ramp: ['ramp', 'apron'],
  tower: ['tower', 'atc', 'controller'],
  atc: ['atc', 'controller', 'clearance'],
  clearance: ['clearance', 'atc'],
  airspace: ['airspace', 'class'],
  'class a': ['airspace', 'class'],
  'class b': ['airspace', 'class'],
  'class c': ['airspace', 'class'],
  'class d': ['airspace', 'class'],
  'class e': ['airspace', 'class'],
  'class g': ['airspace', 'class'],
  // Phonetic-alphabet airspace names are standard aviation phraseology
  // ("Class Bravo," not just "Class B") but the letter-form entries above
  // never match them at all -- confirmed live: "class bravo" against AIM's
  // search_aim doesn't even surface Class B Airspace in the top 3 (ts_rank
  // can't tell "bravo" apart from noise, so B/C/D/E paragraphs all rank
  // identically on "class"+"airspace" alone and ties break by insertion
  // order, which happens to exclude B). These map to the literal phrase
  // ("class b") rather than the generic terms above, since that's a much
  // stronger, letter-specific signal against a title like "Class B Airspace."
  'class alpha': ['class a', 'airspace'],
  'class bravo': ['class b', 'airspace'],
  'class charlie': ['class c', 'airspace'],
  'class delta': ['class d', 'airspace'],
  'class echo': ['class e', 'airspace'],
  'class golf': ['class g', 'airspace'],
  tfr: ['restriction', 'temporary', 'airspace'],
  notam: ['notam', 'notice'],
  map: ['chart', 'navigation'],
  chart: ['chart', 'navigation'],
  gps: ['gps', 'navigation', 'satellite'],
  navigation: ['navigation', 'course', 'route'],
  compass: ['compass', 'magnetic', 'heading'],
  heading: ['heading', 'course', 'magnetic'],
  altitude: ['altitude', 'elevation'],
  night: ['night', 'darkness', 'lighting'],
  dark: ['night', 'darkness'],
  ifr: ['ifr', 'instrument'],
  vfr: ['vfr', 'visual'],
  instrument: ['instrument', 'ifr'],
  approach: ['approach', 'ils', 'instrument'],
  ils: ['ils', 'approach', 'localizer'],
  holding: ['holding', 'hold'],
  wake: ['wake', 'vortex', 'turbulence'],
  turbulence: ['turbulence', 'wake', 'convective'],

  // ── Ops & maintenance ────────────────────────────────────────────────────
  maintenance: ['maintenance', 'inspection', 'repair'],
  repair: ['repair', 'maintenance', 'alteration'],
  fix: ['repair', 'corrective'],
  annual: ['annual', 'inspection'],
  inspection: ['inspection', 'inspect'],
  overhaul: ['overhaul', 'maintenance'],
  airworthy: ['airworthiness', 'airworthy'],
  grounded: ['airworthiness', 'prohibited'],
  charter: ['charter', 'commercial', 'common', 'carriage'],
  'for hire': ['compensation', 'hire', 'commercial'],
  paid: ['compensation', 'hire'],
  money: ['compensation', 'hire'],
  rental: ['rental', 'lease'],
  lease: ['lease', 'leasing'],
  insurance: ['insurance', 'liability'],
  cargo: ['cargo', 'freight'],
  baggage: ['baggage', 'cargo'],
  weight: ['weight', 'balance', 'loading'],
  balance: ['balance', 'weight', 'center'],
  noise: ['noise', 'abatement'],
  banner: ['banner', 'towing'],
  towing: ['towing', 'tow'],
  hood: ['simulated instrument', 'view limiting device'],
  'hood time': ['simulated instrument', 'instrument training'],
  loops: ['aerobatic', 'aerobatic flight'],
  'barrel roll': ['aerobatic', 'aerobatic flight'],
  'too low': ['minimum safe altitude', 'minimum altitudes'],
  'jumping out': ['parachute', 'parachute operations'],
  wx: ['weather'],
  'wx mins': ['weather minimums', 'basic vfr weather minimums'],
  mins: ['minimums'],
  'vfr mins': ['vfr weather minimums', 'basic vfr weather minimums'],
  pic: ['pilot in command'],
  'pic responsibility': ['pilot in command responsibility', 'responsibility and authority'],
  drink: ['alcohol', 'intoxicating liquor'],
  agricultural: ['agricultural', 'dispensing'],
  crop: ['agricultural', 'dispensing'],
  firefighting: ['firefighting', 'dispensing'],
}

// Returns the FAA-vocabulary terms an everyday query should ALSO be searched
// as.
//
// This used to be an EXACT whole-query match, on the reasoning that a partial
// hit ("gas" inside "gas turbine engine") would over-expand a query the user
// had already made specific. Measured, that rule cost far more than it saved:
// the entire "everyday phrasing" category scored 0/6, because nobody types
// the bare keyword. They type "how much gas do I need", "flying drunk",
// "jumping out of a plane" -- none of which are whole-query matches, so the
// bridge never fired at all.
//
// Now: match the LONGEST bridge entries that appear in the query as whole
// words. Two guards keep the original intent:
//   - whole-word only, so "gas" doesn't fire inside "gasket"
//   - skip an entry whose FAA term the query ALREADY uses, which is the
//     "user was already specific" case the exact-match rule was protecting
export function bridgeTerms(query: string): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return []

  const direct = USER_TO_FAA[q]
  if (direct) return direct.filter((t) => t !== q)
  if (q.endsWith('s')) {
    const singular = USER_TO_FAA[q.slice(0, -1)]
    if (singular) return singular.filter((t) => t !== q)
  }

  // Longest key first: "seat belt" should win over "belt".
  const keys = Object.keys(USER_TO_FAA).sort((a, b) => b.length - a.length)
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (out.length >= 6) break
    const re = new RegExp(`(^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    if (!re.test(q)) continue
    for (const term of USER_TO_FAA[key]) {
      const t = term.toLowerCase()
      // Already specific: the query uses the FAA word itself.
      if (q.includes(t)) continue
      if (seen.has(t)) continue
      seen.add(t)
      out.push(term)
    }
  }
  return out.slice(0, 6)
}
