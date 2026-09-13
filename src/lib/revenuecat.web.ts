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

// Parity with the native getEntitlementGrace (added 2026-09-12). The web build
// has no store receipt at all, so there is no billing state to be in the middle
// of -- whatever ?tier= says is the whole truth here. `ok: true` with
// inGrace:false is therefore the honest answer, not a stub: it lets the
// downgrade gate behave in the web preview exactly as the selected tier says it
// should, which is what makes the preview useful for testing that gate.
//
// This file must gain an export whenever the native one does. See
// getSubscriptionStatus above: when that gained `ok` and this did not, every
// guard in auth.tsx silently failed and the entire web build read as Free.
// tsc cannot catch it -- it resolves '@/lib/revenuecat' to the native file.
// The three real store actions, and the product-id map they key off.
//
// These are imported by paywall.tsx and account.tsx from '@/lib/revenuecat',
// which Metro resolves to THIS file on web -- so their absence here was not a
// no-op, it was `undefined is not a function` the moment anyone tapped
// Subscribe or Restore Purchases in the web preview. Found by
// scripts/web_shim_parity_audit.py, which exists because this exact class of
// gap already shipped once (see getSubscriptionStatus's `ok` flag above).
export const PRODUCT_IDS = {
  pro_monthly:     'com.clairveyance.flyregs.pro_monthly',
  pro_annual:      'com.clairveyance.flyregs.pro_annual',
  premium_monthly: 'com.clairveyance.flyregs.premium_monthly',
  premium_annual:  'com.clairveyance.flyregs.premium_annual',
  unlock:          'com.clairveyance.flyregs.unlock',
} as const

// There is no App Store on web, so a purchase genuinely cannot happen. Throwing
// a plain-language error is the honest outcome: paywall.tsx already renders a
// thrown message inline, so the preview shows why instead of a dead button or a
// silent success that would make the gate look broken. Use ?tier= to move
// between tiers in the preview -- that is what it is for.
export async function purchaseSubscription(): Promise<SubscriptionStatus> {
  throw new Error('Purchases are only available in the iOS app. Use ?tier= to change tier in the web preview.')
}

export async function purchaseUnlock(): Promise<SubscriptionStatus> {
  throw new Error('Purchases are only available in the iOS app. Use ?tier= to change tier in the web preview.')
}

// Restore is safe to answer for real: it reports what this preview session is
// entitled to, which is exactly what ?tier= says. account.tsx shows "Purchases
// Restored" or "Nothing to Restore" off this, and both branches are worth being
// able to see in the preview.
export async function restorePurchases(): Promise<SubscriptionStatus> {
  const { isPro, isPremium, isUnlocked } = await getSubscriptionStatus()
  return { isPro, isPremium, isUnlocked }
}

export async function getEntitlementGrace(): Promise<{ ok: boolean; inGrace: boolean; reason: 'billing_issue' | 'recently_expired' | null }> {
  return { ok: true, inGrace: false, reason: null }
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
