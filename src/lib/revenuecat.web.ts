// Web stub — react-native-purchases is native only.
// All RevenueCat features are silently disabled on web.
export const ENTITLEMENT_PRO = 'pro'
export const ENTITLEMENT_PREMIUM = 'premium'
export function initRevenueCat(_userId?: string) { /* no-op */ }
export async function getSubscriptionStatus(): Promise<boolean> { return false }
export async function presentPaywall(): Promise<boolean> { return false }
