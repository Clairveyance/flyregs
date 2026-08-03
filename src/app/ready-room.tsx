import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import {
  getReadyRoomLeaderboard, getDuelsLeaderboard, getMasteryLeaderboard,
  LeaderboardRow, DuelsLeaderboardRow, MasteryLeaderboardRow,
} from '@/lib/leaderboard'

type LbTab = 'study' | 'duels' | 'mastery'

// Named and styled like a squadron roster, not a generic "Leaderboard" --
// three global rankings now (RC: "can the RR have a 'global' leaderboard?
// duels ranking, and probably your total Overall Mastery %. plus the
// nametag. all the things to really brag about"), all sharing the same
// opt-in gate (account.tsx's Community toggle -- off by default) and the
// same tap-through to the real nametag (profile/[userId].tsx). Only opted-
// in users with real activity in that specific dimension appear on each
// tab -- a user who's dueled but never studied only shows up on the Duels
// tab, not Study Activity, same "having done something" gate each RPC
// already applies server-side.
export default function ReadyRoomScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro } = useAuth()
  const [tab, setTab] = useState<LbTab>('study')
  const [loading, setLoading] = useState(true)
  const [studyRows, setStudyRows] = useState<LeaderboardRow[]>([])
  const [duelsRows, setDuelsRows] = useState<DuelsLeaderboardRow[]>([])
  const [masteryRows, setMasteryRows] = useState<MasteryLeaderboardRow[]>([])

  const load = useCallback((t: LbTab) => {
    setLoading(true)
    const fetcher = t === 'study' ? getReadyRoomLeaderboard(50)
      : t === 'duels' ? getDuelsLeaderboard(50)
      : getMasteryLeaderboard(50)
    fetcher
      .then((rows: any) => {
        if (t === 'study') setStudyRows(rows)
        else if (t === 'duels') setDuelsRows(rows)
        else setMasteryRows(rows)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (isPro) load(tab)
  }, [isPro, tab, load])

  if (!isPro) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Ready Room" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Ready Room is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            See how your weekly practice stacks up against other players training toward the same ratings and certifications.
          </Text>
        </View>
      </View>
    )
  }

  const headerRight = (
    <Pressable onPress={() => router.push('/challenges' as any)} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="bolt.fill" size={fs(20)} color={tokens.gold} />
    </Pressable>
  )

  const openProfile = (userId: string, displayLabel: string) =>
    router.push(`/profile/${userId}?label=${encodeURIComponent(displayLabel)}` as any)

  const emptyCopy: Record<LbTab, { icon: string; title: string; sub: string }> = {
    study: {
      icon: 'person.2.fill', title: 'Nobody here yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > Community, then study this week to be the first name on the board.',
    },
    duels: {
      icon: 'bolt.fill', title: 'No duels yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > Community, then challenge another player to be the first name on the board.',
    },
    mastery: {
      icon: 'rectangle.stack', title: 'No mastered terms yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > Community, then study to be the first name on the board.',
    },
  }
  const empty = emptyCopy[tab]
  const rowCount = tab === 'study' ? studyRows.length : tab === 'duels' ? duelsRows.length : masteryRows.length

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Ready Room" onBack={() => router.back()} right={headerRight} />
      <View style={[styles.tabPicker, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
        {(['study', 'duels', 'mastery'] as LbTab[]).map((t) => (
          <Pressable
            key={t}
            style={[styles.tabBtn, tab === t && { backgroundColor: tokens.blu }]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabBtnText, { color: tab === t ? '#fff' : tokens.t3, fontSize: fs(13) }]}>
              {t === 'study' ? 'Study Activity' : t === 'duels' ? 'Duels' : 'Mastery'}
            </Text>
          </Pressable>
        ))}
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : rowCount === 0 ? (
        <View style={styles.center}>
          <Icon name={empty.icon} size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>{empty.title}</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>{empty.sub}</Text>
        </View>
      ) : (
        <TabletContainer>
        {tab === 'study' ? (
          <FlatList
            data={studyRows}
            keyExtractor={(r, i) => `${r.displayLabel}-${i}`}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={false} onRefresh={() => load('study')} tintColor={tokens.t3} />}
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>THIS WEEK · REVIEWS</Text>
            }
            renderItem={({ item, index }) => (
              <Pressable
                style={[styles.row, { backgroundColor: item.isMe ? tokens.goldlt : tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => openProfile(item.userId, item.displayLabel)}
              >
                <Text style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <Text style={[styles.name, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                  {item.isMe ? 'You' : item.displayLabel}
                </Text>
                {item.currentStreak > 0 && <Icon name="bolt.fill" size={fs(12)} color={tokens.gold} />}
                <Text style={[styles.score, { color: tokens.t3, fontSize: fs(12.5) }]}>{item.weeklyReviews}</Text>
              </Pressable>
            )}
          />
        ) : tab === 'duels' ? (
          <FlatList
            data={duelsRows}
            keyExtractor={(r, i) => `${r.displayLabel}-${i}`}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={false} onRefresh={() => load('duels')} tintColor={tokens.t3} />}
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>ALL-TIME · WINS</Text>
            }
            renderItem={({ item, index }) => (
              <Pressable
                style={[styles.row, { backgroundColor: item.isMe ? tokens.goldlt : tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => openProfile(item.userId, item.displayLabel)}
              >
                <Text style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <Text style={[styles.name, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                  {item.isMe ? 'You' : item.displayLabel}
                </Text>
                <Text style={[styles.score, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  {item.wins}W · {item.losses}L{item.ties > 0 ? ` · ${item.ties}T` : ''}
                </Text>
              </Pressable>
            )}
          />
        ) : (
          <FlatList
            data={masteryRows}
            keyExtractor={(r, i) => `${r.displayLabel}-${i}`}
            contentContainerStyle={styles.list}
            refreshControl={<RefreshControl refreshing={false} onRefresh={() => load('mastery')} tintColor={tokens.t3} />}
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>OVERALL MASTERY</Text>
            }
            renderItem={({ item, index }) => (
              <Pressable
                style={[styles.row, { backgroundColor: item.isMe ? tokens.goldlt : tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => openProfile(item.userId, item.displayLabel)}
              >
                <Text style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <Text style={[styles.name, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                  {item.isMe ? 'You' : item.displayLabel}
                </Text>
                <Text style={[styles.score, { color: tokens.t3, fontSize: fs(12.5) }]}>{item.pct}%</Text>
              </Pressable>
            )}
          />
        )}
        </TabletContainer>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 280 },
  tabPicker: {
    flexDirection: 'row', borderRadius: 10, borderWidth: 1, padding: 3, gap: 2,
    marginHorizontal: 12, marginTop: 10,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  tabBtnText: { fontWeight: '700' },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 10, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 6,
  },
  rank: { fontWeight: '700', width: 22, fontVariant: ['tabular-nums'] },
  name: { flex: 1, fontWeight: '500' },
  score: { fontWeight: '600', fontVariant: ['tabular-nums'] },
})
