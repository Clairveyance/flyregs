import { useState, useEffect, useCallback, useRef } from 'react'
import * as Sentry from '@sentry/react-native'
import { View, Text, FlatList, Pressable, StyleSheet, Switch, ActivityIndicator } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { Icon } from '@/components/Icon'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { addManyToFolder, getFolders, removeItemsFromAllFolders } from '@/lib/folders'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions } from '@/lib/share'
import { getNotes, saveNotes, makeNoteId, type Note } from '@/lib/notes'
import { isSyncEnabled, enableSync, disableSync } from '@/lib/sync'
import { syncPushNote, syncPushNoteDeletes } from '@/lib/syncPush'
import { updateSharedNote } from '@/lib/sharedFolders'
import { useScreenActions } from '@/context/screenActions'
import { useIsTablet } from '@/context/responsive'
import { useConfirm } from '@/components/ConfirmDialog'
import { NoteEditor } from '@/components/NoteEditor'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  const days = Math.floor(secs / 86400)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 14) return '1 week ago'
  if (days < 28) return `${Math.floor(days / 7)} weeks ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}



// ─── Screen ──────────────────────────────────────────────────────────────────

export default function NotesScreen() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so these confirms (and the deletes behind them) were
  // invisible and untestable in the Browser pane. See ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const isTablet = useIsTablet()
  // Notes (create/use, local-first) are a Plus feature; only pushing them to
  // Supabase via "Back up & sync" requires Pro. RC, 2026-08-14, direct
  // correction to the 2026-08-11 pass above, which wrongly moved the whole
  // family to Pro -- see migrations_fix_folders_are_plus_not_pro.sql.
  const { isPro, isPremium, hasPlusAccess, hasProAccess, session } = useAuth()
  const { shareNote, shareMany } = useShareActions()
  const { openId } = useLocalSearchParams<{ openId?: string }>()
  const [notes, setNotes] = useState<Note[]>([])
  // `notes` starts empty and only fills in once getNotes() (async
  // AsyncStorage read) resolves -- without a loading flag, "haven't loaded
  // yet" and "genuinely no notes" were indistinguishable, so a real note
  // list could flash "No notes yet" for a moment on mount. Same gap already
  // found and fixed for saved.tsx's Shared tabs (gotcha_saved_shared_empty_
  // state_flash) -- identical pattern, just unnoticed here until now.
  const [notesLoading, setNotesLoading] = useState(true)
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editorNote, setEditorNote] = useState<Note | null>(null)
  const [pickerNote, setPickerNote] = useState<Note | null>(null)
  const [folderSheetVisible, setFolderSheetVisible] = useState(false)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')
  // Guards the auto-open-from-navigation effect below so it fires once per
  // distinct openId, not every time `notes` re-renders for an unrelated reason.
  const openedIdRef = useRef<string | null>(null)
  // Note titles (user-authored) can run long and get cut off the same way
  // FAR Part titles do -- same hook/card pair as far/index.tsx's own
  // long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    getNotes().then(setNotes).finally(() => setNotesLoading(false))
    isSyncEnabled().then(setSyncEnabled)
  }, [])

  useFocusEffect(useCallback(() => {
    // The sync flag can change in the background (applyRemoteSyncPreference,
    // triggered on app launch from context/auth.tsx, isn't awaited there so
    // this screen's initial mount can render before it finishes) — re-check
    // on every focus rather than only once on mount.
    isSyncEnabled().then(setSyncEnabled)
  }, []))

  // Opening a note from outside this screen (e.g. tapping it inside a Folder,
  // which has no note-editing UI of its own) navigates here with ?openId=.
  useEffect(() => {
    if (!hasPlusAccess || typeof openId !== 'string' || openId === openedIdRef.current) return
    const note = notes.find((n) => n.id === openId)
    if (note) {
      openedIdRef.current = openId
      setEditorNote({ ...note })
    }
  }, [openId, notes, hasPlusAccess])

  const persist = useCallback((updated: Note[]) => {
    setNotes(updated)
    saveNotes(updated)
  }, [])

  const openNew = () => {
    if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
    setEditorNote({ id: '', title: '', body: '', linked_ac: null, updated_at: '' })
  }

  const openExisting = (note: Note) => {
    if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
    if (selectMode) {
      setSelected((prev) => {
        const next = new Set(prev)
        next.has(note.id) ? next.delete(note.id) : next.add(note.id)
        return next
      })
    } else {
      setEditorNote({ ...note })
    }
  }

  const handleSave = (note: Note) => {
    const now = new Date().toISOString()
    const saved: Note = note.id ? { ...note, updated_at: now } : { ...note, id: makeNoteId(), updated_at: now }
    persist(note.id ? notes.map((n) => (n.id === note.id ? saved : n)) : [saved, ...notes])
    // A note pulled in because a collaborator placed it in one of MY folders
    // (see mergeNotes' authorId tag) isn't mine to upsert -- syncPushNote's
    // upsert keys on (user_id, id) and would create a duplicate row under my
    // own id rather than update the original. Plain update-by-id instead,
    // authorized by owners_manage_shared_notes.
    if (saved.authorId) {
      // Fire-and-forget by design (the optimistic local update above is
      // what the user actually sees) -- but updateSharedNote can now throw
      // (see its own comment: RLS can silently drop this write). This was
      // a bare unhandled-rejection risk with no visibility at all if that
      // ever fires here; at minimum track it, since the alternative is the
      // exact same silent-data-loss shape this fix exists to close.
      updateSharedNote(saved.id, { title: saved.title, body: saved.body }).catch((err) => Sentry.captureException(err))
    } else {
      syncPushNote(saved)
    }
    setEditorNote(null)
  }

  const deleteNote = (id: string) => {
    persist(notes.filter((n) => n.id !== id))
    syncPushNoteDeletes([id])
    // A deleted note may still be referenced by one or more folders -- drop
    // those references too, or the folder's shown item count silently drifts
    // ahead of what it actually renders.
    removeItemsFromAllFolders('note', [id])
  }

  const confirmDelete = (id: string) =>
    confirm({
      title: 'Delete Note',
      message: 'This note will be permanently deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      // Single-step: swipe-to-delete already requires a deliberate gesture
      // before this dialog even appears -- see feedback_destructive_actions_
      // need_typing's aircraft-fleet-wipe distinction, RC scoped the extra
      // moving-button step to aircraft deletion only.
      twoStep: false,
      onConfirm: () => deleteNote(id),
    })

  const confirmDeleteSelected = () => {
    const count = selected.size
    confirm({
      title: `Delete ${count} Note${count > 1 ? 's' : ''}`,
      message: "This can't be undone.",
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: () => {
        const ids = [...selected]
        persist(notes.filter((n) => !selected.has(n.id)))
        syncPushNoteDeletes(ids)
        removeItemsFromAllFolders('note', ids)
        setSelected(new Set())
        setSelectMode(false)
      },
    })
  }

  const toggleSelect = () => {
    if (selectMode) { setSelectMode(false); setSelected(new Set()) }
    else setSelectMode(true)
  }

  // RC, real device: "once on this page [select mode], let's add an 'All'
  // button in that same spot [next to Done], so user can select/deselect
  // all items at once if desired." Toggles rather than a one-way "select
  // all" -- if everything's already selected, tapping again is the obvious
  // way to clear the selection without a second, separate control.
  const allSelected = notes.length > 0 && selected.size === notes.length
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(notes.map((n) => n.id)))
  }

  const handleBulkAddToFolder = async (folderIds: string[]) => {
    const ids = [...selected]
    // Sequential, not Promise.all -- addManyToFolder does its own read-modify-
    // write on the shared folder_items list, so concurrent calls for different
    // folders would race and clobber each other (only the last write survives).
    for (const folderId of folderIds) {
      await addManyToFolder(folderId, 'note', ids)
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

  const handleShare = (note: Note) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareNote(note)
  }

  const handleBulkShare = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const items = notes.filter((n) => selected.has(n.id))
    shareMany([], items)
    setSelected(new Set())
    setSelectMode(false)
  }

  // The stored sync_enabled flag doesn't get flipped off automatically if a
  // Pro/Premium subscription lapses -- self-correct so the UI (and syncPush.ts's
  // own live isPro check) both agree with reality instead of the row
  // claiming "Synced" forever off a stale local flag. Sync moved from Premium
  // to Pro in the pricing pivot -- see flyregs_decisions.md.
  // hasProAccess (isPro || isPremium), not bare isPro -- matches saved.tsx's
  // fix: a genuine Premium subscriber (isPro: false, isPremium: true) hit
  // this exact bug, since bare `isPro` is false for them.
  const displaySyncEnabled = syncEnabled && hasProAccess
  useEffect(() => {
    if (syncEnabled && !hasProAccess) {
      disableSync()
      setSyncEnabled(false)
    }
  }, [syncEnabled, hasProAccess])

  const toggleSync = async (v: boolean) => {
    // Cross-device sync is a Pro feature — turning it on without Pro opens
    // the paywall (a real navigation, not a dialog -- it worked on web even
    // back when every Alert.alert on this screen silently did nothing).
    if (v && !hasProAccess) {
      router.push('/paywall?tier=pro')
      return // leave the switch off
    }
    if (v && session?.user?.id) {
      setSyncBusy(true)
      try {
        await enableSync(session.user.id)
        setNotes(await getNotes())
        setSyncEnabled(v)
      } catch {
        // Matches saved.tsx's toggleSync -- same underlying enableSync() can
        // genuinely throw (a transient network blip on its own auth/backup
        // calls), and this screen shares the exact same toggle with saved.tsx.
        // Without this, a throw here left the switch stuck without ever
        // clearing syncBusy or telling the user anything failed.
        confirm({ title: 'Error', message: "Couldn't turn on Back up & sync. Try again in a moment.", cancelLabel: null })
      }
      setSyncBusy(false)
    } else {
      await disableSync()
      setSyncEnabled(v)
    }
  }

  // RC, annotated iPad screenshot: Select/+New (list) circled, moved to the
  // bottom bar. Skips registering while the editor is open -- NoteEditor
  // registers its own Back/Folder/Share/Delete/Done there instead (see
  // below), and re-asserts these the moment editorNote goes back to null.
  useScreenActions(
    !hasPlusAccess || editorNote !== null
      ? []
      : [
          { key: 'select', label: selectMode ? 'Done' : 'Select', onPress: toggleSelect },
          ...(!selectMode ? [{ key: 'new', label: '+ New', onPress: openNew, variant: 'primary' as const }] : []),
        ],
    [hasPlusAccess, editorNote !== null, selectMode]
  )

  const rightSlot = hasPlusAccess && !isTablet ? (
    <View style={styles.headerRight}>
      {selectMode && (
        <Pressable onPress={toggleSelectAll} hitSlop={8}>
          <Text style={[styles.selectBtnText, { color: tokens.blu, fontSize: fs(13) }]}>
            {allSelected ? 'None' : 'All'}
          </Text>
        </Pressable>
      )}
      <Pressable onPress={toggleSelect} hitSlop={8}>
        <Text style={[styles.selectBtnText, { color: tokens.blu, fontSize: fs(13) }]}>
          {selectMode ? 'Done' : 'Select'}
        </Text>
      </Pressable>
      {!selectMode && (
        <Pressable onPress={openNew} style={[styles.addBtn, { backgroundColor: tokens.blu }]}>
          <Icon name="plus" size={fs(13)} color="#fff" />
          <Text style={[styles.addBtnText, { fontSize: fs(12.5) }]}>New</Text>
        </Pressable>
      )}
    </View>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Notes" right={rightSlot} />
      <TabletContainer disabled={isTablet}>

      {!hasPlusAccess ? (
        <View style={[styles.empty, { padding: 32 }]}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Notes is a Plus feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Unlock Plus to create personal notes and link them directly to any AC.
          </Text>
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.push('/paywall?tier=plus')}
          >
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {/* Back up & sync row */}
          <View style={styles.syncWrap}>
            <View style={[styles.syncRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}>
              <View style={styles.syncTopRow}>
                <Text style={[styles.syncLabel, { color: tokens.t1, fontSize: fs(13) }]}>Back up & sync</Text>
                {syncBusy ? (
                  <ActivityIndicator size="small" color={tokens.blu} />
                ) : (
                  <Switch
                    value={displaySyncEnabled}
                    onValueChange={toggleSync}
                    trackColor={{ true: tokens.blu, false: undefined }}
                    thumbColor="#fff"
                    style={styles.syncSwitch}
                  />
                )}
              </View>
              <View style={styles.syncBadgeRow}>
                {/* Back up & sync gates on isPro (toggleSync above) -- this
                    badge said PREMIUM, telling a Pro subscriber the toggle
                    they'd already paid for needed a tier up. Same bug already
                    fixed in saved.tsx's identical control; missed here. */}
                <View style={[styles.premBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                  <Text style={[styles.premText, { color: tokens.gold, fontSize: fs(9.5) }]}>PRO</Text>
                </View>
                <View style={[
                  styles.statusPill,
                  displaySyncEnabled
                    ? { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }
                    : { backgroundColor: tokens.gdim, borderColor: tokens.gbdr },
                ]}>
                  <Text style={[styles.statusPillText, { color: displaySyncEnabled ? tokens.blu : tokens.grn, fontSize: fs(10) }]}>
                    {syncBusy ? 'Syncing…' : displaySyncEnabled ? 'Synced' : 'Local Only'}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Notes list */}
          {notesLoading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          ) : notes.length === 0 ? (
            <View style={styles.empty}>
              <Icon name="square.and.pencil" size={fs(36)} color={tokens.t4} />
              <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No notes yet</Text>
              <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                Tap + New to start. Mention an AC like "61-65K" and it auto-links.
              </Text>
            </View>
          ) : (
            <FlatList
              // iPad creative pass: same flexWrap-grid idea as Recents
              // (85f6ed5) and Home's What's New -- a 2-up grid instead of one
              // narrow scrolling column. FlatList's own numColumns needs a
              // `key` change to remount cleanly when the column count changes
              // (RN requirement), and each card needs a wrapper to take a
              // fractional width since SwipeableNoteCard itself is full-width
              // by design (phone). Phone (isTablet false) is the exact
              // original single-column FlatList, byte-identical.
              key={isTablet ? 'grid' : 'list'}
              data={notes}
              keyExtractor={(n) => n.id}
              numColumns={isTablet ? 2 : 1}
              columnWrapperStyle={isTablet ? styles.gridRow : undefined}
              contentContainerStyle={isTablet ? styles.tabletList : styles.list}
              renderItem={({ item }) => (
                <View style={isTablet ? styles.gridCell : undefined}>
                  <SwipeableNoteCard
                    note={item}
                    tokens={tokens}
                    selectMode={selectMode}
                    selected={selected.has(item.id)}
                    onPress={() => openExisting(item)}
                    onDelete={() => confirmDelete(item.id)}
                    onFolder={() => setPickerNote(item)}
                    onShare={() => handleShare(item)}
                    showPreview={showPreview}
                    hidePreview={hidePreview}
                    consumeLongPress={consumeLongPress}
                  />
                </View>
              )}
            />
          )}
        </>
      )}

      {/* Select bar */}
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
              onPress={confirmDeleteSelected}
              disabled={selected.size === 0}
              hitSlop={8}
              style={{ opacity: selected.size > 0 ? 1 : 0.4 }}
            >
              <Icon name="trash" size={fs(23)} color={tokens.red} />
            </Pressable>
          </View>
        </View>
      )}

      {/* Note editor overlay */}
      {editorNote !== null && (
        <NoteEditor
          note={editorNote}
          tokens={tokens}
          onSave={handleSave}
          onClose={() => setEditorNote(null)}
          onDelete={
            editorNote.id
              ? () =>
                  confirm({
                    title: 'Delete Note',
                    message: "This can't be undone.",
                    confirmLabel: 'Delete',
                    destructive: true,
                    twoStep: false,
                    onConfirm: () => { deleteNote(editorNote.id); setEditorNote(null) },
                  })
              : undefined
          }
          onShare={editorNote.id ? () => handleShare(editorNote) : undefined}
          onFolder={editorNote.id ? () => setPickerNote(editorNote) : undefined}
        />
      )}

      {/* Folder picker for notes */}
      <FolderPicker
        visible={pickerNote !== null}
        itemType="note"
        itemId={pickerNote?.id ?? ''}
        onClose={() => setPickerNote(null)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
      />

      {/* Bulk folder assignment */}
      <FolderSelectSheet
        visible={folderSheetVisible}
        title={`Add ${selected.size} Note${selected.size !== 1 ? 's' : ''} to Folder`}
        onConfirm={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
      </TabletContainer>
    </View>
  )
}

// ─── Swipeable note card ──────────────────────────────────────────────────────

function SwipeableNoteCard({
  note, tokens, selectMode, selected, onPress, onDelete, onFolder, onShare,
  showPreview, hidePreview, consumeLongPress,
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onDelete: () => void
  onFolder?: () => void
  onShare?: () => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
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

  return (
    <View style={styles.swipeWrap}>
      {/* Red delete background */}
      <View style={[styles.deleteBg, { backgroundColor: tokens.red }]}>
        <Pressable style={styles.deleteAction} onPress={() => {
          translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
          swiped.current = false
          onDelete()
        }}>
          <Text style={[styles.deleteActionText, { fontSize: fs(13) }]}>Delete</Text>
        </Pressable>
      </View>

      {/* Sliding card — GestureDetector runs on the UI thread, no JS-thread jank */}
      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <NoteCard
            note={note}
            tokens={tokens}
            selectMode={selectMode}
            selected={selected}
            onPress={handlePress}
            onFolder={onFolder}
            onShare={onShare}
            showPreview={showPreview}
            hidePreview={hidePreview}
            consumeLongPress={consumeLongPress}
          />
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

// ─── Note card ────────────────────────────────────────────────────────────────

function NoteCard({
  note, tokens, selectMode, selected, onPress, onFolder, onShare,
  showPreview, hidePreview, consumeLongPress,
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onFolder?: () => void
  onShare?: () => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        onPress()
      }}
      onLongPress={(e) => showPreview(note.title || 'Untitled', e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
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
      <View style={[styles.cardBody, selectMode && styles.cardBodyIndented]}>
        <Text style={[styles.cardTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
          {note.title || 'Untitled'}
        </Text>
        <Text style={[styles.cardPreview, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
          {note.body}
        </Text>
        <View style={styles.cardFooter}>
          <Text style={[styles.cardTime, { color: tokens.t3, fontSize: fs(11) }]}>{timeAgo(note.updated_at)}</Text>
          {note.linked_ac && (
            <View style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
              <Icon name="link" size={fs(10)} color={tokens.blu} />
              <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(11) }]}>AC {note.linked_ac}</Text>
            </View>
          )}
          {!selectMode && (onShare || onFolder) && (
            <View style={styles.cardActions}>
              {onShare && (
                <Pressable onPress={onShare} hitSlop={10} style={styles.actionIconBtn}>
                  <Icon name="square.and.arrow.up" size={fs(22)} color={tokens.t3} />
                </Pressable>
              )}
              {onFolder && (
                <Pressable onPress={onFolder} hitSlop={10} style={styles.actionIconBtn}>
                  <Icon name="folder.badge.plus" size={fs(24)} color={tokens.t3} />
                </Pressable>
              )}
            </View>
          )}
        </View>
      </View>
    </Pressable>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },


  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selectBtnText: { fontSize: 13, fontWeight: '600' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 12.5 },

  // maxWidth keeps this a bounded settings-style card once TabletContainer
  // is disabled for the grid below (isTablet) -- harmless on phone, where
  // the screen is already narrower than the cap.
  syncWrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4, maxWidth: 460 },
  syncRow: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, gap: 8 },
  syncTopRow: { flexDirection: 'row', alignItems: 'center' },
  syncLabel: { fontWeight: '600', fontSize: 13, flexShrink: 1 },
  syncSwitch: { marginLeft: 'auto', flexShrink: 0 },
  syncBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  premBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2 },
  premText: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
  statusPill: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2 },
  statusPillText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },

  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8 },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 280 },
  upgradeBtn: { marginTop: 8, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28 },
  upgradeBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  list: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 40 },
  tabletList: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 },
  gridRow: { gap: 12 },
  gridCell: { flex: 1 },

  // Swipeable wrapper
  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  deleteBg: {
    position: 'absolute', top: 0, bottom: 0, right: 0, width: 84,
    justifyContent: 'center', alignItems: 'center',
  },
  deleteAction: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  deleteActionText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  // Note card (no trash icon)
  card: { flexDirection: 'row', alignItems: 'flex-start', borderRadius: 14, borderWidth: 1, padding: 12, gap: 10 },
  checkbox: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 2 },
  cardBody: { flex: 1, gap: 3 },
  cardBodyIndented: { marginLeft: 2 },
  cardTitle: { fontWeight: '600', fontSize: 14 },
  cardPreview: { fontSize: 13.5, lineHeight: 19 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  cardTime: { fontSize: 11 },
  acChip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1 },
  acChipText: { fontSize: 11, fontWeight: '600' },
  cardActions: { flexDirection: 'row', alignItems: 'center', gap: 16, marginLeft: 'auto' },
  actionIconBtn: { padding: 4 },

  // Select bar
  selectBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1 },
  selectCancel: { fontSize: 13, fontWeight: '600' },
  selectCount: { fontSize: 13, fontWeight: '600' },
  selectIconRow: { flexDirection: 'row', alignItems: 'center', gap: 24 },
})
