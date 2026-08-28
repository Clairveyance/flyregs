import { supabase } from '@/lib/supabase'
import { relatedComponentType, matchesModelAlias, aliasNameIncludesForWord } from '@/lib/partSynonyms'
import { subsequencePattern } from '@/lib/aircraftModels'
import { matchSpan, bestTokenTightness } from '@/lib/fuzzyMatch'

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
  // Set when every literal-match strategy above (exact/substring, drop-a-
  // word, component-type family) found nothing, but pg_trgm trigram
  // similarity did -- a genuine MISSPELLING, not a missing/wrong word.
  // Confirmed live as a real gap 2026-08-12: "Lycomming" (one extra
  // letter, a completely realistic typo) returned nothing at all even
  // though "Lycoming" has 10+ real rows -- partialMatch's drop-a-word
  // retry never applies to a single-word query, and a garbled
  // manufacturer name isn't common-English vocabulary the component-type
  // bridge recognizes either. Last resort in the chain, same "only after
  // every literal strategy has failed" posture as relatedTo.
  fuzzyMatch: { originalQuery: string } | null
}

function mapPartRows(data: any[] | null): AdPart[] {
  return (data ?? []).map((r: any) => ({ id: r.id, name: r.name, componentType: r.component_type, manufacturer: r.manufacturer }))
}

// Relevance-ranking primitives (matchSpan, subsequenceTightness,
// bestTokenTightness) moved to lib/fuzzyMatch.ts 2026-08-14 so
// aircraftModels.ts's type-designator search could reuse the exact same
// fix without a circular import -- see that file's header for the full
// "52241" false-positive story this scoring approach was built to solve.

// A query word containing "&" is almost always a manufacturer abbreviation
// a pilot/mechanic actually types this way ("P&W", "GmbH & Co") -- but the
// catalog's own text always has real spaces around the ampersand ("Pratt &
// Whitney Canada", "BRP-Rotax GmbH & Co. KG"). A literal-substring pattern
// can never bridge that -- "p&w" is not a substring of "pratt & whitney"
// no matter how the rest of the word is cleaned, so this manufacturer was
// unreachable by its single most common real-world abbreviation. Only the
// gap AROUND the "&" needs wildcarding, not every character (that would be
// blanket subsequencePattern-style looseness, which this file's own header
// comment already found to be too permissive for ordinary prose fields) --
// the letters on each side of the "&" stay literal, so "p&w" only ever
// matches text shaped like "p...&...w", not any coincidental scatter.
function ampersandPattern(word: string): string {
  const parts = word.split('&').map((p) => p.replace(/[,()%_]/g, ''))
  return `%${parts.join('%&%')}%`
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
  const EMPTY: PartSearchResult = { results: [], relatedTo: null, partialMatch: null, fuzzyMatch: null }
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
    const pattern = /\d/.test(word)
      ? subsequencePattern(word)
      : word.includes('&')
        ? ampersandPattern(word)
        : `%${word.replace(/[,()%_]/g, '')}%`
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
  if (exact.length > 0) return { results: exact, relatedTo: null, partialMatch: null, fuzzyMatch: null }

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
        return { results: partial.results, relatedTo: null, partialMatch: { droppedWords: [dropped], usedWords }, fuzzyMatch: null }
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
  if (type) {
    const { data: relData, error: relErr } = await supabase
      .from('ad_parts')
      .select('id, name, component_type, manufacturer')
      .eq('status', 'active')
      .eq('component_type', type)
      .order('name')
      .limit(limit)
    if (relErr) throw relErr
    if (relData && relData.length > 0) return { results: mapPartRows(relData), relatedTo: type, partialMatch: null, fuzzyMatch: null }
  }

  // Last resort: trigram similarity (pg_trgm, see migrations_ad_parts_
  // fuzzy_search.sql) against the FULL original query -- catches a genuine
  // misspelling ("Lycomming" for "Lycoming") that no strategy above can,
  // since drop-a-word only fires on a multi-word query and a garbled
  // manufacturer name isn't common-English vocabulary the component-type
  // bridge above recognizes. Only tried after every literal strategy has
  // failed, matching this whole chain's "last resort, not first choice"
  // posture -- a real substring/subsequence match should always win over
  // a fuzzy guess.
  const { data: fuzzyData, error: fuzzyErr } = await supabase.rpc('search_ad_parts_fuzzy', { p_query: trimmed, p_limit: limit })
  if (fuzzyErr) throw fuzzyErr
  if (fuzzyData && fuzzyData.length > 0) {
    return { results: mapPartRows(fuzzyData), relatedTo: null, partialMatch: null, fuzzyMatch: { originalQuery: trimmed } }
  }

  return EMPTY
}

