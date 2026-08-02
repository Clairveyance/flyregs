import { supabase } from '@/lib/supabase'
import { relatedComponentType, matchesModelAlias, aliasNameIncludesForWord } from '@/lib/partSynonyms'
import { subsequencePattern } from '@/lib/aircraftModels'

// AD parts/components catalog -- deliberately bounded to parts that have
// actually been named in a real AD's applicability text (see
// sync/extract_ad_parts.py and flyregs_decisions.md's AD Compliance-
// Tracking Scope Decision), not an attempt at a universal parts database.
// Tier boundary (revised 2026-07-28): searching/browsing this catalog is
// Plus; tagging a specific saved aircraft with a part is Premium (that's
// the personalized-tracking layer, gated separately in my-aircraft.tsx).

export type PartComponentType = 'engine' | 'propeller' | 'avionics' | 'airframe' | 'appliance' | 'other'

export const PART_TYPE_LABELS: Record<PartComponentType, string> = {
  engine: 'Engine', propeller: 'Propeller', avionics: 'Avionics',
  airframe: 'Airframe', appliance: 'Appliance', other: 'Other',
}

export interface AdPart {
  id: string
  name: string
  componentType: PartComponentType
  manufacturer: string | null
}

export interface PartMentionAd {
  adNumber: string
  subjectHeading: string
}

export interface PartSearchResult {
  results: AdPart[]
  // Set only when there was no literal match and results came from the
  // common-language fallback below -- lets the UI say "related propeller
  // parts" instead of implying the query word itself was found verbatim.
  relatedTo: PartComponentType | null
  // Set when the full query matched nothing, but DROPPING one or more
  // words (usually a mistyped/nonexistent model number) found real
  // results for what's left -- e.g. "garmin 450" matches nothing ("450"
  // isn't a real Garmin GNS/GTN model), but "garmin" alone does. RC: "our
  // SS should say 'no direct match...try these?'... let's the user know
  // they typed it in wrong" -- this is that signal, distinct from
  // `relatedTo` (which is a component-TYPE family fallback, not a
  // dropped-word one).
  partialMatch: { droppedWords: string[]; usedWords: string[] } | null
}

function mapPartRows(data: any[] | null): AdPart[] {
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, componentType: r.component_type, manufacturer: r.manufacturer }))
}

