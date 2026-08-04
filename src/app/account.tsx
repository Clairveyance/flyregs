import { useState, useEffect } from 'react'
import {
  View,
  Text,
  TextInput,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Platform,
  Linking,
  Switch,
  Modal,
} from 'react-native'
import { router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { restorePurchases } from '@/lib/revenuecat'
import { useFS } from '@/context/fontScale'
import { SUPPORT_EMAIL } from '@/lib/appInfo'
import { supabase } from '@/lib/supabase'
import { getAvatarUrl, getAvatarPresetId, resolveAvatarUrl, resolveAvatarPresetId, pickAndUploadAvatar, takeAndUploadAvatar, removeAvatar, selectAvatarPreset, getDisplayName } from '@/lib/avatar'
import { getAvatarPreset } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { AvatarEditModal } from '@/components/AvatarEditModal'
import {
  isAcUpdateAlertsEnabled,
  enableAcUpdateAlerts,
  disableAcUpdateAlerts,
  isRegOfTheDayEnabled,
  enableRegOfTheDay,
  disableRegOfTheDay,
  isDuelNotificationsEnabled,
  enableDuelNotifications,
  disableDuelNotifications,
} from '@/lib/notifications'
import { getMyRatings, addRating, removeRating, RATING_CODES, RATING_LABELS, RATING_SHORT_LABELS, RATING_GROUPS, RatingCode } from '@/lib/profileRatings'
import { getLeaderboardOptIn, setLeaderboardOptIn } from '@/lib/leaderboard'

export default function AccountScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, setIsPro, isPremium, setIsPremium, isUnlocked, setIsUnlocked, signOut, avatarOverride, setAvatarOverride, clearAvatarOverride } = useAuth()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const [restoring, setRestoring] = useState(false)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarEditOpen, setAvatarEditOpen] = useState(false)
  // avatarOverride (shared via AuthContext, see lib/avatar.ts) takes priority
  // when active so a freshly picked/selected avatar shows instantly here AND
  // in the Drawer/share cards in the same tick -- no waiting on a session
  // refresh or a network image re-download just to see your own new photo.
  const avatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  // Cache input is always the true remote value regardless of override, so
  // the on-disk cache stays warm in the background; same cache key as the
  // Drawer's avatar and any other "my own photo" spot. Presets never go
  // through this cache -- they're pure vector icon+color, no network fetch.
  const cachedAvatarUrl = useCachedImage(session?.user?.id ? `avatar_${session.user.id}` : null, getAvatarUrl(session))
  const avatarUrl = avatarOverride ? avatarOverride.uri : cachedAvatarUrl
  const [alertsEnabled, setAlertsEnabled] = useState(false)
  const [alertsBusy, setAlertsBusy] = useState(false)
  const [regOfDayEnabled, setRegOfDayEnabled] = useState(false)
  const [regOfDayBusy, setRegOfDayBusy] = useState(false)
  const [duelNotifEnabled, setDuelNotifEnabled] = useState(false)
  const [duelNotifBusy, setDuelNotifBusy] = useState(false)
  const [myRatings, setMyRatings] = useState<RatingCode[]>([])
  const [ratingBusy, setRatingBusy] = useState<RatingCode | null>(null)
  const [ratingPickerOpen, setRatingPickerOpen] = useState(false)
  const [leaderboardOptIn, setLeaderboardOptInState] = useState(false)
  const [leaderboardBusy, setLeaderboardBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Callsign -- shown to other people wherever this account appears in a
  // shared context (folder collaborator lists, "Shared by X" attribution,
  // the branded note-share card, leaderboards) instead of email. RC: "change
  // 'handle' to 'Callsign' for the user. that's much more aviation based
  // and more fun." Still stored in the same user_metadata.display_name
  // field getDisplayName()/the sharing RPCs/leaderboard RPCs already read,
  // so every one of those call sites keeps working with no other change --
  // only the label and the save path change here.
  //
  // Saving is now two steps, not one: set_callsign() (a SECURITY DEFINER
  // RPC backed by public.callsign_registry, see sync/migrations_callsign_
  // uniqueness.sql) reserves the name first and fails with CALLSIGN_TAKEN
  // if another user already holds it -- only once that succeeds does the
  // existing updateUser() call actually set the visible display_name.
  // Uniqueness can't be enforced with a plain index on auth.users itself
  // (confirmed live: Supabase's auth schema isn't owned by a role this
  // project can modify), so callsign_registry is the real gate and
  // auth.users stays purely the value every read site already trusts.
  const existingCallsign = (session?.user?.user_metadata as { display_name?: string } | undefined)?.display_name ?? ''
  const [callsignInput, setCallsignInput] = useState(existingCallsign)
  const [callsignSaving, setCallsignSaving] = useState(false)
  const [callsignDirty, setCallsignDirty] = useState(false)
  // RC: "we can omit this sentence [the always-visible 'must be unique'
  // help text]. that will be understood when the box turns red if a user
  // inputs an already-taken callsign -- then they get a similar red
  // warning as the account sign in page." Same field-level pattern as
  // auth.tsx's emailError/passwordError: red border + a short message
  // below the field, instead of a blocking Alert.
  const [callsignError, setCallsignError] = useState<string | null>(null)

  // session loads asynchronously -- on first render it's often still null,
  // so useState(existingCallsign) above captures an empty string that a
  // plain initializer would never revisit once session actually arrives.
  // Sync whenever the real value changes, but only while the user isn't
  // mid-edit (callsignDirty) so this can never clobber an unsaved draft.
  useEffect(() => {
    if (!callsignDirty) setCallsignInput(existingCallsign)
  }, [existingCallsign])

  const handleSaveCallsign = async () => {
    const trimmed = callsignInput.trim().slice(0, 40)
    setCallsignError(null)
    setCallsignSaving(true)
    try {
      const { error: reserveError } = await supabase.rpc('set_callsign', { p_callsign: trimmed })
      if (reserveError) {
        if (reserveError.message === 'CALLSIGN_TAKEN') {
          setCallsignError('Someone already flies under that callsign. Try another.')
          setCallsignSaving(false)
          return
        }
        throw reserveError
      }
      const { error } = await supabase.auth.updateUser({ data: { display_name: trimmed || null } })
      if (error) throw error
      setCallsignInput(trimmed)
      setCallsignDirty(false)
    } catch (err: any) {
      Sentry.captureException(err)
      Alert.alert('Error', 'Could not save your callsign. Try again in a moment.')
    }
    setCallsignSaving(false)
  }

  // AC update alerts moved from Premium to Pro in the pricing pivot -- see
  // flyregs_decisions.md.
  useEffect(() => {
    if (session?.user?.id && isPro) {
      isAcUpdateAlertsEnabled(session.user.id).then(setAlertsEnabled)
      isRegOfTheDayEnabled(session.user.id).then(setRegOfDayEnabled)
      isDuelNotificationsEnabled(session.user.id).then(setDuelNotifEnabled)
    } else {
      setAlertsEnabled(false)
      setRegOfDayEnabled(false)
      setDuelNotifEnabled(false)
    }
  }, [session?.user?.id, isPro])

  // Ratings are visible to anyone (public SELECT policy) but only load/edit
  // them for the signed-in owner here -- not gated on isPro for *reading*
  // your own list back, only for adding a new one (see handleToggleRating).
  useEffect(() => {
    if (session?.user?.id) {
      getMyRatings(session.user.id).then(setMyRatings)
      getLeaderboardOptIn(session.user.id).then(setLeaderboardOptInState)
    } else {
      setMyRatings([])
      setLeaderboardOptInState(false)
    }
  }, [session?.user?.id])

  const handleToggleLeaderboard = async (v: boolean) => {
    if (!session?.user?.id) return
    if (v && !isPro) { router.push('/paywall'); return }
    setLeaderboardBusy(true)
    try {
      await setLeaderboardOptIn(session.user.id, v)
      setLeaderboardOptInState(v)
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not update leaderboard visibility.')
    }
    setLeaderboardBusy(false)
  }

  const handleToggleRating = async (code: RatingCode) => {
    if (!session?.user?.id) return
    const has = myRatings.includes(code)
    if (!has && !isPro) { router.push('/paywall'); return }
    setRatingBusy(code)
    try {
      if (has) {
        await removeRating(session.user.id, code)
        setMyRatings((prev) => prev.filter((r) => r !== code))
      } else {
        await addRating(session.user.id, code)
        setMyRatings((prev) => [...prev, code])
      }
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not update your ratings.')
    }
    setRatingBusy(null)
  }

  const handleToggleAlerts = async (v: boolean) => {
    if (!isPro) { router.push('/paywall'); return }
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

  const handleToggleRegOfDay = async (v: boolean) => {
    if (!isPro) { router.push('/paywall'); return }
    if (!session?.user?.id) return
    setRegOfDayBusy(true)
    try {
      if (v) {
        await enableRegOfTheDay(session.user.id)
        setRegOfDayEnabled(true)
      } else {
        await disableRegOfTheDay(session.user.id)
        setRegOfDayEnabled(false)
      }
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        Alert.alert(
          'Notifications Disabled',
          'FlyRegs notifications are turned off in your device Settings. Enable them there to receive DailyReg.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        )
      } else {
        Alert.alert('Error', err?.message ?? 'Could not update alert preference.')
      }
      setRegOfDayEnabled(false)
    }
    setRegOfDayBusy(false)
  }

  const handleToggleDuelNotifications = async (v: boolean) => {
    if (!isPro) { router.push('/paywall'); return }
    if (!session?.user?.id) return
    setDuelNotifBusy(true)
    try {
      if (v) {
        await enableDuelNotifications(session.user.id)
        setDuelNotifEnabled(true)
      } else {
        await disableDuelNotifications(session.user.id)
        setDuelNotifEnabled(false)
      }
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        Alert.alert(
          'Notifications Disabled',
          'FlyRegs notifications are turned off in your device Settings. Enable them there to receive Duel alerts.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        )
      } else {
        Alert.alert('Error', err?.message ?? 'Could not update alert preference.')
      }
      setDuelNotifEnabled(false)
    }
    setDuelNotifBusy(false)
  }

  // `source` calls the picker AND uploads -- it takes an onLocalUri callback
  // that fires the instant the picker returns a real asset, well before the
  // network upload finishes, so the override (and everything reading it) can
  // show the actual picked photo immediately instead of waiting on the
  // upload + auth metadata round trip. `optimisticallyShown` tracks whether
  // onLocalUri actually fired THIS attempt, so a permission-denied/cancelled
  // error (which happens before any local asset exists) never wipes out an
  // unrelated override that was already active from an earlier, successful
  // action.
  const runAvatarPick = async (source: (onLocalUri: (uri: string) => void) => Promise<string>) => {
    if (!session?.user?.id || avatarBusy) return
    setAvatarBusy(true)
    let optimisticallyShown = false
    try {
      await source((localUri) => {
        optimisticallyShown = true
        setAvatarOverride(localUri, null)
      })
    } catch (err: any) {
      if (optimisticallyShown) clearAvatarOverride()
      if (err?.message === 'PERMISSION_DENIED') {
        Alert.alert(
          'Access Disabled',
          'FlyRegs needs access to your camera or photos to set a profile picture. Enable it in Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        )
      } else if (err?.message !== 'CANCELLED') {
        Sentry.captureException(err)
        Alert.alert('Error', 'Could not update your profile picture.')
      }
    }
    setAvatarBusy(false)
  }

  const handlePickAvatar = () => {
    if (!session?.user?.id || avatarBusy) return
    setAvatarEditOpen(true)
  }

  const handleRemoveAvatar = () => {
    if (!session?.user?.id || avatarBusy) return
    Alert.alert('Remove Photo', 'Remove your profile photo?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setAvatarBusy(true)
          setAvatarOverride(null, null)
          try {
            await removeAvatar(session.user.id)
          } catch (err: any) {
            Sentry.captureException(err)
            Alert.alert('Error', 'Could not remove your profile picture.')
            clearAvatarOverride()
          }
          setAvatarBusy(false)
        },
      },
    ])
  }

  const handleSelectPreset = async (presetId: string) => {
    if (!session?.user?.id || avatarBusy) return
    setAvatarBusy(true)
    setAvatarOverride(null, presetId)
    try {
      await selectAvatarPreset(session.user.id, presetId)
    } catch (err: any) {
      Sentry.captureException(err)
      Alert.alert('Error', 'Could not update your profile picture.')
      clearAvatarOverride()
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
    // This screen's own early-return above already blocks the whole
    // signed-out render, but guard here too -- belt and suspenders for a
    // paid-tier gate, per the rule that no path should ever be able to call
    // into RevenueCat without a session.
    if (!session) {
      router.replace('/auth')
      return
    }
    setRestoring(true)
    try {
      const status = await restorePurchases()
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      setIsUnlocked(status.isUnlocked)
      const active = status.isPro || status.isPremium || status.isUnlocked
      Alert.alert(
        active ? 'Purchases Restored' : 'Nothing to Restore',
        active ? 'Your FlyRegs purchases are active.' : 'No active purchases were found for this account.'
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

  const runAccountDelete = async () => {
    setDeleting(true)
    try {
      const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' })
      if (error) throw error
      await signOut()
      router.back()
    } catch (err: any) {
      Sentry.captureException(err)
      Alert.alert(
        'Couldn’t Delete Account',
        'Something went wrong. Please try again, or email our support team if this keeps happening.',
        [
          { text: 'OK', style: 'cancel' },
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
    setDeleting(false)
  }

  const handleDelete = () => {
    // Apple/Google don't let a developer cancel a subscription on the
    // user's behalf -- that's the platform's own billing relationship, not
    // this app's. Deleting the FlyRegs account only ever removes FlyRegs'
    // own data; it was never mentioned that the subscription itself keeps
    // billing separately, which is exactly the kind of thing someone
    // deleting their account needs to know before doing it, not after.
    const subscriptionWarning = (isPro || isPremium)
      ? ` You have an active ${isPremium ? 'Premium' : 'Pro'} subscription — deleting your account does NOT cancel it. Manage or cancel it first in ${Platform.OS === 'android' ? 'Google Play > Subscriptions' : 'Settings > [Your Name] > Subscriptions'} if you don't want to keep being charged.`
      : ''
    Alert.alert(
      'Delete Account',
      `This permanently deletes your account and all synced data (bookmarks, folders, notes, highlights). This cannot be undone.${subscriptionWarning}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Everything',
          style: 'destructive',
          onPress: () => {
            Alert.alert(
              'Are You Sure?',
              'There is no way to recover your account or data after this.',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete Permanently', style: 'destructive', onPress: runAccountDelete },
              ]
            )
          },
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
            <Icon name="person.crop.circle" size={fs(34)} color={tokens.t2} />
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
      <TabletContainer>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]} keyboardDismissMode="interactive">
        {/* Profile */}
        <View style={[styles.profileCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Pressable
            style={[styles.avatar, { backgroundColor: avatarPreset?.color ?? tokens.blu }]}
            onPress={handlePickAvatar}
            disabled={avatarBusy}
          >
            {avatarBusy ? (
              <ActivityIndicator color="#fff" />
            ) : avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
            ) : avatarPreset ? (
              <Icon name={avatarPreset.icon} size={fs(26)} color="#fff" />
            ) : (
              <Text style={[styles.avatarText, { fontSize: fs(22) }]}>{initial}</Text>
            )}
            <View style={[styles.avatarEditBadge, { backgroundColor: tokens.bg2, borderColor: tokens.bg }]}>
              <Icon name="camera.fill" size={fs(10)} color={tokens.t2} />
            </View>
          </Pressable>
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={[styles.email, { color: tokens.t1, fontSize: fs(16) }]} numberOfLines={1}>
              {email}
            </Text>
            <View style={styles.tierRow}>
              {isPremium ? (
                <>
                  <Icon name="checkmark.seal.fill" size={fs(14)} color={tokens.gold} />
                  <Text style={[styles.tierText, { color: tokens.gold, fontSize: fs(13) }]}>FlyRegs Premium</Text>
                </>
              ) : isPro ? (
                <>
                  <Icon name="checkmark.seal.fill" size={fs(14)} color={tokens.gold} />
                  <Text style={[styles.tierText, { color: tokens.gold, fontSize: fs(13) }]}>FlyRegs Pro</Text>
                </>
              ) : isUnlocked ? (
                <>
                  <Icon name="checkmark.seal.fill" size={fs(14)} color={tokens.amb} />
                  <Text style={[styles.tierText, { color: tokens.amb, fontSize: fs(13) }]}>FlyRegs Plus</Text>
                </>
              ) : (
                <Text style={[styles.tierText, { color: tokens.t3, fontSize: fs(13) }]}>Free plan</Text>
              )}
            </View>
          </View>
        </View>

        {/* Profile group — Callsign */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>PROFILE</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, padding: 14 }]}>
          <View style={styles.callsignLabelRow}>
            <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Callsign</Text>
            <InfoPopup
              id="account-callsign-fallback"
              title="Callsign"
              body="If none is set, your email prefix is shown in its place in Premium shared folders, leaderboards, and anywhere else this name is relevant to others."
              iconSize={fs(15)}
            />
          </View>
          <View style={styles.handleInputRow}>
            <TextInput
              style={[styles.handleInput, { color: tokens.t1, borderColor: callsignError ? tokens.red : tokens.bdr, backgroundColor: tokens.bg, fontSize: fs(14.5) }]}
              value={callsignInput}
              onChangeText={(v) => { setCallsignInput(v); setCallsignDirty(true); setCallsignError(null) }}
              placeholder="e.g. Maverick"
              placeholderTextColor={tokens.t4}
              maxLength={40}
              autoCapitalize="words"
              returnKeyType="done"
              onSubmitEditing={handleSaveCallsign}
            />
            {callsignSaving ? (
              <ActivityIndicator size="small" color={tokens.t3} style={styles.handleSaveBtn} />
            ) : (
              <Pressable
                style={[styles.handleSaveBtn, { backgroundColor: callsignDirty ? tokens.blu : tokens.bg4 }]}
                onPress={handleSaveCallsign}
                disabled={!callsignDirty}
              >
                <Text style={[styles.handleSaveBtnText, { fontSize: fs(13) }]}>Save</Text>
              </Pressable>
            )}
          </View>
          {callsignError ? (
            <Text style={[styles.fieldError, { color: tokens.red, fontSize: fs(12.5) }]}>{callsignError}</Text>
          ) : null}

          {/* Ratings live on Community > Profile, not here. They are a
              profile/bragging concept shown to other pilots, and having the
              editor in Account while the display was on Profile meant the
              Profile's own "+ Add Rating" just threw you to a settings
              screen. See components/RatingPicker.tsx. */}
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
            onPress={() => router.push('/manage-subscription')}
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

        {/* My Aircraft group — the actual targeting mechanism for AD
            alerts, see my-aircraft.tsx's own header comment. */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>AIRWORTHINESS DIRECTIVES</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Row
            icon="doc.plaintext"
            label={isPremium ? 'My Fleet' : 'My Aircraft'}
            tokens={tokens}
            onPress={() => router.push('/my-aircraft' as any)}
            last
          />
        </View>

        {/* Notifications group — AC Update Alerts is a Pro feature (moved
            from Premium in the pricing pivot); the in-app switch is our own
            send-preference, separate from (and layered on top of) the
            device's own OS-level notification permission — see
            src/lib/notifications.ts header comment. */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>NOTIFICATIONS</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <Icon name="bell" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>AC Update Alerts</Text>
              {!isPro && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PRO</Text>
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
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <Icon name="star.fill" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>DailyReg</Text>
              {!isPro && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PRO</Text>
                </View>
              )}
            </View>
            {regOfDayBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={regOfDayEnabled}
                onValueChange={handleToggleRegOfDay}
                trackColor={{ true: tokens.blu, false: undefined }}
              />
            )}
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <View style={styles.rowIcon}>
              <Icon name="bolt.fill" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Duel Alerts</Text>
              {!isPro && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PRO</Text>
                </View>
              )}
            </View>
            {duelNotifBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={duelNotifEnabled}
                onValueChange={handleToggleDuelNotifications}
                trackColor={{ true: tokens.blu, false: undefined }}
              />
            )}
          </View>
        </View>

        {/* Community group — Ready Room leaderboard visibility. Off by
            default, same privacy stance as shared folders/cloud sync
            elsewhere in this app: opting in surfaces your callsign (or email
            prefix) and weekly study activity to every other opted-in user. */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>COMMUNITY</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <View style={styles.rowIcon}>
              <Icon name="person.2.fill" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Show me on the Ready Room leaderboard</Text>
              {!isPro && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PRO</Text>
                </View>
              )}
            </View>
            {leaderboardBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={leaderboardOptIn}
                onValueChange={handleToggleLeaderboard}
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
            onPress={deleting ? () => {} : handleDelete}
            trailing={deleting ? <ActivityIndicator color={tokens.red} /> : undefined}
            last
          />
        </View>
      </ScrollView>
      </TabletContainer>
      <AvatarEditModal
        visible={avatarEditOpen}
        avatarUrl={avatarUrl}
        preset={avatarPreset}
        initial={initial}
        busy={avatarBusy}
        onTakePhoto={() => runAvatarPick((onLocalUri) => takeAndUploadAvatar(session.user.id, onLocalUri))}
        onChooseLibrary={() => runAvatarPick((onLocalUri) => pickAndUploadAvatar(session.user.id, onLocalUri))}
        onSelectPreset={handleSelectPreset}
        onRemovePhoto={handleRemoveAvatar}
        onDone={() => setAvatarEditOpen(false)}
      />
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
        <Icon name={icon} size={fs(17)} color={tint ?? tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tint ?? tokens.t1, fontSize: fs(14.5) }]}>{label}</Text>
      {trailing ?? <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />}
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
  callsignLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  handleInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handleInput: { flex: 1, height: 42, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12 },
  handleSaveBtn: { height: 42, minWidth: 60, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  handleSaveBtnText: { color: '#fff', fontWeight: '700' },
  fieldError: { marginTop: 6, fontWeight: '500' },
  ratingChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratingChip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, minHeight: 30, justifyContent: 'center' },

  pickerScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  pickerSheet: { height: '78%', borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  pickerHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerTitle: { fontWeight: '700' },
  pickerBody: { padding: 16, paddingBottom: 40 },
  pickerGroupLabel: { fontWeight: '600', letterSpacing: 0.6, marginBottom: 4 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerRowText: { fontWeight: '500' },
  pickerCheckEmpty: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5 },
  ratingChipText: { fontWeight: '600' },

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
