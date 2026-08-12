import { supabase } from '@/lib/supabase'
import type { CategoryClass, StudyRating } from '@/lib/profileRatings'

// "Duels" -- async free-for-all quizzes, 2-8 participants (the creator plus
// 1-7 invitees). Everyone gets the same question set and plays at their own
// pace (no live match required); a given question's per-player results only
// reveal to a player once THEY'VE answered it -- the aggregate "X of Y
// others have answered" count is visible immediately, but another
// participant's actual answer/time stays hidden from you until the whole
// challenge completes (see get_challenge_results). See
// flyregs_decisions.md / this session's design discussion for the full
// mechanic, and PROJECT_NOTES/flyregs_link_integrity_audit.md §14/§18 for
// the multiple-choice + group-mode rewrites.

export interface ChallengeableUser {
  userId: string
  displayLabel: string
}

export interface ChallengeParticipant {
  userId: string
  label: string
  status: 'pending' | 'active' | 'declined'
  answeredCount: number
}

export interface MyChallenge {
  challengeId: string
  amChallenger: boolean
  status: 'active' | 'cancelled' | 'completed'
  myStatus: 'pending' | 'active' | 'declined'
  questionCount: number
  myAnsweredCount: number
  createdAt: string
  // The Challenger's filter picks at creation time, persisted on the
  // challenges row itself (not derivable after the fact from
  // challenge_questions, which has no knowledge-level column) -- null
  // means "ALL" for that dimension, same convention the filter chips use.
  // Both players see the same values since it's read off the shared row.
  itemTypes: DuelItemType[] | null
  levels: KnowledgeLevel[] | null
  categoryClasses: CategoryClass[] | null
  ratings: StudyRating[] | null
  others: ChallengeParticipant[]
}

export interface DuelStats {
  wins: number
  losses: number
  ties: number
}

export type DuelItemType = 'pcg' | 'far' | 'aim' | 'ac'

// Grounded in real FAR structure, not a guess -- see far_knowledge_levels()/
// ac_knowledge_levels() in the DB (Part 61's subparts are official FAA
// structure: C/D/J=student, E=private, F=commercial, G=ATP, H/I/K=
// instructor; 121/135/117=airline ops; 43/65/145/21=mechanic). Content that
// genuinely spans levels (Part 91, Part 61 Subparts A/B, all of AIM/P-CG)
// is deliberately left unclassified and always included, rather than
// guessed into one bucket.
export type KnowledgeLevel = 'student' | 'private' | 'commercial' | 'atp' | 'cfi' | 'mechanic'
export const KNOWLEDGE_LEVEL_LABELS: Record<KnowledgeLevel, string> = {
  student: 'Student',
  private: 'Private',
  commercial: 'Commercial',
  atp: 'ATP',
  cfi: 'CFI',
  mechanic: 'Mechanic (A&P)',
}

export interface NextQuestion {
  questionId: string
  sortOrder: number
  itemType: DuelItemType
  prompt: string
  choices: string[]
  alreadyAnswered: boolean
}

export interface AnswerResult {
  isCorrect: boolean
  correctAnswer: string
  othersAnsweredCount: number
  othersTotalCount: number
  challengeCompleted: boolean
  newCoins: string[]
}

export interface ParticipantAnswer {
  userId: string
  label: string
  isMe: boolean
  answerText: string | null
  isCorrect: boolean | null
  timeMs: number | null
}

export interface ChallengeResultRow {
  sortOrder: number
  itemType: DuelItemType
  term: string
  definition: string
  answers: ParticipantAnswer[]
}

export interface StandingRow {
  userId: string
  label: string
  isMe: boolean
  correctCount: number
  tiebreakMs: number
  finalRank: number
  tieGroupSize: number
}

export async function getChallengeableUsers(): Promise<ChallengeableUser[]> {
  const { data, error } = await supabase.rpc('get_challengeable_users')
  if (error) throw error
  return (data ?? []).map((r: any) => ({ userId: r.user_id, displayLabel: r.display_label }))
}

// opponentIds: 1-7 invitees (2-8 total participants including the caller).
export async function createChallenge(
  opponentIds: string[],
  questionCount = 5,
  itemTypes?: DuelItemType[],
  levels?: KnowledgeLevel[],
  categoryClasses?: CategoryClass[],
  ratings?: StudyRating[]
): Promise<string> {
  const { data, error } = await supabase.rpc('create_challenge', {
    p_opponent_ids: opponentIds,
    p_question_count: questionCount,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
    p_ratings: ratings && ratings.length > 0 ? ratings : null,
  })
  if (error) throw error
  return data as string
}

export async function respondToChallenge(challengeId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_to_challenge', { p_challenge_id: challengeId, p_accept: accept })
  if (error) throw error
}

export async function getMyChallenges(): Promise<MyChallenge[]> {
  const { data, error } = await supabase.rpc('get_my_challenges')
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    challengeId: r.challenge_id,
    amChallenger: r.am_challenger,
    status: r.status,
    myStatus: r.my_status,
    questionCount: r.question_count,
    myAnsweredCount: r.my_answered_count,
    createdAt: r.created_at,
    itemTypes: r.item_types ?? null,
    levels: r.levels ?? null,
    categoryClasses: r.category_classes ?? null,
    ratings: r.ratings ?? null,
    others: (r.others ?? []).map((o: any) => ({
      userId: o.userId, label: o.label, status: o.status, answeredCount: o.answeredCount,
    })),
  }))
}

