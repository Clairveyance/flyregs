import { useState, useCallback, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  SectionList,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { getRecents, removeRecent, removeManyRecents, clearRecents, type RecentAC } from '@/lib/recents'
import { getBookmarks, toggleBookmark } from '@/lib/bookmarks'
import { addManyToFolder } from '@/lib/folders'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions } from '@/lib/share'

interface Group {
  title: string
  data: RecentAC[]
}

function groupByTime(recents: RecentAC[]): Group[] {
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)

  const today: RecentAC[] = []
  const week: RecentAC[] = []
  const earlier: RecentAC[] = []

  for (const r of recents) {
    const d = new Date(r.viewedAt)
    if (d >= todayStart) today.push(r)
    else if (d >= weekStart) week.push(r)
    else earlier.push(r)
  }

  const groups: Group[] = []
  if (today.length) groups.push({ title: 'Today', data: today })
  if (week.length) groups.push({ title: 'This Week', data: week })
  if (earlier.length) groups.push({ title: 'Earlier', data: earlier })
  return groups
}

export default function RecentsScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPremium } = useAuth()
  const { shareAC, shareMany } = useShareActions()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set())
  const [pickerItem, setPickerItem] = useState<RecentAC | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [folderSheetVisible, setFolderSheetVisible] = useState(false)
  const [confirmTick, setConfirmTick] = useState(0)

  const load = useCallback(() => {
    Promise.all([getRecents(), getBookmarks()]).then(([recents, bookmarks]) => {
      setGroups(groupByTime(recents))
      setBookmarkedIds(new Set(bookmarks.map((b) => b.id)))
      setLoading(false)
    })
  }, [])

  // Reload on focus so newly-viewed ACs appear immediately
  useFocusEffect(load)

  const handleToggleBookmark = useCallback(async (item: RecentAC) => {
    const isNowBookmarked = await toggleBookmark({
      id: item.id,
      document_number: item.document_number,
      title: item.title,
      date_issued: item.date_issued,
      office: null,
      subject_series: item.subject_series,
    })
    setBookmarkedIds((prev) => {
      const next = new Set(prev)
      isNowBookmarked ? next.add(item.id) : next.delete(item.id)
      return next
    })
  }, [])

  const handleRemove = useCallback((item: RecentAC) => {
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, data: g.data.filter((r) => r.id !== item.id) }))
        .filter((g) => g.data.length > 0)
    )
    removeRecent(item.id)
  }, [])

  const handleClearAll = useCallback(() => {
    Alert.alert('Clear Recents', 'Remove your entire viewing history? This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          setGroups([])
          await clearRecents()
        },
      },
    ])
  }, [])

  const toggleSelect = () => {
    if (selectMode) { setSelectMode(false); setSelected(new Set()) }
    else setSelectMode(true)
  }

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleBulkAddToFolder = async (folderId: string) => {
    const ids = [...selected]
    await addManyToFolder(folderId, 'ac', ids)
    setFolderSheetVisible(false)
    setSelected(new Set())
    setSelectMode(false)
    setConfirmTick((t) => t + 1)
  }

  const handleBulkRemove = () => {
    const count = selected.size
    Alert.alert(
      `Remove ${count} Item${count > 1 ? 's' : ''}`,
      'Remove from your viewing history?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const ids = [...selected]
            const idSet = new Set(ids)
            setGroups((prev) =>
              prev
                .map((g) => ({ ...g, data: g.data.filter((r) => !idSet.has(r.id)) }))
                .filter((g) => g.data.length > 0)
            )
            setSelected(new Set())
            setSelectMode(false)
            await removeManyRecents(ids)
          },
        },
      ]
    )
  }

  const handleShare = (item: RecentAC) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareAC(item)
  }

  const handleBulkShare = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const all = groups.flatMap((g) => g.data)
    const items = all.filter((r) => selected.has(r.id))
    shareMany(items)
    setSelected(new Set())
    setSelectMode(false)
  }

  const hasRecents = groups.length > 0
  const rightSlot = hasRecents ? (
    <View style={styles.headerRight}>
      <Pressable onPress={toggleSelect} hitSlop={8}>
        <Text style={[styles.headerBtnText, { color: tokens.blu, fontSize: fs(13) }]}>
          {selectMode ? 'Done' : 'Select'}
        </Text>
      </Pressable>
      {!selectMode && (
        <Pressable onPress={handleClearAll} hitSlop={8}>
          <Text style={[styles.headerBtnText, { color: tokens.blu, fontSize: fs(13) }]}>Clear</Text>
        </Pressable>
      )}
    </View>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Recents" right={rightSlot} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : groups.length === 0 ? (
        <View style={styles.center}>
          <Icon name="clock" size={40} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No history yet</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            ACs you open will appear here so you can jump back quickly
          </Text>
        </View>
      ) : (
        <SectionList
          sections={groups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {section.title.toUpperCase()}
            </Text>
          )}
          renderItem={({ item }) => (
            <SwipeableRecentRow
              item={item}
              tokens={tokens}
              selectMode={selectMode}
              selected={selected.has(item.id)}
              bookmarked={bookmarkedIds.has(item.id)}
              onPress={selectMode ? () => toggleRow(item.id) : () => router.push(`/ac/${item.id}`)}
              onToggleBookmark={() => handleToggleBookmark(item)}
              onFolder={() => setPickerItem(item)}
              onRemove={() => handleRemove(item)}
              onShare={() => handleShare(item)}
            />
          )}
        />
      )}

      {/* Select action bar */}
      {selectMode && (
        <View style={[styles.selectBar, { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr }]}>
          <Pressable onPress={toggleSelect}>
            <Text style={[styles.selectCancel, { color: tokens.blu, fontSize: fs(13) }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.selectCount, { color: tokens.t2, fontSize: fs(13) }]}>({selected.size})</Text>
          <View style={styles.selectIconRow}>
            <Pressable
              onPress={() => setFolderSheetVisible(true)}
              disabled={selected.size === 0}
              hitSlop={8}
              style={{ opacity: selected.size > 0 ? 1 : 0.4 }}
            >
              <Icon name="folder.badge.plus" size={fs(25)} color={tokens.blu} />
            </Pressable>
            <Pressable
              onPress={handleBulkShare}
              disabled={selected.size === 0}
              hitSlop={8}
              style={{ opacity: selected.size > 0 ? 1 : 0.4 }}
            >
              <Icon name="square.and.arrow.up" size={fs(23)} color={tokens.blu} />
            </Pressable>
            <Pressable
              onPress={handleBulkRemove}
              disabled={selected.size === 0}
              hitSlop={8}
              style={{ opacity: selected.size > 0 ? 1 : 0.4 }}
            >
              <Icon name="trash" size={fs(23)} color="#ef4444" />
            </Pressable>
          </View>
        </View>
      )}

      <FolderPicker
        visible={pickerItem !== null}
        itemType="ac"
        itemId={pickerItem?.id ?? ''}
        onClose={() => setPickerItem(null)}
      />

      <FolderSelectSheet
        visible={folderSheetVisible}
        title={`Add ${selected.size} AC${selected.size !== 1 ? 's' : ''} to Folder`}
        onSelect={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} />
    </View>
  )
}

