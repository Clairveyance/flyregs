import Purchases, { LOG_LEVEL, PurchasesPackage, CustomerInfo } from 'react-native-purchases'
import { Platform } from 'react-native'
import { supabase } from '@/lib/supabase'

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

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  try {
    const customerInfo = await Purchases.getCustomerInfo()
    return statusFromCustomerInfo(customerInfo)
  } catch {
    return { isPro: false, isPremium: false, isUnlocked: false }
  }
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
export async function syncEntitlements() {
  try {
    await supabase.functions.invoke('sync-entitlements', { method: 'POST' })
  } catch (err) {
    console.warn('[RevenueCat] sync-entitlements failed (webhook will catch up)', err)
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

export async function restorePurchases(): Promise<SubscriptionStatus> {
  try {
    const customerInfo = await Purchases.restorePurchases()
    await syncEntitlements()
    return statusFromCustomerInfo(customerInfo)
  } catch {
    return { isPro: false, isPremium: false, isUnlocked: false }
  }
}