export async function getAdsForPart(partId: string): Promise<PartMentionAd[]> {
  // Ordered descending by AD number -- the FAA's own "YYYY-NN-NN" numbering
  // is chronological, so this also puts the most recent AD first, matching
  // what an owner scanning for the newest applicable directive would want.
  // Previously had no order() at all (arbitrary Postgres/PostgREST return
  // order) -- found during a 2026-08-12 parts-lookup review.
  const { data, error } = await supabase
    .from('ad_part_mentions')
    .select('ad_number, airworthiness_directives!inner(subject_heading)')
    .eq('part_id', partId)
    .order('ad_number', { ascending: false })
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
  // "Every X hours" recurrence for this specific part -- e.g. a 100-hour
  // inspection item. Independent of the general Reminders list: this lives
  // on the part itself so the compliance mark travels with the equipment
  // tag (RC: "each part box needs an input sheet" for its own date/hour
  // requirement). Nullable -- most tagged parts (e.g. an avionics box just
  // tagged for AD matching) carry no tracking at all.
  intervalHours: number | null
  // The actual next-due mark. Client auto-computes this as the aircraft's
  // current_hobbs_hours + intervalHours at the moment the part is added,
  // but it's a plain editable numeric column -- an owner whose part
  // already has hours on it (installed before they started using FlyRegs)
  // overrides it with a custom starting point instead of "now."
  dueHobbsHours: number | null
  // Independent calendar-based due mark -- a part can be tracked by
  // hours, by date, by both, or by neither.
  dueDate: string | null
}

export async function getAircraftEquipment(userAircraftId: string): Promise<AircraftEquipment[]> {
  const { data, error } = await supabase
    .from('user_aircraft_equipment')
    .select('id, interval_hours, due_hobbs_hours, due_date, ad_parts!inner(id, name, component_type, manufacturer)')
    .eq('user_aircraft_id', userAircraftId)
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    part: { id: r.ad_parts.id, name: r.ad_parts.name, componentType: r.ad_parts.component_type, manufacturer: r.ad_parts.manufacturer },
    intervalHours: r.interval_hours,
    dueHobbsHours: r.due_hobbs_hours,
    dueDate: r.due_date,
  }))
}

export interface PartTracking {
  intervalHours: number | null
  dueHobbsHours: number | null
  dueDate: string | null
}

export async function addAircraftEquipment(userAircraftId: string, partId: string, tracking?: PartTracking): Promise<void> {
  const { error } = await supabase.from('user_aircraft_equipment').insert({
    user_aircraft_id: userAircraftId,
    part_id: partId,
    interval_hours: tracking?.intervalHours ?? null,
    due_hobbs_hours: tracking?.dueHobbsHours ?? null,
    due_date: tracking?.dueDate ?? null,
  })
  if (error) throw error
}

export async function updateAircraftEquipmentTracking(id: string, tracking: PartTracking): Promise<void> {
  const { error } = await supabase
    .from('user_aircraft_equipment')
    .update({
      interval_hours: tracking.intervalHours,
      due_hobbs_hours: tracking.dueHobbsHours,
      due_date: tracking.dueDate,
    })
    .eq('id', id)
  if (error) throw error
}

