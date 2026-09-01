import { useState, useEffect, useCallback, useRef } from 'react'
import { View, Text, TextInput, Image, Pressable, ScrollView, StyleSheet, ActivityIndicator, Platform, Linking, Switch, Modal, PanResponder, AppState } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useReturnToMenu, useRailInset } from '@/context/drawer'
import { useIsTablet } from '@/context/responsive'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { MyAircraftBody } from '@/app/my-aircraft'
import { restorePurchases } from '@/lib/revenuecat'
import { useFS, useInputFS } from '@/context/fontScale'
import { SUPPORT_EMAIL } from '@/lib/appInfo'
import { supabase, isEdgeFunctionTimeout } from '@/lib/supabase'
import { wipeAllLocalDataForAccountDeletion } from '@/lib/syncOwner'
import { getAvatarUrl, getAvatarPresetId, resolveAvatarUrl, resolveAvatarPresetId, pickAndUploadAvatar, takeAndUploadAvatar, removeAvatar, selectAvatarPreset, getDisplayName } from '@/lib/avatar'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { AvatarEditModal } from '@/components/AvatarEditModal'
import { useConfirm } from '@/components/ConfirmDialog'
import * as Biometric from '@/lib/biometricAuth'
import {
  isAcUpdateAlertsEnabled,
  enableAcUpdateAlerts,
  disableAcUpdateAlerts,
  isDailyRegEnabled,
  enableDailyReg,
  disableDailyReg,
  isDailyWordEnabled,
  enableDailyWord,
  disableDailyWord,
  isDuelNotificationsEnabled,
  enableDuelNotifications,
  disableDuelNotifications,
} from '@/lib/notifications'
import { getMyRatings, addRating, removeRating, RATING_CODES, RATING_LABELS, RATING_SHORT_LABELS, RATING_GROUPS, RatingCode } from '@/lib/profileRatings'
import { getLeaderboardOptIn, setLeaderboardOptIn } from '@/lib/leaderboard'
import { getFleetSummary } from '@/lib/aircraftSharing'
import { getAircraftReminders } from '@/lib/adParts'
import { getMyPhoneNumber, setMyPhoneNumber } from '@/lib/contactMatch'

// iPad: My Fleet's 3rd-pane width, resizable via a drag handle on its
// leading edge -- same persistence pattern as the drawer's own railWidth in
// context/drawer.tsx, just scoped locally here since only this screen uses it.
const AIRCRAFT_PANE_WIDTH_KEY = '@flyregs/aircraft-pane-width'
const AIRCRAFT_PANE_WIDTH_DEFAULT = 400
const AIRCRAFT_PANE_WIDTH_MIN = 320
const AIRCRAFT_PANE_WIDTH_MAX = 560

// 25s -- longer than this app's other two invoke() timeouts (semantic
// search's 18s, RevenueCat sync's 15s, both in lib/*.ts) because this is a
// real server-side operation, not a lookup that can safely be assumed
// fast: supabase/functions/delete-account/index.ts deletes an avatar
// storage object, then the auth user itself, which cascades across a dozen+
// tables via ON DELETE CASCADE. See lib/supabase.ts's isEdgeFunctionTimeout
// comment for why this call previously had no bound at all.
const DELETE_ACCOUNT_TIMEOUT_MS = 25000

