import { supabase } from '@/lib/supabase'
import type { StudyLevel } from '@/lib/challenges'
import type { CategoryClass } from '@/lib/profileRatings'
export type { CategoryClass, StudyRating } from '@/lib/profileRatings'

export type StudyItemType = 'pcg' | 'far' | 'aim' | 'ac' | 'dictionary' | 'cfr49'

// The TOPIC axis: what a regulation is ABOUT, as opposed to which corpus it
// lives in (Content), who needs it (Knowledge Level) or what it flies
// (Category/Class). Derived server-side by study_topic() -- see
// scripts/study_topic_map.py, which generates that function and is scored
// against the 1,000 hand-labelled questions.
//
// Order is deliberate: the topics a certificate candidate reaches for first,
// then the specialist ones. Not alphabetical, and not by pool size -- a
// student should find "Airspace" and "VFR Weather Minimums" without reading
// the whole row.
export type StudyTopic = string
export const STUDY_TOPICS: readonly string[] = [
  'Airspace',
  'VFR Weather Minimums',
  'Altitudes & Speed Limits',
  'Right-of-Way & Operating Rules',
  'Required Documents & Equipment',
  'Fuel, Oxygen & Life Support',
  'Airport Operations',
  'ATC Communications & Clearances',
  'Weather & Safety of Flight',
  'Navigation',
  'Flight Planning',
  'IFR Procedures',
  'Emergency Procedures',
  'Accident Reporting',
  'Certificates & Ratings',
  'Medical & Fitness',
  'Logging, Currency & Proficiency',
  'Knowledge & Practical Tests',
  'Student Pilot & Solo',
  'Flight Instructors',
  'Maintenance & Airworthiness',
  'Aircraft Registration & Marking',
  'Aircraft Certification Standards',
  'Definitions',
  'Remote Pilot Operations',
  'Hazardous Materials',
  'Aviation Security',
  'Air Carrier & Commercial Operations',
]

// Shortened labels for the chips -- the full names are section headings, too
// long to sit in a filter row on a 375pt screen.
export const STUDY_TOPIC_LABELS: Record<string, string> = {
  'Right-of-Way & Operating Rules': 'Right-of-Way & Ops',
  'Required Documents & Equipment': 'Docs & Equipment',
  'Fuel, Oxygen & Life Support': 'Fuel & Oxygen',
  'ATC Communications & Clearances': 'ATC & Clearances',
  'Weather & Safety of Flight': 'Weather',
  'Logging, Currency & Proficiency': 'Logging & Currency',
  'Knowledge & Practical Tests': 'Tests',
  'Maintenance & Airworthiness': 'Maintenance',
  'Aircraft Registration & Marking': 'Registration & Marks',
  'Aircraft Certification Standards': 'Certification Stds',
  'Air Carrier & Commercial Operations': 'Air Carrier Ops',
  'Remote Pilot Operations': 'Remote Pilot',
  'VFR Weather Minimums': 'VFR Minimums',
  'Altitudes & Speed Limits': 'Altitudes & Speed',
}

export interface StudyCard {
  item_id: string
  item_type: StudyItemType
  term: string
  definition: string
  is_new: boolean
}

export interface StudyMastery {
  mastered: number
  seen: number
  total_available: number
  pct: number
}

// Mixes due reviews (spaced-repetition schedule) with fresh, never-seen terms
// (frequently-used ones first) -- see get_study_queue() in Postgres. Deck
// size is deliberately small (a single sitting), not "start the whole
// glossary" -- matches how real spaced-repetition study tools pace sessions.
export async function getStudyQueue(
  limit = 20,
  itemTypes?: StudyItemType[],
  levels?: StudyLevel[],
  categoryClasses?: CategoryClass[],
  topics?: StudyTopic[]
): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('get_study_queue', {
    p_limit: limit,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
    p_topics: topics && topics.length > 0 ? topics : null,
  })
  if (error) throw error
  return withSeeRefListItems((data ?? []) as StudyCard[])
}

