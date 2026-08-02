import { useState, useEffect, useMemo } from 'react'
import { View, Text, Image, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRefPackets, splitPacketTitle, type RefPacket } from '@/lib/refPackets'
import { getStudyMastery, getCurrency, type StudyMastery, type Currency } from '@/lib/study'
import { getMyCoins, type EarnedCoin } from '@/lib/coins'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getMyRatings, type RatingCode } from '@/lib/profileRatings'
import { getAvatarUrl, resolveAvatarPresetId, getDisplayName } from '@/lib/avatar'
import { getAvatarPreset } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { NameTag } from '@/components/NameTag'

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
  const { session, isPro, hasPlusAccess, avatarOverride } = useAuth()
  // Same resolution chain Account/Drawer use (avatarOverride takes priority
  // so a freshly picked photo/preset shows here in the same tick, no
  // waiting on a session refresh) -- this card previously hardcoded a bare
  // "Y" and "You" regardless of the real avatar/handle, so neither ever
  // updated when either changed.
  const avatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  const cachedAvatarUrl = useCachedImage(session?.user?.id ? `avatar_${session.user.id}` : null, getAvatarUrl(session))
  const avatarUrl = avatarOverride ? avatarOverride.uri : cachedAvatarUrl
  const displayName = getDisplayName(session)
  const [refPackets, setRefPackets] = useState<RefPacket[]>([])
  const [packetCat, setPacketCat] = useState<RefPacket['category'] | 'All'>('All')
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [duelStats, setDuelStats] = useState<DuelStats | null>(null)
  const [ratings, setRatings] = useState<RatingCode[]>([])
  const [coins, setCoins] = useState<EarnedCoin[]>([])

  useEffect(() => {
    getRefPackets().then(setRefPackets)
  }, [])

  // Stats are best-effort — a signed-in Free/Plus user (no Pro/Premium yet)
  // still has a real session and may still have Duel/coin history from a
  // past subscription, so this doesn't gate on tier, only on being signed in.
  useEffect(() => {
    if (!session) {
      setMastery(null); setCurrency(null); setDuelStats(null); setRatings([]); setCoins([])
      return
    }
    getStudyMastery().then(setMastery).catch(() => {})
    getCurrency().then(setCurrency).catch(() => {})
    getMyCoins().then(setCoins).catch(() => {})
    getDuelStats().then(setDuelStats).catch(() => {})
    getMyRatings(session.user.id).then(setRatings).catch(() => {})
  }, [session])

  const hasAnyStats = !!(
    (mastery && mastery.seen > 0) ||
    (currency && currency.currentStreak > 0) ||
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

  // Community is a PAID area end to end (RC, 2026-07-31): Study Mode, Duels,
  // Ready Room, RefPacks and Challenge Coins all live here and none of them
  // are free. Previously the screen rendered for everyone with per-row locks,
  // which advertised a wall of padlocks instead of the feature set.
  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <ScreenHeader title="Community" />
        <TabletContainer>
          <View style={styles.lockedWrap}>
            <Icon name="person.2.fill" size={38} color={tokens.blu} />
            <Text style={[styles.lockedTitle, { color: tokens.t1, fontSize: fs(17) }]}>
              Community is a paid feature
            </Text>
            <Text style={[styles.lockedBody, { color: tokens.t3, fontSize: fs(13.5) }]}>
              Study Mode flashcards, Duels against other pilots, RefPacks for your
              certificate, Challenge Coins and the Ready Room leaderboard all live here.
            </Text>
            <Pressable
              style={[styles.lockedBtn, { backgroundColor: tokens.blu }]}
              onPress={() => router.push('/paywall')}
            >
              <Text style={styles.lockedBtnText}>See what's included</Text>
            </Pressable>
          </View>
        </TabletContainer>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Community" />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          {session ? (
            // A single "who am I and what do I have" identity slate --
            // replaces the old stats strip + separate "View my profile"
            // row + always-expanded visibility/aircraft/ratings editor,
            // which duplicated most of what /profile/[userId] already
            // shows. Editing (visibility toggle, aircraft, ratings) now
            // lives on the profile screen itself, reached by tapping this.
            <Pressable
              style={[styles.identityCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push(`/profile/${session.user.id}` as any)}
            >
              <View style={[styles.identityAvatar, { backgroundColor: avatarPreset?.color ?? tokens.goldlt, borderColor: tokens.goldbdr }]}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.identityAvatarImage} />
                ) : avatarPreset ? (
                  <Icon name={avatarPreset.icon} size={19} color="#fff" />
                ) : (
                  <Text style={[styles.identityAvatarText, { color: tokens.gold, fontSize: fs(18) }]}>
                    {displayName.charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.identityHandle, { color: tokens.t1, fontSize: fs(15.5) }]} numberOfLines={1}>{displayName}</Text>
                {hasAnyStats ? (
                  <IdentityStats
                    tokens={tokens}
                    fs={fs}
                    mastery={mastery}
                    currency={currency}
                    duelStats={duelStats}
                  />
                ) : (
                  <Text style={[styles.identitySub, { color: tokens.t3, fontSize: fs(12) }]}>View your profile</Text>
                )}
                <NameTag ratings={ratings} coins={coins} />
              </View>
              <Icon name="chevron.right" size={14} color={tokens.t4} />
            </Pressable>
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

          {/* Ask FlyRegs (task #114) -- the semantic-search query UI, sitting
              apart from Home's own lexical SmartSearch (see
              smartsearch_architecture memory for why those stay separate).
              Plus-gated same as the rest of this screen -- no extra lock
              overlay needed here since hasPlusAccess is already required
              just to see this screen at all (unlike Study/Duels below,
              which need the higher isPro tier specifically). */}
          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SEARCH</Text>
          <Pressable
            style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
            onPress={() => router.push('/semantic-search')}
          >
            <View style={[styles.hubIconWrap, { backgroundColor: tokens.gdim }]}>
              <Icon name="text.bubble.fill" size={19} color={tokens.grn} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Ask FlyRegs</Text>
              <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                Ask a real question in plain English — get the passages that actually answer it
              </Text>
            </View>
          </Pressable>

          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 18 }]}>STUDY &amp; PRACTICE</Text>
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

