import React, { useState, useRef, useMemo } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { router } from 'expo-router'
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
  LinearTransition,
  type SharedValue,
} from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import * as Haptics from 'expo-haptics'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import { renameFolder, Folder, DUPLICATE_FOLDER_NAME } from '@/lib/folders'
import { useConfirm } from '@/components/ConfirmDialog'

// Fallback only for the one frame before a row's real height is measured via
// onLayout -- every row uses that measured height once known, since actual
// height varies with the text-size slider (fs()) and must never be a fixed
// guess baked into the drag math.
const FALLBACK_ROW_HEIGHT = 78

// Folder list for the Saved tab. Fully prop-driven — the parent (saved.tsx)
// owns folders/counts/select state so it can run bulk actions (share) and a
// single New Folder overlay shared with the rest of the screen's header.
interface Props {
  folders: Folder[]
  counts: Record<string, number>
  selectMode: boolean
  selected: Set<string>
  onToggleSelect: (id: string) => void
  onOpen: (folder: Folder) => void
  onRenamed: () => void
  onDelete: (folder: Folder) => void
  onShare: (folder: Folder) => void
  onDuplicate: (folder: Folder) => void
  onCreateFolder: () => void
  listHeader?: React.ReactElement
  /** True while the user is in "Reorder" mode (a header toggle owned by the
   * parent, same pattern as selectMode) -- rows swap their rename/share icons
   * for a drag handle and disable tap-to-open/swipe-to-delete. */
  reorderMode?: boolean
  /** Called once, on drop, with the complete new folder-id order. Not called
   * on every intermediate frame of the drag -- see reorderFolders() in
   * lib/folders.ts for why persisting only the final order is enough. */
  onReorder?: (orderedIds: string[]) => void
}

