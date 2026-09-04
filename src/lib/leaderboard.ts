import { supabase } from '@/lib/supabase'

export interface LeaderboardRow {
  userId: string
  displayLabel: string
  weeklyReviews: number
  weeklyCorrect: number
  currentStreak: number
  isMe: boolean
  avatarUrl: string | null
  avatarPreset: string | null
}

export async function getReadyRoomLeaderboard(limit = 20): Promise<LeaderboardRow[]> {
  const { data, error } = await supabase.rpc('get_ready_room_leaderboard', { p_limit: limit })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    displayLabel: r.display_label,
    weeklyReviews: r.weekly_reviews,
    weeklyCorrect: r.weekly_correct,
    currentStreak: r.current_streak,
    isMe: r.is_me,
    avatarUrl: r.avatar_url ?? null,
    avatarPreset: r.avatar_preset ?? null,
  }))
}

// Global leaderboards, RC: "can the RR have a 'global' leaderboard?...
// duels ranking, and probably your total Overall Mastery %. plus the
// nametag. all the things to really brag about." Same opt-in flag
// (leaderboard_opt_in) and is_me shape as getReadyRoomLeaderboard above --
// ready-room.tsx switches between all three as tabs against one consistent
// row contract, not three separate screens.
export interface DuelsLeaderboardRow {
  userId: string
  displayLabel: string
  wins: number
  losses: number
  ties: number
  isMe: boolean
  avatarUrl: string | null
  avatarPreset: string | null
}

export async function getDuelsLeaderboard(limit = 50): Promise<DuelsLeaderboardRow[]> {
  const { data, error } = await supabase.rpc('get_duels_leaderboard', { p_limit: limit })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    displayLabel: r.display_label,
    wins: r.wins,
    losses: r.losses,
    ties: r.ties,
    isMe: r.is_me,
    avatarUrl: r.avatar_url ?? null,
    avatarPreset: r.avatar_preset ?? null,
  }))
}

export interface MasteryLeaderboardRow {
  userId: string
  displayLabel: string
  mastered: number
  seen: number
  totalAvailable: number
  pct: number
  isMe: boolean
  avatarUrl: string | null
  avatarPreset: string | null
}

export async function getMasteryLeaderboard(limit = 50): Promise<MasteryLeaderboardRow[]> {
  const { data, error } = await supabase.rpc('get_mastery_leaderboard', { p_limit: limit })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    userId: r.user_id,
    displayLabel: r.display_label,
    mastered: r.mastered,
    seen: r.seen,
    totalAvailable: r.total_available,
    pct: r.pct,
    isMe: r.is_me,
    avatarUrl: r.avatar_url ?? null,
    avatarPreset: r.avatar_preset ?? null,
  }))
}

// Opting in surfaces your Callsign (or email prefix, if no callsign is
// set) and weekly study activity to every other opted-in user -- off by
// default, same privacy stance as shared folders and cloud sync elsewhere
// in this app. Requires a study_progress/user_streaks row to exist at all
// (i.e. having studied at least once), so this upserts rather than assuming
// a row is already there.
// Both visibility toggles go through set_streak_visibility(), NOT a direct
// upsert. Reported by a beta tester 2026-09-02 with a screenshot: toggling
// "Show Me" raised a hard "permission denied for table user_streaks" dialog.
// Verified live -- `authenticated` holds only REFERENCES/SELECT/TRIGGER on
// user_streaks, so the client upsert these two functions used to do was
// rejected at the GRANT layer before RLS was even consulted. The RLS policy
// would have allowed it; the grant never did. Both toggles had therefore
// never worked for anyone.
//
// The fix is an RPC rather than granting the client INSERT/UPDATE, because
// this table also holds current_streak / longest_streak / last_active_date --
// real leaderboard game state. A table-level write grant would let anyone
// forge their own streak, and the whole reason that is not currently possible
// is that these tables are SELECT-only. The definer RPC can only ever touch
// the two visibility booleans, and only for auth.uid()'s own row.
//
// `userId` is kept in both signatures for call-site compatibility but is no
// longer sent: the RPC derives the row from auth.uid(), which is also what
// stops one user editing another's visibility.
export async function setLeaderboardOptIn(_userId: string, optIn: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_streak_visibility', { p_leaderboard_opt_in: optIn })
  if (error) throw error
}

export async function getLeaderboardOptIn(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_streaks')
    .select('leaderboard_opt_in')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return false
  // `?? true` on a MISSING row, not `?? false`. RC, 2026-09-04: these default
  // ON now (migrations_default_account_toggles_on.sql), and a user_streaks row
  // is only created once they study, so a brand-new account legitimately has
  // no row yet. Returning false there showed the toggle OFF while the row that
  // eventually gets written is TRUE -- the switch would appear to flip itself
  // on by itself. A read ERROR still returns false: that is "unknown", and
  // claiming someone is publicly visible when we could not check is the wrong
  // way to be wrong about a visibility setting.
  return data?.leaderboard_opt_in ?? true
}

// Separate, broader opt-in from the leaderboard one above -- leaderboard
// only ever shares a display label + weekly review/streak numbers via a
// SECURITY DEFINER RPC; this shares the full Community stats card
// (ratings, coin count, current aircraft) via a plain RLS-gated SELECT
// (user_streaks_public_stats_read: `stats_visible = true`). ON by default
// as of 2026-09-04 (RC: "be seen in the app, so default is on and they can
// turn off anytime") -- one tap to turn off in Account.
// See setLeaderboardOptIn above for why this is an RPC and not an upsert.
export async function setStatsVisible(_userId: string, visible: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_streak_visibility', { p_stats_visible: visible })
  if (error) throw error
}

export async function getStatsVisible(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('user_streaks').select('stats_visible').eq('user_id', userId).maybeSingle()
  if (error) return false
  // Same reasoning as getLeaderboardOptIn above.
  return data?.stats_visible ?? true
}

// Via set_current_aircraft(), NOT a direct upsert -- see setLeaderboardOptIn
// above. This was the THIRD writer to user_streaks and it was missed when the
// other two were moved to an RPC on 2026-09-02, so it kept failing at the
// GRANT layer and the profile's Save button silently stayed dirty. A separate
// narrow function rather than extra params on set_streak_visibility, because
// overloading it would hit PostgREST's ambiguous-overload trap.
//
// `userId` kept for call-site compatibility but no longer sent: the RPC derives
// the row from auth.uid(), which is also what stops one user editing another's.
export async function setCurrentAircraft(_userId: string, aircraft: string): Promise<void> {
  const trimmed = aircraft.trim().slice(0, 40)
  const { error } = await supabase.rpc('set_current_aircraft', { p_aircraft: trimmed || null })
  if (error) throw error
}

export async function getCurrentAircraft(userId: string): Promise<string> {
  const { data, error } = await supabase.from('user_streaks').select('current_aircraft').eq('user_id', userId).maybeSingle()
  if (error) return ''
  return data?.current_aircraft ?? ''
}
