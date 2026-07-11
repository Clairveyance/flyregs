// Web stub — react-native-purchases is native only.
// All RevenueCat features are silently disabled on web.
import type { SubscriptionStatus, SubscriptionDetails } from '@/lib/revenuecat'

export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'
export function initRevenueCat(_userId?: string) { /* no-op */ }
export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  return { isPro: true, isPremium: true }
}
export async function getSubscriptionDetails(): Promise<SubscriptionDetails> {
  return { tier: 'free', plan: null, willRenew: false, expirationDate: null, managementURL: null }
}
