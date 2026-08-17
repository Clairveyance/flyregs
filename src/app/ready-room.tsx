import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { FindFriendsSheet } from '@/components/FindFriendsSheet'
import { resolveCallsignToUserId } from '@/lib/contactMatch'
import { useConfirm } from '@/components/ConfirmDialog'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'
import { AvatarCircle } from '@/components/AvatarCircle'
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
  // hasProAccess (isPro || isPremium), not bare isPro -- same bug pattern
  // found and fixed in study.tsx and search.tsx's openStudy (2026-08-14): a
  // genuine Premium subscriber shaped isPro:false/isPremium:true (a real
  // shape for admin/comp-granted entitlements) would be locked out of Ready
  // Room entirely even though it's a Pro-tier-and-above feature they're
  // fully entitled to. isPremium itself stays bare below (the Duels button)
  // since Duels really is Premium-only, not Pro-and-above.
  const { isPremium, hasProAccess } = useAuth()
  const confirm = useConfirm()
  const [tab, setTab] = useState<LbTab>('study')
  const [loading, setLoading] = useState(true)
  const [studyRows, setStudyRows] = useState<LeaderboardRow[]>([])
  const [duelsRows, setDuelsRows] = useState<DuelsLeaderboardRow[]>([])
  const [masteryRows, setMasteryRows] = useState<MasteryLeaderboardRow[]>([])
  const [findFriendsVisible, setFindFriendsVisible] = useState(false)
  // A leaderboard row's display name can run long and get cut off the same
  // way FAR Part titles do -- same hook/card pair as far/index.tsx's own
  // long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  // A matched contact is real (their account exists) but may not be
  // opted into the leaderboard this screen otherwise only shows --
  // resolve straight to their profile rather than silently requiring
  // them to also be leaderboard-visible just to be found this way.
  const handleFriendSelected = async (callsign: string) => {
    try {
      const userId = await resolveCallsignToUserId(callsign)
      if (!userId) {
        confirm({ title: 'Not Found', message: `${callsign} couldn't be found right now.`, cancelLabel: null })
        return
      }
      router.push(`/profile/${userId}?label=${encodeURIComponent(callsign)}` as any)
    } catch (e: any) {
      confirm({ title: 'Something Went Wrong', message: e?.message ?? 'Please try again.', cancelLabel: null })
    }
  }

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
    if (hasProAccess) load(tab)
  }, [hasProAccess, tab, load])

  if (!hasProAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Ready Room" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Ready Room is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            See how your weekly practice stacks up against other players training toward the same ratings and certifications.
          </Text>
          {/* Same gap already found and fixed once for Duels' own lock
              screen (challenges/index.tsx, BB-era sweep): "no CTA at all --
              a free user who found [the feature] hit a dead end with no way
              to unlock it." Ready Room's Pro-lock screen had the identical
              gap -- Study Mode and Duels both have an Unlock button here,
              Ready Room didn't. */}
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Pro</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // Duels itself is Premium (this screen is only Pro) -- /challenges
  // already enforces that on load, but this button had no lock at all, so
  // a Pro user got a surprise paywall one tap after arriving here with no
  // upfront signal. Same fix as the Community hub card's own Duels entry.
  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Pressable onPress={() => setFindFriendsVisible(true)} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="person.2" size={fs(20)} color={tokens.blu} />
      </Pressable>
      <Pressable
        onPress={() => router.push(isPremium ? '/challenges' : ('/paywall?tier=premium' as any))}
        hitSlop={12}
        style={{ padding: 4 }}
      >
        {isPremium ? (
          <Icon name="trophy" size={fs(20)} color={tokens.gold} />
        ) : (
          <Icon name="lock.fill" size={fs(18)} color={tokens.t4} />
        )}
      </Pressable>
    </View>
  )

  const openProfile = (userId: string, displayLabel: string) =>
    router.push(`/profile/${userId}?label=${encodeURIComponent(displayLabel)}` as any)

  const emptyCopy: Record<LbTab, { icon: string; title: string; sub: string }> = {
    study: {
      icon: 'person.2.fill', title: 'Nobody here yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > The Wing, then study this week to be the first name on the board.',
    },
    duels: {
      icon: 'trophy', title: 'No duels yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > The Wing, then challenge another player to be the first name on the board.',
    },
    mastery: {
      icon: 'rectangle.stack', title: 'No mastered terms yet',
      sub: 'Turn on "Show me on the Ready Room leaderboard" in Account > The Wing, then study to be the first name on the board.',
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
            style={[
              styles.tabBtn,
              // RC: "the chips don't have to be the exact same width" --
              // "Study Activity" is by far the longest label of the 3, so an
              // equal three-way flex split was cramping it while Duels and
              // Mastery sat with slack space. Weighted by roughly how much
              // text each label actually carries instead.
              { flex: t === 'study' ? 1.5 : t === 'mastery' ? 0.9 : 0.75 },
              tab === t && { backgroundColor: tokens.blu },
            ]}
            onPress={() => setTab(t)}
          >
            <Text
              style={[styles.tabBtnText, { color: tab === t ? '#fff' : tokens.t3, fontSize: fs(13) }]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
            >
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
                onPress={() => {
                  if (consumeLongPress()) return
                  openProfile(item.userId, item.displayLabel)
                }}
                onLongPress={(e) => showPreview(item.isMe ? 'You' : item.displayLabel, e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Text numberOfLines={1} style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <AvatarCircle imageUri={item.avatarUrl} presetId={item.avatarPreset} fallbackLabel={item.displayLabel} size={fs(26)} />
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
                onPress={() => {
                  if (consumeLongPress()) return
                  openProfile(item.userId, item.displayLabel)
                }}
                onLongPress={(e) => showPreview(item.isMe ? 'You' : item.displayLabel, e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Text numberOfLines={1} style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <AvatarCircle imageUri={item.avatarUrl} presetId={item.avatarPreset} fallbackLabel={item.displayLabel} size={fs(26)} />
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
                onPress={() => {
                  if (consumeLongPress()) return
                  openProfile(item.userId, item.displayLabel)
                }}
                onLongPress={(e) => showPreview(item.isMe ? 'You' : item.displayLabel, e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Text numberOfLines={1} style={[styles.rank, { color: item.isMe ? tokens.gold : tokens.t4, fontSize: fs(11.5) }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
                <AvatarCircle imageUri={item.avatarUrl} presetId={item.avatarPreset} fallbackLabel={item.displayLabel} size={fs(26)} />
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
      <FindFriendsSheet
        visible={findFriendsVisible}
        onClose={() => setFindFriendsVisible(false)}
        onSelect={handleFriendSelected}
      />
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 280 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },
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
  rank: { fontWeight: '700', minWidth: 22, fontVariant: ['tabular-nums'] },
  name: { flex: 1, fontWeight: '500' },
  score: { fontWeight: '600', fontVariant: ['tabular-nums'] },
})
