// Web stub — react-native-purchases is native only.
// All RevenueCat features are silently disabled on web.
//
// TIER OVERRIDE (web/QA only, never ships): the App Store build resolves
// entitlements through src/lib/revenuecat.ts, so nothing here reaches a real
// user. This stub used to hardcode every tier to TRUE, which made the web
// preview useless for checking paywalls and gates — every signed-in user was
// simultaneously Plus, Pro and Premium, so no gate could ever be seen to
// work.
//
//   ?tier=free      no entitlements
//   ?tier=plus      the one-time unlock only
//   ?tier=pro       Pro (implies unlocked)
//   ?tier=premium   Premium (implies Pro + unlocked) — the default
//
// The choice sticks in localStorage so it survives in-app navigation, and a
// bare `?tier=` clears it.
import type { SubscriptionStatus, SubscriptionDetails } from '@/lib/revenuecat'

export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'
export const ENTITLEMENT_UNLOCKED = 'unlocked'

const TIER_KEY = 'flyregs.devTier'
type DevTier = 'free' | 'plus' | 'pro' | 'premium'

function currentTier(): DevTier {
  try {
    const qs = new URLSearchParams(window.location.search)
    if (qs.has('tier')) {
      const t = (qs.get('tier') || '').toLowerCase()
      if (t === 'free' || t === 'plus' || t === 'pro' || t === 'premium') {
        window.localStorage.setItem(TIER_KEY, t)
        return t
      }
      window.localStorage.removeItem(TIER_KEY)
    }
    const saved = window.localStorage.getItem(TIER_KEY)
    if (saved === 'free' || saved === 'plus' || saved === 'pro' || saved === 'premium') return saved
  } catch { /* no window (SSR) — fall through to the default */ }
  return 'premium'
}

export function initRevenueCat(_userId?: string) { /* no-op */ }

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  // Mirrors the real entitlement hierarchy: the premium products grant BOTH
  // the `pro` and `premium` entitlements in RevenueCat (verified against the
  // RC V2 API), and Plus is the separate one-time `unlocked` entitlement.
  switch (currentTier()) {
    case 'free': return { isPro: false, isPremium: false, isUnlocked: false }
    case 'plus': return { isPro: false, isPremium: false, isUnlocked: true }
    case 'pro':  return { isPro: true,  isPremium: false, isUnlocked: true }
    default:     return { isPro: true,  isPremium: true,  isUnlocked: true }
  }
}

export async function getSubscriptionDetails(): Promise<SubscriptionDetails> {
  const tier = currentTier()
  return {
    tier: tier === 'plus' ? 'free' : tier,
    plan: null,
    willRenew: false,
    expirationDate: null,
    managementURL: null,
  }
}
