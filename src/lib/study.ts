import { supabase } from '@/lib/supabase'
import type { StudyLevel } from '@/lib/challenges'
import type { CategoryClass } from '@/lib/profileRatings'
export type { CategoryClass, StudyRating } from '@/lib/profileRatings'

export type StudyItemType = 'pcg' | 'far' | 'aim' | 'ac' | 'dictionary' | 'cfr49'

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
  categoryClasses?: CategoryClass[]
): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('get_study_queue', {
    p_limit: limit,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
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
  categoryClasses?: CategoryClass[]
): Promise<number> {
  const { data, error } = await supabase.rpc('get_study_pool_count', {
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
  })
  if (error) throw error
  return (data as number) ?? 0
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
        .select('item_id, question, answer')
        .eq('item_type', itemType)
        .in('item_id', ids)
      if (error) throw error
      const counts = new Map<string, number>()
      for (const row of data ?? []) {
        // Reservoir sampling (k=1): a uniform-random pick among however many
        // live facts this item has, not always the first one authored.
        // Confirmed live as a real gap RC flagged ("each FC session must draw
        // diff random Qs") -- most items with multiple facts have 2-3
        // verified ones, but always picking the same one (e.g. lowest id,
        // or first by created_at) meant re-drawing the same item in a later
        // session -- a near-certainty under spaced repetition -- always
        // showed the IDENTICAL question, forever.
        const key = `${itemType}:${row.item_id}`
        const seen = (counts.get(key) ?? 0) + 1
        counts.set(key, seen)
        if (Math.random() < 1 / seen) map.set(key, { question: row.question, answer: row.answer })
      }
    })
  )
  return map
}
