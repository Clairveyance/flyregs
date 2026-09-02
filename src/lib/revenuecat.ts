import Purchases, { LOG_LEVEL, PurchasesPackage, CustomerInfo } from 'react-native-purchases'
import { Platform } from 'react-native'
import { supabase, isEdgeFunctionTimeout } from '@/lib/supabase'

export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'
// One-time non-consumable unlock (Ref Packets, What's Changed, ACs/LOIs,
// local highlights/notes/folders) — see PROJECT_NOTES/flyregs_decisions.md,
// "Pricing model pivot". Not yet created in App Store Connect; product ID
// is provisional until that IAP exists (task tracked separately).
export const ENTITLEMENT_UNLOCKED = 'unlocked'

// Product IDs — must match App Store Connect exactly
export const PRODUCT_IDS = {
  pro_monthly:     'com.clairveyance.flyregs.pro_monthly',
  pro_annual:      'com.clairveyance.flyregs.pro_annual',
  premium_monthly: 'com.clairveyance.flyregs.premium_monthly',
  premium_annual:  'com.clairveyance.flyregs.premium_annual',
  unlock:          'com.clairveyance.flyregs.unlock',
} as const

export type SubscriptionTier = 'pro' | 'premium'
export type SubscriptionPlan = 'monthly' | 'annual'

export function initRevenueCat(userId?: string) {
  const apiKey = Platform.OS === 'ios'
    ? process.env.EXPO_PUBLIC_RC_API_KEY_IOS
    : process.env.EXPO_PUBLIC_RC_API_KEY_ANDROID

  if (!apiKey || apiKey.startsWith('REPLACE_WITH') || apiKey.length < 10) {
    console.warn('[RevenueCat] API key not configured — subscription features disabled')
    return
  }

  Purchases.setLogLevel(LOG_LEVEL.WARN)
  Purchases.configure({ apiKey, appUserID: userId ?? null })
}

export type SubscriptionStatus = {
  isPro: boolean
  isPremium: boolean
  isUnlocked: boolean
}

// Single place reading the three entitlements out of a CustomerInfo --
// every purchase/restore/status call below built this same three-line
// object inline, which the new update-listener (below) also needs.
function statusFromCustomerInfo(customerInfo: CustomerInfo): SubscriptionStatus {
  const active = customerInfo.entitlements.active
  return {
    isPro: active[ENTITLEMENT_PRO] !== undefined,
    isPremium: active[ENTITLEMENT_PREMIUM] !== undefined,
    isUnlocked: active[ENTITLEMENT_UNLOCKED] !== undefined,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Real bug, RC real-device report 2026-08-21: signing in with Face ID
// reverted the app to a Free/locked account, permanently, until a full
// force-quit + relaunch -- password sign-in didn't show it. Root cause:
// initRevenueCat() calls Purchases.configure(), which returns void (not a
// Promise -- see react-native-purchases' own type declaration) and does its
// real native setup asynchronously under the hood. getCustomerInfo()'s own
// doc comment says it rejects "if configure has not been called yet or if
// there's an issue getting the customer information" -- exactly the
// condition of calling it immediately after an unawaited configure(). The
// password sign-in path incidentally survives this because
// maybeOfferBiometricEnroll() awaits several more calls before the screen
// dismisses, giving configure() more wall-clock time to finish; the
// biometric path dismisses on the very next tick after setSession()
// resolves (auth.tsx's handleBiometricSignIn), racing configure() far more
// tightly. A single failed attempt used to fall back to Free permanently --
// nothing else in a running process ever calls configure() again, so
// foregrounding could never self-heal it, only a full relaunch (which
// re-runs the whole sequence from a cold, uncontested start) could.
// A short retry-with-backoff gives configure() the moment it needs to
// finish instead of giving up on the very first race.
// `ok` distinguishes "RevenueCat said this user has nothing" from "we could not
// reach RevenueCat at all". Before this they returned the IDENTICAL shape, and
// all three callers in auth.tsx cached it unconditionally -- so a single
// foreground with no signal (airplane mode, a hangar, a StoreKit hiccup)
// flipped a paying Premium subscriber to Free in the live UI AND overwrote the
// entitlement cache with {false,false,false}, so the next cold launch opened
// locked too, and the one after that, until a call finally succeeded.
//
// This is the same bug class already fixed twice next door -- restorePurchases'
// own "quietly downgrades them" comment below, and sync-entitlements'
// "don't silently write a false/false/false row over a possibly-still-valid
// one". This path just never got the guard.
export async function getSubscriptionStatus(retries = 3): Promise<SubscriptionStatus & { ok: boolean }> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const customerInfo = await Purchases.getCustomerInfo()
      return { ...statusFromCustomerInfo(customerInfo), ok: true }
    } catch {
      if (attempt === retries) return { isPro: false, isPremium: false, isUnlocked: false, ok: false }
      await sleep(300 * (attempt + 1))
    }
  }
  return { isPro: false, isPremium: false, isUnlocked: false, ok: false }
}