// Relevance ranking for the filtered result set below. RC, live, on a
// "52241" search surfacing unrelated CF34/CF6 turbofan engine rows ahead
// of clean matches: "what's the idea here? how is this useful? ... Here
// we're looking for parts, not ADs" -- turned out the deeper bug wasn't
// those rows being wrong to INCLUDE (a real query-digit sequence can
// legitimately recur inside a long multi-variant engine listing purely by
// chance -- confirmed live, "CF34-8C5A2, ... CF34-8E2A1" contains 5,2,2,4,1
// scattered across it), it's that the query had NO relevance ranking at
// all -- results were plain `.order('name')`, alphabetical, with a literal
// substring match and a coincidental 100-character-spread match sorted
// identically. Literal-substring-vs-not isn't a strong enough signal
// either: the correct real match for "52241" is itself "52A241" (a
// SUBSEQUENCE match, one inserted letter, not a literal substring) --
// exactly the same match TYPE as the false positive, just far tighter.
// The real signal is SPAN: how many characters of the target string sit
// between the first and last matched query character. "52A241" matches
// "52241" across a 6-character span (queryLen 5 / span 6 = 0.83, almost as
// tight as a literal substring); the CF34 listing matches across 80+
// characters of an unrelated multi-variant string (score near 0). Greedy
// leftmost-match span, not a true minimal-window search -- cheap, and
// good enough for short structured queries like part numbers.
function matchSpan(target: string, query: string): { first: number; last: number } | null {
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

function subsequenceTightness(target: string, query: string): number {
  const span = matchSpan(target, query)
  if (!span) return 0
  return query.length / (span.last - span.first + 1)
}

// `name` is frequently a single comma/semicolon-separated LIST of a dozen+
// part numbers or engine model variants (a real row here lists 18 GEnx
// sub-variants in one string). Every one of those variants is itself
// digit-dense, so a digit-shaped query can land a deceptively tight
// subsequence span by scattering across SEVERAL different list entries
// (confirmed live: "52241" scored a tight-looking span inside
// "RB211-524B-02; -524B2-19..." despite matching no real part there) --
// splitting the field into its individual comma/semicolon-separated
// tokens and scoring each independently (rather than the field as a
// whole) keeps a match honest to a single real part/model number, the
// same way it already naturally is for a short, undelimited field.
function bestTokenTightness(field: string, query: string): number {
  // Some multi-variant listings separate with "/" instead of "," (e.g.
  // "CF6-80C2 A1/A2/A3/A5/A8/A5F..."), same false-positive shape as the
  // comma-separated case -- split on both.
  const tokens = field.split(/[,;/]/)
  let best = 0
  for (const token of tokens) best = Math.max(best, subsequenceTightness(token, query))
  return best
}

// UI-facing counterpart to bestTokenTightness -- a result row's `name` is
// often a dense, comma-separated wall of part numbers (RC, live, on a
// screenshot of exactly this: "b/c there's so many condensed numbers on
// screen, maybe we can 'suggest' correct answer by highlighting them in
// some way to make it easier for the user?"). Returns the exact substring
// (already trimmed, e.g. "52A241" out of the token " part number 52A241")
// that accounts for the match, using matchSpan's own first/last matched-
// character offsets rather than the whole comma-delimited token -- a
// first version highlighted the entire token including leading words like
// "part number", which drew the eye to the wrong thing. Returns null when
// nothing in this field matched any word tightly enough to be worth
// calling out (e.g. the row only matched via manufacturer or
// component_type, not its own name).
export function bestMatchingToken(name: string, words: string[]): string | null {
  const tokens = name.split(/[,;/]/)
  let best: { text: string; score: number } | null = null
  for (const token of tokens) {
    for (const word of words) {
      const w = word.toLowerCase().replace(/[,()%_]/g, '')
      const span = matchSpan(token.toLowerCase(), w)
      if (!span) continue
      const score = w.length / (span.last - span.first + 1)
      if (!best || score > best.score) {
        best = { text: token.slice(span.first, span.last + 1).trim(), score }
      }
    }
  }
  return best?.text ?? null
}

function scorePartRow(words: string[], row: { name: string; manufacturer: string | null; component_type: string }): number {
  let total = 0
  for (const word of words) {
    const w = word.toLowerCase().replace(/[,()%_]/g, '')
    // Model-number alias (e.g. "430" for a row named "Garmin GNS- or
    // GTN-series GPS") counts as a tight, literal-strength match -- see
    // partSynonyms.ts's own header for why this row has no digit in its
    // text to score against normally.
    if (matchesModelAlias(row.name, w)) {
      total += 1
      continue
    }
    const fields = [row.name, row.manufacturer ?? '', row.component_type]
    let best = 0
    for (const field of fields) best = Math.max(best, bestTokenTightness(field.toLowerCase(), w))
    total += best
  }
  return total
}

export async function searchParts(query: string, limit = 25): Promise<PartSearchResult> {
  const trimmed = query.trim()
  const EMPTY: PartSearchResult = { results: [], relatedTo: null, partialMatch: null }
  if (trimmed.length < 2) return EMPTY
  // Each WORD must appear somewhere across name/manufacturer/component_type
  // -- not required as one consecutive phrase, and the old version only
  // ever looked at `name`. Confirmed live as a real precision bug: "MT"
  // matched (a substring of "MTV-5-1 Variable Pitch Propeller"), but "MT
  // Propeller" returned nothing at all, because the manufacturer field
  // ("MT-Propeller Entwicklung GmbH") was never searched, and even if it
  // had been, "MT Propeller" (space) doesn't ILIKE-match "MT-Propeller"
  // (hyphen) as one literal substring -- a MORE specific query returned
  // FEWER results than a shorter one, exactly backwards from what a
  // catalog search needs when users type manufacturer + part name, part
  // numbers, or labels in any order. Chained .or() calls AND together in
  // PostgREST (verified against the live DB before shipping this): each
  // word gets its own OR-across-3-fields clause, and the per-word clauses
  // AND with each other, so every word must match something, in any field,
  // in any order.
  // Same "truly SS" idea as the aircraft type-designator search (RC:
  // "same thing for the parts search. needs to be SS") -- but NOT a
  // blanket subsequencePattern per word. Tried that first and confirmed
  // live it was a real regression: `name` is a long free-text description
  // (a real row here runs 137 characters), and a subsequence pattern for
  // an ordinary word like "propeller" (9 characters, gaps allowed) has
  // enough room in a string that long to match by pure coincidence --
  // searching "MT Propeller" pulled in an unrelated Pratt & Whitney
  // compressor-blade part number that happens to contain p/r/o/p/e/l/l/e/r
  // scattered through it. A type designator ("PA-46") is a short,
  // structured code where that risk doesn't exist; a part's own NAME is
  // prose, where it does. Only apply subsequence matching to a word that
  // itself looks code-shaped (contains a digit -- "52A241", "P46") --
  // ordinary words keep the plain substring match this file's own header
  // comment already tuned for the real MT/MT-Propeller case (which a
  // literal substring already solves: "MT" and "Propeller" are each
  // literal substrings of "MT-Propeller Entwicklung GmbH", no fuzzing
  // needed for that specific gap).
  const words = trimmed
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return EMPTY
  let q = supabase
    .from('ad_parts')
    .select('id, name, component_type, manufacturer')
    .eq('status', 'active')
  for (const word of words) {
    const pattern = /\d/.test(word) ? subsequencePattern(word) : `%${word.replace(/[,()%_]/g, '')}%`
    let orClause = `name.ilike.${pattern},manufacturer.ilike.${pattern},component_type.ilike.${pattern}`
    // Widen the DB-level fetch for a known model-number alias -- otherwise
    // a row like "Garmin GNS- or GTN-series GPS" (no digit anywhere in its
    // text) never even reaches scorePartRow's alias check below, since it
    // fails the literal subsequence pattern at the query level first. See
    // partSynonyms.ts for why this row's own text is generic.
    for (const nameIncludes of aliasNameIncludesForWord(word)) {
      orClause += `,name.ilike.%${nameIncludes}%`
    }
    q = q.or(orClause)
  }
  // Fetch a wider pool than we'll show -- the filter above decides what
  // QUALIFIES, relevance ranking below decides what LEADS. Ordering by
  // `name` here is irrelevant (re-sorted immediately after); it's just a
  // stable tiebreak for the row cap.
  const { data, error } = await q.order('name').limit(Math.max(limit * 4, 60))
  if (error) throw error
  const rawRows = (data ?? []) as { id: string; name: string; component_type: PartComponentType; manufacturer: string | null }[]
  const scored = rawRows
    .map((r) => ({ row: r, score: scorePartRow(words, r) }))
    .sort((a, b) => b.score - a.score)
  // A row that only qualified via the loose whole-field filter above (no
  // real per-token match anywhere -- score 0) is noise once genuine
  // matches exist, not a second-tier result worth showing alongside them.
  // RC, live, on a results list where the two correct part rows were
  // buried under a dozen+ unrelated turbofan engine listings: "what's the
  // idea here? how is this useful? ... make it more relevant." Only fall
  // back to keeping the zero-score rows if dropping them would leave
  // nothing at all -- a weak/coincidental match still beats an empty list.
  const strong = scored.filter((r) => r.score > 0)
  const pool = strong.length > 0 ? strong : scored
  const exact = mapPartRows(pool.slice(0, limit).map((r) => r.row))
  if (exact.length > 0) return { results: exact, relatedTo: null, partialMatch: null }

  // No literal match on the FULL query. Before falling all the way back to
  // a generic component-type family, check whether this is really a
  // dropped-word problem: e.g. "garmin 450" -- "garmin" alone matches real
  // Garmin rows, but no Garmin row has "450" in it anywhere (450 isn't a
  // real Garmin GNS/GTN model), so the strict AND-across-words query above
  // matched nothing even though the user was 90% of the way to a real
  // part. RC, live: "our SS should say 'no direct match...try these?'...
  // let's the user know they typed it in wrong" -- rather than silently
  // guessing what they meant, try dropping ONE word at a time (a genuine
  // leave-one-out re-query, not just "does this word match ANYTHING in
  // the whole catalog" -- tried that first and it was a real bug: a bare
  // 3-digit subsequence like "450" coincidentally matches SOMETHING among
  // 3,000+ rows almost every time, just not anything Garmin-related, so
  // it never looked droppable). Digit-shaped words are tried first since
  // those are the ones a pilot is most likely to have mistyped/misremembered.
  if (words.length > 1) {
    const digitWords = words.filter((w) => /\d/.test(w))
    const otherWords = words.filter((w) => !/\d/.test(w))
    for (const dropped of [...digitWords, ...otherWords]) {
      const usedWords = words.filter((w) => w !== dropped)
      if (usedWords.length === 0) continue
      const partial = await searchParts(usedWords.join(' '), limit)
      if (partial.results.length > 0 && !partial.partialMatch) {
        return { results: partial.results, relatedTo: null, partialMatch: { droppedWords: [dropped], usedWords } }
      }
    }
  }

  // No literal match. ad_parts is deliberately bounded to parts actually
  // named in a real AD's applicability text (see the module comment above),
  // so a common shop word like "spinner" can legitimately have zero rows --
  // that's a correct catalog answer, but a bare dead end isn't what a pilot
  // typing everyday vocabulary expects. Fall back to the part's real family
  // (component_type) via the common-language bridge and show those as
  // related results instead of nothing. RC, live: "you HAVE to find a way
  // to increase the SS capability to understand common language as well as
  // aviation language and make comparisons to help users find their parts."
  const type = relatedComponentType(words)
  if (!type) return EMPTY
  const { data: relData, error: relErr } = await supabase
    .from('ad_parts')
    .select('id, name, component_type, manufacturer')
    .eq('status', 'active')
    .eq('component_type', type)
    .order('name')
    .limit(limit)
  if (relErr) throw relErr
  return { results: mapPartRows(relData), relatedTo: type, partialMatch: null }
}

export async function getAdsForPart(partId: string): Promise<PartMentionAd[]> {
  const { data, error } = await supabase
    .from('ad_part_mentions')
    .select('ad_number, airworthiness_directives!inner(subject_heading)')
    .eq('part_id', partId)
  if (error) throw error
  return (data ?? []).map((r: any) => ({ adNumber: r.ad_number, subjectHeading: r.airworthiness_directives?.subject_heading ?? '' }))
}

export async function suggestPart(name: string, componentType: PartComponentType, manufacturer: string | null, userId: string): Promise<void> {
  const { error } = await supabase.from('ad_parts').insert({
    name: name.trim(),
    component_type: componentType,
    manufacturer: manufacturer?.trim() || null,
    source: 'user_suggested',
    status: 'pending_review',
    suggested_by: userId,
  })
  if (error) throw error
}

// ─── Equipment tags on a saved aircraft ────────────────────────────────────

export interface AircraftEquipment {
  id: string
  part: AdPart
}

export async function getAircraftEquipment(userAircraftId: string): Promise<AircraftEquipment[]> {
  const { data, error } = await supabase
    .from('user_aircraft_equipment')
    .select('id, ad_parts!inner(id, name, component_type, manufacturer)')
    .eq('user_aircraft_id', userAircraftId)
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    part: { id: r.ad_parts.id, name: r.ad_parts.name, componentType: r.ad_parts.component_type, manufacturer: r.ad_parts.manufacturer },
  }))
}

