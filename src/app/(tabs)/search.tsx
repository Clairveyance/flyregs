import { useState, useEffect, useMemo } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, Switch, ActivityIndicator, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRefPackets, type RefPacket } from '@/lib/refPackets'
import { getStudyMastery, getCurrency, type StudyMastery, type Currency } from '@/lib/study'
import { getMyCoins } from '@/lib/coins'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getMyRatings, RATING_SHORT_LABELS, type RatingCode } from '@/lib/profileRatings'
import { getStatsVisible, setStatsVisible, getCurrentAircraft, setCurrentAircraft } from '@/lib/leaderboard'

// IA redesign (2026-07-28): this file used to be the Search tab. Search now
// lives entirely on Home (see (tabs)/index.tsx's inline search bar +
// results dropdown) — there is no more standalone search screen to hand off
// to, which freed this tab up to become the app's study/social/game hub
// instead: a lifetime-stats summary, Study Mode, Duels, and Ref Packets
// (moved here unchanged from the old BrowseView). Reachable by every tier
// (so Free/Plus users can see what they're missing, not just a locked
// blank screen) — each section shows its own lock indicator and gates on
// tap, matching the exact pattern Ref Packets already used before this
// redesign. See flyregs_decisions.md / project_flyregs_state.md for the
// full IA-redesign writeup.