export interface SubscriptionDetails {
  tier: 'free' | 'pro' | 'premium'
  plan: 'monthly' | 'annual' | null
  willRenew: boolean
  expirationDate: string | null
  managementURL: string | null
}

// Richer than getSubscriptionStatus() -- backs the in-app Manage Subscription
// screen, which needs to show plan/billing period/renewal state rather than
// just a boolean. If both entitlements are somehow active, Premium wins
// since it's the superset tier.
export async function getSubscriptionDetails(): Promise<SubscriptionDetails> {
  try {
    const customerInfo = await Purchases.getCustomerInfo()
    const active = customerInfo.entitlements.active
    const premiumEnt = active[ENTITLEMENT_PREMIUM]
    const proEnt = active[ENTITLEMENT_PRO]
    const ent = premiumEnt ?? proEnt

    if (!ent) {
      return { tier: 'free', plan: null, willRenew: false, expirationDate: null, managementURL: null }
    }

    return {
      tier: premiumEnt ? 'premium' : 'pro',
      plan: ent.productIdentifier.includes('annual') ? 'annual' : ent.productIdentifier.includes('monthly') ? 'monthly' : null,
      willRenew: ent.willRenew,
      expirationDate: ent.expirationDate,
      managementURL: customerInfo.managementURL,
    }
  } catch {
    return { tier: 'free', plan: null, willRenew: false, expirationDate: null, managementURL: null }
  }
}

// Pushes the DB-backed tier-of-record (user_entitlements, behind every
// *_gated view/RPC -- see gotcha_tier_gate_client_side_only.md) up to date
// right away, rather than waiting for revenuecat-webhook's passive backstop
// to eventually catch the same change. Best-effort and silent on failure:
// the purchase/restore itself already succeeded via RevenueCat's own SDK by
// the time this runs, so a failed sync here just means the gate lifts a
// little later (via the webhook) instead of immediately -- never worth
// surfacing an error for, let alone rolling back a real purchase over.
// Exported so auth.tsx can also call it once at session-init, self-healing
// the rare case a webhook was ever missed while the app was closed.
// 15s timeout -- this call was previously unbounded and, on a stalled
// connection, could hang the `await` forever (confirmed live, see
// lib/supabase.ts's isEdgeFunctionTimeout comment). That wouldn't just
// affect this best-effort sync itself: every caller below
// (purchaseSubscription, purchaseUnlock, restorePurchases) awaits this
// directly AFTER the real RevenueCat purchase/restore has already
// succeeded, so a hang here would leave that screen's busy spinner stuck
// indefinitely even though the user's money already moved. The try/catch
// stays silent on purpose, unchanged from before -- see this function's own
// header comment above: the webhook backstop still catches a failed or
// timed-out sync, so this only ever needed a bound, not new user-facing
// error handling.
export async function syncEntitlements() {
  try {
    await supabase.functions.invoke('sync-entitlements', { method: 'POST', timeout: 15000 })
  } catch (err) {
    if (isEdgeFunctionTimeout(err)) {
      console.warn('[RevenueCat] sync-entitlements timed out (webhook will catch up)')
    } else {
      console.warn('[RevenueCat] sync-entitlements failed (webhook will catch up)', err)
    }
  }
}

export async function purchaseSubscription(
  tier: SubscriptionTier,
  plan: SubscriptionPlan
): Promise<SubscriptionStatus> {
  const productId = PRODUCT_IDS[`${tier}_${plan}`]

  // Fetch offerings to find the matching package
  const offerings = await Purchases.getOfferings()
  const current = offerings.current
  if (!current) throw new Error('No offerings available')

  const pkg: PurchasesPackage | undefined = current.availablePackages.find(
    (p) => p.product.identifier === productId
  )
  if (!pkg) throw new Error(`Package not found: ${productId}`)

  const { customerInfo } = await Purchases.purchasePackage(pkg)
  await syncEntitlements()
  return statusFromCustomerInfo(customerInfo)
}

// Separate from purchaseSubscription: a non-consumable has no tier/plan
// (single product, one price, never renews or expires).
export async function purchaseUnlock(): Promise<SubscriptionStatus> {
  const offerings = await Purchases.getOfferings()
  const current = offerings.current
  if (!current) throw new Error('No offerings available')

  const pkg: PurchasesPackage | undefined = current.availablePackages.find(
    (p) => p.product.identifier === PRODUCT_IDS.unlock
  )
  if (!pkg) throw new Error(`Package not found: ${PRODUCT_IDS.unlock}`)

  const { customerInfo } = await Purchases.purchasePackage(pkg)
  await syncEntitlements()
  return statusFromCustomerInfo(customerInfo)
}

