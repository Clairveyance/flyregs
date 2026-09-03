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

// No real RevenueCat customer on web (see currentTier's ?tier= override
// above) -- calling the real Edge Function here would overwrite
// user_entitlements with this account's TRUE server-side state, silently
// fighting the whole point of the dev-tier override.
export async function syncEntitlements() { /* no-op */ }

// Missing entirely until a real sign-out click-through caught it: auth.tsx's
// signOut() awaits this unconditionally, so on web it threw "logOutRevenueCat
// is not a function" AFTER the real Supabase sign-out had already succeeded —
// the account was actually signed out, but the confirm dialog stayed open
// showing a raw JS error instead of closing. No real RevenueCat identity to
// clear on web, so this is a no-op like the rest of this stub.
export async function logOutRevenueCat() { /* no-op */ }

// No real store/offerings on web -- every call site already falls back to
// its own hardcoded PRICING object when this returns null, same as a real
// fetch failure on native. See revenuecat.ts's own getLivePricing for why
// this exists at all.
export async function getLivePricing(): Promise<null> { return null }

// Returns `ok` too. The native getSubscriptionStatus gained that flag on
// 2026-09-01 so a RevenueCat outage could not read as a downgrade, and all
// three call sites in auth.tsx now guard on it -- but this web stub was not
// updated, so `status.ok` was undefined, every guard failed, and the whole web
// build read as Free with the ?tier= override doing nothing. tsc cannot catch
// this: it resolves '@/lib/revenuecat' to the native file, never the .web one.
export async function getSubscriptionStatus(): Promise<SubscriptionStatus & { ok: boolean }> {
  // Mirrors the real entitlement hierarchy: the premium products grant BOTH
  // the `pro` and `premium` entitlements in RevenueCat (verified against the
  // RC V2 API), and Plus is the separate one-time `unlocked` entitlement.
  switch (currentTier()) {
    case 'free': return { ok: true, isPro: false, isPremium: false, isUnlocked: false }
    case 'plus': return { ok: true, isPro: false, isPremium: false, isUnlocked: true }
    case 'pro':  return { ok: true, isPro: true,  isPremium: false, isUnlocked: true }
    default:     return { ok: true, isPro: true,  isPremium: true,  isUnlocked: true }
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
