import { useState, useEffect } from 'react'
import {
  View,
  Text,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
  Linking,
  Switch,
} from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { restorePurchases } from '@/lib/revenuecat'
import { useFS } from '@/context/fontScale'
import { SUPPORT_EMAIL } from '@/lib/appInfo'
import { getAvatarUrl, pickAndUploadAvatar } from '@/lib/avatar'
import {
  isAcUpdateAlertsEnabled,
  enableAcUpdateAlerts,
  disableAcUpdateAlerts,
} from '@/lib/notifications'

const MANAGE_SUBS_URL = Platform.select({
  ios: 'https://apps.apple.com/account/subscriptions',
  android: 'https://play.google.com/store/account/subscriptions',
  default: 'https://apps.apple.com/account/subscriptions',
})

export default function AccountScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, setIsPro, isPremium, setIsPremium, signOut } = useAuth()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const [restoring, setRestoring] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarOverride, setAvatarOverride] = useState<string | null>(null)
  const [alertsEnabled, setAlertsEnabled] = useState(false)
  const [alertsBusy, setAlertsBusy] = useState(false)

  useEffect(() => {
    if (session?.user?.id && isPremium) {
      isAcUpdateAlertsEnabled(session.user.id).then(setAlertsEnabled)
    } else {
      setAlertsEnabled(false)
    }
  }, [session?.user?.id, isPremium])

  const handleToggleAlerts = async (v: boolean) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    if (!session?.user?.id) return
    setAlertsBusy(true)
    try {
      if (v) {
        await enableAcUpdateAlerts(session.user.id)
        setAlertsEnabled(true)
      } else {
        await disableAcUpdateAlerts(session.user.id)
        setAlertsEnabled(false)
      }
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        Alert.alert(
          'Notifications Disabled',
          'FlyRegs notifications are turned off in your device Settings. Enable them there to receive AC update alerts.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        )
      } else {
        Alert.alert('Error', err?.message ?? 'Could not update alert preference.')
      }
      setAlertsEnabled(false)
    }
    setAlertsBusy(false)
  }

  const handlePickAvatar = async () => {
    if (!session?.user?.id || avatarBusy) return
    setAvatarBusy(true)
    try {
      const url = await pickAndUploadAvatar(session.user.id)
      setAvatarOverride(url)
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        Alert.alert(
          'Photo Access Disabled',
          'FlyRegs needs access to your photos to set a profile picture. Enable it in Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        )
      } else if (err?.message !== 'CANCELLED') {
        Alert.alert('Error', 'Could not update your profile picture.')
      }
    }
    setAvatarBusy(false)
  }

  const email = session?.user?.email ?? null
  const initial = email ? email.charAt(0).toUpperCase() : '?'

  const handleRestore = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Available on iOS & Android', 'Restore purchases from the FlyRegs mobile app.')
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
        active ? 'Your FlyRegs subscription is active.' : 'No active subscription was found for this account.'
      )
    } catch (err: any) {
      Alert.alert('Restore Failed', err?.message ?? 'Please try again later.')
    }
    setRestoring(false)
  }

  const handleSignOut = () => {
    Alert.alert('Sign Out', 'Sign out of your account?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await signOut()
          router.back()
        },
      },
    ])
  }

  const handleDelete = () => {
    Alert.alert(
      'Delete Account',
      'This permanently deletes your account and any synced data. This cannot be undone. To proceed, email our support team and we will process your request within 30 days.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Email Support',
          onPress: () =>
            Linking.openURL(
              `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Delete my account')}`
            ),
        },
      ]
    )
  }

  // Not signed in — soft prompt
  if (!session) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Account" onBack={backToMenu} />
        <View style={styles.signedOut}>
          <View style={[styles.avatar, { backgroundColor: tokens.bg4 }]}>
            <Icon name="person.crop.circle" size={34} color={tokens.t2} />
          </View>
          <Text style={[styles.signedOutTitle, { color: tokens.t1, fontSize: fs(18) }]}>You're not signed in</Text>
          <Text style={[styles.signedOutSub, { color: tokens.t3, fontSize: fs(14) }]}>
            Sign in to sync bookmarks and notes across your devices.
          </Text>
          <Pressable
            style={[styles.primaryBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.replace('/auth')}
          >
            <Text style={[styles.primaryBtnText, { fontSize: fs(15.5) }]}>Sign In or Create Account</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Account" onBack={backToMenu} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {/* Profile */}
        <View style={[styles.profileCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Pressable
            style={[styles.avatar, { backgroundColor: tokens.blu }]}
            onPress={handlePickAvatar}
            disabled={avatarBusy}
          >
            {avatarBusy ? (
              <ActivityIndicator color="#fff" />
            ) : (avatarOverride ?? getAvatarUrl(session)) ? (
              <Image source={{ uri: (avatarOverride ?? getAvatarUrl(session))! }} style={styles.avatarImage} />
            ) : (
              <Text style={[styles.avatarText, { fontSize: fs(22) }]}>{initial}</Text>
            )}
            <View style={[styles.avatarEditBadge, { backgroundColor: tokens.bg2, borderColor: tokens.bg }]}>
              <Icon name="camera.fill" size={10} color={tokens.t2} />
            </View>
          </Pressable>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={[styles.email, { color: tokens.t1, fontSize: fs(16) }]} numberOfLines={1}>
              {email}
            </Text>
            <View style={styles.tierRow}>
              {isPremium ? (
                <>
                  <Icon name="checkmark.seal.fill" size={14} color={tokens.gold} />
                  <Text style={[styles.tierText, { color: tokens.gold, fontSize: fs(13) }]}>FlyRegs Premium</Text>
                </>
              ) : isPro ? (
                <>
                  <Icon name="checkmark.seal.fill" size={14} color={tokens.gold} />
                  <Text style={[styles.tierText, { color: tokens.gold, fontSize: fs(13) }]}>FlyRegs Pro</Text>
                </>
              ) : (
                <Text style={[styles.tierText, { color: tokens.t3, fontSize: fs(13) }]}>Free plan</Text>
              )}
            </View>
          </View>
        </View>

        {/* Subscription group */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SUBSCRIPTION</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {!isPro && (
            <Row
              icon="crown"
              label="Upgrade to Pro"
              tint={tokens.blu}
              tokens={tokens}
              onPress={() => router.push('/paywall')}
            />
          )}
          <Row
            icon="creditcard"
            label="Manage Subscription"
            tokens={tokens}
            onPress={() => Linking.openURL(MANAGE_SUBS_URL)}
          />
          <Row
            icon="arrow.clockwise"
            label="Restore Purchases"
            tokens={tokens}
            onPress={handleRestore}
            trailing={restoring ? <ActivityIndicator size="small" color={tokens.t3} /> : undefined}
            last
          />
        </View>

        {/* Notifications group — AC Update Alerts is a Premium feature; the
            in-app switch is our own send-preference, separate from (and
            layered on top of) the device's own OS-level notification
            permission — see src/lib/notifications.ts header comment. */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>NOTIFICATIONS</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <View style={styles.rowIcon}>
              <Icon name="bell" size={17} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>AC Update Alerts</Text>
              {!isPremium && (
                <View style={[styles.premBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.gold, fontSize: fs(9.5) }]}>PREMIUM</Text>
                </View>
              )}
            </View>
            {alertsBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={alertsEnabled}
                onValueChange={handleToggleAlerts}
                trackColor={{ true: tokens.blu, false: undefined }}
              />
            )}
          </View>
        </View>

        {/* Danger group */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>ACCOUNT</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Row
            icon="rectangle.portrait.and.arrow.right"
            label="Sign Out"
            tokens={tokens}
            onPress={handleSignOut}
          />
          <Row
            icon="trash"
            label="Delete Account"
            tint={tokens.red}
            tokens={tokens}
            onPress={handleDelete}
            last
          />
        </View>
      </ScrollView>
    </View>
  )
}

function Row({
  icon,
  label,
  tokens,
  onPress,
  tint,
  trailing,
  last,
}: {
  icon: string
  label: string
  tokens: ThemeTokens
  onPress: () => void
  tint?: string
  trailing?: React.ReactNode
  last?: boolean
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.row, !last && { borderBottomWidth: 1, borderBottomColor: tokens.bdr }]}
      onPress={onPress}
    >
      <View style={styles.rowIcon}>
        <Icon name={icon} size={17} color={tint ?? tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tint ?? tokens.t1, fontSize: fs(14.5) }]}>{label}</Text>
      {trailing ?? <Icon name="chevron.right" size={13} color={tokens.t4} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 8 },

  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 8,
  },
  avatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: { width: 54, height: 54, borderRadius: 27 },
  avatarEditBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 22 },
  email: { fontSize: 16, fontWeight: '600' },
  tierRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  tierText: { fontSize: 13, fontWeight: '600' },

  groupLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginTop: 10,
    marginBottom: 4,
    paddingLeft: 4,
  },
  group: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 14, gap: 12 },
  rowIcon: { width: 22, alignItems: 'center' },
  rowLabel: { flex: 1, fontSize: 14.5, fontWeight: '500' },
  premBadge: { alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, marginTop: 3 },
  premBadgeText: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },

  // signed out
  signedOut: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 10 },
  signedOutTitle: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  signedOutSub: { fontSize: 14, textAlign: 'center', lineHeight: 21, maxWidth: 280 },
  primaryBtn: {
    borderRadius: 13,
    paddingHorizontal: 22,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 14,
    alignSelf: 'stretch',
  },
  primaryBtnText: { color: '#fff', fontSize: 15.5, fontWeight: '700' },
})
