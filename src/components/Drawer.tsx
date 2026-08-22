import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, Platform, Linking, PanResponder, ScrollView, Switch } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, usePathname } from 'expo-router'
import { useDrawer, RAIL_AWARE_PATHS, DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX } from '@/context/drawer'
import { useIsTablet } from '@/context/responsive'
import { useTheme, ThemeTokens, ThemeMode } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFontScale, useFS, FONT_SCALE_MIN, FONT_SCALE_MAX } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { restorePurchases } from '@/lib/revenuecat'
import { APP_VERSION, APP_STORE_URL, PLAY_STORE_URL } from '@/lib/appInfo'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { BADGE_LIFESPAN_OPTIONS } from '@/lib/badgeLifespan'
import { getAvatarUrl, resolveAvatarPresetId } from '@/lib/avatar'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { useConfirm } from '@/components/ConfirmDialog'

const DRAWER_WIDTH = 284

export function Drawer() {
  const { isOpen, close, railWidth, setRailWidth } = useDrawer()
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  const isTablet = useIsTablet()
  const pathname = usePathname()
  // iPad: RC, "there's plenty of room for Account to open fully to the
  // right of the burger." A rail-aware path (see RAIL_AWARE_PATHS in
  // context/drawer.tsx) keeps the drawer open instead of closing it, so
  // Account renders beside it (see account.tsx's own railInset) rather than
  // covering it. Track whether we WERE on a rail path so navigating away to
  // something unrelated (Sign Out -> /auth, etc.) auto-closes the drawer
  // instead of leaving it stuck open over an unrelated screen.
  // Real bug found while building the 3rd rail pane (see account.tsx): the
  // scrim below is a StyleSheet.absoluteFill Pressable with onPress=close,
  // rendered (and thus hit-tested) above every screen regardless of rail
  // mode -- so ANY tap anywhere on Account while the drawer stayed open
  // beside it just closed the drawer instead of reaching Account's own
  // controls. Confirmed live: tapping the Callsign text input never
  // focused it, it closed the drawer. The rail is meant to be a persistent
  // side-by-side layout, not a modal overlay, so a rail-mode drawer must
  // not have a click-outside-to-dismiss scrim at all.
  const isRailPath = isTablet && RAIL_AWARE_PATHS.includes(pathname)
  const wasRailPath = useRef(false)
  useEffect(() => {
    const isRail = RAIL_AWARE_PATHS.includes(pathname)
    if (wasRailPath.current && !isRail && isOpen) close()
    wasRailPath.current = isRail
  }, [pathname])

  const panelWidth = isTablet ? railWidth : DRAWER_WIDTH
  const translateX = useSharedValue(-panelWidth)
  const scrimOpacity = useSharedValue(0)

  useEffect(() => {
    translateX.value = withSpring(isOpen ? 0 : -panelWidth, {
      damping: 20,
      stiffness: 300,
      overshootClamping: true,
    })
    scrimOpacity.value = withTiming(isOpen && !isRailPath ? 1 : 0, { duration: 180 })
  }, [isOpen, panelWidth, isRailPath])

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: scrimOpacity.value,
  }))

  // Tablet-only resize handle on the panel's trailing edge -- "each vert
  // separator is slideable." A plain PanResponder (not Gesture/reanimated)
  // matches the pattern TextSizeSlider already uses lower in this same
  // file; no need for a second gesture library dependency for one handle.
  const startWidth = useRef(panelWidth)
  const resizePan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { startWidth.current = railWidth },
      onPanResponderMove: (_, { dx }) => setRailWidth(startWidth.current + dx),
      onPanResponderRelease: (_, { dx }) => setRailWidth(startWidth.current + dx),
    })
  ).current

  return (
    <>
      {/* Scrim — z-60 */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.scrim,
          scrimStyle,
          { pointerEvents: isOpen && !isRailPath ? 'auto' : 'none' },
        ]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>

      {/* Panel — z-65, slides from left */}
      <Animated.View
        style={[
          styles.panel,
          drawerStyle,
          {
            width: panelWidth,
            backgroundColor: tokens.bg2,
            borderRightColor: tokens.bdr2,
            paddingTop: Math.max(insets.top + 8, 34),
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        <DrawerContent tokens={tokens} onClose={close} />
        {isTablet && (
          <View style={styles.resizeHandleHit} {...resizePan.panHandlers}>
            <View style={[styles.resizeHandleBar, { backgroundColor: tokens.bdr2 }]} />
          </View>
        )}
      </Animated.View>
    </>
  )
}

// ─── Content ─────────────────────────────────────────────────────────────────

function DrawerContent({
  tokens,
  onClose,
}: {
  tokens: ThemeTokens
  onClose: () => void
}) {
  const { session, isPro, isPremium, isUnlocked, setIsPro, setIsPremium, setIsUnlocked, avatarOverride } = useAuth()
  const { mode, setMode, redShift, setRedShift } = useTheme()
  const { fontScale, setFontScale, previewFontScale } = useFontScale()
  const fs = useFS()
  // RC, real device, B34: "text size slider still not very smooth" -- a
  // recurrence after the B33 fix (which only removed the AsyncStorage
  // writes during drag, see fontScale.tsx's own comment). Second real
  // cause found: previewFontScale live-updates the SAME fontScale this
  // whole screen's rows read via fs() -- so every row above the slider
  // (profile card, Appearance, Red Shift, Badge Duration) grows/shrinks in
  // real time as you drag, which pushes the slider row itself down/up
  // under the finger mid-gesture. Freeze THIS screen's own rows to the
  // scale they had when the drag started (everything else in the app
  // still previews live, unaffected) so the row the user is actually
  // touching can't crawl out from under them. isDraggingSlider/frozenScale
  // only ever apply to Drawer's own layout, never to previewFontScale
  // itself -- the live preview elsewhere in the app is untouched.
  const [isDraggingSlider, setIsDraggingSlider] = useState(false)
  const frozenScaleRef = useRef(fontScale)
  useEffect(() => {
    if (!isDraggingSlider) frozenScaleRef.current = fontScale
  }, [fontScale, isDraggingSlider])
  const activeFs = isDraggingSlider ? (n: number) => Math.round(n * frozenScaleRef.current) : fs
  const { badgeDays, setBadgeDays: updateBadgeDays } = useBadgeLifespan()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const [restoring, setRestoring] = useState(false)

  const initials = session?.user?.email
    ? session.user.email.charAt(0).toUpperCase()
    : '?'
  const email = session?.user?.email ?? 'Not signed in'
  // Same cache key as Account's own avatar — one downloaded copy on disk
  // serves both, so the drawer never has to wait on the network (or show
  // nothing at all on bad wifi) to reflect a photo Account already fetched.
  // avatarOverride (shared via AuthContext) takes priority when active, so a
  // freshly picked/selected avatar shows here the same instant it shows on
  // Account — see AvatarOverride's comment in lib/avatar.ts.
  const cachedAvatarUrl = useCachedImage(
    session?.user?.id ? `avatar_${session.user.id}` : null,
    getAvatarUrl(session)
  )
  const avatarUrl = avatarOverride ? avatarOverride.uri : cachedAvatarUrl
  const avatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  const isTablet = useIsTablet()

  const nav = (path: string) => {
    // iPad: a rail-aware path (Account) stays open beside the drawer
    // instead of closing it -- see the Drawer component's own comment and
    // context/drawer.tsx. Everything else keeps the exact original
    // close-then-push behavior, on every platform.
    if (isTablet && RAIL_AWARE_PATHS.includes(path)) {
      router.push(path as any)
      return
    }
    onClose()
    // Small delay so drawer closes before modal opens
    setTimeout(() => router.push(path as any), 200)
  }

  const handleRestore = async () => {
    if (Platform.OS === 'web') {
      confirm({ title: 'Available on iOS', message: 'Restore purchases from the FlyRegs iOS app.', cancelLabel: null })
      return
    }
    // RC gating audit, 2026-08-22: the other 3 restore call sites (account.tsx,
    // paywall.tsx, manage-subscription.tsx) already guard against a rapid
    // double-tap starting a second concurrent restore while one's in flight --
    // RevenueCat rejects the second call, and restorePurchases() used to
    // swallow that into a false "nothing active" status that could win the
    // race against the real one. This was the one call site missing it.
    if (restoring) return
    // Pro/Premium require a FlyRegs account as part of the plan -- without
    // this check, a signed-out device (e.g. right after deleting an
    // account) could still call into RevenueCat and come back with a real,
    // still-active Apple subscription's entitlements, handing out Premium
    // with no account attached at all. The drawer's Restore Purchases row
    // is always visible regardless of session, so this has to be the gate.
    if (!session) {
      onClose()
      setTimeout(() => router.push('/auth'), 200)
      return
    }
    setRestoring(true)
    try {
      const status = await restorePurchases()
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      setIsUnlocked(status.isUnlocked)
      const active = status.isPro || status.isPremium || status.isUnlocked
      confirm({
        title: active ? 'Purchases Restored' : 'Nothing to Restore',
        message: active
          ? `Your FlyRegs ${status.isPremium ? 'Premium' : status.isPro ? 'Pro' : 'Plus'} purchase is active.`
          : 'No active purchases were found for this account.',
        cancelLabel: null,
      })
    } catch (err: any) {
      confirm({ title: 'Restore failed', message: err?.message ?? 'Please try again later.', cancelLabel: null })
    }
    setRestoring(false)
  }

  const handleRate = () => {
    const url = Platform.OS === 'android' ? PLAY_STORE_URL : APP_STORE_URL
    Linking.openURL(url).catch(() => {})
  }

  return (
    <ScrollView
      style={styles.contentScroll}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Close */}
      <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
        <Icon name="xmark" size={activeFs(17)} color={tokens.t3} />
      </Pressable>

      {/* Profile */}
      <Pressable
        style={[styles.profileCard, { borderColor: tokens.bdr }]}
        onPress={() => nav(session ? '/account' : '/auth')}
      >
        <View style={[styles.avatar, { backgroundColor: avatarPreset ? avatarColorFor(avatarPreset, redShift) : (session ? tokens.blu : tokens.bg4) }]}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
          ) : avatarPreset ? (
            <Icon name={avatarPreset.icon} size={activeFs(20)} color="#fff" />
          ) : (
            <Text style={[styles.avatarText, { fontSize: activeFs(17) }]}>{initials}</Text>
          )}
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={styles.profileNameRow}>
            <Text style={[styles.profileName, { color: tokens.t1, fontSize: activeFs(15) }]} numberOfLines={1}>
              {session ? 'My Account' : 'Sign In'}
            </Text>
            {session && <TierPill isPro={isPro} isPremium={isPremium} isUnlocked={isUnlocked} tokens={tokens} fs={activeFs} />}
          </View>
          <Text style={[styles.profileEmail, { color: tokens.t2, fontSize: activeFs(12) }]} numberOfLines={1}>
            {email}
          </Text>
        </View>
        <Icon name="chevron.right" size={activeFs(13)} color={tokens.t3} />
      </Pressable>

      {/* Account group -- subscription management now lives entirely in
          My Account (tapping the profile card above); the tier pill there
          is enough visibility here without a second, redundant entry point
          that used to just dump straight into the paywall. */}
      <DrawerRow
        icon="arrow.clockwise"
        label="Restore Purchases"
        value={restoring ? 'Restoring…' : undefined}
        tokens={tokens}
        onPress={handleRestore}
        fsOverride={activeFs}
      />
      <DrawerRow
        icon="info.circle"
        label="About FlyRegs"
        value={`v${APP_VERSION}`}
        tokens={tokens}
        onPress={() => nav('/about')}
        fsOverride={activeFs}
      />

      <Divider tokens={tokens} />

      {/* Appearance — Phase 2: wired */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="moon.stars" size={activeFs(17)} color={tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: activeFs(14) }]}>Appearance</Text>
      </View>
      <AppearancePicker mode={mode} setMode={setMode} tokens={tokens} fsOverride={activeFs} />

      {/* Red Shift — manual-only night-vision mode (RC: no auto-switching).
          Toggling either direction normalizes Appearance to Dark underneath
          it, so turning Red Shift off always lands somewhere predictable. */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="eye.fill" size={activeFs(17)} color={redShift ? tokens.red : tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: activeFs(14) }]}>Red Shift</Text>
        <Switch
          value={redShift}
          onValueChange={setRedShift}
          trackColor={{ true: tokens.red, false: undefined }}
        />
      </View>

      {/* Badge Duration — inline picker. Row's leading visual is three small
          NEW/UPD/VER-colored dots (matching acBadge.ts's colors exactly)
          instead of a generic clock icon, so what "Badge" refers to is
          obvious at a glance without needing a long label like "NEW/UPD/VER
          Badge Duration" to spell it out in the fixed-width row. */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <View style={styles.badgeDotRow}>
            <View style={[styles.badgeDot, { backgroundColor: tokens.grn }]} />
            <View style={[styles.badgeDot, { backgroundColor: tokens.blu }]} />
            <View style={[styles.badgeDot, { backgroundColor: tokens.amb }]} />
          </View>
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: activeFs(14) }]}>Badge Duration</Text>
      </View>
      <BadgeLifespanPicker days={badgeDays} setDays={updateBadgeDays} tokens={tokens} fsOverride={activeFs} />

      {/* Text Size — inline picker */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="textformat.size" size={activeFs(17)} color={tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: activeFs(14) }]}>Text Size</Text>
      </View>
      <TextSizeSlider
        scale={fontScale}
        setScale={setFontScale}
        previewScale={previewFontScale}
        tokens={tokens}
        onDragStateChange={setIsDraggingSlider}
      />

      <Divider tokens={tokens} />

      {/* Support group */}
      <DrawerRow icon="questionmark.circle" label="Help & FAQ" tokens={tokens} onPress={() => nav('/faq')} />
      <DrawerRow icon="envelope" label="Send Feedback" tokens={tokens} onPress={() => nav('/feedback')} />
      <DrawerRow icon="star" label="Rate FlyRegs" tokens={tokens} onPress={handleRate} />

      <Divider tokens={tokens} />

      {/* Legal */}
      <DrawerRow icon="doc.text" label="Privacy Policy" tokens={tokens} onPress={() => nav('/privacy')} />
      <DrawerRow icon="doc.plaintext" label="Terms of Use" tokens={tokens} onPress={() => nav('/terms')} />
    </ScrollView>
  )
}