// A handful of P/CG entries are defined as a bare lead-in plus a list, where
// the FAA marks the list items up as "See" cross-references rather than as
// prose -- so pcg_terms.definition really is just "Any of the following:"
// and the four items live in see_refs. The detail screen has always shown
// both, but a study card renders `definition` alone, which is how a beta
// tester got a flashcard whose entire text was "Any of the following:"
// (2026-08-22: "The answer says any of the following and there's nothing
// following."). She was looking at APPROPRIATE OBSTACLE CLEARANCE MINIMUM
// ALTITUDE or its TERRAIN twin -- corpus-wide those are now the only two
// left, since the other 46 bare lead-ins were the pcg_scraper.py <ol> bug
// fixed alongside this.
//
// Kept here rather than in get_study_queue() so it stays reviewable app-side
// code instead of another RPC to keep in sync, and rather than folding the
// refs into pcg_terms.definition itself -- the scraper re-upserts that
// column verbatim from the FAA's HTML every week (sync_pcg.sh documents two
// separate fixes already lost that way), and the detail screen would then
// render the same four items twice, once as text and once as its own
// see_refs links.
//
// One extra query, only when such a card is actually dealt.
async function withSeeRefListItems(cards: StudyCard[]): Promise<StudyCard[]> {
  const bare = cards.filter((c) => c.item_type === 'pcg' && /:\s*$/.test(c.definition ?? ''))
  if (bare.length === 0) return cards
  const { data, error } = await supabase
    .from('pcg_terms')
    .select('slug, see_refs')
    .in('slug', bare.map((c) => c.item_id))
  // Non-fatal: a card showing only its lead-in is exactly today's behavior,
  // and is a far better outcome than failing the whole study session.
  if (error || !data) return cards
  const refsBySlug = new Map<string, string[]>(
    data.map((r) => [r.slug as string, (r.see_refs ?? []) as string[]])
  )
  const bareIds = new Set(bare.map((c) => c.item_id))
  return cards.map((c) => {
    if (c.item_type !== 'pcg' || !bareIds.has(c.item_id)) return c
    const refs = refsBySlug.get(c.item_id)
    if (!refs || refs.length === 0) return c
    // Two constraints decide this exact shape, and they pull opposite ways:
    //
    // \n\n between items is load-bearing, NOT cosmetic. Bookmarking a card
    // snippets from `normalizeRegBody(definition).split('\n\n')[0]` (see
    // study.tsx) precisely so the captured span can't cross a paragraph the
    // detail screen's search treats as absolute. Everything appended here
    // is app-side only -- it is deliberately not in pcg_terms.definition --
    // so it must stay out of that first paragraph, or the bookmark would
    // highlight text the detail screen has no way to find.
    //
    // The bullet is what makes the card readable: buildStudyCard runs the
    // text through condenseDefinition, which flattens all whitespace to
    // single spaces, so \n\n alone would run four altitude names together
    // into one unreadable line. A leading "• " survives that flattening and
    // still reads as a list. Purely a display affordance added in app code;
    // the stored FAA text is untouched either way.
    return { ...c, definition: `${c.definition}\n\n${refs.map((r) => `• ${r}`).join('\n\n')}` }
  })
}

// Separate from getStudyMastery()'s total_available (always the full,
// unfiltered corpus size) -- this is how many items actually match the
// CURRENTLY selected Content/Level filters, so the filter row's own count
// stays honest instead of implying the 20-card session batch is the whole
// pool (selecting ALL can mean thousands of items, not 20).
export async function getStudyPoolCount(
  itemTypes?: StudyItemType[],
  levels?: StudyLevel[],
  categoryClasses?: CategoryClass[],
  topics?: StudyTopic[]
): Promise<number> {
  const { data, error } = await supabase.rpc('get_study_pool_count', {
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
    p_topics: topics && topics.length > 0 ? topics : null,
  })
  if (error) throw error
  return (data as number) ?? 0
}

// Per-level pool sizes for the Level chips, so the filter row shows the SIZE
// of each section rather than only the aggregate of whatever is selected.
// One server-side pass: doing this client-side meant 9 getStudyPoolCount
// calls at 297-488ms each (~4.4s on mount) versus 567ms measured for this.
// Item-type/category filters are passed through, so each chip's count always
// reflects the other chips already set.
export async function getStudyPoolCountsByLevel(
  itemTypes?: StudyItemType[],
  categoryClasses?: CategoryClass[],
  topics?: StudyTopic[]
): Promise<Partial<Record<StudyLevel, number>>> {
  const { data, error } = await supabase.rpc('get_study_pool_counts_by_level', {
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
    p_topics: topics && topics.length > 0 ? topics : null,
  })
  if (error) throw error
  const out: Partial<Record<StudyLevel, number>> = {}
  for (const row of (data ?? []) as { level: StudyLevel; cnt: number }[]) out[row.level] = Number(row.cnt)
  return out
}

