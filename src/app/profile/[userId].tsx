import { useEffect, useState, useCallback, type ComponentType, type ComponentProps } from 'react'
import Reanimated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, useReducedMotion,
} from 'react-native-reanimated'
import { View, Text, Image, ScrollView, Pressable, TextInput, Switch, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme, darkTokens } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { RatingPicker } from '@/components/RatingPicker'
import { TabletContainer } from '@/components/TabletContainer'
import { useIsTablet } from '@/context/responsive'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getStudyMastery, type StudyMastery } from '@/lib/study'
import { getMyRatings, RATING_SHORT_LABELS, type RatingCode } from '@/lib/profileRatings'
import { getCoinsForUser, COIN_BY_CODE, COIN_CATALOG, TROPHY_CATALOG, RE_EARNABLE_CODES, type EarnedCoin, type CoinDef } from '@/lib/coins'
import { CoinMedal } from '@/components/CoinMedal'
import { TrophyBadge } from '@/components/TrophyBadge'
import type { AceGem3D as AceGem3DType } from '@/components/AceGem3D'
import type { MasterGlobe3D as MasterGlobe3DType } from '@/components/MasterGlobe3D'
import { NameTag } from '@/components/NameTag'
import { getStatsVisible, setStatsVisible, getCurrentAircraft, setCurrentAircraft } from '@/lib/leaderboard'
import { getAvatarUrl, resolveAvatarPresetId, getDisplayName, getConnectedProfileAvatar, type ConnectedProfileAvatar } from '@/lib/avatar'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// The Community "bragging page" -- badges, ratings, Duel record, current
// aircraft. Duel record is unconditionally public (get_duel_stats() has no
// visibility gate by original design -- match results aren't private).
// Ratings/coins/aircraft respect the existing "Show my stats" toggle
// (account.tsx / search.tsx's Community hub) -- that toggle's own copy
// promises this exact set of fields stays hidden until opted in, so this
// screen honors that even though user_coins/user_profile_ratings' RLS
// policies are technically public-readable already (a pre-existing
// permissiveness this screen doesn't rely on for anyone but the owner).

// RC, 3rd pass on these two -- the 1st redesign (small badge + bar, both in
// a plain icon-row card) read as "standard boxes"; the 2nd (StatRing, two
// big proportional-donut rings reusing FleetRing's radial-tick technique)
// fixed the "boxes" complaint's visual style but got rejected on two counts
// at once: "we don't need the boxes" (the bordered card wrapper itself,
// which the ring redesign kept even though it dropped the small-badge
// look) and "the ring design can't be the same as the My Aircraft ring.
// that needs to stay unique to that." So this pass drops the card entirely
// (bare `styles.section`, same no-box convention already used one screen
// section down for RATINGS/CHALLENGE COINS) and swaps BOTH rings for a
// shape that isn't a ring at all: RC's own earlier suggestion "one circle
// and one bar graph" is the seed. Duel record -- 3 discrete categories
// (W/L/T) -- gets a bubble cluster: three separately-sized filled circles,
// diameter scaled to each outcome's own share of the max, so the dominant
// outcome is visibly biggest -- a genuinely different visual grammar from
// a single dashed dial (composition via SIZE, not arc angle), directly
// answering "we need a visual that can show each category... how to rep
// that graphically." Mastery -- one proportion, not a category breakdown
// -- gets a plain horizontal fill bar instead, so the two cards read as
// two different shapes from each other too, not just from My Aircraft.
const MASTERY_TRACK = '#3A4552'
// Red Shift: neutral blue-grey isn't red-safe -- same dim warm rust-black
// used for CoinMedal's locked/dim state, so every "low progress" visual in
// the app reads consistently under Red Shift.
const MASTERY_TRACK_REDSHIFT = '#4a3530'
// ─── Duel record: medal rings in slow orbit ────────────────────────────────
//
// RC signed off on this exact spec after four static passes were rejected
// ("they don't look 'cool'", "use rings, not solid fills") and two motion
// concepts were narrowed down. Every number below is his call, not a
// default -- worth stating because several look arbitrary and aren't:
//
//   - Colour is FIXED to the outcome, never to rank: "W is always gold, no
//     matter where it is. T is Bronze and L is silver." So gold is not
//     necessarily the outer ring.
//   - Size and orbit position DO rank by count -- biggest count gets the
//     largest ring on the outermost orbit -- which is what makes gold
//     "moving outward" a real signal of a winning record.
//   - The number stays upright while its ring orbits (counter-rotation),
//     RC: "try to lock the inside number to vertical."
//   - 160s for one revolution of the outer ring. RC walked this down twice
//     ("slow the orbit speed WAY down", then 4x, then 8x) until it reads as
//     drift rather than spin. It is meant to be almost imperceptible.
//   - Only the gold ring pulses, "very subtle, slow, and not too frequent."
const ORBIT_SLOTS = [
  { inset: 14, ring: 38, font: 16, seconds: 160 },
  { inset: 40, ring: 30, font: 14, seconds: 112 },
  { inset: 60, ring: 24, font: 12.5, seconds: 74 },
]
const ORBIT_CANVAS = 160
const GOLD_PULSE_MS = 5000
// Bronze has no theme token of its own (gold -> tokens.gold, silver ->
// tokens.slv, both already red-shift aware). Same warm/dim pairing the
// MASTERY_TRACK constants above use.
//
// RC, on a light-mode screenshot: "these two color tones need some
// adjustment - look too similar." Correct, and it's specific to light
// mode: tokens.gold there is #A87C00, a dark amber-brown that sits right
// on top of this bronze. Dark mode is fine (gold is #C6A224, clearly
// brighter). So light mode gets a deeper, redder copper that reads as a
// different metal rather than a slightly darker gold.
const BRONZE_DARK = '#b3773f'
const BRONZE_LIGHT = '#8A4020'
const BRONZE_REDSHIFT = '#8a5a2e'

