import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Linking, Platform, Alert } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { getSubscriptionDetails, restorePurchases, SubscriptionDetails } from '@/lib/revenuecat'

// Apple/Google don't let an app deep-link to a management screen scoped to
// just its own subscription -- managementURL (when RevenueCat has one) is
// the closest thing, and this is only a fallback for the rare case it's
// null (e.g. no purchase has synced yet).
const FALLBACK_MANAGE_URL = Platform.select({
  ios: 'https://apps.apple.com/account/subscriptions',
  android: 'https://play.google.com/store/account/subscriptions',
  default: 'https://apps.apple.com/account/subscriptions',
})

export default function ManageSubscriptionScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium, setIsPro, setIsPremium } = useAuth()
  const insets = useSafeAreaInsets()
  const [details, setDetails] = useState<SubscriptionDetails | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    getSubscriptionDetails().then(setDetails)
  }, [])

  const handleManage = () => {
    if (Platform.OS === 'web') {
      Alert.alert('Available on iOS & Android', 'Manage your subscription from the FlyRegs mobile app.')
      return
    }
    const url = details?.managementURL ?? FALLBACK_MANAGE_URL
    Linking.openURL(url).catch(() => {})
  }

  const handleRestore = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Available on iOS & Android', 'Restore purchases from the FlyRegs mobile app.')
      return
    }
    // This screen is only ever navigated to from Account (which already
    // requires a session), but it's a directly routable path -- gate here
    // too so a signed-out deep link can't reach RevenueCat at all.
    if (!session) {
      router.replace('/auth')
      return
    }
    setRestoring(true)
    try {
      const status = await restorePurchases()
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      const active = status.isPro || status.isPremium
      Alert.alert(
        active ? 'Purchases Restored' : 'Nothing to Restore',
        active
          ? `Your FlyRegs ${status.isPremium ? 'Premium' : 'Pro'} subscription is active.`
          : 'No active subscription was found for this account.'
      )
      getSubscriptionDetails().then(setDetails)
    } catch (err: any) {
      Alert.alert('Restore Failed', err?.message ?? 'Please try again later.')
    }
    setRestoring(false)
  }

  const tier = isPremium ? 'premium' : isPro ? 'pro' : 'free'
  const tierLabel = tier === 'premium' ? 'Premium' : tier === 'pro' ? 'Pro' : 'Free'
  const tierColor = tier === 'premium' ? tokens.gold : tier === 'pro' ? tokens.blu : tokens.t3

  const renewalText = (() => {
    if (!details?.expirationDate) return null
    const date = new Date(details.expirationDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    return details.willRenew ? `Renews ${date}` : `Expires ${date} — will not renew`
  })()

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Manage Subscription" onBack={() => router.back()} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {/* Current plan card */}
        <View style={[styles.planCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={styles.planCardTop}>
            <Icon name={tier === 'premium' ? 'crown.fill' : tier === 'pro' ? 'star.fill' : 'star'} size={20} color={tierColor} />
            <Text style={[styles.planName, { color: tokens.t1, fontSize: fs(18) }]}>FlyRegs {tierLabel}</Text>
          </View>
          {details === null ? (
            <ActivityIndicator style={{ marginTop: 8 }} color={tokens.t3} />
          ) : tier === 'free' ? (
            <Text style={[styles.planSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
              You're on the free plan. Upgrade for full AC text, folders, sync, and more.
            </Text>
          ) : (
            <>
              {details.plan && (
                <Text style={[styles.planSub, { color: tokens.t2, fontSize: fs(13.5) }]}>
                  {details.plan === 'annual' ? 'Annual' : 'Monthly'} plan
                </Text>
              )}
              {renewalText && (
                <Text style={[styles.planSub, { color: tokens.t3, fontSize: fs(12.5) }]}>{renewalText}</Text>
              )}
            </>
          )}
        </View>

        {/* Change-plan offer, one per tier */}
        {tier === 'free' && (
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.push('/paywall')}
          >
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>See Plans</Text>
          </Pressable>
        )}
        {tier === 'pro' && (
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.gold }]}
            onPress={() => router.push('/paywall?tier=premium')}
          >
            <Icon name="crown.fill" size={15} color="#fff" />
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Upgrade to Premium</Text>
          </Pressable>
        )}
        {/* Premium is the top tier -- nothing to upgrade to, but a Premium
            subscriber still needs a way to reach the paywall at all to
            downgrade to Pro. Without this row there was no path back to
            that screen once already on Premium, which is the real reason
            "downgrade" looked broken -- not a platform limitation. Pro and
            Premium are levels 1/2 in one subscription group ("FlyRegs Pro"),
            so purchasing Pro while on Premium is handled by StoreKit as a
            real downgrade via the exact same purchasePackage() call an
            upgrade uses (takes effect at renewal, no proration) -- see
            paywall.tsx's downgradeMode. This replaces an earlier "Downgrade
            to Pro" row that just linked out to Apple's own subscription
            page, based on a wrong assumption that in-app downgrade wasn't
            possible; that hand-off is still correct for actual
            cancellation (below), just not for switching to a lower paid tier. */}
        {tier === 'premium' && (
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.bg2, borderWidth: 1, borderColor: tokens.bdr }]}
            onPress={() => router.push('/paywall')}
          >
            <Text style={[styles.upgradeBtnText, { color: tokens.t2, fontSize: fs(15) }]}>Change Plan</Text>
          </Pressable>
        )}

        {/* Manage / cancel — has to hand off to the platform store, Apple
            and Google don't allow in-app cancellation of IAP subscriptions */}
        {tier !== 'free' && (
          <Row
            icon="creditcard"
            label="Manage or Cancel Subscription"
            tokens={tokens}
            onPress={handleManage}
          />
        )}
        <Row
          icon="arrow.clockwise"
          label="Restore Purchases"
          tokens={tokens}
          onPress={handleRestore}
          trailing={restoring ? <ActivityIndicator size="small" color={tokens.t3} /> : undefined}
        />

        {tier !== 'free' && (
          <Text style={[styles.footnote, { color: tokens.t4, fontSize: fs(11.5) }]}>
            Subscriptions are billed through the {Platform.OS === 'android' ? 'Google Play' : 'App Store'}. Cancelling or
            changing your plan happens through your {Platform.OS === 'android' ? 'Google' : 'Apple'} account, not in FlyRegs directly.
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

function Row({
  icon, label, tokens, onPress, trailing,
}: {
  icon: string
  label: string
  tokens: ThemeTokens
  onPress: () => void
  trailing?: React.ReactNode
}) {
  const fs = useFS()
  return (
    <Pressable style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Icon name={icon} size={17} color={tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>{label}</Text>
      {trailing ?? <Icon name="chevron.right" size={13} color={tokens.t4} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 10 },

  planCard: { borderRadius: 16, borderWidth: 1, padding: 18 },
  planCardTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planName: { fontWeight: '700' },
  planSub: { marginTop: 6 },

  upgradeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    height: 50,
  },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14, gap: 12, borderRadius: 14, borderWidth: 1 },
  rowIcon: { width: 22, alignItems: 'center' },
  rowLabel: { flex: 1, fontWeight: '500' },

  footnote: { lineHeight: 16, marginTop: 4, paddingHorizontal: 4 },
})
