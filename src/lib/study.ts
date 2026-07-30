import { supabase } from '@/lib/supabase'
import type { KnowledgeLevel } from '@/lib/challenges'

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
export async function getStudyQueue(limit = 20, itemTypes?: StudyItemType[], levels?: KnowledgeLevel[]): Promise<StudyCard[]> {
  const { data, error } = await supabase.rpc('get_study_queue', {
    p_limit: limit,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
  })
  if (error) throw error
  return (data ?? []) as StudyCard[]
}

export async function recordStudyReview(itemId: string, correct: boolean): Promise<{ correctStreak: number; nextReviewAt: string; newCoins: string[] }> {
  const { data, error } = await supabase.rpc('record_study_review', { p_item_id: itemId, p_correct: correct })
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