function OrbitRing({
  slot, color, count, fs, reduceMotion, isGold, phaseDeg,
}: {
  slot: (typeof ORBIT_SLOTS)[number]
  color: string
  count: number
  fs: (n: number) => number
  reduceMotion: boolean
  isGold: boolean
  phaseDeg: number
}) {
  const rot = useSharedValue(phaseDeg)
  const pulse = useSharedValue(0)

  useEffect(() => {
    if (reduceMotion) return
    rot.value = phaseDeg
    rot.value = withRepeat(
      withTiming(phaseDeg + 360, { duration: slot.seconds * 1000, easing: Easing.linear }),
      -1,
      false,
    )
    if (isGold) {
      pulse.value = withRepeat(withTiming(1, { duration: GOLD_PULSE_MS, easing: Easing.out(Easing.quad) }), -1, false)
    }
  }, [reduceMotion, isGold, phaseDeg, slot.seconds, rot, pulse])

  const orbitStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rot.value}deg` }] }))
  // Same shared value, negated -- the number can never drift out of sync
  // with its own ring the way two independent timers eventually would.
  const uprightStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${-rot.value}deg` }] }))
  const haloStyle = useAnimatedStyle(() => ({
    opacity: pulse.value < 0.55 ? 0.85 * (1 - pulse.value / 0.55) : 0,
    transform: [{ scale: 1 + Math.min(pulse.value / 0.55, 1) * 0.85 }],
  }))

  const half = slot.ring / 2
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: slot.inset, left: slot.inset, right: slot.inset, bottom: slot.inset },
        orbitStyle,
      ]}
    >
      <View style={{ position: 'absolute', top: -half, left: '50%', marginLeft: -half, width: slot.ring, height: slot.ring }}>
        <Reanimated.View style={[{ width: '100%', height: '100%' }, uprightStyle]}>
          {isGold && (
            <Reanimated.View
              style={[
                {
                  position: 'absolute', top: -2, left: -2, right: -2, bottom: -2,
                  borderRadius: half + 2, borderWidth: 2, borderColor: color,
                },
                haloStyle,
              ]}
            />
          )}
          <View
            style={{
              width: '100%', height: '100%', borderRadius: half,
              borderWidth: 2, borderColor: color,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Text style={[styles.orbitValue, { color, fontSize: fs(count >= 100 ? slot.font - 3 : slot.font) }]}>
              {count}
            </Text>
          </View>
        </Reanimated.View>
      </View>
    </Reanimated.View>
  )
}

function DuelOrbit({
  wins, losses, ties, tokens, fs, redShift, isLight,
}: {
  wins: number
  losses: number
  ties: number
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  redShift: boolean
  isLight: boolean
}) {
  const reduceMotion = useReducedMotion()
  const bronze = redShift ? BRONZE_REDSHIFT : isLight ? BRONZE_LIGHT : BRONZE_DARK
  const items = [
    { label: 'Wins', count: wins, color: tokens.gold },
    { label: 'Losses', count: losses, color: tokens.slv },
    { label: 'Ties', count: ties, color: bronze },
  ]
  // Rank decides slot only. Ties broken by the fixed Wins/Losses/Ties order
  // so an all-zero (or all-equal) record still lays out deterministically
  // instead of shuffling between renders.
  const ranked = items.map((it, i) => ({ ...it, i })).sort((a, b) => b.count - a.count || a.i - b.i)

  return (
    <View style={styles.orbitRow}>
      <View style={{ width: ORBIT_CANVAS, height: ORBIT_CANVAS }}>
        <View style={[styles.orbitCenter, { backgroundColor: tokens.bdr }]} />
        {ORBIT_SLOTS.map((slot, i) => (
          <View
            key={`track-${i}`}
            style={{
              position: 'absolute', top: slot.inset, left: slot.inset, right: slot.inset, bottom: slot.inset,
              borderRadius: (ORBIT_CANVAS - slot.inset * 2) / 2,
              borderWidth: StyleSheet.hairlineWidth, borderColor: tokens.bdr, borderStyle: 'dashed',
            }}
          />
        ))}
        {ranked.map((it, i) => (
          <OrbitRing
            key={it.label}
            slot={ORBIT_SLOTS[i]}
            color={it.color}
            count={it.count}
            fs={fs}
            reduceMotion={reduceMotion}
            isGold={it.label === 'Wins'}
            // Staggered starts so the three never line up on one radius --
            // and when motion is reduced this is the whole layout, since
            // nothing then moves off its starting angle.
            phaseDeg={i * 120}
          />
        ))}
      </View>
      <View style={styles.orbitLegend}>
        {items.map((it) => (
          <View key={it.label} style={styles.orbitLegendRow}>
            <View style={[styles.orbitLegendDot, { borderColor: it.color }]} />
            <Text style={[styles.orbitLegendText, { color: tokens.t2, fontSize: fs(13) }]}>{it.label}</Text>
          </View>
        ))}
      </View>
    </View>
  )
}

function MasteryBar({ pct, tokens, redShift }: { pct: number; tokens: ReturnType<typeof useTheme>['tokens']; redShift: boolean }) {
  const track = redShift ? MASTERY_TRACK_REDSHIFT : MASTERY_TRACK
  // A real but tiny % (e.g. 1%) would render as an invisible sliver at full
  // bar width -- floor the visible fill so "some progress" always reads as
  // some progress, same reasoning as FleetRing's own minimum-arc handling.
  const fillPct = pct <= 0 ? 0 : Math.max(pct, 3)
  return (
    <View style={[styles.masteryTrack, { backgroundColor: track }]}>
      <View style={[styles.masteryFill, { width: `${fillPct}%`, backgroundColor: tokens.gold }]} />
    </View>
  )
}

