import { supabase } from '@/lib/supabase'

// Challenge Coins -- app-verified achievement badges, distinct from the
// self-reported profile ratings in profileRatings.ts. A coin is only ever
// awarded server-side (see record_study_review()'s coin-check block) off
// data the app already tracks -- never user-declared, so unlike ratings
// these need no "self-attested" disclaimer. STREAK_90 deliberately mirrors
// real FAA flight currency (90 days) -- the one coin name with a direct
// real-world callback.
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
}

export const COIN_CATALOG: CoinDef[] = [
  { code: 'FIRST_REP', name: 'First Rep', description: 'Completed your first study review', icon: 'flag.fill' },
  { code: 'STREAK_7', name: '7-Day Currency', description: '7 consecutive days of practice', icon: 'flame' },
  { code: 'STREAK_30', name: '30-Day Currency', description: '30 consecutive days of practice', icon: 'flame.fill' },
  { code: 'STREAK_90', name: '90-Day Currency', description: '90 consecutive days — real aviation currency, matched', icon: 'airplane.circle.fill' },
  { code: 'MASTERY_25', name: 'Quarter Century', description: '25 P/CG terms mastered', icon: 'graduationcap.fill' },
  { code: 'MASTERY_100', name: 'Century', description: '100 P/CG terms mastered', icon: 'trophy.fill' },
  { code: 'DUEL_FIRST_WIN', name: 'First Blood', description: 'Won your first Duel', icon: 'bolt.fill' },
  { code: 'DUEL_5_WINS', name: 'Squadron Leader', description: '5 Duel wins', icon: 'shield.fill' },
  { code: 'DUEL_25_WINS', name: 'Top Gun', description: '25 Duel wins', icon: 'rosette' },
]

export const COIN_BY_CODE: Record<string, CoinDef> = Object.fromEntries(COIN_CATALOG.map((c) => [c.code, c]))

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
