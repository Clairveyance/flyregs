import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getReadyRoomLeaderboard, LeaderboardRow } from '@/lib/leaderboard'

// Named and styled like a squadron roster, not a generic "Leaderboard" --
// rank and weekly activity only, no avatars/points-shop chrome. Ranked by
// weekly review volume (practice shows up, not luck), only opted-in users
// appear at all (see account.tsx's Community toggle -- off by default).
export default function ReadyRoomScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro } = useAuth()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<LeaderboardRow[]>([])

  const load = useCallback(() => {
    setLoading(true)
    getReadyRoomLeaderboard(50)
      .then(setRows)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (isPro) load()
  }, [isPro, load])

  if (!isPro) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Ready Room" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={36} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Ready Room is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            See how your weekly practice stacks up against other pilots training toward the same ratings.
          </Text>
        </View>
      </View>
    )
  }

  const headerRight = (
    <Pressable onPress={() => router.push('/challenges' as any)} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="bolt.fill" size={20} color={tokens.gold} />
    </Pressable>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Ready Room" onBack={() => router.back()} right={headerRight} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : rows.length === 0 ? (
        <View style={styles.center}>
          <Icon name="person.2.fill" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Nobody here yet</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Turn on "Show me on the Ready Room leaderboard" in Account &gt; Community, then study this week to be
            the first name on the board.
          </Text>
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          data={rows}
          keyExtractor={(r, i) => `${r.displayLabel}-${i}`}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
          ListHeaderComponent={
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>THIS WEEK · REVIEWS</Text>
          }
          renderItem={({ item, index }) => (
            <Pressable
              style={[
                styles.row,
                { backgroundColor: item.isMe ? tokens.goldlt : tokens.bg2, borderColor: tokens.bdr },
              ]}
              onPress={() => router.push(`/profile/${item.userId}?label=${encodeURIComponent(item.displayLabel)}` as any)}
            >
              <Text style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                {String(index + 1).padStart(2, '0')}
              </Text>
              <Text style={[styles.name, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                {item.isMe ? 'You' : item.displayLabel}
              </Text>
              {item.currentStreak > 0 && (
                <Icon name="bolt.fill" size={12} color={tokens.gold} />
              )}
              <Text style={[styles.score, { color: tokens.t3, fontSize: fs(12.5) }]}>{item.weeklyReviews}</Text>
            </Pressable>
          )}
        />
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
