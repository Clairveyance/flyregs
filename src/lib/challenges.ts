import * as Sentry from '@sentry/react-native'
import { supabase } from '@/lib/supabase'
import type { CategoryClass, StudyRating } from '@/lib/profileRatings'
import { STUDY_RATINGS, STUDY_RATING_LABELS } from '@/lib/profileRatings'

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
  avatarUrl: string | null
  avatarPreset: string | null
}

export interface ChallengeParticipant {
  userId: string
  label: string
  status: 'pending' | 'active' | 'declined'
  answeredCount: number
  avatarUrl: string | null
  avatarPreset: string | null
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
  // Widened from KnowledgeLevel[] to also carry the folded-in rating
  // values (see StudyLevel below) -- old rows created before this change
  // only ever have KnowledgeLevel values here, which is a valid subset.
  levels: StudyLevel[] | null
  categoryClasses: CategoryClass[] | null
  // No longer written by create_challenge (ratings are folded into
  // `levels` now) -- kept readable for any pre-existing row that still has
  // real values here, so old duels' filter-summary chips keep working.
  ratings: StudyRating[] | null
  others: ChallengeParticipant[]
}

export interface DuelStats {
  wins: number
  losses: number
  ties: number
}

export type DuelItemType = 'pcg' | 'far' | 'aim' | 'ac' | 'dictionary'

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

// RC, 2026-08-13, Study Mode screenshot: "in Rating, selecting ALL will
// allow questions covering all those other topics, Instrument, A/P, etc.
// But for students, PVT, etc that isn't helpful... can't we just fold
// those 3 items into the Knowledge area? that's really what we're testing
// anyway... this is needed, b/c otherwise, there's no way to 'turn off'
// those 3 elements from the filter system." Root cause: Rating used a
// PERMISSIVE filter (an item with no rating tag always passed, so "ALL"
// meant zero restriction, not "exclude rating-specific content") while
// Knowledge Level used a strict intersection (item's own levels must
// overlap the selection). There was no way to express "only Student-level,
// and specifically NOT Instrument-only material" because unchecking every
// Rating chip still left Rating filtering out entirely.
//
// Fix: Instrument/Airframe/Powerplant become 3 more selectable values in
// the SAME array/chip-group as Student/Private/.../Mechanic, filtered with
// Knowledge Level's own strict-intersection rule (see xxx_all_levels() in
// sync/migrations_fold_ratings_into_knowledge_levels.sql) -- a section
// tagged only 'instrument' (no cert-level tag) now only surfaces when
// 'instrument' itself is selected, while general content keeps its own
// existing cert-level tags untouched. StudyRating/STUDY_RATING_LABELS
// (profileRatings.ts) still exist as their own narrow type -- this is
// just where they're combined for the one shared filter axis.
export type StudyLevel = KnowledgeLevel | StudyRating
export const ALL_KNOWLEDGE_LEVELS: KnowledgeLevel[] = ['student', 'private', 'commercial', 'atp', 'cfi', 'mechanic']
export const ALL_STUDY_LEVELS: StudyLevel[] = [...ALL_KNOWLEDGE_LEVELS, ...STUDY_RATINGS]
export const STUDY_LEVEL_LABELS: Record<StudyLevel, string> = {
  ...KNOWLEDGE_LEVEL_LABELS,
  ...STUDY_RATING_LABELS,
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
  /** Raw challenge_questions.item_id, unresolved -- routing only. For
   * far/aim/ac/pcg this happens to equal (or transform trivially into)
   * `term`, but dictionary's real slug isn't derivable from its display
   * term, so this is the one field guaranteed route-safe for every type.
   * See get_challenge_results()'s own comment. */
  itemId: string
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
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    displayLabel: r.display_label,
    avatarUrl: r.avatar_url ?? null,
    avatarPreset: r.avatar_preset ?? null,
  }))
}

// opponentIds: 1-7 invitees (2-8 total participants including the caller).
// `levels` carries both cert-level and rating values now -- create_challenge
// itself dropped p_ratings, see STUDY_LEVEL_LABELS' own comment for why.
export async function createChallenge(
  opponentIds: string[],
  questionCount = 5,
  itemTypes?: DuelItemType[],
  levels?: StudyLevel[],
  categoryClasses?: CategoryClass[]
): Promise<string> {
  const { data, error } = await supabase.rpc('create_challenge', {
    p_opponent_ids: opponentIds,
    p_question_count: questionCount,
    p_item_types: itemTypes && itemTypes.length > 0 ? itemTypes : null,
    p_levels: levels && levels.length > 0 ? levels : null,
    p_category_classes: categoryClasses && categoryClasses.length > 0 ? categoryClasses : null,
  })
  if (error) throw error
  return data as string
}

export async function respondToChallenge(challengeId: string, accept: boolean): Promise<void> {
  const { error } = await supabase.rpc('respond_to_challenge', { p_challenge_id: challengeId, p_accept: accept })
  if (error) throw error
}

// RC 2026-08-16: swipe to delete a duel from MY OWN history list. This is
// a per-user hide, not a real delete -- it only touches this user's own
// challenge_participants row (hidden_at), never challenges/questions/
// answers/user_duel_stats, so the OTHER participant's history and every
// W/L stat (profile, leaderboard) are completely unaffected. Reversible
// server-side even though it reads as "delete" in the UI.
export async function hideChallengeFromHistory(challengeId: string): Promise<void> {
  const { error } = await supabase.rpc('hide_challenge_from_history', { p_challenge_id: challengeId })
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
      avatarUrl: o.avatarUrl ?? null, avatarPreset: o.avatarPreset ?? null,
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
//
// 2026-08-16: RC reported a real invite that the recipient never saw. The
// full pipeline (RPC row selection, both her push_tokens flags, a live
// test push + Expo receipt) checked out completely -- no bug found, most
// likely an iOS-side notification setting on her device. But that
// investigation only worked because it was reproducible right then; the
// swallow-everything error handling below (still correct: a push failure
// must never block the actual Duel action) means a real, transient
// failure leaves zero trace. Logging failures to Sentry ONLY -- never
// awaited beyond what already happens, never surfaced to the user, never
// changes the fire-and-forget behavior -- just stops the next one from
// being undiagnosable.
export async function sendDuelPush(challengeId: string, event: 'invited' | 'accepted' | 'completed'): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('get_duel_push_target', { p_challenge_id: challengeId, p_event: event })
    if (error) {
      Sentry.captureException(error, { tags: { feature: 'duel_push' }, extra: { challengeId, event, stage: 'rpc' } })
      return
    }
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
      })
        .then(async (res) => {
          if (!res.ok) {
            Sentry.captureMessage('Duel push send failed', {
              level: 'warning',
              tags: { feature: 'duel_push' },
              extra: { challengeId, event, stage: 'send', status: res.status, body: await res.text().catch(() => null) },
            })
          }
        })
        .catch((err) => {
          Sentry.captureException(err, { tags: { feature: 'duel_push' }, extra: { challengeId, event, stage: 'fetch' } })
        })
    ))
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'duel_push' }, extra: { challengeId, event, stage: 'outer' } })
  }
}

export async function getChallengeResults(challengeId: string): Promise<ChallengeResultRow[]> {
  const { data, error } = await supabase.rpc('get_challenge_results', { p_challenge_id: challengeId })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    sortOrder: r.sort_order,
    itemType: r.item_type,
    itemId: r.item_id,
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
