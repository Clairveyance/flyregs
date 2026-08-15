import { supabase } from '@/lib/supabase'

// Challenge Coins -- app-verified achievement badges, distinct from the
// self-reported profile ratings in profileRatings.ts. A coin is only ever
// awarded server-side (see record_study_review()'s coin-check block) off
// data the app already tracks -- never user-declared, so unlike ratings
// these need no "self-attested" disclaimer. STREAK_90 deliberately mirrors
// real FAA flight currency (90 days) -- the one coin name with a direct
// real-world callback.
export type CoinTier = 'bronze' | 'silver' | 'gold'

export interface CoinDef {
  code: string
  name: string
  description: string
  // Every coin previously rendered with the same uniform 'sparkles'/'rosette'
  // icon regardless of which one it was -- "First Rep" was visually
  // identical to "Top Gun," and identical to MagicLink's own sparkle motif
  // (confusing two unrelated features). One distinct, aviation-appropriate
  // icon per coin now. 'rosette' (a medal shape) is deliberately reserved
  // for just the single top duel tier rather than reused everywhere, and
  // 'crown'/'crown.fill' is avoided entirely since that's already the
  // Pro/Premium subscription-tier icon elsewhere in the app.
  icon: string
  // Each of the 3 progressions (streak/mastery/duel) escalates bronze ->
  // silver -> gold; FIRST_REP (the very first coin anyone earns) is bronze.
  // Drives CoinMedal's metallic rim -- real challenge-coin sets are
  // conventionally tiered this way, and it's a real visual distinguisher
  // between coins beyond just the center icon.
  tier: CoinTier
}

export const COIN_CATALOG: CoinDef[] = [
  { code: 'FIRST_REP', name: 'First Rep', description: 'Completed your first study review', icon: 'flag.fill', tier: 'bronze' },
  { code: 'STREAK_7', name: '7-Day Currency', description: '7 consecutive days of practice', icon: 'flame', tier: 'bronze' },
  { code: 'STREAK_30', name: '30-Day Currency', description: '30 consecutive days of practice', icon: 'flame.fill', tier: 'silver' },
  { code: 'STREAK_90', name: '90-Day Currency', description: '90 consecutive days — real aviation currency, matched', icon: 'airplane.circle.fill', tier: 'gold' },
  { code: 'MASTERY_25', name: 'Quarter Century', description: '25 P/CG terms mastered', icon: 'graduationcap.fill', tier: 'bronze' },
  { code: 'MASTERY_100', name: 'Century', description: '100 P/CG terms mastered', icon: 'trophy.fill', tier: 'silver' },
  // 'target' not 'trophy' -- the outline trophy is Duels' own icon
  // everywhere else in the app (ready-room, account, search, challenges);
  // reusing it here made this coin look like a generic Duels badge
  // instead of its own achievement. Confirmed live: "use a diff icon for
  // this one." (Was 'bolt.fill', then 'figure.fencing' before landing on
  // 'trophy' -- Duels' icon has moved twice since, same reasoning holds
  // each time. Also note: this coin's neighbor MASTERY_100 below uses
  // 'trophy.fill' -- the FILLED variant -- deliberately distinct from
  // Duels' outline 'trophy' so the two don't collide either.)
  { code: 'DUEL_FIRST_WIN', name: 'First Blood', description: 'Won your first Duel', icon: 'target', tier: 'bronze' },
  { code: 'DUEL_5_WINS', name: 'Squadron Leader', description: '5 Duel wins', icon: 'shield.fill', tier: 'silver' },
  { code: 'DUEL_25_WINS', name: 'Top Gun', description: '25 Duel wins', icon: 'rosette', tier: 'gold' },
]

// The 3 "currency" coins alone are re-earnable -- STREAK_90's own comment
// above already frames them as mirroring real FAA flight currency, and real
// currency lapses and gets re-established. RC, 2026-08-12, after asking
// what the coin badges should actually show: "all the currency coins are
// re-earnable. if you get one, then break currency and start a new streak,
// you get new coins when reaching those goals again." Every other coin
// stays a genuine one-time milestone -- see sync/migrations_coin_rework.sql
// for the award-logic side of this (record_study_review awards on the
// exact day current_streak CROSSES 7/30/90, not merely "is >=", so it can
// fire again after a real break+rebuild without ever double-firing on a
// second same-day review).
export const RE_EARNABLE_CODES: ReadonlySet<string> = new Set(['STREAK_7', 'STREAK_30', 'STREAK_90'])

export const COIN_BY_CODE: Record<string, CoinDef> = Object.fromEntries(COIN_CATALOG.map((c) => [c.code, c]))

// "Trophy case" coins -- deliberately NOT part of COIN_CATALOG/the regular
// 3-per-row grid. RC, same 2026-08-12 conversation, unprompted: wanted two
// new top-tier milestones "below all of them," bigger, glowing, slowly
// spinning "like trophies in a case."
//
// The Ace (100 Duel wins) -- RC named the diamond himself. Icy blue-white
// rather than the warm gold/bronze/silver language the regular tiers use,
// so it reads as its own register entirely, not just a 4th tier bolted onto
// DUEL_FIRST_WIN/5_WINS/25_WINS' progression.
//
// The Master (100% overall mastery, every item type -- the same
// cross-type total get_study_mastery() already reports) -- RC asked for
// "something great," his own words, for reaching this. Real FAA aviation
// already has a direct namesake worth borrowing from, the same move
// STREAK_90 already makes for currency: the Wright Brothers Master Pilot
// Award, given for 50 years of safe flying, whose own medal is a laurel
// wreath. 'medal.fill' (a real SF Symbol) reads as exactly that -- warm
// gold-white, distinct from Ace's cool diamond blue, and it's the one
// coin in this file whose real-world reference is a laurel medal rather
// than a tier color, matching how big a "big step" 100% genuinely is.
export const TROPHY_CATALOG: CoinDef[] = [
  { code: 'DUEL_100_WINS', name: 'The Ace', description: '100 Duel wins', icon: 'diamond.fill', tier: 'gold' },
  { code: 'MASTERY_FULL', name: 'The Master', description: '100% overall mastery', icon: 'medal.fill', tier: 'gold' },
]
export const TROPHY_BY_CODE: Record<string, CoinDef> = Object.fromEntries(TROPHY_CATALOG.map((c) => [c.code, c]))

export interface EarnedCoin {
  code: string
  earnedAt: string
}

export async function getMyCoins(): Promise<EarnedCoin[]> {
  const { data, error } = await supabase.rpc('get_my_coins')
  if (error) throw error
  return (data ?? []).map((r: any) => ({ code: r.coin_code, earnedAt: r.earned_at }))
}

// Any user's coins, not just the caller's own -- user_coins already has a
// public-read RLS policy (`user_coins_read_all: true`), same as ratings, so
// this is a plain select rather than a new RPC. Used by the Community
// bragging profile page to show another pilot's badges.
export async function getCoinsForUser(userId: string): Promise<EarnedCoin[]> {
  const { data, error } = await supabase.from('user_coins').select('coin_code,earned_at').eq('user_id', userId).order('earned_at')
  if (error) throw error
  return (data ?? []).map((r: any) => ({ code: r.coin_code, earnedAt: r.earned_at }))
}
