import AsyncStorage from '@react-native-async-storage/async-storage'
import type { SubscriptionStatus } from '@/lib/revenuecat'

// RC real-device report, B35: "everything in the app is taking WAY TOO LONG
// to open... should not be dependent on internet speed." Root cause: every
// app launch/sign-in blocks its `loading` gate (which the WHOLE app renders
// behind) on RevenueCat's Purchases.getCustomerInfo() -- a real network
// call, with up to 3 retries (300/600/900ms backoff) if it's slow or
// failing, per getSubscriptionStatus()'s own retry loop. A poor connection
// could genuinely stall the entire app behind a spinner for several
// seconds, no matter how fast Supabase itself responds.
//
// Fix: a tiny local cache of the LAST KNOWN entitlement result, keyed to
// the specific userId it belongs to (never applied across a different
// account -- see loadCachedEntitlement's own check). auth.tsx uses this to
// unblock `loading` IMMEDIATELY on a warm launch using the last-known
// truth, then refreshes for real in the background and corrects the UI
// (and the cache) once the real fetch resolves -- the network call still
// happens every time, it just no longer has to finish before the app can
// render. Safe to show a few seconds of stale tier state: every actual
// gated CONTENT read is enforced server-side (has_pro_access()/
// has_plus_access() in every *_gated view/RPC, not client trust), so a
// stale "still Premium" cache for a few seconds after a real downgrade
// can't leak anything -- the server still redacts it regardless of what
// the client briefly displays.
const CACHE_KEY = '@flyregs/entitlement-cache'

interface CachedEntitlement extends SubscriptionStatus {
  userId: string
}

export async function loadCachedEntitlement(userId: string): Promise<SubscriptionStatus | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached: CachedEntitlement = JSON.parse(raw)
    // Only ever applied to the SAME account it was cached for -- a
    // different user signing in on this device (or this device's very
    // first launch for this account) always falls through to the normal
    // blocking fetch, never a stale PREVIOUS account's cached tier.
    if (cached.userId !== userId) return null
    return { isPro: cached.isPro, isPremium: cached.isPremium, isUnlocked: cached.isUnlocked }
  } catch {
    return null
  }
}

/**
 * The last cached tier for WHOEVER was last signed in, without needing a
 * userId to ask for it.
 *
 * Needed because of a real offline failure: this project's JWTs expire after
 * 1 hour, and auth-js returns `{ session: null }` when an expired token cannot
 * be refreshed -- which is exactly what happens with no connection. The
 * session is still on disk; the app simply cannot prove it right now. But
 * loadCachedEntitlement() is keyed on session.user.id, so with a null session
 * there was no id to look up and the tier fell back to false/false/false.
 *
 * A pilot who downloaded documents at home and opened the app in the air the
 * next morning therefore had their PAID, ALREADY-DOWNLOADED library gated
 * behind a purchase screen. Safe to apply: every real gated READ is enforced
 * server-side, and a local offline copy can only exist because
 * record_offline_download already verified entitlement at download time.
 */
export async function loadLastCachedEntitlement(): Promise<(SubscriptionStatus & { userId: string }) | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const cached: CachedEntitlement = JSON.parse(raw)
    if (!cached?.userId) return null
    return { userId: cached.userId, isPro: cached.isPro, isPremium: cached.isPremium, isUnlocked: cached.isUnlocked }
  } catch {
    return null
  }
}

export async function saveCachedEntitlement(userId: string, status: SubscriptionStatus): Promise<void> {
  try {
    const cached: CachedEntitlement = { userId, ...status }
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cached))
  } catch {
    // Non-fatal -- next launch just falls through to the normal blocking
    // fetch again, same as if nothing had ever been cached.
  }
}