// `record_study_review`'s own `p_item_type` param defaults to 'pcg' server
// -side -- omitting it here (as this used to) silently mis-recorded every
// FAR/AIM/AC review as a pcg item_type/item_id pair that doesn't actually
// exist in pcg_terms, which then crashed get_study_queue()'s per-type CASE
// lookup the next time that corrupted row came up due for review (found
// live: a reviewed AC card produced a null term, which redactTerm() then
// crashed on). Always pass the real type explicitly.
export async function recordStudyReview(itemId: string, correct: boolean, itemType: StudyItemType = 'pcg'): Promise<{ correctStreak: number; nextReviewAt: string; newCoins: string[] }> {
  const { data, error } = await supabase.rpc('record_study_review', { p_item_id: itemId, p_correct: correct, p_item_type: itemType })
  if (error) throw error
  const row = data?.[0]
  return { correctStreak: row?.correct_streak ?? 0, nextReviewAt: row?.next_review_at ?? '', newCoins: row?.new_coins ?? [] }
}

// userId optional -- omitted (the normal case, Study Mode's own gauge)
// means "the calling user," same as before. profile/[userId].tsx's
// nametag page passes another user's id explicitly to show THEIR Overall
// Mastery %, RC: "your total Overall Mastery %. plus the nametag. all the
// things to really brag about."
export async function getStudyMastery(userId?: string): Promise<StudyMastery> {
  const { data, error } = await supabase.rpc('get_study_mastery', userId ? { p_user_id: userId } : {})
  if (error) throw error
  const row = data?.[0]
  return row ?? { mastered: 0, seen: 0, total_available: 0, pct: 0 }
}

export interface Currency {
  currentStreak: number
  longestStreak: number
  lastActiveDate: string | null
  isCurrent: boolean
}

// "Currency" (not "streak") deliberately -- pilots already respect the word
// from real aviation currency requirements; see the tier-placement/branding
// discussion. get_currency() computes whether a stored streak has already
// lapsed rather than trusting the raw stored value (which only updates on
// the next review).
export async function getCurrency(): Promise<Currency> {
  const { data, error } = await supabase.rpc('get_currency')
  if (error) throw error
  const row = data?.[0]
  return {
    currentStreak: row?.current_streak ?? 0,
    longestStreak: row?.longest_streak ?? 0,
    lastActiveDate: row?.last_active_date ?? null,
    isCurrent: row?.is_current ?? false,
  }
}

export interface StudyFact {
  question: string
  answer: string
  // Present only on hand-authored questions. `explanation` says WHY the answer
  // is what it is and which sibling reg it gets confused with.
  explanation?: string
  // The verbatim reg text the answer came from. Every row has one -- authored
  // AND generated (33,475 of 33,475 checked live, 2026-09-09) -- which is what
  // lets the card show SOMETHING under every answer instead of only under the
  // ~6% that are hand-authored. RC, B42: "though some answers don't have that
  // explanation ... it would be great to add those to each Q if poss."
  //
  // Deliberately fed to the UI as a FALLBACK rather than written into
  // explanation for all 33k rows: a bulk content write would risk real data to
  // store something already present in the same row, and would drift the moment
  // a quote is re-scraped. The render path composes it instead.
  sourceQuote?: string
  category?: string
  qType?: 'recall' | 'scenario'
}

// Function words carry no information, so they must not count toward "this
// quote adds something". Kept deliberately short: anything longer starts
// discarding real regulatory vocabulary.
const STOP_WORDS = new Set(
  ('the a an of to in for or and is are be by on at with that this shall must may each any all ' +
   'not no from as under section paragraph if when such other than its it what which does do')
    .split(' '),
)

/**
 * What to show under a revealed answer.
 *
 * RC, B42: "though some answers don't have that explanation ... it would be
 * great to add those to each Q if poss." Only the ~2,000 hand-authored rows
 * carry a written `explanation`; the other 33,475 live rows carry none -- but
 * every single one of them carries the verbatim reg text the answer came from.
 *
 * So a card with no authored explanation falls back to quoting its own source.
 * That is evidence rather than teaching, and it is labelled as such -- but it
 * answers the question the missing explanation left open ("says who?"), which
 * on RC's own example (91.193, "No, it does not") is the whole point: the
 * source reads "Such authorization does not permit operation of the aircraft
 * carrying persons or property for compensation or hire."
 *
 * Returns undefined when there is nothing worth showing, so the caller can
 * keep rendering conditionally exactly as before.
 */
