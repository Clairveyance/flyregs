import Purchases, { LOG_LEVEL, PurchasesPackage } from 'react-native-purchases'
import { Platform } from 'react-native'

export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'

// Product IDs — must match App Store Connect exactly
export const PRODUCT_IDS = {
  pro_monthly:     'com.clairveyance.flyregs.pro_monthly',
  pro_annual:      'com.clairveyance.flyregs.pro_annual',
  premium_monthly: 'com.clairveyance.flyregs.premium_monthly',
  premium_annual:  'com.clairveyance.flyregs.premium_annual',
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
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  try {
    const customerInfo = await Purchases.getCustomerInfo()
    const active = customerInfo.entitlements.active
    return {
      isPro: active[ENTITLEMENT_PRO] !== undefined,
      isPremium: active[ENTITLEMENT_PREMIUM] !== undefined,
    }
  } catch {
    return { isPro: false, isPremium: false }
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
  const active = customerInfo.entitlements.active
  return {
    isPro: active[ENTITLEMENT_PRO] !== undefined,
    isPremium: active[ENTITLEMENT_PREMIUM] !== undefined,
  }
}

export async function restorePurchases(): Promise<SubscriptionStatus> {
  try {
    const customerInfo = await Purchases.restorePurchases()
    const active = customerInfo.entitlements.active
    return {
      isPro: active[ENTITLEMENT_PRO] !== undefined,
      isPremium: active[ENTITLEMENT_PREMIUM] !== undefined,
    }
  } catch {
    return { isPro: false, isPremium: false }
  }
}