export interface LivePricing {
  plus: { oneTime: string }
  pro: { monthly: string; annual: string; annualSaving: string }
  premium: { monthly: string; annual: string; annualSaving: string }
}

// 2026-08-29 "built but inert" sweep: paywall.tsx/manage-subscription.tsx's
// prices were 100% hardcoded string literals, never read from RevenueCat's
// live offerings -- purchaseSubscription/purchaseUnlock above already fetch
// this exact offerings object to find a package by product id, the real
// price was sitting right there unused. A real App Store Connect/RevenueCat
// price change would leave the paywall showing a stale number while the
// actual charge is correct -- an advertised-price-!=-charged-price mismatch.
// RC: "while prices wont change right away, we still should have our
// system built to auto reflect [live pricing], in case we change that
// later." Returns null on any failure (no offerings configured yet, no
// network, web has no real store at all) -- every call site keeps its
// existing hardcoded PRICING object as a fallback rather than ever showing
// a blank/broken price, matching this app's "must always open fast, must
// never show nothing" pattern elsewhere (see entitlementCache.ts).
export async function getLivePricing(): Promise<LivePricing | null> {
  try {
    const offerings = await Purchases.getOfferings()
    const current = offerings.current
    if (!current) return null

    const find = (id: string) => current.availablePackages.find((p) => p.product.identifier === id)
    const unlock = find(PRODUCT_IDS.unlock)
    const proMonthly = find(PRODUCT_IDS.pro_monthly)
    const proAnnual = find(PRODUCT_IDS.pro_annual)
    const premiumMonthly = find(PRODUCT_IDS.premium_monthly)
    const premiumAnnual = find(PRODUCT_IDS.premium_annual)
    if (!unlock || !proMonthly || !proAnnual || !premiumMonthly || !premiumAnnual) return null

    // Real numeric prices for the "Save X%" badge, not string parsing --
    // priceString is locale/currency-formatted for display only.
    const savingPct = (monthly: number, annual: number) =>
      `Save ${Math.round((1 - annual / (monthly * 12)) * 100)}%`

    return {
      plus: { oneTime: unlock.product.priceString },
      pro: {
        monthly: proMonthly.product.priceString,
        annual: proAnnual.product.priceString,
        annualSaving: savingPct(proMonthly.product.price, proAnnual.product.price),
      },
      premium: {
        monthly: premiumMonthly.product.priceString,
        annual: premiumAnnual.product.priceString,
        annualSaving: savingPct(premiumMonthly.product.price, premiumAnnual.product.price),
      },
    }
  } catch (_) {
    return null
  }
}

// Resets RevenueCat's own identity back to anonymous -- without this, the
// SDK keeps whatever appUserID it was last configure()'d with (the account
// that just signed out or got deleted), so a subsequent restorePurchases()
// call would still resolve against that old identity's entitlements. This
// alone doesn't gate anything (see the session checks at every
// restorePurchases()/purchaseSubscription() call site for the real fix) but
// closes the underlying identity-bleed issue for good, including the case
// of a second account signing in on the same device afterward.
export async function logOutRevenueCat() {
  try {
    await Purchases.logOut()
  } catch {
    // Throws if already logged out (anonymous) -- fine, that's the goal state.
  }
}

// RC gating audit, 2026-08-22: swallowing every error here into the exact
// same {false,false,false} shape as a genuine "nothing to restore" meant a
// network blip, an offline device, or any StoreKit hiccup during a
// user-initiated Restore locally downgraded a real subscriber to Free for
// the rest of the session -- every one of the 4 call sites (account.tsx,
// Drawer.tsx, paywall.tsx, manage-subscription.tsx) writes this return
// value straight into auth state and tells the user "No purchases found
// for this Apple ID," which is simply false. Unlike getSubscriptionStatus()
// above (a passive background check, where retry-then-fall-back-to-Free is
// the right call so one failed read doesn't lock a real subscriber out),
// this is a user-initiated action with its own visible loading state and
// an existing error dialog at every call site -- a real failure should
// surface as a real error the user can retry, not a fabricated "you have
// nothing" that quietly downgrades them. Genuinely having no purchases is
// not an error case for RevenueCat's SDK (it resolves normally with an
// empty/inactive CustomerInfo), so anything that reaches this catch is a
// real failure -- let it propagate.
export async function restorePurchases(): Promise<SubscriptionStatus> {
  const customerInfo = await Purchases.restorePurchases()
  await syncEntitlements()
  return statusFromCustomerInfo(customerInfo)
}
