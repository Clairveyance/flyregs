import { useEffect, useState, useCallback } from 'react'
import { View, Text, Image, ScrollView, Pressable, TextInput, Switch, StyleSheet, ActivityIndicator, Modal } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
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

// RC, 2nd pass on these two cards -- the first redesign (small badge +
// bar, both in a plain icon-row card) still read as "standard boxes":
// "something more visual than standard boxes. like two big rings, or
// concentric circles, or one circle and one bar graph... think of a fun,
// visually striking way to display this info." Went with "two big rings" --
// reuses FleetRing's own proven radial-tick donut technique (My Fleet's
// compliant/open/overdue visualization, already built and already praised)
// generalized to take arbitrary weighted segments, instead of inventing a
// new shape from scratch: Duel record's ring is a real W/L/T proportional
// donut (the same "color IS the data" idea DuelRecordBar had, just as a
// ring instead of a bar), Mastery's ring is a real filled/unfilled
// proportional donut instead of a solid-border badge with a lerped color.
const RING_DULL = '#3A4552'
// Red Shift: neutral blue-grey isn't red-safe -- same dim warm rust-black
// used for CoinMedal's locked/dim state, so every "low progress" visual in
// the app reads consistently under Red Shift.
const RING_DULL_REDSHIFT = '#4a3530'
const STAT_RING_SIZE = 104
const STAT_RING_TICKS = 28