export function FolderListView({
  folders,
  counts,
  selectMode,
  selected,
  onToggleSelect,
  onOpen,
  onRenamed,
  onDelete,
  onShare,
  onDuplicate,
  onCreateFolder,
  listHeader,
  reorderMode = false,
  onReorder,
}: Props) {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { hasPlusAccess } = useAuth()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const listRef = useRef<FlatList<Folder>>(null)

  // Drag-to-reorder state. rowHeight is measured (not guessed) from the
  // first rendered row so the drag math stays correct at any text-size-
  // slider setting. dragId/dragStartIndex are plain state (drive React
  // re-renders of the live-splice order below); dragY is a shared value so
  // the dragged row's own translateY can update on the UI thread every
  // frame without round-tripping through React.
  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT)
  const rowHeightMeasured = useRef(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragStartIndex, setDragStartIndex] = useState(0)
  const [dragHoverIndex, setDragHoverIndex] = useState(0)
  const dragY = useSharedValue(0)

  const onRowLayout = (h: number) => {
    if (!rowHeightMeasured.current && h > 0) {
      rowHeightMeasured.current = true
      setRowHeight(h)
    }
  }

  // The order actually rendered: while a drag is in flight, splice the
  // dragged folder out of its start position and into its current hover
  // position, purely for display -- nothing is persisted until drop.
  const displayFolders = useMemo(() => {
    if (!dragId || dragHoverIndex === dragStartIndex) return folders
    const next = [...folders]
    const [moved] = next.splice(dragStartIndex, 1)
    next.splice(dragHoverIndex, 0, moved)
    return next
  }, [folders, dragId, dragStartIndex, dragHoverIndex])

  const handleDragUpdate = (translationY: number, startIndex: number, len: number) => {
    dragY.value = translationY
    const hover = Math.min(len - 1, Math.max(0, startIndex + Math.round(translationY / rowHeight)))
    setDragHoverIndex((prev) => (prev === hover ? prev : hover))
  }

  const handleDragEnd = () => {
    dragY.value = withSpring(0, { damping: 20, stiffness: 300 })
    if (dragId && dragHoverIndex !== dragStartIndex) {
      onReorder?.(displayFolders.map((f) => f.id))
    }
    setDragId(null)
  }

  // Renaming happens inline in the list — scroll the row into view since the
  // keyboard can cover a row that was visible before it opened.
  const startRename = (folder: Folder, index: number) => {
    setEditingId(folder.id)
    setEditName(folder.name)
    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 })
      } catch {}
    })
  }

  const handleRename = async () => {
    if (!editingId || !editName.trim()) { setEditingId(null); return }
    try {
      await renameFolder(editingId, editName.trim())
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        confirm({ title: 'Folder Already Exists', message: `You already have a folder named "${editName.trim()}". Choose a different name.`, cancelLabel: null })
        return
      }
      throw e
    }
    setEditingId(null)
    onRenamed()
  }

  const cancelRename = () => setEditingId(null)

  // Renaming happens inline among other rows (not a full-screen overlay), so
  // "tap outside to cancel" means: tapping any other row, or the empty space
  // below the list, cancels the edit instead of performing that row's normal
  // action.
  const handleRowPress = (action: () => void) => {
    if (editingId) { cancelRename(); return }
    action()
  }

  const guardPro = (action: () => void) => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    action()
  }

  if (folders.length === 0) {
    return (
      <View style={styles.empty}>
        {listHeader}
        <Icon name="folder" size={fs(40)} color={tokens.t4} />
        <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No folders yet</Text>
        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
          Folders let you organize saved regulations and notes together — great for training syllabi, study sets, and reference packs.
        </Text>
        <Pressable
          style={[styles.createCta, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr, borderWidth: 1 }]}
          onPress={() => guardPro(onCreateFolder)}
        >
          <Icon name="folder.badge.plus" size={fs(16)} color={tokens.blu} />
          <Text style={[styles.createCtaText, { color: tokens.blu, fontSize: fs(14) }]}>New Folder</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.avoidingView}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <FlatList
        ref={listRef}
        data={displayFolders}
        extraData={[reorderMode, dragId, dragHoverIndex]}
        keyExtractor={(f) => f.id}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        scrollEnabled={!dragId}
        ListHeaderComponent={listHeader}
        ListFooterComponent={editingId ? <Pressable style={styles.dismissFooter} onPress={cancelRename} /> : null}
        onScrollToIndexFailed={({ index }) => {
          setTimeout(() => {
            try {
              listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 })
            } catch {}
          }, 100)
        }}
        renderItem={({ item, index }) => {
          const count = counts[item.id] ?? 0
          const isEditing = editingId === item.id

          if (isEditing) {
            return (
              <View style={[styles.folderCard, { backgroundColor: tokens.bg2, borderColor: tokens.blu }]}>
                <Icon name="folder.fill" size={fs(20)} color={tokens.blu} />
                <TextInput
                  style={[styles.nameInput, { color: tokens.t1, flex: 1, fontSize: ifs(14.5) }]}
                  value={editName}
                  onChangeText={setEditName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleRename}
                  maxLength={60}
                />
                <Pressable onPress={handleRename} hitSlop={8}>
                  <Icon name="checkmark.circle.fill" size={fs(22)} color={tokens.blu} />
                </Pressable>
                <Pressable onPress={() => setEditName('')} hitSlop={8}>
                  <Icon name="xmark.circle.fill" size={fs(22)} color={tokens.t3} />
                </Pressable>
              </View>
            )
          }

          return (
            <SwipeableFolderRow
              folder={item}
              count={count}
              tokens={tokens}
              selectMode={selectMode}
              selected={selected.has(item.id)}
              onPress={() => handleRowPress(() => (selectMode ? onToggleSelect(item.id) : onOpen(item)))}
              onRename={() => startRename(item, index)}
              onDelete={() => onDelete(item)}
              onShare={() => onShare(item)}
              onDuplicate={() => onDuplicate(item)}
              reorderMode={reorderMode}
              isDragging={dragId === item.id}
              dragY={dragY}
              // The dragged row's own rendered `index` moves as displayFolders
              // splices it past other rows -- that's a real layout shift, not
              // a visual one, so raw dragY (the pointer's offset from where
              // the drag STARTED) would double-count it and the row would
              // overshoot by (indexDelta * rowHeight) on top of where the
              // finger actually is. Subtracting that delta in the row's own
              // transform cancels the double-count.
              dragIndexDelta={dragId === item.id ? index - dragStartIndex : 0}
              rowHeight={rowHeight}
              onLayoutHeight={onRowLayout}
              onDragStart={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
            setDragStartIndex(index); setDragHoverIndex(index); setDragId(item.id)
          }}
              // dragStartIndex, not `index` -- `index` is this row's CURRENT
              // rendered position, which shifts every time displayFolders
              // re-splices mid-drag (same fact the comment above this row
              // already accounts for in the visual transform). translationY
              // from the Pan gesture is cumulative from the ORIGINAL touch-
              // down point, so feeding it a drifting reference point instead
              // of the fixed start compounds the error every time the row
              // crosses a neighbor -- RC, real device: "only allows you to
              // drag ... to the very top, not anyplace in between."
              onDragUpdate={(translationY: number) => handleDragUpdate(translationY, dragStartIndex, displayFolders.length)}
              onDragEnd={handleDragEnd}
            />
          )
        }}
      />
    </KeyboardAvoidingView>
  )
}

