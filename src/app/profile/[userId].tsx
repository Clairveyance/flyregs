import { useEffect, useState, useCallback } from 'react'
import Reanimated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, useReducedMotion,
} from 'react-native-reanimated'
import { View, Text, Image, ScrollView, Pressable, TextInput, Switch, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { RatingPicker } from '@/components/RatingPicker'
import { TabletContainer } from '@/components/TabletContainer'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getStudyMastery, type StudyMastery } from '@/lib/study'
import { getMyRatings, RATING_SHORT_LABELS, type RatingCode } from '@/lib/profileRatings'
import { getCoinsForUser, COIN_BY_CODE, COIN_CATALOG, type EarnedCoin, type CoinDef } from '@/lib/coins'
import { CoinMedal } from '@/components/CoinMedal'
import { NameTag } from '@/components/NameTag'
import { getStatsVisible, setStatsVisible, getCurrentAircraft, setCurrentAircraft } from '@/lib/leaderboard'
import { getAvatarUrl, resolveAvatarPresetId, getDisplayName } from '@/lib/avatar'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'

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
const BRONZE = '#b3773f'
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
  wins, losses, ties, tokens, fs, redShift,
}: {
  wins: number
  losses: number
  ties: number
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  redShift: boolean
}) {
  const reduceMotion = useReducedMotion()
  const items = [
    { label: 'Wins', count: wins, color: tokens.gold },
    { label: 'Losses', count: losses, color: tokens.slv },
    { label: 'Ties', count: ties, color: redShift ? BRONZE_REDSHIFT : BRONZE },
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
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const { session, avatarOverride } = useAuth()
  const isSelf = session?.user.id === userId
  // Same avatarOverride-first resolution as Account/Drawer/Community's
  // identity card -- only meaningful for isSelf, since we have no public
  // avatar lookup for other users here.
  const selfAvatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  const selfCachedAvatarUrl = useCachedImage(session?.user?.id ? `avatar_${session.user.id}` : null, getAvatarUrl(session))
  const selfAvatarUrl = avatarOverride ? avatarOverride.uri : selfCachedAvatarUrl

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
              <View style={[styles.avatar, { backgroundColor: (isSelf && selfAvatarPreset && avatarColorFor(selfAvatarPreset, redShift)) || tokens.goldlt, borderColor: tokens.goldbdr }]}>
                {isSelf && selfAvatarUrl ? (
                  <Image source={{ uri: selfAvatarUrl }} style={styles.avatarImage} />
                ) : isSelf && selfAvatarPreset ? (
                  <Icon name={selfAvatarPreset.icon} size={fs(26)} color="#fff" />
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
                    style={[styles.aircraftInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg, fontSize: fs(13.5) }]}
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
            {duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0) && (
              <Pressable
                style={styles.section}
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
                    {duelStats.wins + duelStats.losses + duelStats.ties}
                  </Text>
                  <Text style={[styles.statHeadlineSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                    {' '}duel{duelStats.wins + duelStats.losses + duelStats.ties === 1 ? '' : 's'} played
                  </Text>
                </Text>
                <DuelOrbit
                  wins={duelStats.wins}
                  losses={duelStats.losses}
                  ties={duelStats.ties}
                  tokens={tokens}
                  fs={fs}
                  redShift={redShift}
                />
              </Pressable>
            )}

            {mastery && mastery.mastered > 0 && (
              <Pressable
                style={[styles.section, styles.sectionDivided, { borderTopColor: tokens.bdr }]}
                disabled={!isSelf}
                onPress={isSelf ? () => router.push('/study' as any) : undefined}
              >
                <View style={styles.sectionTitleRow}>
                  <Icon name="graduationcap.fill" size={fs(11)} color={tokens.t3} />
                  <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>OVERALL MASTERY</Text>
                </View>
                <Text style={{ color: tokens.t1 }}>
                  <Text style={[styles.statHeadlineNum, { fontSize: fs(23) }]}>{mastery.pct}%</Text>
                  <Text style={[styles.statHeadlineSub, { color: tokens.t3, fontSize: fs(13.5) }]}> · {mastery.mastered} terms mastered</Text>
                </Text>
                <MasteryBar pct={mastery.pct} tokens={tokens} redShift={redShift} />
              </Pressable>
            )}

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
                  <View style={[styles.section, styles.sectionDivided, { borderTopColor: tokens.bdr }]}>
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

                <View style={[styles.section, styles.sectionDivided, { borderTopColor: tokens.bdr }]}>
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
                        const earned = coins.some((c) => c.code === coin.code)
                        return (
                          <Pressable
                            key={coin.code}
                            style={styles.coinCard}
                            onPress={() => setCoinDetail(coin)}
                          >
                            <CoinMedal tier={coin.tier} icon={coin.icon} earned={earned} />
                            <Text style={[styles.coinName, { color: earned ? tokens.t1 : tokens.t4, fontSize: fs(12) }]} numberOfLines={2}>
                              {coin.name}
                            </Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  ) : coins.length === 0 ? (
                    <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>No coins earned yet.</Text>
                  ) : (
                    <View style={styles.coinGrid}>
                      {coins.map((c) => {
                        const def = COIN_BY_CODE[c.code]
                        if (!def) return null
                        return (
                          <View key={c.code} style={styles.coinCard}>
                            <CoinMedal tier={def.tier} icon={def.icon} earned />
                            <Text style={[styles.coinName, { color: tokens.t1, fontSize: fs(12) }]} numberOfLines={2}>{def.name}</Text>
                          </View>
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
            return (
              <Pressable style={[styles.coinDetailCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={() => {}}>
                <CoinMedal tier={coinDetail.tier} icon={coinDetail.icon} earned={earned} size={64} />
                <Text style={[styles.coinDetailName, { color: tokens.t1, fontSize: fs(16), marginTop: 8 }]}>{coinDetail.name}</Text>
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
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sectionTitle: { fontWeight: '700', letterSpacing: 0.6 },
  emptySub: {},
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratingChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  ratingChipText: { fontWeight: '700' },

  coinGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  coinCard: {
    width: '26%', gap: 6, alignItems: 'center', justifyContent: 'center',
  },
  coinName: { fontWeight: '600', textAlign: 'center', lineHeight: 14 },

  coinScrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  coinDetailCard: { width: '100%', maxWidth: 320, borderRadius: 18, borderWidth: 1, padding: 24, alignItems: 'center', gap: 8 },
  coinDetailName: { fontWeight: '700' },
  coinDetailStatus: { fontWeight: '700', letterSpacing: 0.6 },
  coinDetailDesc: { textAlign: 'center', lineHeight: 20, marginTop: 4, marginBottom: 8 },
  coinDetailClose: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 9, marginTop: 4 },
})