function StatRing({
  segments, centerValue, centerLabel, tokens, redShift, fs,
}: {
  segments: Array<{ color: string; count: number }>
  centerValue: string
  centerLabel: string
  tokens: ReturnType<typeof useTheme>['tokens']
  redShift: boolean
  fs: (n: number) => number
}) {
  const total = segments.reduce((sum, s) => sum + s.count, 0)
  // Only reached when there's literally nothing to show yet (e.g. 0 duels
  // played) -- real data always supplies its own "remainder" segment color
  // as part of `segments` (see the Mastery ring's own dull-gold-remainder
  // below), so this fallback is StatRing's own concern, not the caller's.
  const dull = redShift ? RING_DULL_REDSHIFT : RING_DULL
  let tickColors: string[] = []
  if (total > 0) {
    segments.forEach((seg) => {
      const n = Math.round((seg.count / total) * STAT_RING_TICKS)
      tickColors.push(...Array(n).fill(seg.color))
    })
    // Rounding each segment independently can land one tick short/long of
    // STAT_RING_TICKS -- pad or trim against the last real segment's color
    // rather than leaving a gap or overflowing the ring.
    const fillColor = segments[segments.length - 1]?.color ?? dull
    while (tickColors.length < STAT_RING_TICKS) tickColors.push(fillColor)
    tickColors = tickColors.slice(0, STAT_RING_TICKS)
  } else {
    tickColors = Array(STAT_RING_TICKS).fill(dull)
  }
  const angleStep = 360 / STAT_RING_TICKS
  return (
    <View style={{ width: STAT_RING_SIZE, height: STAT_RING_SIZE }}>
      {tickColors.map((color, i) => (
        <View
          key={i}
          style={[StyleSheet.absoluteFill, styles.statRingTickWrap, { transform: [{ rotate: `${i * angleStep}deg` }] }]}
        >
          <View style={[styles.statRingTick, { backgroundColor: color }]} />
        </View>
      ))}
      <View style={[StyleSheet.absoluteFill, styles.statRingCenter]}>
        <Text style={[styles.statRingValue, { color: tokens.t1, fontSize: fs(22) }]}>{centerValue}</Text>
        <Text style={[styles.statRingLabel, { color: tokens.t4, fontSize: fs(9) }]}>{centerLabel}</Text>
      </View>
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
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.editTitle, { color: tokens.t1, fontSize: fs(14) }]}>Show my stats</Text>
                    <Text style={[styles.editSub, { color: tokens.t3, fontSize: fs(11.5) }]}>
                      Lets other players see your ratings, coin count, and current aircraft.
                    </Text>
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

            {/* RC, 2nd pass: "something more visual than standard boxes...
                two big rings... a fun, visually striking way to display
                this info." Side by side, both real proportional donuts
                (StatRing, generalized from FleetRing's own radial-tick
                technique) instead of a small badge/bar in an icon-row card.
                Duel record's ring is blue-bordered, Mastery's is gold --
                same distinct-accent-per-card idea the first pass already
                had, just carried onto a bigger shape. Tappable when
                viewing your own profile (into Duels/Study), not on someone
                else's -- there's nothing self-only to navigate to there. */}
            <View style={styles.statRingRow}>
              {duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0) && (
                <Pressable
                  style={[styles.statRingCard, { backgroundColor: tokens.bg2, borderColor: tokens.bbdr }]}
                  onPress={isSelf ? () => router.push('/challenges' as any) : undefined}
                >
                  <StatRing
                    segments={[
                      { color: tokens.grn, count: duelStats.wins },
                      { color: tokens.red, count: duelStats.losses },
                      { color: tokens.t4, count: duelStats.ties },
                    ]}
                    centerValue={String(duelStats.wins + duelStats.losses + duelStats.ties)}
                    centerLabel="DUELS"
                    tokens={tokens}
                    redShift={redShift}
                    fs={fs}
                  />
                  <Text style={[styles.statRingCardTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>Duel record</Text>
                  <Text style={[styles.statRingCardSub, { color: tokens.t3, fontSize: fs(11.5) }]}>
                    {duelStats.wins}W · {duelStats.losses}L{duelStats.ties > 0 ? ` · ${duelStats.ties}T` : ''}
                  </Text>
                </Pressable>
              )}

              {mastery && mastery.mastered > 0 && (
                <Pressable
                  style={[styles.statRingCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
                  onPress={isSelf ? () => router.push('/study' as any) : undefined}
                >
                  <StatRing
                    segments={[
                      { color: tokens.gold, count: mastery.pct },
                      { color: redShift ? RING_DULL_REDSHIFT : RING_DULL, count: 100 - mastery.pct },
                    ]}
                    centerValue={`${mastery.pct}%`}
                    centerLabel="MASTERY"
                    tokens={tokens}
                    redShift={redShift}
                    fs={fs}
                  />
                  <Text style={[styles.statRingCardTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>Overall Mastery</Text>
                  <Text style={[styles.statRingCardSub, { color: tokens.t3, fontSize: fs(11.5) }]}>{mastery.mastered} terms</Text>
                </Pressable>
              )}
            </View>

            {/* RC: "your total Overall Mastery %. plus the nametag. all
                the things to really brag about" -- both cards above stay
                unconditionally public, same as the rest of this "bragging
                page," not gated behind the "Show my stats" toggle the way
                ratings/coins/aircraft are. */}

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
                  <View style={styles.section}>
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

                <View style={styles.section}>
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
  content: { padding: 16, paddingBottom: 40, gap: 18 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 58, height: 58, borderRadius: 29, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { fontWeight: '800' },
  name: { fontWeight: '700' },
  aircraft: { marginTop: 3 },

  editCard: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 12 },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  editTitle: { fontWeight: '600' },
  editSub: { marginTop: 2, lineHeight: 16 },
  aircraftRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  aircraftInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  aircraftSaveBtn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  aircraftSaveBtnText: { color: '#fff', fontWeight: '700' },
  addRatingChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },

  // Two big rings, side by side -- see StatRing's own header comment.
  statRingRow: { flexDirection: 'row', gap: 12 },
  statRingCard: {
    flex: 1, alignItems: 'center', gap: 8,
    borderRadius: 16, borderWidth: 1, paddingVertical: 18, paddingHorizontal: 10,
  },
  statRingCardTitle: { fontWeight: '700', marginTop: 2 },
  statRingCardSub: { fontVariant: ['tabular-nums'], letterSpacing: 0.2 },
  statRingTickWrap: { alignItems: 'center' },
  statRingTick: { width: 5, height: 13, borderRadius: 2.5, marginTop: 3 },
  statRingCenter: { alignItems: 'center', justifyContent: 'center' },
  statRingValue: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  statRingLabel: { letterSpacing: 0.8, marginTop: -2, fontWeight: '600' },

  privateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 16,
  },
  privateText: { flex: 1, lineHeight: 18 },

  section: { gap: 8 },
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