export default function ProfileScreen() {
  const { userId, label } = useLocalSearchParams<{ userId: string; label?: string }>()
  const { tokens, redShift, resolved } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const { session, avatarOverride } = useAuth()
  const isSelf = session?.user.id === userId
  // iPad, RC: "our coins, and orbiting planets, and ratings lists, etc. we
  // can make big separate boxes for all of this and give real, good,
  // visual sep bet all of it." Phone deliberately dropped these boxes in
  // an earlier pass ("we don't need the boxes" -- RC, 3rd redesign round)
  // because a single narrow column made them feel like padding, not
  // separation. iPad's wide detail pane is a different tier of space --
  // real boxes plus a genuine 2-up row for the two stat visuals reads as
  // organized, not padded. Phone's exact JSX/logic is untouched below.
  const isTablet = useIsTablet()
  // Same avatarOverride-first resolution as Account/Drawer/Community's
  // identity card -- for isSelf only. Someone else's real avatar comes from
  // otherAvatar below instead, gated server-side by get_profile_avatar (see
  // getConnectedProfileAvatar's own comment) -- never shown to a viewer who
  // isn't an actual folder/aircraft collaborator of this profile's owner.
  const selfAvatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  const selfCachedAvatarUrl = useCachedImage(session?.user?.id ? `avatar_${session.user.id}` : null, getAvatarUrl(session))
  const selfAvatarUrl = avatarOverride ? avatarOverride.uri : selfCachedAvatarUrl
  const [otherAvatar, setOtherAvatar] = useState<ConnectedProfileAvatar | null>(null)
  const otherCachedAvatarUrl = useCachedImage(
    !isSelf && otherAvatar?.avatarUrl ? `avatar_${userId}` : null,
    otherAvatar?.avatarUrl ?? null
  )
  const otherAvatarPreset = getAvatarPreset(otherAvatar?.avatarPresetId ?? null)

  const [loading, setLoading] = useState(true)
  // `statsVisibleReal` is the actual stored toggle value -- always fetched,
  // even for isSelf, since the owner needs to see/control the real state.
  // `visible` is what gates showing ratings/coins/aircraft on screen: the
  // owner always sees their own (regardless of whether it's public), so
  // it's `true` for isSelf and mirrors the real toggle for everyone else.
  const [statsVisibleReal, setStatsVisibleReal] = useState(false)
  const [statsVisibleBusy, setStatsVisibleBusy] = useState(false)
  const visible = isSelf || statsVisibleReal
  const [duelStats, setDuelStats] = useState<DuelStats | null>(null)
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  const [ratings, setRatings] = useState<RatingCode[]>([])
  // Ratings are edited HERE now, not on Account — see RatingPicker.tsx.
  const [ratingPickerOpen, setRatingPickerOpen] = useState(false)
  const [coins, setCoins] = useState<EarnedCoin[]>([])
  const [aircraft, setAircraft] = useState('')
  const [aircraftInput, setAircraftInput] = useState('')
  const [aircraftDirty, setAircraftDirty] = useState(false)
  const [aircraftSaving, setAircraftSaving] = useState(false)
  const [coinDetail, setCoinDetail] = useState<CoinDef | null>(null)
  // AceGem3D/MasterGlobe3D (expo-gl/expo-three/three) are dynamically
  // imported, not top-level -- confirmed live via Sentry as the app's
  // highest-volume unresolved fatal crash (38 occurrences): GLView calls
  // requireNativeModule('ExpoGL') at IMPORT time, not render time, so a
  // static top-level import here crashed this entire screen the instant
  // its module loaded -- before the trophy popup was ever opened, before
  // any tap -- on any build whose native side hasn't been rebuilt with
  // these (new this session) dependencies linked in. Same bug shape, same
  // fix, as contactMatch.ts's expo-contacts deferral: only touch the
  // native-module-backed import at the moment it's actually needed (the
  // user opening one of these two specific trophy popups), not merely by
  // opening Profile. Doesn't eliminate the need for a real native rebuild
  // to link the module in -- it shrinks the blast radius from "the whole
  // Profile screen" to "just this popup, only if actually opened."
  const [AceGem3DComp, setAceGem3DComp] = useState<ComponentType<ComponentProps<typeof AceGem3DType>> | null>(null)
  const [MasterGlobe3DComp, setMasterGlobe3DComp] = useState<ComponentType<ComponentProps<typeof MasterGlobe3DType>> | null>(null)
  useEffect(() => {
    if (!coinDetail) return
    if (coinDetail.code === 'DUEL_100_WINS' && !AceGem3DComp) {
      import('@/components/AceGem3D').then((m) => setAceGem3DComp(() => m.AceGem3D))
    } else if (coinDetail.code === 'MASTERY_FULL' && !MasterGlobe3DComp) {
      import('@/components/MasterGlobe3D').then((m) => setMasterGlobe3DComp(() => m.MasterGlobe3D))
    }
  }, [coinDetail, AceGem3DComp, MasterGlobe3DComp])
  // Challenge Coin names can run long ("30-Day Currency" etc., per the
  // coinNameSlot layout comment below) and get cut off the same way FAR
  // Part titles do -- same hook/card pair as far/index.tsx's own long-press
  // preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    const [stats, realVisible, masteryStats] = await Promise.all([
      getDuelStats(userId).catch(() => ({ wins: 0, losses: 0, ties: 0 })),
      getStatsVisible(userId).catch(() => false),
      getStudyMastery(userId).catch(() => null),
    ])
    setDuelStats(stats)
    setStatsVisibleReal(realVisible)
    setMastery(masteryStats)
    if (!isSelf) {
      getConnectedProfileAvatar(userId)
        .then(setOtherAvatar)
        .catch(() => setOtherAvatar({ avatarUrl: null, avatarPresetId: null, connected: false }))
    }
    if (isSelf || realVisible) {
      const [r, c, a] = await Promise.all([
        getMyRatings(userId).catch(() => []),
        getCoinsForUser(userId).catch(() => []),
        getCurrentAircraft(userId).catch(() => ''),
      ])
      setRatings(r); setCoins(c); setAircraft(a)
      setAircraftInput(a); setAircraftDirty(false)
    }
    setLoading(false)
  }, [userId, isSelf])

  useEffect(() => { load() }, [load])

  const handleToggleStatsVisible = async (v: boolean) => {
    if (!isSelf || !userId) return
    setStatsVisibleBusy(true)
    try {
      await setStatsVisible(userId, v)
      setStatsVisibleReal(v)
    } catch (_) {}
    setStatsVisibleBusy(false)
  }

  const handleSaveAircraft = async () => {
    if (!isSelf || !userId || aircraftSaving) return
    setAircraftSaving(true)
    try {
      await setCurrentAircraft(userId, aircraftInput)
      setAircraft(aircraftInput)
      setAircraftDirty(false)
    } catch (_) {}
    setAircraftSaving(false)
  }

  // Real callsign (or email prefix fallback), same as Community's identity
  // card -- previously hardcoded "You" here, so an updated callsign in
  // Account never showed up on your own profile page.
  const displayLabel = isSelf ? getDisplayName(session) : (label || 'Pilot')

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Profile" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      ) : (
        <TabletContainer>
          <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive">
            <View style={styles.headerRow}>
              <View style={[styles.avatar, {
                backgroundColor:
                  (isSelf && selfAvatarPreset && avatarColorFor(selfAvatarPreset, redShift)) ||
                  (!isSelf && otherAvatarPreset && avatarColorFor(otherAvatarPreset, redShift)) ||
                  tokens.goldlt,
                borderColor: tokens.goldbdr,
              }]}>
                {isSelf && selfAvatarUrl ? (
                  <Image source={{ uri: selfAvatarUrl }} style={styles.avatarImage} />
                ) : isSelf && selfAvatarPreset ? (
                  <Icon name={selfAvatarPreset.icon} size={fs(26)} color="#fff" />
                ) : !isSelf && otherCachedAvatarUrl ? (
                  <Image source={{ uri: otherCachedAvatarUrl }} style={styles.avatarImage} />
                ) : !isSelf && otherAvatarPreset ? (
                  <Icon name={otherAvatarPreset.icon} size={fs(26)} color="#fff" />
                ) : (
                  <Text style={[styles.avatarText, { color: tokens.gold, fontSize: fs(24) }]}>
                    {displayLabel.charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: tokens.t1, fontSize: fs(19) }]}>{displayLabel}</Text>
                {aircraft ? (
                  <Text style={[styles.aircraft, { color: tokens.t3, fontSize: fs(13) }]}>Flying: {aircraft}</Text>
                ) : null}
                {visible && <NameTag ratings={ratings} coins={coins} />}
              </View>
            </View>

            {isSelf && (
              // Editing (visibility toggle, aircraft, ratings) used to live
              // duplicated on the Community tab's own "Show my stats" panel
              // -- moved here since this is the actual profile the toggle's
              // copy describes ("other users see your ratings..."), and
              // Community already links here via "View my profile".
              <View style={[styles.editCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <View style={styles.editRow}>
                  <View style={[{ flex: 1 }, styles.editTitleRow]}>
                    <Text style={[styles.editTitle, { color: tokens.t1, fontSize: fs(14) }]}>Show my stats</Text>
                    {/* RC: "let's get this off page and into an info icon" --
                        was always-visible body text under the title; now
                        the same explanation, tap-to-reveal. */}
                    <InfoPopup
                      id="profile-show-my-stats"
                      title="Show my stats"
                      body="Lets other players see your ratings, coin count, and current aircraft."
                      iconSize={15}
                    />
                  </View>
                  {statsVisibleBusy ? (
                    <ActivityIndicator size="small" color={tokens.t3} />
                  ) : (
                    <Switch value={statsVisibleReal} onValueChange={handleToggleStatsVisible} trackColor={{ true: tokens.blu, false: undefined }} />
                  )}
                </View>
                <View style={styles.aircraftRow}>
                  <TextInput
                    style={[styles.aircraftInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg, fontSize: ifs(13.5) }]}
                    value={aircraftInput}
                    onChangeText={(v) => { setAircraftInput(v); setAircraftDirty(true) }}
                    placeholder="Current aircraft (e.g. SR22, G550)"
                    placeholderTextColor={tokens.t4}
                    maxLength={40}
                    autoCapitalize="characters"
                    returnKeyType="done"
                    onSubmitEditing={handleSaveAircraft}
                  />
                  {aircraftSaving ? (
                    <ActivityIndicator size="small" color={tokens.t3} style={styles.aircraftSaveBtn} />
                  ) : (
                    <Pressable
                      style={[styles.aircraftSaveBtn, { backgroundColor: aircraftDirty ? tokens.blu : tokens.bg4 }]}
                      onPress={handleSaveAircraft}
                      disabled={!aircraftDirty}
                    >
                      <Text style={[styles.aircraftSaveBtnText, { fontSize: fs(12.5) }]}>Save</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            {/* RC, 3rd pass: "we don't need the boxes" + "the ring design
                can't be the same as the My Aircraft ring." No card wrapper
                (bare `section`, matching RATINGS/CHALLENGE COINS below),
                and neither shape is My Aircraft's dashed dial -- a bubble
                cluster for Duels' 3-way W/L/T breakdown, a plain fill bar
                for Mastery's single proportion. Tappable when viewing your
                own profile (into Duels/Study), not on someone else's --
                there's nothing self-only to navigate to there. Both stay
                unconditionally public, same as the rest of this "bragging
                page," not gated behind the "Show my stats" toggle the way
                ratings/coins/aircraft are (RC: "your total Overall Mastery
                %. plus the nametag. all the things to really brag about"). */}
            {(() => {
              const showDuel = duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0)
              const showMastery = mastery && mastery.mastered > 0
              // RC, iPad: "we can make big separate boxes for all of this
              // and give real, good, visual sep bet all of it." Phone keeps
              // the exact bare-section, stacked layout from the 3rd redesign
              // pass (styles.section, no box) -- only isTablet adds a real
              // bordered/backgrounded card and sits the two stat visuals
              // side by side instead of stacked, since there's finally
              // width to spare for it.
              const duelCard = showDuel ? (
                <Pressable
                  style={[styles.section, isTablet && [styles.tabletCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }], isTablet && { flex: 1 }]}
                  disabled={!isSelf}
                  onPress={isSelf ? () => router.push('/challenges' as any) : undefined}
                >
                  <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>DUEL RECORD</Text>
                  {/* RC: "we see the 0W 1L 1T count already, so what is the
                      'plan' with these rings?" -- fair catch, the rings below
                      already show each of wins/losses/ties as their own
                      number, so restating the same breakdown here was pure
                      duplication. This headline now only says what the rings
                      don't: the total played. */}
                  <Text style={{ color: tokens.t1 }}>
                    <Text style={[styles.statHeadlineNum, { fontSize: fs(23) }]}>
                      {duelStats!.wins + duelStats!.losses + duelStats!.ties}
                    </Text>
                    <Text style={[styles.statHeadlineSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                      {' '}duel{duelStats!.wins + duelStats!.losses + duelStats!.ties === 1 ? '' : 's'} played
                    </Text>
                  </Text>
                  <DuelOrbit
                    wins={duelStats!.wins}
                    losses={duelStats!.losses}
                    ties={duelStats!.ties}
                    tokens={tokens}
                    fs={fs}
                    redShift={redShift}
                    isLight={resolved === 'light'}
                  />
                </Pressable>
              ) : null

              const masteryCard = showMastery ? (
                <Pressable
                  style={[
                    styles.section,
                    !isTablet && styles.sectionDivided,
                    !isTablet && { borderTopColor: tokens.bdr },
                    isTablet && [styles.tabletCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }],
                    isTablet && { flex: 1 },
                  ]}
                  disabled={!isSelf}
                  onPress={isSelf ? () => router.push('/study' as any) : undefined}
                >
                  <View style={styles.sectionTitleRow}>
                    <Icon name="graduationcap.fill" size={fs(11)} color={tokens.t3} />
                    <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>OVERALL MASTERY</Text>
                  </View>
                  <Text style={{ color: tokens.t1 }}>
                    <Text style={[styles.statHeadlineNum, { fontSize: fs(23) }]}>{mastery!.pct}%</Text>
                    <Text style={[styles.statHeadlineSub, { color: tokens.t3, fontSize: fs(13.5) }]}> · {mastery!.mastered} terms mastered</Text>
                  </Text>
                  <MasteryBar pct={mastery!.pct} tokens={tokens} redShift={redShift} />
                </Pressable>
              ) : null

              if (!duelCard && !masteryCard) return null
              return isTablet ? (
                <View style={styles.statRow}>{duelCard}{masteryCard}</View>
              ) : (
                <>{duelCard}{masteryCard}</>
              )
            })()}

            {!visible ? (
              <View style={[styles.privateCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="eye.slash" size={fs(22)} color={tokens.t4} />
                <Text style={[styles.privateText, { color: tokens.t3, fontSize: fs(13) }]}>
                  {displayLabel} hasn't made ratings, badges, or aircraft visible to other players yet.
                </Text>
              </View>
            ) : (
              <>
                {(ratings.length > 0 || isSelf) && (
                  <View style={[
                    styles.section,
                    !isTablet && styles.sectionDivided,
                    !isTablet && { borderTopColor: tokens.bdr },
                    isTablet && [styles.tabletCard, styles.tabletCardSpaced, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }],
                  ]}>
                    <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>RATINGS</Text>
                    <View style={styles.chipWrap}>
                      {ratings.map((code) => (
                        <View key={code} style={[styles.ratingChip, { borderColor: tokens.gold, backgroundColor: tokens.goldlt }]}>
                          <Text style={[styles.ratingChipText, { color: tokens.gold, fontSize: fs(12) }]}>{RATING_SHORT_LABELS[code]}</Text>
                        </View>
                      ))}
                      {isSelf && (
                        <Pressable
                          style={[styles.ratingChip, styles.addRatingChip, { borderColor: tokens.bdr }]}
                          onPress={() => setRatingPickerOpen(true)}
                        >
                          <Icon name="plus" size={fs(11)} color={tokens.t2} />
                          <Text style={[styles.ratingChipText, { color: tokens.t2, fontSize: fs(12) }]}>Add Rating</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                )}

                <View style={[
                  styles.section,
                  !isTablet && styles.sectionDivided,
                  !isTablet && { borderTopColor: tokens.bdr },
                  isTablet && [styles.tabletCard, styles.tabletCardSpaced, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }],
                ]}>
                  <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>
                    CHALLENGE COINS{coins.length > 0 ? ` · ${coins.length}` : ''}
                  </Text>
                  {isSelf ? (
                    // Full catalog with locked slots + tap-to-detail --
                    // moved here from Account (which showed the exact same
                    // grid, now duplicated) since this is the actual
                    // "bragging page" the coins are for.
                    <View style={styles.coinGrid}>
                      {COIN_CATALOG.map((coin) => {
                        const count = coins.filter((c) => c.code === coin.code).length
                        const earned = count > 0
                        return (
                          <Pressable
                            key={coin.code}
                            style={styles.coinCard}
                            onPress={() => {
                              if (consumeLongPress()) return
                              setCoinDetail(coin)
                            }}
                            onLongPress={(e) => showPreview(coin.name, e)}
                            onPressOut={hidePreview}
                            delayLongPress={350}
                          >
                            <View style={styles.coinMedalWrap}>
                              <CoinMedal tier={coin.tier} icon={coin.icon} earned={earned} />
                              {/* RC, 2026-08-12: asked whether the "1" here
                                  was ever wrong -- it wasn't (every award
                                  path was NOT-EXISTS-gated, one row per
                                  coin, forever), but a badge that can only
                                  ever say "1" isn't telling anyone
                                  anything. Now split by whether the coin is
                                  actually re-earnable (RE_EARNABLE_CODES,
                                  the 3 currency coins -- real running
                                  count) or a genuine one-time milestone (no
                                  badge at all, matching RC's "the rest, i
                                  suppose, you can remove their badges
                                  altogether"). */}
                              {earned && RE_EARNABLE_CODES.has(coin.code) && (
                                <View style={[styles.coinCountBadge, { backgroundColor: tokens.gold }]}>
                                  <Text style={styles.coinCountBadgeText}>{count}</Text>
                                </View>
                              )}
                            </View>
                            <View style={styles.coinNameSlot}>
                              <Text style={[styles.coinName, { color: earned ? tokens.t1 : tokens.t4, fontSize: fs(12) }]} numberOfLines={2}>
                                {coin.name}
                              </Text>
                            </View>
                          </Pressable>
                        )
                      })}
                    </View>
                  ) : coins.length === 0 ? (
                    <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>No coins earned yet.</Text>
                  ) : (
                    <View style={styles.coinGrid}>
                      {/* Distinct codes, not one card per row -- a
                          re-earnable currency coin can now have more than
                          one user_coins row, which used to render as
                          duplicate cards for the same coin here. */}
                      {[...new Set(coins.map((c) => c.code))].map((code) => {
                        const def = COIN_BY_CODE[code]
                        if (!def) return null
                        const count = coins.filter((c) => c.code === code).length
                        return (
                          <View key={code} style={styles.coinCard}>
                            <View style={styles.coinMedalWrap}>
                              <CoinMedal tier={def.tier} icon={def.icon} earned />
                              {RE_EARNABLE_CODES.has(code) && (
                                <View style={[styles.coinCountBadge, { backgroundColor: tokens.gold }]}>
                                  <Text style={styles.coinCountBadgeText}>{count}</Text>
                                </View>
                              )}
                            </View>
                            <Pressable
                              style={styles.coinNameSlot}
                              onLongPress={(e) => showPreview(def.name, e)}
                              onPressOut={hidePreview}
                              delayLongPress={350}
                            >
                              <Text style={[styles.coinName, { color: tokens.t1, fontSize: fs(12) }]} numberOfLines={2}>{def.name}</Text>
                            </Pressable>
                          </View>
                        )
                      })}
                    </View>
                  )}
                  {/* "Trophy case" -- The Ace (100 Duel wins) and The
                      Master (100% overall mastery), RC's own "two big
                      ticket items... side by side, both slowly spinning,
                      like trophies in a case." Self always sees both
                      (locked or earned, same aspirational-grid convention
                      as CHALLENGE COINS above); other users only see this
                      row at all once they've earned at least one, matching
                      how the regular grid never shows another user locked
                      slots either. */}
                  {(isSelf || TROPHY_CATALOG.some((t) => coins.some((c) => c.code === t.code))) && (
                    <View style={styles.trophyCase}>
                      {TROPHY_CATALOG.map((trophy) => {
                        const earned = coins.some((c) => c.code === trophy.code)
                        if (!isSelf && !earned) return null
                        return (
                          <Pressable key={trophy.code} style={styles.trophyCard} onPress={() => setCoinDetail(trophy)}>
                            <TrophyBadge variant={trophy.code === 'DUEL_100_WINS' ? 'ace' : 'master'} icon={trophy.icon} earned={earned} />
                            <Text style={[styles.trophyName, { color: earned ? tokens.t1 : tokens.t4, fontSize: fs(13) }]}>{trophy.name}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        </TabletContainer>
      )}

      <Modal visible={!!coinDetail} animationType="fade" transparent onRequestClose={() => setCoinDetail(null)}>
        <Pressable style={styles.coinScrim} onPress={() => setCoinDetail(null)}>
          {coinDetail && (() => {
            const earned = coins.some((c) => c.code === coinDetail.code)
            const trophyVariant = coinDetail.code === 'DUEL_100_WINS' ? 'ace' : coinDetail.code === 'MASTERY_FULL' ? 'master' : null
            return (
              <Pressable style={[styles.coinDetailCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={() => {}}>
                {/* RC: "these go on the pop up cards which display when a
                    user clicks on the locked image to see what they get
                    when they reach that goal" -- the real WebGL diamond/
                    globe (trophy_3d.html, tuned live with RC over this
                    whole session) replaces the flat Reanimated TrophyBadge
                    specifically here, in the reveal/preview popup. The
                    grid tile version further up this file (TrophyBadge at
                    line ~678) is untouched -- RC scoped this to the popup
                    only, not every place a trophy renders. Always shows
                    the real vivid render, earned or not: the whole point
                    of this popup is to preview what you GET, not to gate
                    the preview behind having it already. */}
                {trophyVariant === 'ace' ? (
                  // RC, Light Mode: "the black diamond is completely
                  // ruined... make the top portion of that pop up card our
                  // standard dark mode b/g color." The gem's transmission
                  // genuinely needs a dark surround -- it's a translucent
                  // material that shows its backdrop THROUGH its facets, so
                  // a light backdrop makes the whole gem read as washed-out
                  // white/grey instead of a black diamond. This stage
                  // always uses `darkTokens.bg2` (not the active theme's
                  // `tokens.bg2`) on both the surrounding View and the
                  // `backdropColor` prop, in every theme, not just Light
                  // Mode. RC round 7: "extend the dark area all the way to
                  // the edges of this CTA box" -- the negative margin
                  // canceled the card's own padding, but `coinDetailCard`'s
                  // `alignItems:'center'` sizes children to their own
                  // content width instead of stretching them, so this box
                  // was only ever as wide as the circular render inside it,
                  // not the full card -- `alignSelf:'stretch'` is the fix,
                  // not more margin.
                  <View
                    style={{
                      backgroundColor: darkTokens.bg2,
                      marginTop: -10,
                      marginHorizontal: -10,
                      alignSelf: 'stretch',
                      borderTopLeftRadius: 18,
                      borderTopRightRadius: 18,
                      paddingVertical: 12,
                      alignItems: 'center',
                    }}
                  >
                    {/* RC round 9: "the glow around the diamond needs to
                        fade out into the dark blue of the actual app
                        background." Every clip tried so far (square, then
                        circular) was solving the wrong problem -- measured
                        directly with gl.readPixels (the same technique
                        that root-caused the globe's white-rim issue):
                        the backdrop plane's own far-corner color is
                        (12,24,38), an EXACT bit-for-bit match to
                        darkTokens.bg2. There was never a color seam to
                        fade -- the "hard edge" was always just the CLIP
                        ITSELF, a geometric cutout drawn on top of a
                        background that already matches perfectly. No clip
                        at all, on a color-matched backdrop, IS the fade --
                        removed the wrapper entirely. */}
                    {AceGem3DComp ? (
                      <AceGem3DComp size={268} backdropColor={darkTokens.bg2} />
                    ) : (
                      <View style={{ width: 268, height: 268, borderRadius: 134, backgroundColor: 'rgba(79,209,255,0.12)' }} />
                    )}
                  </View>
                ) : trophyVariant === 'master' ? (
                  // RC round 7: "the globe is solid, and gold, so it
                  // doesn't need this dark b/g. remove it." Correct, and
                  // the reason the Light-Mode dark-stage trick was ever
                  // applied here was scoping consistency with the gem, not
                  // a real need of its own -- unlike the gem, the globe's
                  // material is fully opaque metal (metalness 0.88, no
                  // transmission), so nothing behind it ever shows through
                  // its surface. The only place a backdrop color could even
                  // matter is the square canvas's corners outside the
                  // sphere's own circular silhouette, and the circular clip
                  // below already crops those away almost entirely. So:
                  // no stage box, no forced dark color -- just the real
                  // active-theme `tokens.bg2`, same circular clip as the
                  // gem for the square-edge fix.
                  <View style={{ width: 268, height: 268, borderRadius: 134, overflow: 'hidden', alignSelf: 'center' }}>
                    {MasterGlobe3DComp ? (
                      <MasterGlobe3DComp size={268} backdropColor={tokens.bg2} />
                    ) : (
                      <View style={{ width: 268, height: 268, borderRadius: 134, backgroundColor: 'rgba(79,209,255,0.12)' }} />
                    )}
                  </View>
                ) : (
                  <CoinMedal tier={coinDetail.tier} icon={coinDetail.icon} earned={earned} size={64} />
                )}
                {/* RC: "The text should say 'The Ace's Black Diamond'...
                    'black diamond' on the next line, below The Ace's --
                    and the 'BD' words should be black with a white glow
                    behind them" (same pattern for Master: "Golden Globe"
                    in gold). A real nickname for each trophy object, not
                    just its catalog name -- two-line stack, second line
                    carries the color+glow treatment. Regular (non-trophy)
                    coins are untouched, still just coinDetail.name.
                    RC, later: "remove the 's' from The Ace and The
                    Master" -- first line is now the bare name, no
                    possessive. */}
                {trophyVariant === 'ace' ? (
                  <>
                    <Text style={[styles.coinDetailName, { color: tokens.t1, fontSize: fs(16), marginTop: 8 }]}>The Ace</Text>
                    <Text
                      style={[
                        styles.coinDetailName,
                        {
                          color: '#000000',
                          fontSize: fs(16),
                          textShadowColor: '#ffffff',
                          textShadowOffset: { width: 0, height: 0 },
                          textShadowRadius: 8,
                        },
                      ]}
                    >
                      Black Diamond
                    </Text>
                  </>
                ) : trophyVariant === 'master' ? (
                  <>
                    <Text style={[styles.coinDetailName, { color: tokens.t1, fontSize: fs(16), marginTop: 8 }]}>The Master</Text>
                    <Text
                      style={[
                        styles.coinDetailName,
                        {
                          // RC: "make 'golden globe' a bit brighter and
                          // 'golden' looking." `tokens.gold` is the shared
                          // app-wide gold token (badges, EARNED status,
                          // etc.) -- muted on purpose for those uses, but
                          // reads dull/olive for a headline trophy label.
                          // A dedicated brighter gold here, scoped to just
                          // this line, doesn't touch the shared token or
                          // any other gold-colored UI in the app.
                          color: '#FFCB47',
                          fontSize: fs(16),
                          textShadowColor: '#ffffff',
                          textShadowOffset: { width: 0, height: 0 },
                          textShadowRadius: 8,
                        },
                      ]}
                    >
                      Golden Globe
                    </Text>
                  </>
                ) : (
                  <Text style={[styles.coinDetailName, { color: tokens.t1, fontSize: fs(16), marginTop: 8 }]}>{coinDetail.name}</Text>
                )}
                <Text style={[styles.coinDetailStatus, { color: earned ? tokens.gold : tokens.t3, fontSize: fs(12) }]}>
                  {earned ? 'EARNED' : 'LOCKED — HOW TO UNLOCK'}
                </Text>
                <Text style={[styles.coinDetailDesc, { color: tokens.t2, fontSize: fs(14) }]}>{coinDetail.description}</Text>
                <Pressable style={[styles.coinDetailClose, { borderColor: tokens.bdr }]} onPress={() => setCoinDetail(null)}>
                  <Text style={{ color: tokens.t2, fontWeight: '600' }}>Close</Text>
                </Pressable>
              </Pressable>
            )
          })()}
        </Pressable>
      </Modal>
      {isSelf && session?.user.id && (
        <RatingPicker
          visible={ratingPickerOpen}
          userId={session.user.id}
          ratings={ratings}
          onClose={() => setRatingPickerOpen(false)}
          onChange={setRatings}
        />
      )}
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // RC: "page still looks cluttered. we need better definition and spacing
  // between sections." The box-free sections (RC, 3rd pass: "we don't need
  // the boxes") had nothing but a flat 18px gap between them -- no visual
  // break at all between e.g. the coin grid ending and Ratings starting.
  // Widened the base rhythm and gave every section after the first a thin
  // top rule + extra top padding -- a divider line, not a card, so it reads
  // as more air/structure without reintroducing the box look.
  content: { padding: 16, paddingBottom: 40, gap: 26 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 58, height: 58, borderRadius: 29, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { fontWeight: '800' },
  name: { fontWeight: '700' },
  aircraft: { marginTop: 3 },

  editCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 12 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  editTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  editTitle: { fontWeight: '600' },
  aircraftRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aircraftInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  aircraftSaveBtn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  aircraftSaveBtnText: { color: '#fff', fontWeight: '700' },
  addRatingChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },

  // Duel record / Overall Mastery -- see DuelBubbles/MasteryBar's own
  // header comment for why these dropped the card+ring look entirely.
  statHeadlineNum: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  statHeadlineSub: { fontVariant: ['tabular-nums'] },
  orbitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22, marginTop: 12 },
  orbitCenter: {
    position: 'absolute', top: '50%', left: '50%',
    width: 6, height: 6, marginTop: -3, marginLeft: -3, borderRadius: 3,
  },
  orbitValue: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  orbitLegend: { gap: 11 },
  orbitLegendRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  orbitLegendDot: { width: 11, height: 11, borderRadius: 5.5, borderWidth: 2 },
  orbitLegendText: { fontWeight: '600' },
  masteryTrack: { height: 14, borderRadius: 7, overflow: 'hidden', marginTop: 10 },
  masteryFill: { height: '100%', borderRadius: 7 },

  privateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 16,
  },
  privateText: { flex: 1, lineHeight: 18 },

  section: { gap: 8 },
  sectionDivided: { paddingTop: 22, borderTopWidth: StyleSheet.hairlineWidth },
  statRow: { flexDirection: 'row', gap: 14, marginTop: 22 },
  tabletCard: { borderWidth: 1, borderRadius: 16, padding: 16 },
  tabletCardSpaced: { marginTop: 22 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sectionTitle: { fontWeight: '700', letterSpacing: 0.6 },
  emptySub: {},
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratingChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  ratingChipText: { fontWeight: '700' },

  // justifyContent: 'center' -- RC: "make sure they're all centered on any
  // phone screen." Without it, coinCard's own width: '26%' (3 per row) left
  // the grid's own rows flush against the container's LEFT edge, out of
  // alignment with trophyCase below (already justifyContent: 'center'),
  // so the whole "trophy case" row read as off-center under the grid above
  // it rather than the two visually lining up.
  coinGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' },
  // alignItems: 'flex-start' (not 'center') is load-bearing -- RC, real
  // device: "coins aren't aligned." Root cause, confirmed via direct DOM
  // measurement: numberOfLines={2} lets a card's label render as 1 line
  // ("Century") or 2 ("30-Day Currency") depending on the coin's own name
  // length. With every card centered independently inside a row that CSS
  // flexbox stretches to its tallest sibling, a 1-line card's whole
  // coin+label stack shifts DOWN (and a 2-line card's shifts UP) by half
  // the line-count difference -- coins in the same row visibly land at
  // different heights. Top-aligning removes the thing that was doing the
  // shifting; coinNameSlot's fixed height (below) removes the OTHER half
  // of the cause by giving every label the same reserved space regardless
  // of its own actual line count.
  // gap bumped from 6 -- RC, real device: "the words got pulled up right
  // under the coins." Correct fixed-footprint math (see CoinMedal.tsx's
  // own wrap comment) meant the label now sits exactly `gap` below the
  // coin's TRUE edge for the first time, instead of behind extra invisible
  // padding that used to read as breathing room by accident.
  coinCard: {
    width: '26%', gap: 10, alignItems: 'center', justifyContent: 'flex-start',
  },
  coinMedalWrap: { position: 'relative' },
  coinCountBadge: {
    position: 'absolute', bottom: -2, right: -4,
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 3,
    alignItems: 'center', justifyContent: 'center',
  },
  coinCountBadgeText: { color: '#000', fontWeight: '800', fontSize: 10 },
  // Fixed 2-line height, regardless of how many lines THIS coin's own name
  // actually needs -- see coinCard's own comment for why the box has to be
  // fixed at all. RC, real device: "wording still cut off" -- the box was
  // sized to the exact mathematical minimum (lineHeight 14 * 2 = 28), with
  // zero slack for how iOS actually renders a bold 2-line label (real font
  // metrics reserve a little more vertical room per line than the raw
  // lineHeight number implies -- this app has hit that exact "exact-fit
  // math looks right, clips glyphs on a real device" class of bug before,
  // see CoinMedal.tsx's shadow/glow comment). Both the box and the
  // line-height itself now have real headroom instead of a razor-exact fit.
  coinNameSlot: { height: 34, justifyContent: 'flex-start', overflow: 'visible' },
  coinName: { fontWeight: '600', textAlign: 'center', lineHeight: 16 },
  // "Trophy case" -- The Ace / The Master, deliberately its own row below
  // the regular coinGrid, not a 3rd/4th column squeezed into it: RC's own
  // spec was "side by side," just the two of them, bigger than the rest.
  trophyCase: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 20 },
  trophyCard: { alignItems: 'center', gap: 8, width: 130 },
  trophyName: { fontWeight: '700', textAlign: 'center' },

  // RC, round 2: still "not centered at all" (real bug, fixed in
  // AceGem3D/MasterGlobe3D -- see their setPixelRatio comment) and wanted
  // another 2x from 300. A literal 2x (600) physically cannot fit a
  // 375pt-wide iPhone screen inside a padded modal card -- this is the
  // practical ceiling for THIS layout (335px render, scrim padding
  // 20->10, card padding 16->10, maxWidth loosened to let the card use
  // nearly the full screen width). Going bigger than this specifically
  // means changing the popup from a centered card into a full-screen
  // takeover instead, which is a real design option but a bigger change
  // than a number -- flagged to RC rather than done silently.
  coinScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 10 },
  coinDetailCard: { width: '100%', maxWidth: 400, borderRadius: 18, borderWidth: 1, padding: 10, alignItems: 'center', gap: 8 },
  coinDetailName: { fontWeight: '700' },
  coinDetailStatus: { fontWeight: '700', letterSpacing: 0.6 },
  coinDetailDesc: { textAlign: 'center', lineHeight: 20, marginTop: 4, marginBottom: 8 },
  coinDetailClose: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 9, marginTop: 4 },
})
