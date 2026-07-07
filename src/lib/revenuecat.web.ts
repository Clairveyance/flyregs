// Web stub — react-native-purchases is native only.
// All RevenueCat features are silently disabled on web.
import type { SubscriptionStatus } from '@/lib/revenuecat'

export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'
export function initRevenueCat(_userId?: string) { /* no-op */ }
export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  return { isPro: false, isPremium: false }
}