export async function addAircraftEquipment(userAircraftId: string, partId: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_equipment').insert({ user_aircraft_id: userAircraftId, part_id: partId })
  if (error) throw error
}

export async function removeAircraftEquipment(id: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_equipment').delete().eq('id', id)
  if (error) throw error
}

// ─── Maintenance reminders ──────────────────────────────────────────────────
// AD-linked (a specific compliance part) or general (ELT, transponder,
// annual, 100-hour) -- one mechanism for both, see flyregs_decisions.md.
// 100% user-input-driven: the app does date math and notifies, it verifies
// nothing independently.

export interface AircraftReminder {
  id: string
  userAircraftId: string
  title: string
  dueDate: string
  linkedAdNumber: string | null
  notes: string | null
}

export async function getAircraftReminders(userAircraftId: string): Promise<AircraftReminder[]> {
  const { data, error } = await supabase
    .from('user_aircraft_reminders')
    .select('id, user_aircraft_id, title, due_date, linked_ad_number, notes')
    .eq('user_aircraft_id', userAircraftId)
    .order('due_date')
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    userAircraftId: r.user_aircraft_id,
    title: r.title,
    dueDate: r.due_date,
    linkedAdNumber: r.linked_ad_number,
    notes: r.notes,
  }))
}

export async function addAircraftReminder(
  userId: string,
  userAircraftId: string,
  title: string,
  dueDate: string,
  linkedAdNumber?: string | null,
  notes?: string | null,
): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').insert({
    user_id: userId,
    user_aircraft_id: userAircraftId,
    title: title.trim(),
    due_date: dueDate,
    linked_ad_number: linkedAdNumber || null,
    notes: notes?.trim() || null,
  })
  if (error) throw error
}

export async function removeAircraftReminder(id: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').delete().eq('id', id)
  if (error) throw error
}

export async function updateAircraftReminder(
  id: string,
  title: string,
  dueDate: string,
  linkedAdNumber?: string | null,
  notes?: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('user_aircraft_reminders')
    .update({
      title: title.trim(),
      due_date: dueDate,
      linked_ad_number: linkedAdNumber || null,
      notes: notes?.trim() || null,
    })
    .eq('id', id)
  if (error) throw error
}