export function explanationText(fact: StudyFact | undefined): string | undefined {
  if (!fact) return undefined
  if (fact.explanation && fact.explanation.trim()) return fact.explanation.trim()
  // Quotes are scraped, so they arrive with hard newlines and column breaks
  // mid-sentence (1,590 of them contain a newline). Collapse to one line.
  const quote = (fact.sourceQuote ?? '').replace(/\s+/g, ' ').trim()
  // Reject fragments that add nothing the answer did not already say. Length
  // alone is the wrong test -- "azimuth to 20 degrees" is 21 characters and
  // genuinely useful, while "Steady white | 20" is 17 and is a table row torn
  // out of its header.
  if (quote.length < 12) return undefined
  if (quote.includes('|')) return undefined
  if (quote.split(' ').filter(Boolean).length < 3) return undefined

  // THE REAL TEST: does the quote actually SAY anything the card did not?
  //
  // RC, B42: "the 'fix' you made for 91.193 doesn't really do anything. it
  // doesn't explain WHY, it just basically repeats the short answer in a long
  // way." He was right, and the whole bank agreed with him -- measured over all
  // 33,475 generated rows, 34% of source quotes add ZERO or ONE content word
  // beyond the question and answer. Those are the restatements he objected to:
  // answer "An 'essential load'" against quote "is an 'essential load' on the
  // power supply".
  //
  // The bar is FIVE new content words, and it is deliberately strict.
  //
  // Two was tried first and failed on RC's own card: quote "Such authorization
  // does not permit operation of the aircraft carrying persons or property for
  // compensation or hire" against answer "No, it does not permit compensation
  // or hire operations" clears a two-word bar on "operation" and "aircraft"
  // while saying nothing new. Word counting cannot tell restatement from
  // addition, because a quote of the sentence the answer came FROM is a
  // restatement by construction.
  //
  // At five the survivors are the ones carrying real extra content -- answer
  // "1,500 feet AGL", quote "up to 1,500 feet above ground level, BUT NOT LESS
  // THAN V1 MINIMUM FOR AIRPLANES". Measured across all 33,475 generated rows:
  // 34% add 0-1 words (pure restatement), 38% add 2-4, 28% add 5+.
  //
  // This drops coverage from a claimed 98% to about 32%, and that is the right
  // trade. RC, B42: "we don't just want to duplicate things already there we
  // want to offer real explanations." Showing nothing is honest; padding an
  // answer and calling it an explanation is not.
  //
  // What this is: GROUNDING -- the regulation's own words, labelled as a quote.
  // What it is not: an explanation of WHY. That only comes from authoring, and
  // the ~2,000 hand-authored rows remain the only place it exists.
  const contentWords = (t: string) =>
    new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)))
  const known = new Set([...contentWords(fact.question), ...contentWords(fact.answer)])
  let added = 0
  for (const w of contentWords(quote)) if (!known.has(w)) added++
  if (added < 5) return undefined
  // Many quotes are cut mid-word by the scraper's window ("...for compen").
  // An ellipsis is honest about that rather than pretending it is a sentence.
  const ends = /[.!?"\u201d)]$/.test(quote)
  return `Source: \u201c${quote}${ends ? '' : '\u2026'}\u201d`
}