// ─── Appearance picker ───────────────────────────────────────────────────────

const MODES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'auto', label: 'Auto' },
]

function AppearancePicker({
  mode,
  setMode,
  tokens,
  fsOverride,
}: {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
  tokens: ThemeTokens
  fsOverride?: (n: number) => number
}) {
  const contextFs = useFS()
  const fs = fsOverride ?? contextFs
  return (
    <View style={[styles.segWrap, { backgroundColor: tokens.bg3 }]}>
      {MODES.map((m) => {
        const active = mode === m.value
        return (
          <Pressable
            key={m.value}
            style={[
              styles.segBtn,
              active && { backgroundColor: tokens.bg2 },
            ]}
            onPress={() => setMode(m.value)}
          >
            <Text
              style={[
                styles.segLabel,
                { color: active ? tokens.t1 : tokens.t2, fontSize: fs(12.5) },
              ]}
            >
              {m.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── Badge Lifespan picker ───────────────────────────────────────────────────

// Labels derived from the single shared options list (lib/badgeLifespan.ts)
// so this picker can never drift out of sync with what the rest of the app
// actually treats as valid.
const LIFESPAN_OPTIONS: Array<{ value: number; label: string }> =
  BADGE_LIFESPAN_OPTIONS.map((value) => ({ value, label: `${value}d` }))

function BadgeLifespanPicker({
  days,
  setDays,
  tokens,
  fsOverride,
}: {
  days: number
  setDays: (d: number) => void
  tokens: ThemeTokens
  fsOverride?: (n: number) => number
}) {
  const contextFs = useFS()
  const fs = fsOverride ?? contextFs
  return (
    <View style={[styles.segWrap, { backgroundColor: tokens.bg3 }]}>
      {LIFESPAN_OPTIONS.map((opt) => {
        const active = days === opt.value
        return (
          <Pressable
            key={opt.value}
            style={[styles.segBtn, active && { backgroundColor: tokens.bg2 }]}
            onPress={() => setDays(opt.value)}
          >
            <Text style={[styles.segLabel, { color: active ? tokens.t1 : tokens.t2, fontSize: fs(12.5) }]}>
              {opt.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── Text Size slider ─────────────────────────────────────────────────────────

const THUMB = 22
const SCALE_RANGE = FONT_SCALE_MAX - FONT_SCALE_MIN

function TextSizeSlider({
  scale,
  setScale,
  previewScale,
  tokens,
  onDragStateChange,
}: {
  scale: number
  setScale: (v: number) => void
  previewScale: (v: number) => void
  tokens: ThemeTokens
  onDragStateChange?: (dragging: boolean) => void
}) {
  const trackW = useRef(0)
  const startX = useRef(0)
  // RC, real device: "very jumpy and jittery... hard to work." Root cause:
  // trackW was re-read live (trackW.current) on every move event, but the
  // drawer's OWN text (including this slider's neighboring labels) resizes
  // live as fontScale drags -- which can nudge this row's layout mid-
  // gesture, re-firing onLayout and changing trackW WHILE a drag was still
  // in progress. The math then measured new finger movement against a
  // width that had shifted since the gesture started, producing a real
  // discontinuous jump, not just visual roughness. Freezing the track
  // width once per gesture (captured on grant, used for the whole
  // gesture) removes the feedback loop entirely -- this component's own
  // layout can still shift live, it just can't retroactively corrupt a
  // drag that's already in progress.
  const gestureTrackW = useRef(0)
  const [layoutW, setLayoutW] = useState(0)
  // Keep a live ref so PanResponder callbacks see the current scale
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  // RC, real device, B34: "still not very smooth" -- the B33 fix above
  // (freezing trackW, dropping the AsyncStorage write per tick) was real
  // but didn't touch the actual headline cause. thumbLeft/the fill bar used
  // to derive purely from the `scale` PROP, which only updates after a full
  // round trip: onPanResponderMove -> previewScale() -> context state ->
  // FontScaleProvider re-renders -> every one of the ~90 files calling
  // useFS() re-renders (no memoization anywhere in that context, confirmed
  // by a dedicated investigation) -> only THEN does this component receive
  // a new `scale` prop and move the thumb. On a real device that fan-out is
  // slow enough that touch-move events queue up and the thumb visibly
  // stutters/lags the finger -- this IS the "jumpy" symptom, and it can't
  // be fixed by anything inside the gesture math, only by not waiting on
  // that round trip for the slider's OWN rendering.
  //
  // dragFrac is purely local state: set directly from the gesture's own
  // dx on every move, with no context involved, so the thumb/fill move at
  // the speed of this one component re-rendering, not the whole app.
  // previewScale() is still called every move (unchanged) so the live-
  // preview-elsewhere behavior is fully preserved -- it just no longer
  // gates this component's own visual feedback. Cleared back to null
  // whenever `scale` changes while NOT dragging, so an external change
  // (e.g. a future reset-to-default control) is still respected.
  const [dragFrac, setDragFrac] = useState<number | null>(null)
  const isDragging = useRef(false)
  useEffect(() => {
    if (!isDragging.current) setDragFrac(null)
  }, [scale])

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      // Default RN behavior lets the enclosing vertical ScrollView steal
      // the responder on any vertical finger wander mid-drag -- on a real
      // device that reads as the slider randomly "letting go." Refusing
      // the request keeps this gesture in full control once it's started.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        isDragging.current = true
        onDragStateChange?.(true)
        gestureTrackW.current = trackW.current
        startX.current = ((scaleRef.current - FONT_SCALE_MIN) / SCALE_RANGE) * gestureTrackW.current
      },
      onPanResponderMove: (_, { dx }) => {
        const tw = gestureTrackW.current
        if (!tw) return
        const newX = Math.max(0, Math.min(tw, startX.current + dx))
        const f = newX / tw
        setDragFrac(f)
        // Preview only (state update, no AsyncStorage write) -- the app's
        // text still resizes live as you drag, just without persisting on
        // every single touch-move event. See fontScale.tsx's own comment.
        previewScale(FONT_SCALE_MIN + f * SCALE_RANGE)
      },
      onPanResponderRelease: (_, { dx }) => {
        const tw = gestureTrackW.current
        isDragging.current = false
        onDragStateChange?.(false)
        if (!tw) return
        const newX = Math.max(0, Math.min(tw, startX.current + dx))
        // Persists (writes AsyncStorage once) with the final settled value.
        setScale(FONT_SCALE_MIN + (newX / tw) * SCALE_RANGE)
      },
      // A terminated gesture (in practice, now rare -- see the termination-
      // request refusal above, but still reachable, e.g. an incoming call
      // UI) used to leave the value wherever the last preview tick put it,
      // never persisted. Commits it the same as a normal release instead
      // of silently dropping the drag.
      onPanResponderTerminate: (_, { dx }) => {
        const tw = gestureTrackW.current
        isDragging.current = false
        onDragStateChange?.(false)
        if (!tw) return
        const newX = Math.max(0, Math.min(tw, startX.current + dx))
        setScale(FONT_SCALE_MIN + (newX / tw) * SCALE_RANGE)
      },
    })
  ).current

  const frac = dragFrac ?? Math.max(0, Math.min(1, (scale - FONT_SCALE_MIN) / SCALE_RANGE))
  const thumbLeft = layoutW > 0
    ? Math.max(0, Math.min(layoutW - THUMB, frac * layoutW - THUMB / 2))
    : 0

  return (
    <View style={styles.sliderRow}>
      {/* Small "A" anchors the minimum end — the app's actual text already
          resizes live as you drag, so no separate word preview is needed. */}
      <Text style={[styles.sliderPreview, { color: tokens.t3, fontSize: Math.round(FONT_SCALE_MIN * 14) }]}>
        A
      </Text>

      {/* Slider track + thumb */}
      <View
        style={styles.sliderWrap}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width
          trackW.current = w
          setLayoutW(w)
        }}
      >
        <View style={[styles.sliderTrackBg, { backgroundColor: tokens.bg3 }]} />
        <View style={[styles.sliderTrackFill, { backgroundColor: tokens.blu, width: frac * layoutW }]} />
        <View
          style={[
            styles.sliderThumb,
            { backgroundColor: tokens.bg, borderColor: tokens.blu, left: thumbLeft },
          ]}
          {...pan.panHandlers}
        />
      </View>

      {/* Range labels */}
      <Text style={[styles.sliderEndLabel, { color: tokens.t3, fontSize: Math.round(FONT_SCALE_MAX * 14) }]}>A</Text>
    </View>
  )
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function DrawerRow({
  icon,
  label,
  value,
  tokens,
  onPress,
  fsOverride,
}: {
  icon: string
  label: string
  value?: string
  tokens: ThemeTokens
  onPress?: () => void
  fsOverride?: (n: number) => number
}) {
  const contextFs = useFS()
  const fs = fsOverride ?? contextFs
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Icon name={icon} size={fs(17)} color={tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14) }]}>{label}</Text>
      {value ? <Text style={[styles.rowValue, { color: tokens.t3, fontSize: fs(12.5) }]}>{value}</Text> : null}
      <Icon name="chevron.right" size={fs(12)} color={tokens.t4} />
    </Pressable>
  )
}

function Divider({ tokens }: { tokens: ThemeTokens }) {
  return <View style={[styles.divider, { backgroundColor: tokens.bdr }]} />
}

function TierPill({
  isPro, isPremium, isUnlocked, tokens, fs,
}: {
  isPro: boolean
  isPremium: boolean
  isUnlocked: boolean
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  // Plus (isUnlocked) sits below Pro -- Pro/Premium subscribers already have
  // hasPlusAccess included, so this branch only ever fires for someone who
  // bought Plus without also subscribing.
  const tier = isPremium ? 'Premium' : isPro ? 'Pro' : isUnlocked ? 'Plus' : 'Free'
  const color = isPremium ? tokens.gold : isPro ? tokens.blu : isUnlocked ? tokens.amb : tokens.t3
  const bg = isPremium ? tokens.goldlt : isPro ? tokens.bdim : isUnlocked ? tokens.adim : tokens.bg3
  const bdr = isPremium ? tokens.goldbdr : isPro ? tokens.bbdr : isUnlocked ? tokens.abdr : tokens.bdr
  return (
    <View style={[styles.tierPill, { backgroundColor: bg, borderColor: bdr }]}>
      <Text style={[styles.tierPillText, { color, fontSize: fs(8.5) }]} numberOfLines={1}>{tier.toUpperCase()}</Text>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scrim: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    zIndex: 60,
  },
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_WIDTH,
    zIndex: 65,
    borderRightWidth: 1,
  },
  resizeHandleHit: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: -8,
    width: 16,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? ({ cursor: 'col-resize' } as object) : null),
  },
  resizeHandleBar: {
    width: 2,
    height: '100%',
    opacity: 0.6,
  },
  contentScroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  closeBtn: {
    alignSelf: 'flex-end',
    padding: 8,
    marginBottom: 4,
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 14,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  avatarImage: { width: 46, height: 46, borderRadius: 23 },
  avatarText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 17,
  },
  profileNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: {
    fontWeight: '600',
    fontSize: 15,
    flexShrink: 1,
  },
  tierPill: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 4,
    paddingVertical: 2,
    flexShrink: 0,
  },
  tierPillText: {
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  profileEmail: {
    fontSize: 12,
    marginTop: 2,
  },
  divider: {
    height: 1,
    marginVertical: 8,
    marginHorizontal: -4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 12,
  },
  rowIcon: {
    width: 24,
    alignItems: 'center',
  },
  badgeDotRow: { flexDirection: 'row', gap: 3 },
  badgeDot: { width: 8, height: 6, borderRadius: 2 },
  rowLabel: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
  },
  rowValue: {
    fontSize: 12.5,
    fontWeight: '500',
    marginRight: 6,
  },
  appearanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 8,
    gap: 12,
  },
  segWrap: {
    flexDirection: 'row',
    borderRadius: 10,
    padding: 2,
    marginBottom: 4,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 8,
    alignItems: 'center',
  },
  segLabel: {
    fontSize: 12.5,
    fontWeight: '500',
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingBottom: 10,
    paddingTop: 2,
  },
  sliderPreview: {
    fontWeight: '700',
    width: 32,
    textAlign: 'center',
  },
  sliderEndLabel: {
    fontWeight: '700',
    width: 22,
    textAlign: 'center',
  },
  sliderWrap: {
    flex: 1,
    height: THUMB,
    position: 'relative',
  },
  sliderTrackBg: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (THUMB - 4) / 2,
    height: 4,
    borderRadius: 2,
  },
  sliderTrackFill: {
    position: 'absolute',
    left: 0,
    top: (THUMB - 4) / 2,
    height: 4,
    borderRadius: 2,
  },
  sliderThumb: {
    position: 'absolute',
    top: 0,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    borderWidth: 2,
  },
})
