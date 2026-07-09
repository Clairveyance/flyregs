import AsyncStorage from '@react-native-async-storage/async-storage'

// Shared by every screen that renders a NEW/UPD badge (series list, AC
// detail, Home's "What's New" feed + cards) so the user's Badge Lifespan
// setting (Drawer > Appearance) actually has an effect everywhere, not just
// in the one screen that reads it. Previously this setting was written to
// AsyncStorage by the Drawer but never read anywhere else, so badges showed
// unconditionally forever regardless of how old the AC actually was.
//
// One rolling clock, not two: 90 days is the original long limit for both
// "what counts as new/updated at all" (Home's feed) and "how long the visual
// badge shows" — the 7d/14d/30d options let a user shorten that single
// window, they don't create a separate, shorter concept alongside a fixed
// 90-day feed.
export const BADGE_LIFESPAN_KEY = '@flyregs/badge-lifespan'
export const DEFAULT_BADGE_LIFESPAN_DAYS = 90

export async function getBadgeLifespanDays(): Promise<number> {
  const raw = await AsyncStorage.getItem(BADGE_LIFESPAN_KEY)
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BADGE_LIFESPAN_DAYS
}

// Whether a NEW/UPD badge should still show for an AC issued/revised on
// `dateIssued`, given the user's configured lifespan (in days).
export function isWithinBadgeLifespan(dateIssued: string | null, days: number): boolean {
  if (!dateIssued) return false
  const issued = new Date(dateIssued).getTime()
  if (Number.isNaN(issued)) return false
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return issued >= cutoff
}