export default function AccountScreen() {
  const { tokens, redShift } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web: no dialog, no throw, no log. Every error message and every
  // confirm on this screen (including Delete Account) was invisible during
  // Browser-pane QA. See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { session, isPro, setIsPro, isPremium, setIsPremium, isUnlocked, setIsUnlocked, hasPlusAccess, hasProAccess, signOut, avatarOverride, setAvatarOverride, clearAvatarOverride, loading: authLoading } = useAuth()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  // iPad: RC, "there's plenty of room for Account to open fully to the
  // right of the burger." The drawer stays open beside this screen instead
  // of closing (see Drawer.tsx's nav() + context/drawer.tsx's
  // RAIL_AWARE_PATHS) -- railInset offsets this screen's own content so it
  // starts after the drawer panel instead of rendering underneath it.
  const isTablet = useIsTablet()
  const railInset = useRailInset(isTablet)
  // iPad: "let's figure out how to build the 3 pane slide out" -- My Fleet
  // beside Account, beside the drawer, matching the drawer<->Account rail
  // pattern above rather than a full-screen push that would cover Account.
  // Tablet-only; phone keeps the original router.push behavior below.
  const [aircraftPaneOpen, setAircraftPaneOpen] = useState(false)
  const [aircraftPaneWidth, setAircraftPaneWidthState] = useState(AIRCRAFT_PANE_WIDTH_DEFAULT)
  useEffect(() => {
    AsyncStorage.getItem(AIRCRAFT_PANE_WIDTH_KEY).then((raw) => {
      const n = Number(raw)
      if (!isNaN(n) && n >= AIRCRAFT_PANE_WIDTH_MIN && n <= AIRCRAFT_PANE_WIDTH_MAX) {
        setAircraftPaneWidthState(n)
      }
    })
  }, [])
  const setAircraftPaneWidth = (w: number) => {
    const clamped = Math.max(AIRCRAFT_PANE_WIDTH_MIN, Math.min(AIRCRAFT_PANE_WIDTH_MAX, w))
    setAircraftPaneWidthState(clamped)
    AsyncStorage.setItem(AIRCRAFT_PANE_WIDTH_KEY, String(clamped))
  }
  // BB-008/#422: Face ID/Touch ID as a faster sign-in alternative -- see
  // lib/biometricAuth.ts. Row stays hidden entirely when there's no
  // biometric hardware (always true on web/web preview).
  const [biometricAvailable, setBiometricAvailable] = useState(false)
  const [biometricEnabled, setBiometricEnabled] = useState(false)
  const [biometricBusy, setBiometricBusy] = useState(false)
  const [bioLabel, setBioLabel] = useState('Face ID')
  useEffect(() => {
    Biometric.isHardwareAvailable().then((available) => {
      setBiometricAvailable(available)
      if (!available) return
      Biometric.biometricLabel().then(setBioLabel)
      Biometric.isBiometricSignInEnabled().then(setBiometricEnabled)
    })
  }, [])
  const handleToggleBiometric = async (next: boolean) => {
    if (!session) return
    setBiometricBusy(true)
    if (next) {
      const ok = await Biometric.enableBiometricSignIn(session).catch(() => false)
      setBiometricEnabled(ok)
    } else {
      await Biometric.disableBiometricSignIn()
      setBiometricEnabled(false)
    }
    setBiometricBusy(false)
  }
  const aircraftPaneStartWidth = useRef(aircraftPaneWidth)
  const aircraftPaneResizePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { aircraftPaneStartWidth.current = aircraftPaneWidth },
      // Divider sits at the pane's LEADING edge, so dragging it right (+dx)
      // should shrink the pane, not grow it -- the inverse of the drawer's
      // own trailing-edge handle.
      onPanResponderMove: (_, { dx }) => setAircraftPaneWidth(aircraftPaneStartWidth.current - dx),
      onPanResponderRelease: (_, { dx }) => setAircraftPaneWidth(aircraftPaneStartWidth.current - dx),
    })
  ).current
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
  const [dailyRegEnabled, setDailyRegEnabled] = useState(false)
  const [dailyRegBusy, setDailyRegBusy] = useState(false)
  const [dailyWordEnabled, setDailyWordEnabled] = useState(false)
  const [dailyWordBusy, setDailyWordBusy] = useState(false)
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
    if (callsignSaving) return
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
      confirm({ title: 'Could not save callsign', message: 'Try again in a moment.', cancelLabel: null })
    }
    setCallsignSaving(false)
  }

  // Phone Number -- optional, matching-only field for Find Friends' contact
  // discovery (RC: "let's do the phone addition your way. make it optional
  // and prompt it contextually"). Never shown to anyone else -- only hashed
  // and compared against the CALLER's own device contacts (see
  // contactMatch.ts / sync/migrations_contact_match_phone.sql), same
  // privacy shape as the existing email match. Unlike Callsign, no
  // uniqueness reservation is needed (nothing else reads this value), so a
  // plain updateUser() write is the whole save path.
  const existingPhone = getMyPhoneNumber(session) ?? ''
  const [phoneInput, setPhoneInput] = useState(existingPhone)
  const [phoneSaving, setPhoneSaving] = useState(false)
  const [phoneDirty, setPhoneDirty] = useState(false)

  useEffect(() => {
    if (!phoneDirty) setPhoneInput(existingPhone)
  }, [existingPhone])

  const handleSavePhone = async () => {
    if (phoneSaving) return
    const trimmed = phoneInput.trim().slice(0, 30)
    setPhoneSaving(true)
    try {
      await setMyPhoneNumber(trimmed || null)
      setPhoneInput(trimmed)
      setPhoneDirty(false)
    } catch (err: any) {
      Sentry.captureException(err)
      confirm({ title: 'Could not save phone number', message: 'Try again in a moment.', cancelLabel: null })
    }
    setPhoneSaving(false)
  }

  // AC update alerts moved from Premium to Pro in the pricing pivot -- see
  // flyregs_decisions.md. hasProAccess (not bare isPro): Premium subscribers
  // get everything Pro offers, so a Premium account whose entitlement shape
  // happens to be isPro:false/isPremium:true (comp-granted, see
  // context/auth.tsx's hasProAccess comment) must still see its real
  // AC-alert/DailyReg/Duel-notification status here, not a false "off".
  useEffect(() => {
    if (session?.user?.id && hasProAccess) {
      isAcUpdateAlertsEnabled(session.user.id).then(setAlertsEnabled)
      isDailyRegEnabled(session.user.id).then(setDailyRegEnabled)
      isDuelNotificationsEnabled(session.user.id).then(setDuelNotifEnabled)
    } else if (session?.user?.id && authLoading) {
      // Signed in, but hasProAccess isn't trustworthy yet -- isPro/isPremium
      // both start false and only become authoritative once auth's own
      // `loading` resolves (see context/auth.tsx). Blanking the toggles on
      // that transient false showed a real Pro/Premium subscriber every
      // notification switch as OFF, which reads as "my settings were lost"
      // rather than "still loading." Leave them as-is and let the effect
      // re-run with the real value; same reasoning as (tabs)/index.tsx's
      // HobbsHeaderButton refusing to blank its cached fleet.
    } else {
      setAlertsEnabled(false)
      setDailyRegEnabled(false)
      setDuelNotifEnabled(false)
    }
  }, [session?.user?.id, hasProAccess, authLoading])

  // DailyWord is its own effect, keyed on hasPlusAccess rather than folded
  // into the hasProAccess one above -- DailyWord's real content gate is
  // Plus (has_plus_access() in get_word_of_the_day()), a lower bar than
  // DailyReg's Pro gate, confirmed live before writing this (see
  // notifications.ts's getWordOfTheDay comment). A Plus-only account must
  // see its real DailyWord status here even though hasProAccess is false
  // for them.
  useEffect(() => {
    if (session?.user?.id && hasPlusAccess) {
      isDailyWordEnabled(session.user.id).then(setDailyWordEnabled)
    } else if (session?.user?.id && authLoading) {
      // Same transient-false guard as the hasProAccess effect above.
    } else {
      setDailyWordEnabled(false)
    }
  }, [session?.user?.id, hasPlusAccess, authLoading])

  // RC: "let's put a small version of the color wheel on the actual
  // Account bar for them. this will let them see at a glance if they have
  // any approaching or overdue (orange or red) ADs even before having to
  // open the section." Pro AND Premium -- RC (2026-08-29, real device):
  // "Pro doesn't get the full fleet framing, but they can still get the
  // single colored ring identifier that sits on the My Aircraft button."
  // Only the LABEL above ("My Fleet" vs "My Aircraft") stays tier-specific;
  // the ring itself is just mimicking whatever's inside, same real
  // getFleetSummary() data Pro's own My Aircraft screen already uses.
  const [fleetStatus, setFleetStatus] = useState<'clear' | 'attention' | 'overdue' | null>(null)
  // 2026-08-29, "built but inert" sweep: this ring reproduced two bugs
  // my-aircraft/index.tsx already found and fixed for itself the same
  // night, in this sibling copy of the same feature.
  //
  // (1) get_fleet_summary()'s overdueReminderCount is computed server-side
  // as `due_date < current_date` in UTC -- a reminder due "today" reads as
  // already overdue for the rest of the evening in any timezone behind
  // UTC (and the mirror case ahead of it). my-aircraft/index.tsx works
  // around this by re-fetching each aircraft's real reminders and
  // recomputing overdue/due-soon from daysUntil() in the DEVICE's local
  // time -- this ring trusted the raw server field instead, so it could
  // show red "overdue" here while My Aircraft, one tap away, correctly
  // showed the same reminder as amber "due soon."
  // (2) it also had no due-soon concept at all -- an aircraft with an
  // imminent-but-not-yet-overdue reminder and no open ADs read as fully
  // clear here.
  const loadFleetStatus = useCallback(() => {
    if (session?.user?.id && !hasProAccess && authLoading) return
    if (!session?.user?.id || !hasProAccess) { setFleetStatus(null); return }
    getFleetSummary()
      .then(async (rows) => {
        if (rows.length === 0) { setFleetStatus(null); return }
        const openAds = rows.reduce((sum, a) => sum + a.openAdCount, 0)
        const lists = await Promise.all(rows.map((a) => getAircraftReminders(a.aircraftId).catch(() => [])))
        let overdue = 0
        let dueSoon = 0
        lists.forEach((list, i) => {
          // Hobbs counts here too. This mini-ring read dueDate only, so an
          // aircraft whose 100-hour inspection was overdue BY HOURS showed
          // clear/green on the Account screen while its own detail row showed
          // red. Same 10hr threshold and worst-of-both-axes rule as the
          // aircraft detail row and the fleet card ring, so every surface that
          // reports fleet status now agrees. (RC, 2026-09-01: green outside
          // 10 hrs, amber 0-10, red once the reminder meets or passes the tach.)
          const currentHobbs = rows[i].currentHobbsHours
          for (const r of list) {
            const due = new Date(r.dueDate + 'T00:00:00')
            const now = new Date()
            now.setHours(0, 0, 0, 0)
            const days = Math.round((due.getTime() - now.getTime()) / 86400000)
            const hobbsRemaining = r.dueHobbsHours != null && currentHobbs != null
              ? r.dueHobbsHours - currentHobbs
              : null
            const hobbsOverdue = hobbsRemaining != null && hobbsRemaining < 0
            const hobbsSoon = hobbsRemaining != null && hobbsRemaining >= 0 && hobbsRemaining <= 10
            if (days < 0 || hobbsOverdue) overdue++
            else if (days <= 30 || hobbsSoon) dueSoon++
          }
        })
        setFleetStatus(overdue > 0 ? 'overdue' : openAds > 0 || dueSoon > 0 ? 'attention' : 'clear')
      })
      .catch(() => setFleetStatus(null))
  }, [session?.user?.id, hasProAccess, authLoading])

  // useFocusEffect, not a plain mount-only useEffect: Account is a plain
  // Stack.Screen that stays mounted in the background behind My Aircraft,
  // so this must re-fetch on every return, not just once. Plus an
  // AppState foreground listener, since useFocusEffect alone doesn't fire
  // on unlocking the phone and these are date-derived numbers that go
  // stale simply by crossing midnight. Matches the identical pair of
  // listeners my-aircraft/index.tsx already has for the exact same reason.
  useFocusEffect(useCallback(() => { loadFleetStatus() }, [loadFleetStatus]))
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') loadFleetStatus()
    })
    return () => sub.remove()
  }, [loadFleetStatus])

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
    // !authLoading on every tier gate in this file: isPro/isPremium/
    // isUnlocked all start false and only become authoritative once auth's
    // own `loading` resolves (cold launch, and the SIGNED_IN event a Face
    // ID sign-in raises -- see context/auth.tsx). Account is two taps from
    // Home via the drawer, so a real subscriber genuinely can tap one of
    // these controls inside that window; doing nothing for that fraction of
    // a second is far better than bouncing them to a paywall for a tier
    // they already pay for. Retapping once auth has landed works normally.
    if (v && !hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    // Every leaderboard RPC's display name falls back to a generic "Member"
    // when no Callsign is set (see sync/migrations_fix_leaderboard_email_
    // exposure.sql) -- safe, but not personalized. Require a real Callsign
    // before opt-in so nobody shows up on a leaderboard as just "Member."
    if (v && !existingCallsign.trim()) {
      confirm({
        title: 'Set a Callsign First',
        message: 'The Ready Room leaderboard shows your Callsign to other people -- set one above, then turn this on.',
        cancelLabel: null,
      })
      return
    }
    setLeaderboardBusy(true)
    try {
      await setLeaderboardOptIn(session.user.id, v)
      setLeaderboardOptInState(v)
    } catch (err: any) {
      confirm({ title: 'Error', message: err?.message ?? 'Could not update leaderboard visibility.', cancelLabel: null })
    }
    setLeaderboardBusy(false)
  }

  const handleToggleRating = async (code: RatingCode) => {
    if (!session?.user?.id) return
    const has = myRatings.includes(code)
    if (!has && !hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
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
      confirm({ title: 'Error', message: err?.message ?? 'Could not update your ratings.', cancelLabel: null })
    }
    setRatingBusy(null)
  }

  const handleToggleAlerts = async (v: boolean) => {
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
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
        confirm({
          title: 'Notifications Disabled',
          message: 'FlyRegs notifications are turned off in your device Settings. Enable them there to receive AC update alerts.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else {
        confirm({ title: 'Error', message: err?.message ?? 'Could not update alert preference.', cancelLabel: null })
      }
      setAlertsEnabled(false)
    }
    setAlertsBusy(false)
  }

  const handleToggleDailyReg = async (v: boolean) => {
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    if (!session?.user?.id) return
    setDailyRegBusy(true)
    try {
      if (v) {
        await enableDailyReg(session.user.id)
        setDailyRegEnabled(true)
      } else {
        await disableDailyReg(session.user.id)
        setDailyRegEnabled(false)
      }
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        confirm({
          title: 'Notifications Disabled',
          message: 'FlyRegs notifications are turned off in your device Settings. Enable them there to receive DailyReg.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else {
        confirm({ title: 'Error', message: err?.message ?? 'Could not update alert preference.', cancelLabel: null })
      }
      setDailyRegEnabled(false)
    }
    setDailyRegBusy(false)
  }

  const handleToggleDailyWord = async (v: boolean) => {
    // hasPlusAccess, NOT hasProAccess -- DailyWord's own content gate is
    // Plus (see the effect above and notifications.ts's getWordOfTheDay
    // comment). BB-090 (flyregs_beta_bug_tracker.md) was exactly this
    // mistake for a different toggle: copy-pasting handleToggleDailyReg's
    // gate check verbatim silently mis-gated a lower/different-tier
    // feature. Checked, not assumed, before writing this line.
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (!session?.user?.id) return
    setDailyWordBusy(true)
    try {
      if (v) {
        await enableDailyWord(session.user.id)
        setDailyWordEnabled(true)
      } else {
        await disableDailyWord(session.user.id)
        setDailyWordEnabled(false)
      }
    } catch (err: any) {
      if (err?.message === 'PERMISSION_DENIED') {
        confirm({
          title: 'Notifications Disabled',
          message: 'FlyRegs notifications are turned off in your device Settings. Enable them there to receive DailyWord.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else {
        confirm({ title: 'Error', message: err?.message ?? 'Could not update alert preference.', cancelLabel: null })
      }
      setDailyWordEnabled(false)
    }
    setDailyWordBusy(false)
  }

  const handleToggleDuelNotifications = async (v: boolean) => {
    // Duels itself is Premium-only (see paywall.tsx PLUS/PRO/PREMIUM feature
    // lists) -- this toggle was copy-pasted from handleToggleDailyReg above
    // it and inherited that function's `isPro` check, which let a Pro
    // (non-Premium) account enable alerts for a feature it can't even play.
    // BB-090, real device beta report, 2026-08-08.
    if (!isPremium) { if (!authLoading) router.push('/paywall?tier=premium'); return }
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
        confirm({
          title: 'Notifications Disabled',
          message: 'FlyRegs notifications are turned off in your device Settings. Enable them there to receive Duel alerts.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else {
        confirm({ title: 'Error', message: err?.message ?? 'Could not update alert preference.', cancelLabel: null })
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
        confirm({
          title: 'Access Disabled',
          message: 'FlyRegs needs access to your camera or photos to set a profile picture. Enable it in Settings.',
          confirmLabel: 'Open Settings',
          onConfirm: () => Linking.openSettings(),
        })
      } else if (err?.message !== 'CANCELLED') {
        Sentry.captureException(err)
        confirm({ title: 'Error', message: 'Could not update your profile picture.', cancelLabel: null })
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
    confirm({
      title: 'Remove Photo',
      message: 'Remove your profile photo?',
      confirmLabel: 'Remove',
      destructive: true,
      // Single-step: a profile photo is trivially re-pickable, so this is
      // the one destructive action here that hasn't earned a second tap.
      twoStep: false,
      onConfirm: async () => {
        setAvatarBusy(true)
        setAvatarOverride(null, null)
        try {
          await removeAvatar(session.user.id)
        } catch (err: any) {
          Sentry.captureException(err)
          clearAvatarOverride()
          throw err  // surfaced inline by the dialog, not a second dead alert
        } finally {
          setAvatarBusy(false)
        }
      },
    })
  }

  const handleSelectPreset = async (presetId: string) => {
    if (!session?.user?.id || avatarBusy) return
    setAvatarBusy(true)
    setAvatarOverride(null, presetId)
    try {
      await selectAvatarPreset(session.user.id, presetId)
    } catch (err: any) {
      Sentry.captureException(err)
      confirm({ title: 'Error', message: 'Could not update your profile picture.', cancelLabel: null })
      clearAvatarOverride()
    }
    setAvatarBusy(false)
  }

  const email = session?.user?.email ?? null
  const initial = email ? email.charAt(0).toUpperCase() : '?'

  const handleRestore = async () => {
    if (Platform.OS === 'web') {
      confirm({ title: 'Available on iOS', message: 'Restore purchases from the FlyRegs iOS app.', cancelLabel: null })
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
    // restorePurchases() swallows Purchases.restorePurchases()'s own
    // rejection and returns a plain "nothing active" status instead of
    // throwing -- the native SDK rejects a second concurrent restore call
    // while one is already in flight, so without this guard a rapid
    // double-tap could let the failed call's result win the race and tell a
    // real, paying subscriber "Nothing to Restore." Same bug class as the
    // printReg.ts double-tap fix; the Row above is now also disabled while
    // restoring, this is the belt-and-suspenders backstop.
    if (restoring) return
    setRestoring(true)
    try {
      const status = await restorePurchases()
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      setIsUnlocked(status.isUnlocked)
      const active = status.isPro || status.isPremium || status.isUnlocked
      confirm({
        title: active ? 'Purchases Restored' : 'Nothing to Restore',
        message: active ? 'Your FlyRegs purchases are active.' : 'No active purchases were found for this account.',
        cancelLabel: null,
      })
    } catch (err: any) {
      confirm({ title: 'Restore failed', message: err?.message ?? 'Please try again later.', cancelLabel: null })
    }
    setRestoring(false)
  }

  const handleSignOut = () => {
    confirm({
      title: 'Sign Out',
      message: 'Sign out of your account? Your synced data stays on your account and comes back when you sign in again.',
      confirmLabel: 'Sign Out',
      // Not `destructive` -- signing out destroys nothing, and painting it
      // red next to a real Delete Account button teaches users to ignore
      // red. It just needs a confirm, not a warning.
      onConfirm: async () => {
        await signOut()
        // backToMenu (not plain router.back()) so this lands on the burger
        // menu like every other Account exit, not whatever screen (often
        // Home) happened to be underneath. BB-071, real device beta report.
        backToMenu()
      },
    })
  }

  const runAccountDelete = async () => {
    setDeleting(true)
    try {
      const { error } = await supabase.functions.invoke('delete-account', { method: 'POST', timeout: DELETE_ACCOUNT_TIMEOUT_MS })
      if (error) throw error
      // Unlike a plain sign-out, the account itself is gone -- a stored
      // biometric credential pointing at it would just be a dead "Sign in
      // with Face ID" button on this device's sign-in screen forever after.
      await Biometric.disableBiometricSignIn().catch(() => {})
      // Real production report, 2026-08-22: "I deleted my account and came
      // back in the free account and it still shows the recents that I had
      // when I was logged in." A plain signOut() deliberately leaves local
      // data alone (bookmarks/recents/etc. work with no account at all,
      // by design) -- correct for a normal sign-out, wrong here: deleting
      // the account is an explicit "remove everything tied to me," not
      // just a session change. Wipe local-first storage BEFORE signOut()
      // clears the session, since claimDeviceIfMismatched-style wiping
      // only ever runs on a subsequent SIGN-IN, never on the way out.
      await wipeAllLocalDataForAccountDeletion()
      await signOut()
      backToMenu()
    } catch (err: any) {
      Sentry.captureException(err)
      // delete-account (supabase/functions/delete-account/index.ts)
      // resolves the caller from their OWN session token on every
      // invocation, then deletes the auth user -- so a genuine timeout is
      // the one failure mode here where we truly can't tell what happened
      // server-side: the request may never have reached the function, or it
      // may have completed and only the response never made it back before
      // the client gave up. A same-account retry can't disambiguate the two
      // either -- it would 401 in BOTH cases once the account is actually
      // gone, since the function's own /auth/v1/user lookup needs that same
      // now-stale session token to still resolve. So rather than word this
      // as a safe "just try again," the timeout case tells the user how to
      // check for themselves instead of implying either outcome.
      const timedOut = isEdgeFunctionTimeout(err)
      confirm({
        title: timedOut ? 'Delete Request Timed Out' : "Couldn't Delete Account",
        message: timedOut
          ? "The connection timed out and we can't confirm whether your account was deleted. Try signing in again — if you still can, it wasn't deleted and you're safe to retry. If you're unsure, email our support team and we'll check for you."
          : 'Something went wrong. Please try again, or email our support team if this keeps happening.',
        confirmLabel: 'Email Support',
        cancelLabel: 'OK',
        onConfirm: () =>
          // .catch(), not left bare -- same real Sentry-confirmed gap as
          // faq.tsx's identical Email Support link (a real user with no
          // Mail account configured), fixed the same way there.
          Linking.openURL(
            `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Delete my account')}`
          ).catch(() =>
            confirm({ title: 'Could not open mail', message: `Please email us at ${SUPPORT_EMAIL}.`, cancelLabel: null })
          ),
      })
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
    confirm({
      title: 'Delete Account',
      message: `This permanently deletes your account and all synced data (bookmarks, folders, notes, highlights). This cannot be undone.${subscriptionWarning}`,
      confirmLabel: 'Delete Permanently',
      destructive: true,
      // RC narrowed the moving-button two-step to aircraft deletion only;
      // everything else gets one popup. Account deletion keeps its own,
      // stronger guard below instead -- typing the word, not an extra tap.
      twoStep: false,
      requireTyped: 'DELETE',
      onConfirm: runAccountDelete,
    })
  }

  // Not signed in — soft prompt
  if (!session) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg, marginLeft: railInset, borderLeftWidth: railInset ? 1 : 0, borderLeftColor: tokens.bdr2 }]}>
        <OverlayHeader title="Account" onBack={backToMenu} />
        <View style={styles.signedOut}>
          <View style={[styles.avatar, { backgroundColor: tokens.bg4 }]}>
            <Icon name="person.crop.circle" size={fs(34)} color={tokens.t2} />
          </View>
          <Text style={[styles.signedOutTitle, { color: tokens.t1, fontSize: fs(18) }]}>You're not signed in</Text>
          <Text style={[styles.signedOutSub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
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

  const showAircraftPane = isTablet && aircraftPaneOpen
  return (
    <View
      style={[
        styles.root,
        showAircraftPane && styles.rootSplit,
        { backgroundColor: tokens.bg, marginLeft: railInset, borderLeftWidth: railInset ? 1 : 0, borderLeftColor: tokens.bdr2 },
      ]}
    >
    <View style={styles.accountColumn}>
      <OverlayHeader title="Account" onBack={backToMenu} />
      <TabletContainer>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]} keyboardDismissMode="interactive">
        {/* Profile */}
        <View style={[styles.profileCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Pressable
            style={[styles.avatar, { backgroundColor: avatarPreset ? avatarColorFor(avatarPreset, redShift) : tokens.blu }]}
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
            {/* RC: "this account designation should be colored to reflect
                tier: orange, blue, gold." Pro and Premium both rendered gold
                before, so the badge told you nothing you didn't already
                know from the word next to it. One colour per tier now, and
                gold is reserved for the top one -- the same way gold means
                Premium everywhere else in this app. */}
            <View style={styles.tierRow}>
              {isPremium ? (
                <>
                  <Icon name="checkmark.seal.fill" size={fs(14)} color={tokens.gold} />
                  <Text style={[styles.tierText, { color: tokens.gold, fontSize: fs(13) }]}>FlyRegs Premium</Text>
                </>
              ) : isPro ? (
                <>
                  <Icon name="checkmark.seal.fill" size={fs(14)} color={tokens.blu} />
                  <Text style={[styles.tierText, { color: tokens.blu, fontSize: fs(13) }]}>FlyRegs Pro</Text>
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
              style={[styles.handleInput, { color: tokens.t1, borderColor: callsignError ? tokens.red : tokens.bdr, backgroundColor: tokens.bg, fontSize: ifs(14.5) }]}
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

          <View style={{ marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.bdr }}>
            <View style={styles.callsignLabelRow}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Phone Number</Text>
              <InfoPopup
                id="account-phone-number"
                title="Phone Number"
                body="Optional, and never shown to anyone. Only used to help friends who already have your number saved find you in Find Friends -- the same privacy-preserving match already used for email, just matched against phone numbers too."
                iconSize={fs(15)}
              />
            </View>
            <View style={styles.handleInputRow}>
              <TextInput
                style={[styles.handleInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg, fontSize: ifs(14.5) }]}
                value={phoneInput}
                onChangeText={(v) => { setPhoneInput(v); setPhoneDirty(true) }}
                placeholder="e.g. (555) 123-4567"
                placeholderTextColor={tokens.t4}
                maxLength={30}
                keyboardType="phone-pad"
                returnKeyType="done"
                onSubmitEditing={handleSavePhone}
              />
              {phoneSaving ? (
                <ActivityIndicator size="small" color={tokens.t3} style={styles.handleSaveBtn} />
              ) : (
                <Pressable
                  style={[styles.handleSaveBtn, { backgroundColor: phoneDirty ? tokens.blu : tokens.bg4 }]}
                  onPress={handleSavePhone}
                  disabled={!phoneDirty}
                >
                  <Text style={[styles.handleSaveBtnText, { fontSize: fs(13) }]}>Save</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Ratings live on Community > Profile, not here. They are a
              profile/bragging concept shown to other pilots, and having the
              editor in Account while the display was on Profile meant the
              Profile's own "+ Add Rating" just threw you to a settings
              screen. See components/RatingPicker.tsx. */}
        </View>

        {/* Subscription group */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SUBSCRIPTION</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {!hasProAccess && (
            <Row
              icon="crown"
              label="Upgrade to Pro"
              tint={tokens.blu}
              tokens={tokens}
              onPress={() => router.push('/paywall?tier=pro')}
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
            disabled={restoring}
            last
          />
        </View>

        {/* Security group — hidden entirely with no biometric hardware on
            this device (always the case on web/web preview). See
            lib/biometricAuth.ts for the full BB-008/#422 design. */}
        {biometricAvailable && (
          <>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SECURITY</Text>
            <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <View style={[styles.row, { borderBottomWidth: 0 }]}>
                <View style={styles.rowIcon}>
                  <Icon name="faceid" size={fs(17)} color={tokens.t2} />
                </View>
                <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5), flex: 1 }]}>
                  Sign in with {bioLabel}
                </Text>
                {biometricBusy ? (
                  <ActivityIndicator size="small" color={tokens.t3} />
                ) : (
                  <Switch
                    value={biometricEnabled}
                    onValueChange={handleToggleBiometric}
                    trackColor={{ true: tokens.blu, false: undefined }}
                  />
                )}
              </View>
            </View>
          </>
        )}

        {/* My Aircraft group — the actual targeting mechanism for AD
            alerts, see my-aircraft.tsx's own header comment. */}
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>AIRWORTHINESS DIRECTIVES</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Row
            // RC: "this should be an aircraft icon" -- it was a generic
            // document glyph, which reads as "a form" rather than "your
            // plane," and every other reference to a saved aircraft in this
            // app already uses `airplane`.
            icon="airplane"
            label={isPremium ? 'My Fleet' : 'My Aircraft'}
            tokens={tokens}
            onPress={() => {
              // RC: "Free and Plus don't have a My Aircraft bar. it can
              // show, but needs a lock on it with paywall." Pro/Premium go
              // straight into the real screen; Free/Plus go straight to
              // the paywall instead of into a screen that would only
              // block them once they try to add an aircraft.
              if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
              // iPad: open beside Account as a 3rd rail pane instead of
              // pushing full-screen over it. Phone has no rail to extend,
              // so it keeps the original push.
              if (isTablet) { setAircraftPaneOpen(true); return }
              router.push('/my-aircraft' as any)
            }}
            trailing={
              !hasProAccess ? (
                <Icon name="lock.fill" size={fs(14)} color={tokens.t4} />
              ) : fleetStatus ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20 }}>
                  <FleetStatusWheel status={fleetStatus} tokens={tokens} />
                  <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
                </View>
              ) : undefined
            }
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
              {!hasProAccess && (
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
              {!hasProAccess && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PRO</Text>
                </View>
              )}
            </View>
            {dailyRegBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={dailyRegEnabled}
                onValueChange={handleToggleDailyReg}
                trackColor={{ true: tokens.blu, false: undefined }}
              />
            )}
          </View>
          <View style={styles.row}>
            <View style={styles.rowIcon}>
              <Icon name="books.vertical.fill" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>DailyWord</Text>
              {!hasPlusAccess && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PLUS</Text>
                </View>
              )}
            </View>
            {dailyWordBusy ? (
              <ActivityIndicator size="small" color={tokens.t3} />
            ) : (
              <Switch
                value={dailyWordEnabled}
                onValueChange={handleToggleDailyWord}
                trackColor={{ true: tokens.blu, false: undefined }}
              />
            )}
          </View>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <View style={styles.rowIcon}>
              <Icon name="trophy" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Duel Alerts</Text>
              {!isPremium && (
                <View style={[styles.premBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Text style={[styles.premBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>PREMIUM</Text>
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
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>THE WING</Text>
        <View style={[styles.group, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={[styles.row, { borderBottomWidth: 0 }]}>
            <View style={styles.rowIcon}>
              <Icon name="person.2.fill" size={fs(17)} color={tokens.t2} />
            </View>
            <View style={{ flex: 1 }}>
              {/* RC: "just have the toggle say 'Show Me'. then add an info
                  icon and inside that, you can explain the RR board, FF
                  area, etc. Keep thing tidy and uncluttered." Same
                  label+InfoPopup pattern as the Callsign row above. */}
              <View style={styles.callsignLabelRow}>
                <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>Show Me</Text>
                <InfoPopup
                  id="account-show-me"
                  title="Show Me"
                  body={[
                    'Puts your Callsign, profile photo, and weekly study activity on the Ready Room leaderboard and in Duels, visible to other opted-in members.',
                    'Also lets friends find you by contact when inviting you to a shared folder or aircraft (Find Friends).',
                  ]}
                  iconSize={fs(15)}
                />
              </View>
              {!hasProAccess && (
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
    </View>

    {showAircraftPane && (
      <>
        <View style={styles.paneResizeHandleHit} {...aircraftPaneResizePan.panHandlers}>
          <View style={[styles.paneResizeHandleBar, { backgroundColor: tokens.bdr2 }]} />
        </View>
        <View style={[styles.aircraftPane, { width: aircraftPaneWidth, borderLeftColor: tokens.bdr2, backgroundColor: tokens.bg }]}>
          <MyAircraftBody embedded onClose={() => setAircraftPaneOpen(false)} />
        </View>
      </>
    )}

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

// A small ring, not a filled dot -- RC: "a small version of the color
// wheel." A true proportional multi-segment wheel (like the Fleet mockup's
// own ring) isn't legible at this size, so this reads the same "wheel"
// shape while only carrying the one signal RC actually asked for here:
// worst-severity color, visible before ever opening the section.
// Flat single color (the worst status across the fleet), not a proportional
// multi-segment mimic of the real My Fleet screen's own FleetRing -- RC
// asked directly whether this should mimic that ring's color %s. Kept flat
// on purpose: at this row-icon size (~28px) a proportional split would be a
// handful of illegible slivers, and the per-aircraft RowStatusBadge on the
// real My Fleet screen ALSO uses one flat status color per ring (never a
// proportional split) -- proportional aggregation is specifically FleetRing's
// own job as a dashboard visualization, not a settings-row glance indicator's.
function FleetStatusWheel({ status, tokens }: { status: 'clear' | 'attention' | 'overdue'; tokens: ThemeTokens }) {
  const color = status === 'overdue' ? tokens.red : status === 'attention' ? tokens.amb : tokens.grn
  return <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 4, borderColor: color }} />
}

function Row({
  icon,
  label,
  tokens,
  onPress,
  tint,
  trailing,
  last,
  disabled,
}: {
  icon: string
  label: string
  tokens: ThemeTokens
  onPress: () => void
  tint?: string
  trailing?: React.ReactNode
  last?: boolean
  disabled?: boolean
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.row, !last && { borderBottomWidth: 1, borderBottomColor: tokens.bdr }]}
      onPress={onPress}
      disabled={disabled}
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
  // iPad 3rd pane: root becomes a row (Account column + divider + My
  // Fleet pane) only while the pane is open -- see showAircraftPane.
  rootSplit: { flexDirection: 'row' },
  accountColumn: { flex: 1 },
  paneResizeHandleHit: {
    width: 16,
    marginHorizontal: -8,
    zIndex: 1,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as object) : null),
  },
  paneResizeHandleBar: { width: 2, height: '100%', opacity: 0.6 },
  aircraftPane: { borderLeftWidth: 1 },
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
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.5
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  signedOutSub: { fontSize: 14, textAlign: 'center', maxWidth: 280 },
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
