import { supabase } from '@/lib/supabase'
import type { KnowledgeLevel } from '@/lib/challenges'
import type { CategoryClass } from '@/lib/profileRatings'
export type { CategoryClass } from '@/lib/profileRatings'

export type StudyItemType = 'pcg' | 'far' | 'aim' | 'ac'

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
  levels?: KnowledgeLevel[],
  categoryClasses?: CategoryClass[]
): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('get_study_queue', {
    p_limit: limit,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
  })
  if (error) throw error
  return (data ?? []) as StudyCard[]
}

// Separate from getStudyMastery()'s total_available (always the full,
// unfiltered corpus size) -- this is how many items actually match the
// CURRENTLY selected Content/Level filters, so the filter row's own count
// stays honest instead of implying the 20-card session batch is the whole
// pool (selecting ALL can mean thousands of items, not 20).
export async function getStudyPoolCount(
  itemTypes?: StudyItemType[],
  levels?: KnowledgeLevel[],
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

export async function getStudyMastery(): Promise<StudyMastery> {
  const { data, error } = await supabase.rpc('get_study_mastery')
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
export async function getAimFacts(): Promise<Map<string, StudyFact>> {
  const map = new Map<string, StudyFact>()
  const counts = new Map<string, number>()
  const page = 1000
  let offset = 0
  while (true) {
    // PostgREST caps an unfiltered .select() at 1000 rows with no error --
    // see memory/gotcha_postgrest_1000_row_cap.md. Well over 1,000 live AIM
    // facts exist, so this WILL span multiple pages.
    const { data, error } = await supabase
      .from('study_facts')
      .select('item_id, question, answer')
      .eq('item_type', 'aim')
      .eq('status', 'live')
      .order('item_id', { ascending: true })
      .range(offset, offset + page - 1)
    if (error) throw error
    for (const row of data ?? []) {
      // Reservoir sampling (k=1): a uniform-random pick among however many
      // live facts this paragraph has, not always the first one authored.
      // Confirmed live as a real gap RC flagged ("each FC session must draw
      // diff random Qs") -- most AIM paragraphs have 2-3 verified facts,
      // but the original "first by created_at" dedup meant re-drawing the
      // same paragraph in a later session (a near-certainty under spaced
      // repetition) always showed the IDENTICAL question, forever.
      const seen = (counts.get(row.item_id) ?? 0) + 1
      counts.set(row.item_id, seen)
      if (Math.random() < 1 / seen) map.set(row.item_id, { question: row.question, answer: row.answer })
    }
    if (!data || data.length < page) break
    offset += page
  }
  return map
}