export default function CommunityScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, hasPlusAccess } = useAuth()
  const [refPackets, setRefPackets] = useState<RefPacket[]>([])
  const [packetCat, setPacketCat] = useState<RefPacket['category'] | 'All'>('All')
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [coinCount, setCoinCount] = useState<number | null>(null)
  const [duelStats, setDuelStats] = useState<DuelStats | null>(null)
  const [myRatings, setMyRatings] = useState<RatingCode[]>([])
  const [statsVisible, setStatsVisibleState] = useState(false)
  const [statsVisibleBusy, setStatsVisibleBusy] = useState(false)
  const [aircraftInput, setAircraftInput] = useState('')
  const [aircraftDirty, setAircraftDirty] = useState(false)
  const [aircraftSaving, setAircraftSaving] = useState(false)

  useEffect(() => {
    getRefPackets().then(setRefPackets)
  }, [])

  // Stats are best-effort — a signed-in Free/Plus user (no Pro/Premium yet)
  // still has a real session and may still have Duel/coin history from a
  // past subscription, so this doesn't gate on tier, only on being signed in.
  useEffect(() => {
    if (!session) {
      setMastery(null); setCurrency(null); setCoinCount(null); setDuelStats(null)
      setMyRatings([]); setStatsVisibleState(false); setAircraftInput(''); setAircraftDirty(false)
      return
    }
    getStudyMastery().then(setMastery).catch(() => {})
    getCurrency().then(setCurrency).catch(() => {})
    getMyCoins().then((c) => setCoinCount(c.length)).catch(() => {})
    getDuelStats().then(setDuelStats).catch(() => {})
    getMyRatings(session.user.id).then(setMyRatings).catch(() => {})
    getStatsVisible(session.user.id).then(setStatsVisibleState).catch(() => {})
    getCurrentAircraft(session.user.id).then((a) => { setAircraftInput(a); setAircraftDirty(false) }).catch(() => {})
  }, [session])

  const handleToggleStatsVisible = async (v: boolean) => {
    if (!session) return
    setStatsVisibleBusy(true)
    try {
      await setStatsVisible(session.user.id, v)
      setStatsVisibleState(v)
    } catch (_) {}
    setStatsVisibleBusy(false)
  }

  const handleSaveAircraft = async () => {
    if (!session || aircraftSaving) return
    setAircraftSaving(true)
    try {
      await setCurrentAircraft(session.user.id, aircraftInput)
      setAircraftDirty(false)
    } catch (_) {}
    setAircraftSaving(false)
  }

  const hasAnyStats = !!(
    (mastery && mastery.seen > 0) ||
    (currency && currency.currentStreak > 0) ||
    (coinCount && coinCount > 0) ||
    (duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0))
  )

  const openStudy = () => {
    if (!isPro) { router.push('/paywall'); return }
    router.push('/study')
  }

  const openDuels = () => {
    if (!isPro) { router.push('/paywall'); return }
    router.push('/ready-room')
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Community" />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          {session ? (
            <>
              {hasAnyStats && (
                <StatsStrip
                  tokens={tokens}
                  fs={fs}
                  mastery={mastery}
                  currency={currency}
                  coinCount={coinCount}
                  duelStats={duelStats}
                />
              )}
              <Pressable
                style={[styles.profileLinkRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/profile/${session.user.id}` as any)}
              >
                <Icon name="person.crop.circle" size={18} color={tokens.blu} />
                <Text style={[styles.profileLinkText, { color: tokens.t1, fontSize: fs(13.5) }]}>View my profile</Text>
                <Icon name="chevron.right" size={13} color={tokens.t4} />
              </Pressable>
              <View style={[styles.visibilityCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <View style={styles.visibilityRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Show my stats</Text>
                    <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12), marginTop: 2 }]}>
                      Lets other users see your ratings, coin count, and current aircraft. Off by default.
                    </Text>
                  </View>
                  {statsVisibleBusy ? (
                    <ActivityIndicator size="small" color={tokens.t3} />
                  ) : (
                    <Switch value={statsVisible} onValueChange={handleToggleStatsVisible} trackColor={{ true: tokens.blu, false: undefined }} />
                  )}
                </View>
                {statsVisible && (
                  <>
                    <View style={styles.aircraftRow}>
                      <TextInput
                        style={[styles.aircraftInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg, fontSize: fs(14) }]}
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
                          <Text style={[styles.aircraftSaveBtnText, { fontSize: fs(13) }]}>Save</Text>
                        </Pressable>
                      )}
                    </View>
                    <View style={styles.previewRatings}>
                      {myRatings.map((code) => (
                        <View key={code} style={[styles.previewChip, { borderColor: tokens.gold, backgroundColor: tokens.goldlt }]}>
                          <Text style={[styles.previewChipText, { color: tokens.gold, fontSize: fs(11.5) }]}>{RATING_SHORT_LABELS[code]}</Text>
                        </View>
                      ))}
                      {/* Ratings are only ever added/removed via the picker on
                          Account -- this row previously had no way to get
                          there at all when myRatings was empty, and no way
                          to add MORE ratings even when it wasn't. */}
                      <Pressable
                        style={[styles.previewChip, styles.previewAddChip, { borderColor: tokens.bdr }]}
                        onPress={() => router.push('/account')}
                      >
                        <Icon name="plus" size={11} color={tokens.t2} />
                        <Text style={[styles.previewChipText, { color: tokens.t2, fontSize: fs(11.5) }]}>Add Rating</Text>
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            </>
          ) : (
            <Pressable
              style={[styles.signInCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push('/auth')}
            >
              <Icon name="person.crop.circle" size={22} color={tokens.blu} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.signInTitle, { color: tokens.t1, fontSize: fs(14) }]}>
                  Sign in to track your progress
                </Text>
                <Text style={[styles.signInSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  Study mastery, your Duel record, and Challenge Coins all live on your account.
                </Text>
              </View>
              <Icon name="chevron.right" size={14} color={tokens.t4} />
            </Pressable>
          )}

          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>STUDY &amp; PRACTICE</Text>
          <Pressable
            style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
            onPress={openStudy}
          >
            <View style={[styles.hubIconWrap, { backgroundColor: tokens.bdim }]}>
              <Icon name="rectangle.stack" size={19} color={tokens.blu} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Study Mode</Text>
              <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                {mastery && mastery.seen > 0
                  ? `${mastery.mastered} of ${mastery.total_available} items mastered`
                  : 'Spaced-repetition flashcards across FAR, AIM, P/CG, and ACs'}
              </Text>
            </View>
            {!isPro && <Icon name="lock.fill" size={13} color={tokens.t4} />}
          </Pressable>

          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 18 }]}>DUELS</Text>
          <Pressable
            style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
            onPress={openDuels}
          >
            <View style={[styles.hubIconWrap, { backgroundColor: tokens.goldlt }]}>
              <Icon name="bolt.fill" size={19} color={tokens.gold} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Challenge a friend</Text>
              <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                {duelStats && (duelStats.wins > 0 || duelStats.losses > 0)
                  ? `${duelStats.wins}W · ${duelStats.losses}L${duelStats.ties ? ` · ${duelStats.ties}T` : ''} — head-to-head across FAR, AIM, P/CG, AC`
                  : 'Multiple-choice quiz across FAR, AIM, P/CG, AC — most correct wins, time breaks ties'}
              </Text>
            </View>
            {!isPro && <Icon name="lock.fill" size={13} color={tokens.t4} />}
          </Pressable>

          {refPackets.length > 0 && (
            <RefPacketGrid
              refPackets={refPackets}
              tokens={tokens}
              hasPlusAccess={hasPlusAccess}
              category={packetCat}
              onSelectCategory={setPacketCat}
            />
          )}
        </ScrollView>
      </TabletContainer>
    </View>
  )
}

// ─── Stats strip ─────────────────────────────────────────────────────────────

function StatsStrip({
  tokens,
  fs,
  mastery,
  currency,
  coinCount,
  duelStats,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  mastery: StudyMastery | null
  currency: Currency | null
  coinCount: number | null
  duelStats: DuelStats | null
}) {
  const chips = useMemo(() => {
    const out: { icon: string; value: string; label: string; color: string }[] = []
    if (mastery && mastery.seen > 0) {
      out.push({ icon: 'star.fill', value: `${mastery.pct}%`, label: 'mastered', color: tokens.blu })
    }
    if (currency && currency.currentStreak > 0) {
      out.push({ icon: 'flame.fill', value: `${currency.currentStreak}d`, label: currency.isCurrent ? 'current' : 'lapsed', color: tokens.amb })
    }
    if (coinCount) {
      out.push({ icon: 'rosette', value: `${coinCount}`, label: coinCount === 1 ? 'coin' : 'coins', color: tokens.gold })
    }
    if (duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0)) {
      out.push({ icon: 'bolt.fill', value: `${duelStats.wins}-${duelStats.losses}`, label: 'Duel record', color: tokens.grn })
    }
    return out
  }, [mastery, currency, coinCount, duelStats, tokens])

  if (chips.length === 0) return null

  return (
    <View style={[styles.statsStrip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      {chips.map((c, i) => (
        <View key={i} style={[styles.statChip, i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: tokens.bdr }]}>
          <Icon name={c.icon} size={15} color={c.color} />
          <Text style={[styles.statValue, { color: tokens.t1, fontSize: fs(15) }]}>{c.value}</Text>
          <Text style={[styles.statLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>{c.label}</Text>
        </View>
      ))}
    </View>
  )
}

// ─── Ref Packet grid ─────────────────────────────────────────────────────────
// Certificate/rating study-and-reference guides built from the FAA's own
// ACS/PTS structure — moved here unchanged from the old Search tab's
// BrowseView as part of the 2026-07-28 IA redesign (this tab's whole reason
// for being repurposed was to house exactly this kind of content).

const PACKET_CATS: (RefPacket['category'] | 'All')[] = ['All', 'Airplane', 'Rotorcraft', 'Powered-Lift']

function RefPacketGrid({
  refPackets,
  tokens,
  hasPlusAccess,
  category,
  onSelectCategory,
}: {
  refPackets: RefPacket[]
  tokens: ReturnType<typeof useTheme>['tokens']
  hasPlusAccess: boolean
  category: RefPacket['category'] | 'All'
  onSelectCategory: (c: RefPacket['category'] | 'All') => void
}) {
  const fs = useFS()
  const filtered = category === 'All' ? refPackets : refPackets.filter((p) => p.category === category)

  const openPacket = (p: RefPacket) => {
    if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
    router.push(`/ref-packets/${p.code}` as any)
  }

  return (
    <View style={{ marginTop: 18 }}>
      <View style={styles.packetHeaderRow}>
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginBottom: 0 }]}>
          {/* "RefPacks", not "Ref Packets" -- the branded, single-word form
              (matching "MagicLink"'s own naming convention), with the same
              first-letter-of-each-word-pops treatment MagicLink's wordmark
              uses, so this reads as an equally intentional brand element
              rather than a generic section label. */}
          {'REFPACKS'.split('').map((ch, i) => (
            <Text key={i} style={{ fontSize: fs(i === 0 || i === 3 ? 13 : 11) }}>{ch}</Text>
          ))}
        </Text>
        {!hasPlusAccess && <Icon name="lock.fill" size={11} color={tokens.t4} />}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.packetCatRow}>
        {PACKET_CATS.map((c) => {
          const active = category === c
          return (
            <Pressable
              key={c}
              style={[
                styles.packetCatChip,
                { backgroundColor: active ? tokens.gold : tokens.bg2, borderColor: active ? tokens.gold : tokens.bdr },
              ]}
              onPress={() => onSelectCategory(c)}
            >
              <Text style={[styles.packetCatText, { color: active ? '#000' : tokens.t2, fontSize: fs(12.5) }]}>{c}</Text>
            </Pressable>
          )
        })}
      </ScrollView>
      <View style={styles.packetGrid}>
        {filtered.map((p) => {
          // Multi-category source PDFs (Recreational Pilot Airplane+
          // Rotorcraft, Sport Pilot Airplane+Gyroplane+Glider, etc.) split
          // into one pack per category, title suffixed " — <category>" --
          // but 3 packs from the SAME PDF sharing everything up to that
          // suffix, truncated to 3 lines in a narrow grid card, were
          // genuinely indistinguishable (confirmed live: three "Sport Pilot
          // and Sport Pilot Flight..." cards with no visible difference).
          // The suffix is the one thing that actually tells them apart, so
          // it renders separately and is never truncated, instead of being
          // buried at the end of a clipped title.
          const base = p.title.replace(/ ACS$/, '')
          const dashIdx = base.lastIndexOf(' — ')
          const mainTitle = dashIdx > -1 ? base.slice(0, dashIdx) : base
          const suffix = dashIdx > -1 ? base.slice(dashIdx + 3) : null
          return (
            <Pressable
              key={p.code}
              style={[styles.packetCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
              onPress={() => openPacket(p)}
            >
              <Icon name="rosette" size={18} color={tokens.gold} />
              {suffix && (
                <View style={[styles.packetSuffixBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                  <Text style={[styles.packetSuffixText, { color: tokens.gold, fontSize: fs(10) }]} numberOfLines={1}>
                    {suffix}
                  </Text>
                </View>
              )}
              <Text style={[styles.packetTitle, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={3}>
                {mainTitle}
              </Text>
              <Text style={[styles.packetMeta, { color: tokens.t4, fontSize: fs(10.5) }]}>
                {p.areaCount} areas · {p.taskCount} tasks
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, paddingBottom: 40 },

  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingLeft: 2,
  },

  signInCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 18,
  },
  signInTitle: { fontWeight: '600' },
  signInSub: { marginTop: 2, lineHeight: 17 },

  statsStrip: {
    flexDirection: 'row',
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 18,
    paddingVertical: 12,
  },
  statChip: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontWeight: '700', marginTop: 2 },
  statLabel: { fontWeight: '500', letterSpacing: 0.2 },

  hubCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14,
  },
  hubIconWrap: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  hubTitle: { fontWeight: '600' },
  hubSub: { marginTop: 2, lineHeight: 17 },

  profileLinkRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 12,
  },
  profileLinkText: { flex: 1, fontWeight: '600' },

  visibilityCard: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 18 },
  visibilityRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  aircraftRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  aircraftInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  aircraftSaveBtn: { borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  aircraftSaveBtnText: { color: '#fff', fontWeight: '700' },
  previewRatings: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  previewChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  previewAddChip: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  previewChipText: { fontWeight: '600' },

  // Ref Packet grid
  packetHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, paddingLeft: 2 },
  packetCatRow: { marginBottom: 10 },
  packetCatChip: {
    borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
  },
  packetCatText: { fontWeight: '600' },
  packetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  packetCard: {
    width: '31%', borderRadius: 14, borderWidth: 1, padding: 10, gap: 6, minHeight: 92,
  },
  packetTitle: { fontWeight: '600', lineHeight: 16 },
  packetMeta: { marginTop: 'auto' },
  packetSuffixBadge: {
    alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2,
  },
  packetSuffixText: { fontWeight: '700' },
})
