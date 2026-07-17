import React, { useEffect, useRef, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, Alert, Platform, Linking, PanResponder, ScrollView } from 'react-native'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { useDrawer } from '@/context/drawer'
import { useTheme, ThemeTokens, ThemeMode } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFontScale, useFS, FONT_SCALE_MIN, FONT_SCALE_MAX } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { restorePurchases } from '@/lib/revenuecat'
import { APP_VERSION, APP_STORE_URL, PLAY_STORE_URL } from '@/lib/appInfo'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { BADGE_LIFESPAN_OPTIONS } from '@/lib/badgeLifespan'
import { getAvatarUrl, resolveAvatarPresetId } from '@/lib/avatar'
import { getAvatarPreset } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'

const DRAWER_WIDTH = 284

export function Drawer() {
  const { isOpen, close } = useDrawer()
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()

  const translateX = useSharedValue(-DRAWER_WIDTH)
  const scrimOpacity = useSharedValue(0)

  useEffect(() => {
    translateX.value = withSpring(isOpen ? 0 : -DRAWER_WIDTH, {
      damping: 20,
      stiffness: 300,
      overshootClamping: true,
    })
    scrimOpacity.value = withTiming(isOpen ? 1 : 0, { duration: 180 })
  }, [isOpen])

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: scrimOpacity.value,
  }))

  return (
    <>
      {/* Scrim — z-60 */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.scrim,
          scrimStyle,
          { pointerEvents: isOpen ? 'auto' : 'none' },
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
            backgroundColor: tokens.bg2,
            borderRightColor: tokens.bdr2,
            paddingTop: Math.max(insets.top + 8, 34),
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        <DrawerContent tokens={tokens} onClose={close} />
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
  const { session, isPro, isPremium, setIsPro, setIsPremium, avatarOverride } = useAuth()
  const { mode, setMode } = useTheme()
  const { fontScale, setFontScale } = useFontScale()
  const fs = useFS()
  const { badgeDays, setBadgeDays: updateBadgeDays } = useBadgeLifespan()
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

  const nav = (path: string) => {
    onClose()
    // Small delay so drawer closes before modal opens
    setTimeout(() => router.push(path as any), 200)
  }

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
        active
          ? `Your FlyRegs ${status.isPremium ? 'Premium' : 'Pro'} subscription is active.`
          : 'No active subscription was found for this account.'
      )
    } catch (err: any) {
      Alert.alert('Restore Failed', err?.message ?? 'Please try again later.')
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
        <Icon name="xmark" size={17} color={tokens.t3} />
      </Pressable>

      {/* Profile */}
      <Pressable
        style={[styles.profileCard, { borderColor: tokens.bdr }]}
        onPress={() => nav(session ? '/account' : '/auth')}
      >
        <View style={[styles.avatar, { backgroundColor: avatarPreset?.color ?? (session ? tokens.blu : tokens.bg4) }]}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
          ) : avatarPreset ? (
            <Icon name={avatarPreset.icon} size={20} color="#fff" />
          ) : (
            <Text style={[styles.avatarText, { fontSize: fs(17) }]}>{initials}</Text>
          )}
        </View>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <View style={styles.profileNameRow}>
            <Text style={[styles.profileName, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={1}>
              {session ? 'My Account' : 'Sign In'}
            </Text>
            {session && <TierPill isPro={isPro} isPremium={isPremium} tokens={tokens} fs={fs} />}
          </View>
          <Text style={[styles.profileEmail, { color: tokens.t2, fontSize: fs(12) }]} numberOfLines={1}>
            {email}
          </Text>
        </View>
        <Icon name="chevron.right" size={13} color={tokens.t3} />
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
      />
      <DrawerRow
        icon="info.circle"
        label="About FlyRegs"
        value={`v${APP_VERSION}`}
        tokens={tokens}
        onPress={() => nav('/about')}
      />

      <Divider tokens={tokens} />

      {/* Appearance — Phase 2: wired */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="moon.stars" size={17} color={tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14) }]}>Appearance</Text>
      </View>
      <AppearancePicker mode={mode} setMode={setMode} tokens={tokens} />

      {/* Badge Lifespan — inline picker */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="clock.badge" size={17} color={tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14) }]}>Badge Lifespan</Text>
      </View>
      <BadgeLifespanPicker days={badgeDays} setDays={updateBadgeDays} tokens={tokens} />

      {/* Text Size — inline picker */}
      <View style={styles.appearanceRow}>
        <View style={styles.rowIcon}>
          <Icon name="textformat.size" size={17} color={tokens.t2} />
        </View>
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14) }]}>Text Size</Text>
      </View>
      <TextSizeSlider scale={fontScale} setScale={setFontScale} tokens={tokens} />

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
}: {
  mode: ThemeMode
  setMode: (m: ThemeMode) => void
  tokens: ThemeTokens
}) {
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
                { color: active ? tokens.t1 : tokens.t2 },
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
}: {
  days: number
  setDays: (d: number) => void
  tokens: ThemeTokens
}) {
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
            <Text style={[styles.segLabel, { color: active ? tokens.t1 : tokens.t2 }]}>
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
  tokens,
}: {
  scale: number
  setScale: (v: number) => void
  tokens: ThemeTokens
}) {
  const trackW = useRef(0)
  const startX = useRef(0)
  const [layoutW, setLayoutW] = useState(0)
  // Keep a live ref so PanResponder callbacks see the current scale
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startX.current = ((scaleRef.current - FONT_SCALE_MIN) / SCALE_RANGE) * trackW.current
      },
      onPanResponderMove: (_, { dx }) => {
        const tw = trackW.current
        if (!tw) return
        const newX = Math.max(0, Math.min(tw, startX.current + dx))
        setScale(FONT_SCALE_MIN + (newX / tw) * SCALE_RANGE)
      },
      onPanResponderRelease: (_, { dx }) => {
        const tw = trackW.current
        if (!tw) return
        const newX = Math.max(0, Math.min(tw, startX.current + dx))
        setScale(FONT_SCALE_MIN + (newX / tw) * SCALE_RANGE)
      },
    })
  ).current

  const frac = Math.max(0, Math.min(1, (scale - FONT_SCALE_MIN) / SCALE_RANGE))
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
}: {
  icon: string
  label: string
  value?: string
  tokens: ThemeTokens
  onPress?: () => void
}) {
  const fs = useFS()
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowIcon}>
        <Icon name={icon} size={17} color={tokens.t2} />
      </View>
      <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(14) }]}>{label}</Text>
      {value ? <Text style={[styles.rowValue, { color: tokens.t3, fontSize: fs(12.5) }]}>{value}</Text> : null}
      <Icon name="chevron.right" size={12} color={tokens.t4} />
    </Pressable>
  )
}

function Divider({ tokens }: { tokens: ThemeTokens }) {
  return <View style={[styles.divider, { backgroundColor: tokens.bdr }]} />
}

function TierPill({
  isPro, isPremium, tokens, fs,
}: {
  isPro: boolean
  isPremium: boolean
  tokens: ThemeTokens
  fs: (n: number) => number
}) {
  const tier = isPremium ? 'Premium' : isPro ? 'Pro' : 'Free'
  const color = isPremium ? tokens.gold : isPro ? tokens.blu : tokens.t3
  const bg = isPremium ? tokens.goldlt : isPro ? tokens.bdim : tokens.bg3
  const bdr = isPremium ? tokens.goldbdr : isPro ? tokens.bbdr : tokens.bdr
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