function SwipeableRecentRow({
  item,
  tokens,
  selectMode,
  selected,
  bookmarked,
  onPress,
  onToggleBookmark,
  onFolder,
  onRemove,
  onShare,
}: {
  item: RecentAC
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  bookmarked: boolean
  onPress: () => void
  onToggleBookmark: () => void
  onFolder: () => void
  onRemove: () => void
  onShare: () => void
}) {
  const fs = useFS()
  const translateX = useSharedValue(0)
  const swiped = useRef(false)

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .enabled(!selectMode)
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-92, e.translationX))
    })
    .onEnd((e) => {
      if (e.translationX < -48) {
        translateX.value = withSpring(-84, { damping: 18, stiffness: 280 })
        swiped.current = true
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
        swiped.current = false
      }
    })

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  const handlePress = () => {
    if (swiped.current) {
      translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
      swiped.current = false
    } else {
      onPress()
    }
  }

  const timeStr = new Date(item.viewedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.removeBg}>
        <Pressable
          style={styles.removeAction}
          onPress={() => {
            translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
            swiped.current = false
            onRemove()
          }}
        >
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable
            style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
            onPress={handlePress}
          >
            <View style={styles.rowTop}>
              {selectMode && (
                <View style={[
                  styles.checkbox,
                  selected
                    ? { backgroundColor: tokens.blu, borderColor: tokens.blu }
                    : { borderColor: tokens.t3 },
                ]}>
                  {selected && <Icon name="checkmark" size={11} color="#fff" />}
                </View>
              )}
              <View style={styles.rowBody}>
                <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12.5) }]}>{item.document_number}</Text>
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <View style={styles.metaActionRow}>
                  <View style={styles.metaRow}>
                    {item.subject_series ? (
                      <Text style={[styles.meta, { color: tokens.t4, fontSize: fs(11) }]}>Series {item.subject_series}</Text>
                    ) : null}
                    <Text style={[styles.time, { color: tokens.t4, fontSize: fs(11) }]}>{timeStr}</Text>
                  </View>
                  {!selectMode && (
                    <View style={styles.metaActions}>
                      <Pressable onPress={onToggleBookmark} hitSlop={10} style={styles.actionBtn}>
                        <Icon
                          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
                          size={fs(22)}
                          color={bookmarked ? tokens.blu : tokens.t3}
                        />
                      </Pressable>
                      <Pressable onPress={onFolder} hitSlop={10} style={styles.actionBtn}>
                        <Icon name="folder.badge.plus" size={fs(24)} color={tokens.t3} />
                      </Pressable>
                      <Pressable onPress={onShare} hitSlop={10} style={styles.actionBtn}>
                        <Icon name="square.and.arrow.up" size={fs(22)} color={tokens.t3} />
                      </Pressable>
                    </View>
                  )}
                </View>
              </View>
            </View>
          </Pressable>
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8, textAlign: 'center' },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, marginTop: 4 },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerBtnText: { fontSize: 13, fontWeight: '600' },

  list: { padding: 12, paddingBottom: 32 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: 6,
    marginTop: 8,
    paddingLeft: 2,
  },

  swipeWrap: { marginBottom: 6, borderRadius: 14, overflow: 'hidden' },
  removeBg: {
    position: 'absolute',
    top: 0, bottom: 0, right: 0,
    width: 84,
    backgroundColor: '#ef4444',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeAction: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  row: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginTop: 2,
  },
  rowBody: { flex: 1, gap: 3 },
  acNum: { fontWeight: '700', fontSize: 12.5 },
  rowTitle: { fontWeight: '500', fontSize: 14.5, lineHeight: 20 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  meta: { fontSize: 11 },
  time: { fontSize: 11 },
  // Shares the metadata line with Series/time instead of a separate divided
  // row below — cuts the extra vertical space each card took up just to
  // host the three icons.
  metaActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 3,
    gap: 8,
  },
  metaActions: { flexDirection: 'row', alignItems: 'center', gap: 14, flexShrink: 0 },
  actionBtn: { padding: 1 },

  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  selectCancel: { fontSize: 13, fontWeight: '600' },
  selectCount: { fontSize: 13, fontWeight: '600' },
  selectIconRow: { flexDirection: 'row', alignItems: 'center', gap: 24 },
})