function SwipeableFolderRow({
  folder, count, tokens, selectMode, selected, onPress, onRename, onShare, onDuplicate, onDelete,
  reorderMode = false, isDragging = false, dragY, dragIndexDelta = 0, rowHeight = FALLBACK_ROW_HEIGHT,
  onLayoutHeight, onDragStart, onDragUpdate, onDragEnd,
}: {
  folder: Folder
  count: number
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onRename: () => void
  onShare: () => void
  onDuplicate: () => void
  onDelete: () => void
  reorderMode?: boolean
  isDragging?: boolean
  dragY?: SharedValue<number>
  dragIndexDelta?: number
  rowHeight?: number
  onLayoutHeight?: (height: number) => void
  onDragStart?: () => void
  onDragUpdate?: (translationY: number) => void
  onDragEnd?: () => void
}) {
  const fs = useFS()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so this dialog would be invisible in the Browser pane.
  const confirm = useConfirm()
  const translateX = useSharedValue(0)
  const swiped = useRef(false)

  // RC, real-device feedback: "move Duplicate + rename pencil into a Folders
  // ⋯ menu" -- these two were cluttering the row as separate icons. Reuses
  // the existing choices action-sheet pattern (see folder/[id].tsx's
  // Invite-by-Link/Callsign picker) rather than HeaderOverflowMenu, since
  // that component's dropdown is fixed-anchored near the screen's top/bottom
  // insets -- wrong for a per-row menu inside a scrolling list.
  const handleMore = () => {
    confirm({
      title: folder.name,
      choices: [
        { label: 'Rename', onPress: onRename },
        { label: 'Duplicate', onPress: onDuplicate },
      ],
    })
  }

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .enabled(!selectMode && !reorderMode)
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-84, e.translationX))
    })
    .onEnd((e) => {
      if (e.translationX < -42) {
        translateX.value = withSpring(-76, { damping: 18, stiffness: 280 })
        swiped.current = true
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
        swiped.current = false
      }
    })

  // Whole-row press-and-hold-then-drag, not a tiny handle icon. Previously
  // this only lived on a ~20px handle icon reached via a separate
  // GestureDetector nested inside this row's own -- RC reported "press/hold
  // ... nothing" on real device, and pressing/holding the row itself (the
  // natural gesture, matching iOS's own long-press-then-drag pattern) was
  // never wired to anything at all. activateAfterLongPress is RNGH's
  // purpose-built solution for exactly this arbitration problem: the pan
  // simply doesn't activate until the hold duration elapses, so it never
  // competes with the parent FlatList's native scroll responder on a quick
  // swipe/scroll -- unlike the old manual activeOffsetY/failOffsetX gating,
  // which was never confirmed working on real hardware.
  const dragGesture = Gesture.Pan()
    .activateAfterLongPress(300)
    .enabled(!selectMode && reorderMode)
    .onStart(() => {
      if (onDragStart) runOnJS(onDragStart)()
    })
    .onUpdate((e) => {
      if (onDragUpdate) runOnJS(onDragUpdate)(e.translationY)
    })
    .onEnd(() => {
      if (onDragEnd) runOnJS(onDragEnd)()
    })

  // Only one of these ever applies to a row at a time -- reorderMode already
  // disables panGesture (swipe) and enables dragGesture, so picking directly
  // avoids composing two gesture recognizers against each other at all.
  const rowGesture = reorderMode ? dragGesture : panGesture

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      // dragY is the raw pointer offset from where this drag started.
      // dragIndexDelta * rowHeight is how far this row has ALREADY moved via
      // plain layout reflow (displayFolders splicing it to a new index) --
      // subtracting it stops that shift from double-counting on top of the
      // transform, which otherwise sends the row far past the real finger
      // position the moment it crosses its first neighbor.
      { translateY: isDragging && dragY ? dragY.value - dragIndexDelta * rowHeight : 0 },
    ],
  }))

  const handlePress = () => {
    if (swiped.current) {
      translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
      swiped.current = false
    } else {
      onPress()
    }
  }

  const handleSwipeDelete = () => {
    translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    swiped.current = false
    onDelete()
  }

  return (
    <Reanimated.View
      layout={LinearTransition}
      style={[styles.swipeWrap, isDragging && styles.swipeWrapDragging]}
      onLayout={(e) => onLayoutHeight?.(e.nativeEvent.layout.height)}
    >
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
        <Pressable style={styles.removeAction} onPress={handleSwipeDelete}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Delete</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={rowGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable
            style={[
              styles.folderCard,
              { backgroundColor: tokens.bg2, borderColor: isDragging ? tokens.blu : tokens.bdr },
            ]}
            onPress={reorderMode ? undefined : handlePress}
          >
            {selectMode && !reorderMode && (
              <View style={[
                styles.checkbox,
                selected
                  ? { backgroundColor: tokens.blu, borderColor: tokens.blu }
                  : { borderColor: tokens.t3 },
              ]}>
                {selected && <Icon name="checkmark" size={fs(11)} color="#fff" />}
              </View>
            )}
            <Icon name="folder.fill" size={fs(20)} color={tokens.blu} />
            <View style={styles.folderCardBody}>
              <Text style={[styles.folderName, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                {folder.name}
              </Text>
              <Text style={[styles.folderCount, { color: tokens.t3, fontSize: fs(11.5) }]}>
                {count} item{count !== 1 ? 's' : ''}
              </Text>
            </View>
            {!selectMode && !reorderMode && (
              <>
                <Pressable onPress={onShare} hitSlop={10} style={styles.iconBtn}>
                  <Icon name="square.and.arrow.up" size={fs(20)} color={tokens.t3} />
                </Pressable>
                {/* BB-102/task #433, RC real-device beta report: Rename +
                    Duplicate (BB-079) declutter into one "..." menu instead
                    of two separate row icons. */}
                <Pressable onPress={handleMore} hitSlop={10} style={styles.iconBtn}>
                  <Icon name="ellipsis" size={fs(20)} color={tokens.t3} />
                </Pressable>
              </>
            )}
            {reorderMode && (
              // Purely decorative now -- the whole row is the drag target
              // (rowGesture above), not just this icon. Kept as a visual
              // affordance so it's still obvious the row is draggable.
              <View style={styles.dragHandle}>
                <Icon name="arrow.up.arrow.down" size={fs(20)} color={tokens.t3} />
              </View>
            )}
          </Pressable>
        </Reanimated.View>
      </GestureDetector>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  avoidingView: { flex: 1 },
  list: { padding: 12, paddingBottom: 40 },
  // flexGrow doesn't reliably cascade through FlatList's internal content
  // wrapper on web, so this can't stretch to fill exactly the remaining
  // viewport -- a generous fixed height is a simpler, more reliable way to
  // give "tap empty space to cancel" a large real target.
  dismissFooter: { minHeight: 600 },

  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8, textAlign: 'center' },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 300 },
  createCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 16,
    borderRadius: 13,
    paddingVertical: 13,
    paddingHorizontal: 20,
  },
  createCtaText: { fontWeight: '600', fontSize: 14 },

  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  swipeWrapDragging: {
    zIndex: 10,
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  dragHandle: { padding: 4, marginLeft: 2 },
  removeBg: {
    position: 'absolute',
    top: 0, bottom: 0, right: 0,
    width: 84,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeAction: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },

  folderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  folderCardBody: { flex: 1, gap: 2 },
  folderName: { fontWeight: '600', fontSize: 14.5 },
  folderCount: { fontSize: 11.5 },
  iconBtn: { padding: 4 },

  nameInput: {
    fontSize: 14.5,
    paddingVertical: 2,
    flex: 1,
  },
})