export async function getDuelStats(userId?: string): Promise<DuelStats> {
  const { data, error } = await supabase.rpc('get_duel_stats', { p_user_id: userId ?? null })
  if (error) throw error
  const row = (data ?? [])[0]
  return { wins: row?.wins ?? 0, losses: row?.losses ?? 0, ties: row?.ties ?? 0 }
}

// A Duel win's coin is only shown synchronously to whichever player's
// submission happened to trigger finalize_challenge_if_done -- the actual
// winner, if that was the OTHER player, never got a reveal. This is the
// catch-up path: any screen the winner opens later checks for coins they
// haven't been shown yet and reveals them then, independent of timing.
export async function getUnseenCoins(): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_unseen_coins')
  if (error) throw error
  return (data ?? []).map((r: any) => r.coin_code)
}

export async function markCoinsSeen(coinCodes: string[]): Promise<void> {
  if (!coinCodes.length) return
  const { error } = await supabase.rpc('mark_coins_seen', { p_coin_codes: coinCodes })
  if (error) throw error
}

export async function getNextChallengeQuestion(challengeId: string): Promise<NextQuestion | null> {
  const { data, error } = await supabase.rpc('get_next_challenge_question', { p_challenge_id: challengeId })
  if (error) throw error
  const row = (data ?? [])[0]
  if (!row) return null
  return {
    questionId: row.question_id,
    sortOrder: row.sort_order,
    itemType: row.item_type,
    prompt: row.prompt,
    choices: row.choices ?? [],
    alreadyAnswered: row.already_answered,
  }
}

export async function submitChallengeAnswer(
  questionId: string,
  answerText: string,
  timeMs: number,
): Promise<AnswerResult> {
  const { data, error } = await supabase.rpc('submit_challenge_answer', {
    p_question_id: questionId,
    p_answer_text: answerText,
    p_time_ms: timeMs,
  })
  if (error) throw error
  const row = (data ?? [])[0]
  return {
    isCorrect: row.is_correct,
    correctAnswer: row.correct_answer,
    othersAnsweredCount: row.others_answered_count,
    othersTotalCount: row.others_total_count,
    challengeCompleted: row.challenge_completed,
    newCoins: row.new_coins ?? [],
  }
}

// Best-effort push on a Duel event (invite sent / accepted / completed) --
// looks up whether the OTHER participant has opted in via
// get_duel_push_target() (SECURITY DEFINER, so this works even though
// push_tokens' own RLS only lets a user read their own row), then hits
// Expo's push endpoint directly from the client. No server-side trigger:
// the client performing the action (creating/accepting/finishing a duel)
// is already online, so there's no need for a deployed edge function just
// to relay one HTTP call. Swallows all errors -- a failed/missing push
// must never block the actual Duel action it's attached to.
//
// 2026-08-05: get_duel_push_target itself was reading challenges.opponent_id,
// a column that no longer exists since Duels moved to the multi-participant
// challenge_participants model -- every single call raised "column
// opponent_id does not exist", swallowed silently by the try/catch below.
// Every Duel push notification (invite/accept/complete) had been completely
// non-functional. Rewritten against challenge_participants.
//
// 2026-08-11: that rewrite kept a `limit 1` on the RPC (matching the
// pre-existing 1:1-era scope, tracked at the time as a fast-follow, not
// fixed in that pass) -- a group duel (3+ people) only ever pushed to ONE
// other participant even when several qualified (e.g. several still-
// pending invitees on 'invited', several still-active participants on
// 'completed'; 'accepted' was accidentally fine already since is_creator
// naturally matches exactly one row). Removed the limit server-side and
// fan out to every returned row client-side.
export async function sendDuelPush(challengeId: string, event: 'invited' | 'accepted' | 'completed'): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('get_duel_push_target', { p_challenge_id: challengeId, p_event: event })
    if (error) return
    const rows = (data ?? []).filter((r: any) => r?.expo_push_token)
    if (rows.length === 0) return
    // Fans out to every qualifying participant, not just one -- a group
    // duel (3+ people) can have several pending invitees or several still-
    // active participants for the same event. The Expo push API accepts a
    // single POST per message; Promise.all rather than a sequential loop
    // since these are independent sends to different recipients, and one
    // recipient's failure shouldn't block another's notification.
    await Promise.all(rows.map((row: any) =>
      fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          to: row.expo_push_token,
          sound: 'default',
          title: row.title,
          body: row.body,
          data: { type: 'duel', challengeId },
        }),
      }).catch(() => {})
    ))
  } catch (_) { /* best-effort */ }
}

export async function getChallengeResults(challengeId: string): Promise<ChallengeResultRow[]> {
  const { data, error } = await supabase.rpc('get_challenge_results', { p_challenge_id: challengeId })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    sortOrder: r.sort_order,
    itemType: r.item_type,
    term: r.term,
    definition: r.definition,
    answers: (r.answers ?? []).map((a: any) => ({
      userId: a.userId, label: a.label, isMe: a.isMe, answerText: a.answerText, isCorrect: a.isCorrect, timeMs: a.timeMs,
    })),
  }))
}

export async function getChallengeStandings(challengeId: string): Promise<StandingRow[]> {
  const { data, error } = await supabase.rpc('get_challenge_standings', { p_challenge_id: challengeId })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    label: r.label,
    isMe: r.is_me,
    correctCount: r.correct_count,
    tiebreakMs: r.tiebreak_ms,
    finalRank: r.final_rank,
    tieGroupSize: r.tie_group_size,
  }))
}
