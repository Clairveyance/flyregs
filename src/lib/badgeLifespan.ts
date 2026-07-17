import AsyncStorage from '@react-native-async-storage/async-storage'

// Shared by every screen that renders a NEW/UPD/VER badge (series list, AC
// detail, Home's "What's New" feed + cards) so the user's Badge Lifespan
// setting (Drawer > Appearance) actually has an effect everywhere, not just
// in the one screen that reads it. Previously this setting was written to
// AsyncStorage by the Drawer but never read anywhere else, so badges showed
// unconditionally forever regardless of how old the AC actually was.
//
// One rolling clock, not two: this is the single window for both "what
// counts as new/updated at all" (Home's feed) and "how long the visual
// badge shows" — the options below let a user lengthen or shorten that one
// window, they don't create a separate concept alongside a fixed feed.
export const BADGE_LIFESPAN_KEY = '@flyregs/badge-lifespan'
export const DEFAULT_BADGE_LIFESPAN_DAYS = 90
// Single source of truth for the picker (Drawer.tsx) AND for migrating a
// previously-persisted value that's no longer offered (see
// BadgeLifespanProvider's migration in context/badgeLifespan.tsx) -- both
// read this instead of hardcoding their own copy of the list, so they can't
// drift out of sync with each other.
export const BADGE_LIFESPAN_OPTIONS: number[] = [14, 30, 90, 180]

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