// AIM paragraph numbers aren't something pilots memorize -- "Which AIM
// paragraph covers Taxiway Markings?" tests recall of an internal indexing
// scheme, not real knowledge. Rejected live, RC: "knowledge of the sections
// of the AIM is not standard requirement... develop actually content
// questions" (e.g. Q: "if you see two dashed lines with two solid lines
// behind them, what does that mean?" A: "Hold short"). study_facts holds
// exactly that -- real content-recall Q/A authored+verified via
// scripts/author_fact_deck.py (see PROJECT_NOTES/flyregs_fact_deck_scope.md)
// -- fetched once per session and used in study.tsx to override the AIM
// branch of buildStudyCard() when a live fact exists for that paragraph.
// One fact per paragraph -- Study Mode is still one-card-per-item -- but
// picked at RANDOM among however many live facts that paragraph has, fresh
// on every call (see the reservoir-sampling comment below for why).
// Was getAimFacts(): AIM-only, and fetched EVERY live AIM fact (2,100+ rows,
// paginated across 3 requests) on every single session even though a deck
// is capped at 20 cards. Two problems found together, 2026-08-03: (1) the
// study_facts table has always held live, verified facts for FAR (13,392!)
// and P/CG (583) and AC (125) too, per scripts/author_fact_deck.py's own
// two authoring runs -- but study.tsx only ever asked for 'aim', so 14,000+
// already-paid-for, already-verified real content questions sat unused.
// RC, real device: "a lot of our Qs are just asking the player to remember
// the FAR, AC, etc number cold... we need to figure out how to ask similar
// Qs about the other regs" -- the content questions already existed, they
// just weren't wired in for anything but AIM. (2) fetching the WHOLE table
// doesn't scale to 4 types (16,000+ rows) the way it barely did for one --
// this version instead asks only for the item_ids actually in THIS deck
// (<=20), grouped by type, which is both correct for every type and far
// cheaper than the old whole-table fetch ever was.
export async function getStudyFactsForItems(
  items: { item_type: StudyItemType; item_id: string }[]
): Promise<Map<string, StudyFact>> {
  const map = new Map<string, StudyFact>()
  if (items.length === 0) return map
  const idsByType = new Map<StudyItemType, string[]>()
  for (const it of items) {
    if (!idsByType.has(it.item_type)) idsByType.set(it.item_type, [])
    idsByType.get(it.item_type)!.push(it.item_id)
  }
  await Promise.all(
    [...idsByType.entries()].map(async ([itemType, ids]) => {
      // study_facts_gated, not the raw table -- found 2026-08-12 during the
      // QA re-sweep: the raw study_facts table had SELECT granted directly
      // to anon+authenticated (only a status='live' RLS filter, no tier
      // check), so this call was serving real, live, verified quiz
      // question/answer content to every tier including a fully anonymous
      // request. Same root cause and same fix shape as
      // gotcha_tier_gate_client_side_only.md's other entries -- the raw
      // GRANT has been revoked server-side and study_facts_gated added,
      // redacting question/answer/distractors/source_quote to NULL for
      // non-Pro (see sync/migrations_fix_study_facts_anonymous_leak.sql).
      // A non-Pro caller now gets real rows back with null question/
      // answer, which the reservoir-sampling logic below already handles
      // correctly by never populating the map for a null pair.
      const { data, error } = await supabase
        .from('study_facts_gated')
        .select('item_id, question, answer, explanation, source_quote, category, q_type, origin')
        .eq('item_type', itemType)
        .in('item_id', ids)
      if (error) throw error
      // Hand-authored questions win outright over generated ones for the same
      // item. Under the plain reservoir sampling below, 81 authored rows would
      // almost never be drawn against 35,000+ generated ones, which would make
      // authoring them pointless. Items with no authored fact are unaffected
      // and keep the uniform-random behaviour described below.
      const authoredIds = new Set(
        (data ?? []).filter((r: any) => r.origin === 'authored').map((r: any) => r.item_id)
      )
      const rows = (data ?? []).filter((r: any) => !authoredIds.has(r.item_id) || r.origin === 'authored')
      const counts = new Map<string, number>()
      for (const row of rows) {
        // Reservoir sampling (k=1): a uniform-random pick among however many
        // live facts this item has, not always the first one authored.
        // Confirmed live as a real gap RC flagged ("each FC session must draw
        // diff random Qs") -- most items with multiple facts have 2-3
        // verified ones, but always picking the same one (e.g. lowest id,
        // or first by created_at) meant re-drawing the same item in a later
        // session -- a near-certainty under spaced repetition -- always
        // showed the IDENTICAL question, forever.
        const key = `${itemType}:${row.item_id}`
        // A null question/answer pair is not a usable fact -- skip it before it
        // enters the reservoir, so it can neither win the draw nor inflate
        // `seen`. study_facts_gated's row filter means this cannot fire today,
        // but BOTH this file's comment above and
        // migrations_study_facts_gated_deny_free.sql justify the row gate by
        // claiming the sampler "never populates the map for a null pair" -- and
        // it did not actually do that. This makes the documented contract true,
        // so the per-column redaction really is defence in depth rather than
        // the only thing standing between a free user and a blank flashcard.
        if (row.question == null || row.answer == null) continue
        const seen = (counts.get(key) ?? 0) + 1
        counts.set(key, seen)
        if (Math.random() < 1 / seen) map.set(key, {
          question: row.question,
          answer: row.answer,
          explanation: (row as any).explanation ?? undefined,
          sourceQuote: (row as any).source_quote ?? undefined,
          category: (row as any).category ?? undefined,
          qType: (row as any).q_type ?? undefined,
        })
      }
    })
  )
  return map
}
