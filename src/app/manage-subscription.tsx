import { useEffect, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Linking, Platform } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { getSubscriptionDetails, restorePurchases, SubscriptionDetails } from '@/lib/revenuecat'
import { getOwnedAircraftOldestFirst } from '@/lib/aircraftSharing'
import { useConfirm } from '@/components/ConfirmDialog'

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
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { session, isPro, isPremium, isUnlocked, setIsPro, setIsPremium, setIsUnlocked } = useAuth()
  const insets = useSafeAreaInsets()
  const [details, setDetails] = useState<SubscriptionDetails | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    getSubscriptionDetails().then(setDetails)
  }, [])

  const openManageURL = () => {
    const url = details?.managementURL ?? FALLBACK_MANAGE_URL
    Linking.openURL(url).catch(() => {})
  }

  const handleManage = async () => {
    if (Platform.OS === 'web') {
      confirm({ title: 'Available on iOS', message: 'Manage your subscription from the FlyRegs iOS app.', cancelLabel: null })
      return
    }
    // RC, 2026-08-22: "if d/g to Plus or Free, they must be reminded that
    // they will lose (complete delete) all their a/c's and data." Plus and
    // Free both have fleet_visible_cap() 0 -- Aircraft Manager isn't part
    // of either tier -- so cancelling out of Pro/Premium here is a full
    // wipe of every saved aircraft, not just a downgrade. Only worth the
    // lookup (and only worth mentioning) if there's currently something to
    // lose -- a Free/Plus subscriber managing nothing has no aircraft to
    // warn about in the first place.
    let aircraftCount = 0
    if (isPro || isPremium) {
      try {
        aircraftCount = (await getOwnedAircraftOldestFirst()).length
      } catch { /* best-effort -- don't block cancellation on this lookup failing */ }
    }
    const aircraftNote = aircraftCount > 0
      ? ` You currently have ${aircraftCount} saved aircraft -- Aircraft Manager isn't part of Plus or Free, so ${aircraftCount === 1 ? 'it' : 'all of them'}, and their equipment/reminders/AD history, will be permanently deleted.`
      : ''
    // Cancelling drops the subscriber to whatever they separately own
    // (isUnlocked) -- if they never bought Plus on its own, that's a full
    // cliff back to Free, losing Highlights/Notes/Bookmarks and the AC/LOI
    // library, not just the Pro/Premium-specific extras. Apple/Google require
    // the actual cancellation to happen in their own settings, so this is the
    // last point we can intercept before handing off -- offer Plus as a
    // permanent floor, but "Continue to Cancel" must be just as easy to tap
    // as "Get Plus" (a real choice, not a buried escape hatch) and there's a
    // genuine no-op "Not Now" too, so nobody is forced to decide on the spot.
    if (!isUnlocked) {
      confirm({
        title: 'Before you go',
        message: `Cancelling will remove access to your Highlights, Notes, and AC/LOI library. Keep that permanently for $17.99 instead?${aircraftNote}`,
        // Three real options, so `choices` rather than a confirm/cancel pair.
        // Order matters: "Continue to Cancel" must be as easy to reach as
        // "Get Plus" -- a genuine choice, not a buried escape hatch -- and
        // "Not Now" (the plain cancel) is a real no-op so nobody is forced
        // to decide on the spot.
        cancelLabel: 'Not Now',
        choices: [
          { label: 'Get Plus', onPress: () => router.push('/paywall?tier=plus') },
          { label: 'Continue to Cancel', destructive: true, onPress: openManageURL },
        ],
      })
      return
    }
    // Already owns Plus permanently, so the Highlights/Notes/library
    // warning above doesn't apply -- but the aircraft warning still does,
    // and previously had NO confirmation step at all here.
    if (aircraftNote) {
      confirm({
        title: 'Before you go',
        message: `Cancelling will move you to Plus (already yours to keep).${aircraftNote}`,
        confirmLabel: 'Continue to Cancel',
        destructive: true,
        onConfirm: openManageURL,
      })
      return
    }
    openManageURL()
  }

  const handleRestore = async () => {
    if (Platform.OS === 'web') {
      confirm({ title: 'Available on iOS', message: 'Restore purchases from the FlyRegs iOS app.', cancelLabel: null })
      return
    }
    // This screen is only ever navigated to from Account (which already
    // requires a session), but it's a directly routable path -- gate here
    // too so a signed-out deep link can't reach RevenueCat at all.
    if (!session) {
      router.replace('/auth')
      return
    }
    // Same guard as account.tsx/paywall.tsx's Restore Purchases: RevenueCat
    // rejects a second concurrent restore call while one is in flight, and
    // restorePurchases() swallows that into a false "nothing active" status
    // rather than throwing -- without this guard a rapid double-tap could
    // let the failed call's result win and tell a real subscriber "Nothing
    // to Restore." Same bug class as the printReg.ts double-tap fix.
    if (restoring) return
    setRestoring(true)
    try {
      const status = await restorePurchases()
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      // RC gating audit, 2026-08-22: setIsUnlocked was never called here at
      // all (not even destructured above), and `active` excluded isUnlocked
      // entirely -- so a Plus-only customer (the normal shape for anyone
      // who bought the standalone $17.99 unlock and no subscription) got
      // told "Nothing to Restore -- No active subscription was found,"
      // despite the restore genuinely succeeding, and their restored Plus
      // entitlement was never applied to app state. Every other restore
      // call site (account.tsx, Drawer.tsx, paywall.tsx) already handles
      // this correctly; this was the one that didn't.
      setIsUnlocked(status.isUnlocked)
      const active = status.isPro || status.isPremium || status.isUnlocked
      confirm({
        title: active ? 'Purchases Restored' : 'Nothing to Restore',
        message: active
          ? `Your FlyRegs ${status.isPremium ? 'Premium' : status.isPro ? 'Pro' : 'Plus'} ${status.isPro || status.isPremium ? 'subscription' : 'purchase'} is active.`
          : 'No active subscription was found for this account.',
        cancelLabel: null,
      })
      getSubscriptionDetails().then(setDetails)
    } catch (err: any) {
      confirm({ title: 'Restore failed', message: err?.message ?? 'Please try again later.', cancelLabel: null })
    }
    setRestoring(false)
  }

  // 2026-08-19 gating re-sweep: this was `isPremium ? 'premium' : isPro ?
  // 'pro' : 'free'` with no `isUnlocked` branch at all -- a real Plus
  // subscriber (isUnlocked: true, isPro/isPremium both false, the normal
  // shape for anyone who only ever bought the standalone Plus unlock) fell
  // straight through to 'free'. That made this whole screen lie to a
  // paying customer ("You're on the free plan"), hid the "Manage or Cancel
  // Subscription" row entirely (gated on `tier !== 'free'`), and offered
  // "See Plans" instead of an upgrade CTA. Same bug shape as the 14
  // bare-`isPro` gates found 2026-08-14 (see gotcha_gating_sweep_2026_08_14),
  // just via a ternary that dropped a branch instead of a missing check.
  // Drawer.tsx's own `TierPill` already gets this right -- copy its ladder.
  const tier = isPremium ? 'premium' : isPro ? 'pro' : isUnlocked ? 'plus' : 'free'
  const tierLabel = tier === 'premium' ? 'Premium' : tier === 'pro' ? 'Pro' : tier === 'plus' ? 'Plus' : 'Free'
  const tierColor = tier === 'premium' ? tokens.gold : tier === 'pro' ? tokens.blu : tier === 'plus' ? tokens.amb : tokens.t3

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
            <Icon name={tier === 'premium' ? 'crown.fill' : tier === 'free' ? 'star' : 'star.fill'} size={fs(20)} color={tierColor} />
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
        {tier === 'plus' && (
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.push('/paywall?tier=pro')}
          >
            <Icon name="star.fill" size={fs(15)} color="#fff" />
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Upgrade to Pro</Text>
          </Pressable>
        )}
        {tier === 'pro' && (
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.gold }]}
            onPress={() => router.push('/paywall?tier=premium')}
          >
            <Icon name="crown.fill" size={fs(15)} color="#fff" />
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
          disabled={restoring}
        />

        {tier !== 'free' && (
          <Text style={[styles.footnote, { color: tokens.t4, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.39 }]}>
            Subscriptions are billed through the {Platform.OS === 'android' ? 'Google Play' : 'App Store'}. Cancelling or
            changing your plan happens through your {Platform.OS === 'android' ? 'Google' : 'Apple'} account, not in FlyRegs directly.
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

function Row({
  icon, label, tokens, onPress, trailing, disabled,
}: {
  icon: string
  label: string
  tokens: ThemeTokens
  onPress: () => void
  trailing?: React.ReactNode
  disabled?: boolean
}) {
  const fs = useFS()
  return (
    <Pressable style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={onPress} disabled={disabled}>
      <View style={styles.rowIcon}>
        <Icon name={icon} size={fs(17)} color={tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>{label}</Text>
      {trailing ?? <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />}
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

  // lineHeight NOT set here -- always overridden inline with fs(11.5) * 1.39
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  footnote: { marginTop: 4, paddingHorizontal: 4 },
})
