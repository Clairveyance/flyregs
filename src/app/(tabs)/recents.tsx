import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, Pressable, SectionList, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useIsTablet } from '@/context/responsive'
import { useAuth } from '@/context/auth'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { supabase } from '@/lib/supabase'
import { ScreenHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { Icon } from '@/components/Icon'
import { getRecents, removeRecent, removeManyRecents, clearRecents, routeForRecent, recentItemType, type RecentAC } from '@/lib/recents'
import { getBookmarks, toggleBookmark, addManyBookmarks } from '@/lib/bookmarks'
import { addManyToFolder, getFolders } from '@/lib/folders'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions, ShareableReg } from '@/lib/share'
import { toRegShareType } from '@/lib/regShare'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix, rowTitle } from '@/lib/titleFormat'
import { useConfirm } from '@/components/ConfirmDialog'

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
  // iPad creative pass: a single narrow centered column wasted most of the
  // screen's width for a list that's really just cards. Matches Home's own
  // What's New treatment (a3db9d0) -- flexWrap grid of fixed-ish-width cards,
  // TabletContainer disabled so the grid gets the full rail-inset width
  // instead of a 700px cap. Phone (isTablet false) renders the exact
  // original SectionList, untouched.
  const isTablet = useIsTablet()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so these confirms (and the deletes behind them) were
  // invisible and untestable in the Browser pane. See ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  // Bookmarks/Folders require Pro (RC, 2026-08-11: "back up sync is Pro" --
  // corrected from an earlier Plus-tier gate); sharing stays Premium.
  const { isPremium, hasProAccess } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const { shareAC, shareReg, shareMany } = useShareActions()
  const [groups, setGroups] = useState<Group[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set())
  // Same live-lookup approach as Saved's BookmarkRow -- recents are local
  // AsyncStorage snapshots with no cancels/changed_block_indices, and a
  // "this changed" badge that never refreshes after the first view would
  // defeat its own purpose.
  const [badgeDataById, setBadgeDataById] = useState<Record<string, {
    cancels: string[]
    changed_block_indices: number[] | null
    date_issued: string | null
    document_number: string
  }>>({})
  const [pickerItem, setPickerItem] = useState<RecentAC | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [folderSheetVisible, setFolderSheetVisible] = useState(false)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')

  const load = useCallback(() => {
    Promise.all([getRecents(), getBookmarks()]).then(([recents, bookmarks]) => {
      setGroups(groupByTime(recents))
      setBookmarkedIds(new Set(bookmarks.map((b) => b.id)))
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    // AC-only -- advisory_circulars.id is a uuid column, and a FAR/AIM/P-CG/AD
    // recent's id (e.g. "91.13", "AAM") isn't one. Passing a non-uuid string
    // into .in('id', ...) throws a Postgres error for the WHOLE query, not
    // just a no-match for that one id -- which was silently zeroing out
    // badge data for real AC recents too, the moment any non-AC item was
    // also in the list.
    const ids = [...new Set(
      groups.flatMap((g) => g.data).filter((r) => recentItemType(r) === 'ac').map((r) => r.id)
    )]
    if (ids.length === 0) { setBadgeDataById({}); return }
    supabase
      .from('advisory_circulars')
      .select('id, document_number, cancels, changed_block_indices, date_issued')
      .in('id', ids)
      .then(({ data }) => {
        const map: Record<string, { cancels: string[]; changed_block_indices: number[] | null; date_issued: string | null; document_number: string }> = {}
        for (const row of data ?? []) map[row.id] = row
        setBadgeDataById(map)
      })
  }, [groups])

  // Reload on focus so newly-viewed ACs appear immediately
  useFocusEffect(load)

  const handleToggleBookmark = useCallback(async (item: RecentAC) => {
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    const isNowBookmarked = await toggleBookmark({
      id: item.id,
      itemType: recentItemType(item),
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
  }, [hasProAccess])

  const handleRemove = useCallback((item: RecentAC) => {
    setGroups((prev) =>
      prev
        .map((g) => ({ ...g, data: g.data.filter((r) => r.id !== item.id) }))
        .filter((g) => g.data.length > 0)
    )
    removeRecent(item.id)
  }, [])

  const handleClearAll = useCallback(() => {
    confirm({
      title: 'Clear Recents',
      message: 'Remove your entire viewing history? This cannot be undone.',
      confirmLabel: 'Clear',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        setGroups([])
        await clearRecents()
      },
    })
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

  const handleBulkAddToFolder = async (folderIds: string[]) => {
    const ids = [...selected]
    // A Recents item isn't necessarily bookmarked -- the folder-detail screen
    // resolves an 'ac' folder item's display data via the bookmarks list, so
    // without this, an item added to a folder straight from Recents would
    // silently disappear from its own folder (and get permanently pruned by
    // folder/[id].tsx's orphaned-item self-heal). Ensure a bookmark exists
    // for everything being added, using data already on hand here.
    const allRecents = groups.flatMap((g) => g.data)
    const selectedRecents = allRecents.filter((r) => ids.includes(r.id))
    const toBookmark = selectedRecents.map((r) => ({
      id: r.id,
      itemType: recentItemType(r),
      document_number: r.document_number,
      title: r.title,
      date_issued: r.date_issued,
      office: null,
      subject_series: r.subject_series,
    }))
    await addManyBookmarks(toBookmark)
    setBookmarkedIds((prev) => new Set([...prev, ...toBookmark.map((b) => b.id)]))
    // Selected items can span multiple content types in one bulk action --
    // group by itemType before calling addManyToFolder, which takes one type
    // per call (see folders.ts).
    const idsByType = new Map<string, string[]>()
    for (const r of selectedRecents) {
      const t = recentItemType(r)
      idsByType.set(t, [...(idsByType.get(t) ?? []), r.id])
    }
    // Sequential, not Promise.all -- addManyToFolder does its own read-modify-
    // write on the shared folder_items list, so concurrent calls (whether for
    // different folders or different item types) would race and clobber each
    // other (only the last write survives).
    for (const folderId of folderIds) {
      for (const [type, typeIds] of idsByType) {
        await addManyToFolder(folderId, type as any, typeIds)
      }
    }
    setFolderSheetVisible(false)
    setSelected(new Set())
    setSelectMode(false)
    const allFolders = await getFolders()
    const names = folderIds.map((id) => allFolders.find((f) => f.id === id)?.name).filter(Boolean)
    setConfirmLabel(
      names.length === 1 ? `Added to ${names[0]}` : names.length > 1 ? 'Added to multiple folders' : 'Added to folder'
    )
    setConfirmTick((t) => t + 1)
  }

  const handleBulkRemove = () => {
    const count = selected.size
    confirm({
      title: `Remove ${count} Item${count > 1 ? 's' : ''}`,
      message: 'Remove from your viewing history?',
      confirmLabel: 'Remove',
      destructive: true,
      // Single-step: recents are a convenience trail, not user-authored
      // content -- nothing is lost that re-opening the document won't
      // rebuild. The full Clear Recents above still two-steps.
      twoStep: false,
      onConfirm: async () => {
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
    })
  }

  // See toRegShareType -- null means "shares by a different route", not
  // "unshareable", so callers skip rather than force a bad type through.
  const toShareableReg = (item: RecentAC): ShareableReg | null => {
    const type = toRegShareType(recentItemType(item))
    if (!type) return null
    return { type, id: item.id, label: item.document_number, title: item.title }
  }

  const handleShare = (item: RecentAC) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const type = recentItemType(item)
    if (type === 'ac') { shareAC(item); return }
    const reg = toShareableReg(item)
    if (reg) shareReg(reg)
  }

  // Recents is the one list that shows the folder icon to free users without
  // gating the whole screen behind a ProWall first (Saved/Notes both hide
  // their entire list for non-Plus). Gate synchronously here, same pattern as
  // handleToggleBookmark/handleShare above -- FolderPicker's own internal
  // hasProAccess effect (open -> close -> setTimeout-delayed router.push) was
  // the only gate before, and a second tap shortly after the first landed
  // while that effect's queued navigation was still resolving, so it silently
  // no-op'd instead of opening the paywall again.
  const handleFolder = (item: RecentAC) => {
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    setPickerItem(item)
  }

  const handleBulkShare = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const all = groups.flatMap((g) => g.data)
    const selectedItems = all.filter((r) => selected.has(r.id))
    const acs = selectedItems.filter((r) => recentItemType(r) === 'ac')
    const regs = selectedItems.filter((r) => recentItemType(r) !== 'ac')
    if (acs.length === 0 && regs.length === 0) return
    shareMany(acs, [], regs.map(toShareableReg).filter((r): r is ShareableReg => r !== null))
    setSelected(new Set())
    setSelectMode(false)
  }

  const renderRow = (item: RecentAC) => (
    <SwipeableRecentRow
      key={item.id}
      item={item}
      tokens={tokens}
      selectMode={selectMode}
      selected={selected.has(item.id)}
      bookmarked={bookmarkedIds.has(item.id)}
      badgeData={badgeDataById[item.id]}
      badgeDays={badgeDays}
      onPress={selectMode ? () => toggleRow(item.id) : () => router.push(routeForRecent(item) as any)}
      onToggleBookmark={() => handleToggleBookmark(item)}
      onFolder={() => handleFolder(item)}
      onRemove={() => handleRemove(item)}
      onShare={() => handleShare(item)}
    />
  )

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
      <TabletContainer disabled={isTablet}>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : groups.length === 0 ? (
        <View style={styles.center}>
          <Icon name="clock" size={fs(40)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No history yet</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Anything you open will appear here so you can jump back quickly
          </Text>
        </View>
      ) : isTablet ? (
        <ScrollView contentContainerStyle={styles.tabletList}>
          {groups.map((group) => (
            <View key={group.title}>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {group.title.toUpperCase()}
              </Text>
              <View style={styles.grid}>
                {group.data.map((item) => (
                  <View key={item.id} style={styles.gridCell}>
                    {renderRow(item)}
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : (
        <SectionList
          sections={groups}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {section.title.toUpperCase()}
            </Text>
          )}
          renderItem={({ item }) => renderRow(item)}
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
              onPress={() => { if (!hasProAccess) { router.push('/paywall?tier=pro'); return } setFolderSheetVisible(true) }}
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
              <Icon name="trash" size={fs(23)} color={tokens.red} />
            </Pressable>
          </View>
        </View>
      )}

      <FolderPicker
        visible={pickerItem !== null}
        itemType={pickerItem ? recentItemType(pickerItem) : 'ac'}
        itemId={pickerItem?.id ?? ''}
        onClose={() => setPickerItem(null)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={pickerItem ? {
          document_number: pickerItem.document_number,
          title: pickerItem.title,
          date_issued: pickerItem.date_issued,
          office: null,
          subject_series: pickerItem.subject_series,
        } : undefined}
      />

      <FolderSelectSheet
        visible={folderSheetVisible}
        title={`Add ${selected.size} AC${selected.size !== 1 ? 's' : ''} to Folder`}
        onConfirm={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
      </TabletContainer>
    </View>
  )
}

function SwipeableRecentRow({
  item,
  tokens,
  selectMode,
  selected,
  bookmarked,
  badgeData,
  badgeDays,
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
  badgeData?: { cancels: string[]; changed_block_indices: number[] | null; date_issued: string | null; document_number: string }
  badgeDays: number
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
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
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
                  {selected && <Icon name="checkmark" size={fs(11)} color="#fff" />}
                </View>
              )}
              <View style={styles.rowBody}>
                <View style={styles.rowNumBadgeWrap}>
                  <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12.5) }]}>
                    {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
                  </Text>
                  {badgeData && isWithinBadgeLifespan(badgeData.date_issued, badgeDays) && (() => {
                    const badge = getBadgeStyle(getBadgeKind(badgeData), tokens)
                    return (
                      <View style={[styles.rowBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
                        <Text style={[styles.rowBadgeText, { color: badge.color, fontSize: fs(8.5) }]}>{badge.label}</Text>
                      </View>
                    )
                  })()}
                </View>
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                  {rowTitle(item.document_number, item.title)}
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
  tabletList: { padding: 16, paddingBottom: 32 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  gridCell: { width: '48%', minWidth: 320 },
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
  rowNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  rowBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
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
