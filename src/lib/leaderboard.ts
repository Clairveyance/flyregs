import { supabase } from '@/lib/supabase'

export interface LeaderboardRow {
  userId: string
  displayLabel: string
  weeklyReviews: number
  weeklyCorrect: number
  currentStreak: number
  isMe: boolean
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
  }))
}

// Opting in surfaces your Callsign (or email prefix, if no callsign is
// set) and weekly study activity to every other opted-in user -- off by
// default, same privacy stance as shared folders and cloud sync elsewhere
// in this app. Requires a study_progress/user_streaks row to exist at all
// (i.e. having studied at least once), so this upserts rather than assuming
// a row is already there.
export async function setLeaderboardOptIn(userId: string, optIn: boolean): Promise<void> {
  const { error } = await supabase
    .from('user_streaks')
    .upsert(
      { user_id: userId, leaderboard_opt_in: optIn, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
  if (error) throw error
}

export async function getLeaderboardOptIn(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_streaks')
    .select('leaderboard_opt_in')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) return false
  return data?.leaderboard_opt_in ?? false
}

// Separate, broader opt-in from the leaderboard one above -- leaderboard
// only ever shares a display label + weekly review/streak numbers via a
// SECURITY DEFINER RPC; this shares the full Community stats card
// (ratings, coin count, current aircraft) via a plain RLS-gated SELECT
// (user_streaks_public_stats_read: `stats_visible = true`). Off by default,
// same privacy stance as everywhere else this app has an opt-in.
export async function setStatsVisible(userId: string, visible: boolean): Promise<void> {
  const { error } = await supabase
    .from('user_streaks')
    .upsert({ user_id: userId, stats_visible: visible, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}

export async function getStatsVisible(userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('user_streaks').select('stats_visible').eq('user_id', userId).maybeSingle()
  if (error) return false
  return data?.stats_visible ?? false
}

export async function setCurrentAircraft(userId: string, aircraft: string): Promise<void> {
  const trimmed = aircraft.trim().slice(0, 40)
  const { error } = await supabase
    .from('user_streaks')
    .upsert({ user_id: userId, current_aircraft: trimmed || null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
  if (error) throw error
}

export async function getCurrentAircraft(userId: string): Promise<string> {
  const { data, error } = await supabase.from('user_streaks').select('current_aircraft').eq('user_id', userId).maybeSingle()
  if (error) return ''
  return data?.current_aircraft ?? ''
}