// Deleting the tag alone was never enough. Every AD that mentions a tagged
// part also has its own user_ad_notifications row (matched_via =
// 'equipment', written by backfill_aircraft_ad_notifications() /
// send-ad-alerts.mjs), and nothing removed those when the tag went away --
// so the remove-equipment confirm's own promise ("AD alerts matched only by
// this equipment will stop appearing") was simply false, and a mistagged
// part left its ADs permanently inflating the aircraft's open-AD count on
// both the Fleet list and the detail screen. Confirmed live 2026-08-22: tag
// a part, backfill, delete the tag -> all 4 equipment-matched rows still
// present. prune_orphaned_equipment_ad_notifications() (see
// sync/migrations_fleet_sweep_2026_08_22.sql) removes exactly the rows no
// remaining tag can still justify -- never airframe matches, never a
// complied compliance record, never an already-dismissed row.
//
// Runs AFTER the delete, and reads the row's aircraft id BEFORE it, since
// the prune's own "is any still-tagged part responsible for this AD?" test
// has to see the post-delete tag set. Ordering also matters at the one call
// site that swaps a part (PartPickerModal's editing branch adds the new tag
// before removing the old one), so an AD shared by both parts is correctly
// kept rather than pruned and re-added.
export async function removeAircraftEquipment(id: string): Promise<void> {
  const { data: row, error: readErr } = await supabase
    .from('user_aircraft_equipment')
    .select('user_aircraft_id')
    .eq('id', id)
    .maybeSingle()
  if (readErr) throw readErr
  const { error } = await supabase.from('user_aircraft_equipment').delete().eq('id', id)
  if (error) throw error
  if (!row?.user_aircraft_id) return
  const { error: pruneErr } = await supabase.rpc('prune_orphaned_equipment_ad_notifications', {
    p_user_aircraft_id: row.user_aircraft_id,
  })
  // Best-effort, but not silent: the tag itself is already gone either way,
  // this only affects whether its stale AD rows got cleaned up with it.
  if (pruneErr) console.error('Failed to prune orphaned equipment AD matches:', pruneErr.message)
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
  // Nullable -- 100-Hour and AD Compliance reminders aren't calendar-
  // interval-based, and a Custom reminder may have no fixed recurrence.
  // See sync/migrations_reminder_interval.sql for why this now persists
  // (was a client-only creation-time convenience before).
  intervalMonths: number | null
  // Parallel days-based interval for reminders whose real regulatory cycle
  // isn't month-granular (VOR check, 14 CFR 91.171, is a strict 30-day
  // currency). Mutually exclusive with intervalMonths -- see
  // sync/migrations_reminder_interval_days.sql's CHECK constraint.
  intervalDays: number | null
  // Optional usage-based due mark (100-hour, TBO, etc), compared live
  // against the aircraft's own current_hobbs_hours. See
  // sync/migrations_hobbs_tracking.sql -- v1 is manual-reset only, no
  // auto-generated future cycles.
  dueHobbsHours: number | null
}

export async function getAircraftReminders(userAircraftId: string): Promise<AircraftReminder[]> {
  const { data, error } = await supabase
    .from('user_aircraft_reminders')
    .select('id, user_aircraft_id, title, due_date, linked_ad_number, notes, interval_months, interval_days, due_hobbs_hours')
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
    intervalMonths: r.interval_months,
    intervalDays: r.interval_days,
    dueHobbsHours: r.due_hobbs_hours,
  }))
}

export async function addAircraftReminder(
  userId: string,
  userAircraftId: string,
  title: string,
  dueDate: string,
  linkedAdNumber?: string | null,
  notes?: string | null,
  intervalMonths?: number | null,
  dueHobbsHours?: number | null,
  intervalDays?: number | null,
): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').insert({
    user_id: userId,
    user_aircraft_id: userAircraftId,
    title: title.trim(),
    due_date: dueDate,
    linked_ad_number: linkedAdNumber || null,
    notes: notes?.trim() || null,
    interval_months: intervalMonths ?? null,
    interval_days: intervalDays ?? null,
    due_hobbs_hours: dueHobbsHours ?? null,
  })
  if (error) throw error
}

export async function removeAircraftReminder(id: string): Promise<void> {
  const { error } = await supabase.from('user_aircraft_reminders').delete().eq('id', id)
  if (error) throw error
}

// NOTE on notified_at: this deliberately does NOT send it. Rolling a
// recurring reminder's due date forward is the only "I did this, schedule
// the next one" action the app offers (there is no complete/reset button --
// the form's own field is literally labelled "LENGTH (RECURS EVERY)"), and
// send-reminder-alerts.mjs pushes once per row, tracked by notified_at. So
// an edited-forward reminder used to keep its old notified_at stamp and
// never push again for the life of the row -- confirmed live 2026-08-22.
// Fixed in the DB instead of here (trg_rearm_reminder_on_due_date_change,
// sync/migrations_fleet_sweep_2026_08_22.sql): the rule belongs to the row,
// not to this one form -- an editor collaborator writes the same table, and
// a trigger can't be forgotten by a future call site the way an extra
// argument here could. It fires only when due_date actually changes, so
// editing a title/notes/interval on an already-pushed reminder still
// doesn't re-notify.
export async function updateAircraftReminder(
  id: string,
  title: string,
  dueDate: string,
  linkedAdNumber?: string | null,
  notes?: string | null,
  intervalMonths?: number | null,
  dueHobbsHours?: number | null,
  intervalDays?: number | null,
): Promise<void> {
  const { error } = await supabase
    .from('user_aircraft_reminders')
    .update({
      title: title.trim(),
      due_date: dueDate,
      linked_ad_number: linkedAdNumber || null,
      notes: notes?.trim() || null,
      interval_months: intervalMonths ?? null,
      interval_days: intervalDays ?? null,
      due_hobbs_hours: dueHobbsHours ?? null,
    })
    .eq('id', id)
  if (error) throw error
}