// ─── Identity stats (compact, inline in the identity card) ──────────────────

function IdentityStats({
  tokens,
  fs,
  mastery,
  currency,
  duelStats,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  mastery: StudyMastery | null
  currency: Currency | null
  duelStats: DuelStats | null
}) {
  // Coin count used to also show here as a plain "N coins" text chip,
  // duplicating the tier-broken-out tally NameTag already renders one row
  // below -- confirmed confusing live ("coins earned should be on the row
  // below"). NameTag is now the single place coins show on this card.
  const chips = useMemo(() => {
    const out: { icon: string; value: string; color: string }[] = []
    if (mastery && mastery.seen > 0) {
      out.push({ icon: 'star.fill', value: `${mastery.pct}% mastered`, color: tokens.blu })
    }
    if (currency && currency.currentStreak > 0) {
      out.push({ icon: 'flame.fill', value: `${currency.currentStreak}d streak`, color: tokens.amb })
    }
    if (duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0)) {
      out.push({ icon: 'bolt.fill', value: `${duelStats.wins}-${duelStats.losses}`, color: tokens.grn })
    }
    return out
  }, [mastery, currency, duelStats, tokens])

  return (
    <View style={styles.identityStatsRow}>
      {chips.map((c, i) => (
        <View key={i} style={styles.identityStatChip}>
          <Icon name={c.icon} size={11} color={c.color} />
          <Text style={[styles.identityStatText, { color: tokens.t3, fontSize: fs(11.5) }]}>{c.value}</Text>
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

  // Multi-section source PDFs (sync/pts_multisection_scraper.py) previously
  // showed as N separate, nearly-identical cards ("Sport Pilot... —
  // Section 1/2/3") -- confirmed live as genuinely hard to tell apart even
  // with the suffix badge. Grouped into one card per source document here;
  // the in-pack Section picker (ref-packets/[code].tsx) is where a specific
  // section actually gets chosen, matching how a pilot thinks about it
  // ("the Sport Pilot ACS", not three unrelated things).
  const groups = useMemo(() => {
    const byTitle = new Map<string, RefPacket[]>()
    for (const p of filtered) {
      const { mainTitle } = splitPacketTitle(p.title)
      const list = byTitle.get(mainTitle) ?? []
      list.push(p)
      byTitle.set(mainTitle, list)
    }
    return Array.from(byTitle.entries()).map(([mainTitle, members]) => ({
      mainTitle,
      members: members.sort((a, b) => a.code.localeCompare(b.code)),
    }))
  }, [filtered])

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
        {groups.map(({ mainTitle, members }) => {
          const primary = members[0]
          const multi = members.length > 1
          const totalAreas = members.reduce((sum, m) => sum + m.areaCount, 0)
          const totalTasks = members.reduce((sum, m) => sum + m.taskCount, 0)
          return (
            <Pressable
              key={mainTitle}
              style={[styles.packetCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
              onPress={() => openPacket(primary)}
            >
              <Icon name="rosette" size={18} color={tokens.gold} />
              {multi && (
                <View style={[styles.packetSuffixBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                  <Text style={[styles.packetSuffixText, { color: tokens.gold, fontSize: fs(10) }]} numberOfLines={1}>
                    {members.length} sections
                  </Text>
                </View>
              )}
              <Text style={[styles.packetTitle, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={3}>
                {mainTitle}
              </Text>
              <Text style={[styles.packetMeta, { color: tokens.t4, fontSize: fs(10.5) }]}>
                {totalAreas} areas · {totalTasks} tasks
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
  lockedWrap: { alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10, paddingTop: 80 },
  lockedTitle: { fontWeight: '700', marginTop: 6 },
  lockedBody: { textAlign: 'center', lineHeight: 20, maxWidth: 330 },
  lockedBtn: { borderRadius: 22, paddingHorizontal: 24, paddingVertical: 12, marginTop: 12 },
  lockedBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
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

  identityCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 18,
  },
  identityAvatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  identityAvatarImage: { width: '100%', height: '100%' },
  identityAvatarText: { fontWeight: '800' },
  identityHandle: { fontWeight: '700' },
  identitySub: { marginTop: 2 },
  identityStatsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  identityStatChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  identityStatText: { fontWeight: '600' },

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
