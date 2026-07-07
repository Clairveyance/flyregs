import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  Switch,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { getBookmarks, removeBookmark, removeManyBookmarks, BookmarkAC } from '@/lib/bookmarks'
import { getDownloads, removeDownload, formatBytes, DownloadedAC } from '@/lib/downloads'
import {
  getFolders,
  getFolderItemCounts,
  getItemsInFolder,
  createFolder,
  deleteFolder,
  addManyToFolder,
  Folder,
} from '@/lib/folders'
import { getNotes } from '@/lib/notes'
import { isSyncEnabled, enableSync, disableSync } from '@/lib/sync'
import { FolderListView } from '@/components/FolderListView'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions, ShareableAC, ShareableNote } from '@/lib/share'

type Tab = 'all' | 'folders' | 'offline'

export default function SavedScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium } = useAuth()
  const { shareAC, shareMany } = useShareActions()
  const [tab, setTab] = useState<Tab>('all')
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)

  useEffect(() => {
    isSyncEnabled().then(setSyncEnabled)
  }, [])
  const [bookmarks, setBookmarks] = useState<BookmarkAC[]>([])
  const [downloads, setDownloads] = useState<DownloadedAC[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [folderCounts, setFolderCounts] = useState<Record<string, number>>({})
  const [pickerAC, setPickerAC] = useState<BookmarkAC | null>(null)
  const [pickerDownloadId, setPickerDownloadId] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [folderSelectMode, setFolderSelectMode] = useState(false)
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set())
  const [newFolderVisible, setNewFolderVisible] = useState(false)
  const [folderSheetVisible, setFolderSheetVisible] = useState(false)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')

  const load = useCallback(() => {
    getBookmarks().then(setBookmarks)
    getDownloads().then(setDownloads)
    Promise.all([getFolders(), getFolderItemCounts()]).then(([f, c]) => {
      setFolders(f)
      setFolderCounts(c)
    })
  }, [])

  useFocusEffect(useCallback(() => {
    load()
    // The sync flag can change in the background (applyRemoteSyncPreference,
    // triggered on app launch from context/auth.tsx, isn't awaited there so
    // this screen's initial mount can render before it finishes) — re-check
    // on every focus rather than only once on mount.
    isSyncEnabled().then(setSyncEnabled)
  }, [load]))

  const toggleSync = async (v: boolean) => {
    if (v && !isPremium) { router.push('/paywall?tier=premium'); return }
    if (v && session?.user?.id) {
      setSyncBusy(true)
      await enableSync(session.user.id)
      load()
      setSyncBusy(false)
    } else {
      await disableSync()
    }
    setSyncEnabled(v)
  }

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

  const handleRemove = (item: BookmarkAC) => {
    Alert.alert('Remove Bookmark', `Remove AC ${item.document_number} from your saved list?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setBookmarks((prev) => prev.filter((b) => b.id !== item.id))
          await removeBookmark(item.id)
        },
      },
    ])
  }

  const handleBulkDelete = () => {
    const count = selected.size
    Alert.alert(
      `Remove ${count} Bookmark${count > 1 ? 's' : ''}`,
      "They'll be removed from Saved but not deleted.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const ids = [...selected]
            setBookmarks((prev) => prev.filter((b) => !selected.has(b.id)))
            setSelected(new Set())
            setSelectMode(false)
            await removeManyBookmarks(ids)
          },
        },
      ]
    )
  }

  const handleRemoveDownload = (item: DownloadedAC) => {
    Alert.alert('Remove Download', `Remove the offline copy of AC ${item.document_number}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          setDownloads((prev) => prev.filter((d) => d.id !== item.id))
          await removeDownload(item.id)
        },
      },
    ])
  }

  const handleBulkAddToFolder = async (folderId: string) => {
    const ids = [...selected]
    await addManyToFolder(folderId, 'ac', ids)
    setFolderSheetVisible(false)
    setSelected(new Set())
    setSelectMode(false)
    const folder = folders.find((f) => f.id === folderId)
    setConfirmLabel(folder ? `Added to ${folder.name}` : 'Added to folder')
    setConfirmTick((t) => t + 1)
  }

  const handleShare = (item: { document_number: string; title: string }) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareAC(item)
  }

  const handleBulkShare = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const items = bookmarks.filter((b) => selected.has(b.id))
    shareMany(items)
    setSelected(new Set())
    setSelectMode(false)
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  const toggleFolderSelect = () => {
    if (folderSelectMode) { setFolderSelectMode(false); setSelectedFolders(new Set()) }
    else setFolderSelectMode(true)
  }

  const toggleFolderRow = (id: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleCreateFolder = async (name: string) => {
    await createFolder(name)
    setNewFolderVisible(false)
    load()
  }

  const handleDeleteFolder = (folder: Folder) => {
    Alert.alert('Delete Folder', `Delete "${folder.name}"? The ACs and notes inside will not be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteFolder(folder.id)
          load()
        },
      },
    ])
  }

  // Resolves a folder's items down to shareable AC/note content — folders only
  // store {item_type, item_id} pointers, so sharing needs to cross-reference
  // the actual bookmark/note data.
  const resolveFolderContents = useCallback(async (folderIds: string[]) => {
    const [items, notes] = await Promise.all([
      Promise.all(folderIds.map((id) => getItemsInFolder(id))).then((lists) => lists.flat()),
      getNotes(),
    ])
    const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
    const noteMap = new Map(notes.map((n) => [n.id, n]))

    const acs: ShareableAC[] = []
    const shareNotes: ShareableNote[] = []
    const seenAc = new Set<string>()
    const seenNote = new Set<string>()
    for (const item of items) {
      if (item.item_type === 'ac') {
        const bm = bookmarkMap.get(item.item_id)
        if (bm && !seenAc.has(bm.id)) { seenAc.add(bm.id); acs.push(bm) }
      } else {
        const note = noteMap.get(item.item_id)
        if (note && !seenNote.has(note.id)) { seenNote.add(note.id); shareNotes.push(note) }
      }
    }
    return { acs, notes: shareNotes }
  }, [bookmarks])

  const handleShareFolder = async (folder: Folder) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const { acs, notes } = await resolveFolderContents([folder.id])
    shareMany(acs, notes)
  }

  const handleBulkShareFolders = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const ids = [...selectedFolders]
    const { acs, notes } = await resolveFolderContents(ids)
    shareMany(acs, notes)
    setSelectedFolders(new Set())
    setFolderSelectMode(false)
  }

  const rightSlot = (
    <View style={styles.headerRight}>
      <Pressable onPress={toggleSelect} hitSlop={8}>
        <Text style={[styles.selectBtn, { color: tokens.blu, fontSize: fs(13) }]}>
          {selectMode ? 'Done' : 'Select'}
        </Text>
      </Pressable>
    </View>
  )

  const folderRightSlot = (
    <View style={styles.headerRight}>
      <Pressable onPress={toggleFolderSelect} hitSlop={8}>
        <Text style={[styles.selectBtn, { color: tokens.blu, fontSize: fs(13) }]}>
          {folderSelectMode ? 'Done' : 'Select'}
        </Text>
      </Pressable>
      {!folderSelectMode && (
        <Pressable
          onPress={() => (isPro ? setNewFolderVisible(true) : router.push('/paywall'))}
          style={[styles.addBtn, { backgroundColor: tokens.blu }]}
        >
          <Icon name="plus" size={13} color="#fff" />
          <Text style={[styles.addBtnText, { fontSize: fs(12.5) }]}>New</Text>
        </Pressable>
      )}
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader
        title="Saved"
        right={tab === 'all' ? rightSlot : tab === 'folders' ? folderRightSlot : undefined}
      />

      {/* Segmented control */}
      <View style={styles.segWrap}>
        <View style={[styles.seg, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {(['all', 'folders', 'offline'] as Tab[]).map((t) => (
            <Pressable
              key={t}
              style={[styles.segBtn, tab === t && { backgroundColor: tokens.blu }]}
              onPress={() => {
                if (t === 'offline' && !isPremium) { router.push('/paywall?tier=premium'); return }
                setTab(t)
                setSelectMode(false)
                setSelected(new Set())
                setFolderSelectMode(false)
                setSelectedFolders(new Set())
              }}
            >
              <Text style={[styles.segText, { color: tab === t ? '#fff' : tokens.t3, fontSize: fs(13) }]}>
                {t === 'all' ? 'All' : t === 'folders' ? 'Folders' : 'Offline'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Back up & sync row */}
      {tab === 'all' && (
        <View style={styles.syncWrap}>
          <View style={[styles.syncRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            <View style={styles.syncTopRow}>
              <Text style={[styles.syncLabel, { color: tokens.t1, fontSize: fs(13) }]}>Back up & sync</Text>
              {syncBusy ? (
                <ActivityIndicator size="small" color={tokens.blu} />
              ) : (
                <Switch
                  value={syncEnabled}
                  onValueChange={toggleSync}
                  trackColor={{ true: tokens.blu, false: undefined }}
                  style={styles.syncSwitch}
                />
              )}
            </View>
            <View style={styles.syncBadgeRow}>
              <View style={[styles.premBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                <Text style={[styles.premText, { color: tokens.gold, fontSize: fs(9.5) }]}>PREMIUM</Text>
              </View>
              <View style={[
                styles.statusPill,
                syncEnabled
                  ? { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }
                  : { backgroundColor: tokens.gdim, borderColor: tokens.gbdr },
              ]}>
                <Text style={[styles.statusPillText, { color: syncEnabled ? tokens.blu : tokens.grn, fontSize: fs(10) }]}>
                  {syncBusy ? 'Syncing…' : syncEnabled ? 'Synced' : 'Local Only'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {tab === 'all' ? (
        <>
          {bookmarks.length === 0 ? (
            <EmptyState tokens={tokens} signedIn={!!session} />
          ) : (
            <FlatList
              data={bookmarks}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              ListHeaderComponent={
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                  {bookmarks.length} SAVED AC{bookmarks.length !== 1 ? 'S' : ''}
                </Text>
              }
              renderItem={({ item }) => (
                <BookmarkRow
                  item={item}
                  tokens={tokens}
                  selectMode={selectMode}
                  selected={selected.has(item.id)}
                  onPress={selectMode ? () => toggleRow(item.id) : () => router.push(`/ac/${item.id}`)}
                  onRemove={() => handleRemove(item)}
                  onFolder={() => setPickerAC(item)}
                  onShare={() => handleShare(item)}
                />
              )}
            />
          )}
        </>
      ) : tab === 'folders' ? (
        <FolderListView
          folders={folders}
          counts={folderCounts}
          selectMode={folderSelectMode}
          selected={selectedFolders}
          onToggleSelect={toggleFolderRow}
          onOpen={(folder) => router.push(`/folder/${folder.id}`)}
          onRenamed={load}
          onDelete={handleDeleteFolder}
          onShare={handleShareFolder}
          onCreateFolder={() => setNewFolderVisible(true)}
        />
      ) : (
        <OfflineListView
          downloads={downloads}
          tokens={tokens}
          onOpen={(item) => router.push(`/ac/${item.id}`)}
          onFolder={(item) => setPickerDownloadId(item.id)}
          onRemove={handleRemoveDownload}
          onShare={handleShare}
        />
      )}

      {/* Select action bar */}
      {selectMode && tab === 'all' && (
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
              onPress={handleBulkDelete}
              disabled={selected.size === 0}
              hitSlop={8}
              style={{ opacity: selected.size > 0 ? 1 : 0.4 }}
            >
              <Icon name="trash" size={fs(23)} color="#ef4444" />
            </Pressable>
          </View>
        </View>
      )}

      {/* Folder select action bar */}
      {folderSelectMode && tab === 'folders' && (
        <View style={[styles.selectBar, { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr }]}>
          <Pressable onPress={toggleFolderSelect}>
            <Text style={[styles.selectCancel, { color: tokens.blu, fontSize: fs(13) }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.selectCount, { color: tokens.t2, fontSize: fs(12.5) }]}>{selectedFolders.size} selected</Text>
          <Pressable
            onPress={handleBulkShareFolders}
            disabled={selectedFolders.size === 0}
            style={{ opacity: selectedFolders.size > 0 ? 1 : 0.4 }}
          >
            <Text style={[styles.selectAction, { color: tokens.blu, fontSize: fs(13) }]}>Share</Text>
          </Pressable>
        </View>
      )}

      {newFolderVisible && (
        <FolderEditor onCreate={handleCreateFolder} onClose={() => setNewFolderVisible(false)} />
      )}

      {/* Per-item folder picker */}
      <FolderPicker
        visible={pickerAC !== null}
        itemType="ac"
        itemId={pickerAC?.id ?? ''}
        onClose={() => setPickerAC(null)}
      />

      {/* Folder picker for offline downloads */}
      <FolderPicker
        visible={pickerDownloadId !== null}
        itemType="ac"
        itemId={pickerDownloadId ?? ''}
        onClose={() => setPickerDownloadId(null)}
      />

      {/* Bulk folder picker */}
      <FolderSelectSheet
        visible={folderSheetVisible}
        title={`Add ${selected.size} AC${selected.size !== 1 ? 's' : ''} to Folder`}
        onSelect={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Full-screen "New Folder" overlay — matches Notes' NoteEditor look (same
// header layout, same slide-in-over-the-tab presentation) instead of the
// inline expanding row this used to be, so creating a Folder feels identical
// to creating a Note.
function FolderEditor({
  onCreate,
  onClose,
}: {
  onCreate: (name: string) => void
  onClose: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const [name, setName] = useState('')

  const handleCreate = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreate(trimmed)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[StyleSheet.absoluteFill, styles.editorRoot, { backgroundColor: tokens.bg }]}
    >
      <View style={[styles.editorHeader, { backgroundColor: tokens.bg2, borderBottomColor: tokens.bdr, paddingTop: insets.top + 14 }]}>
        <Pressable onPress={onClose} style={styles.editorBack} hitSlop={8}>
          <Icon name="chevron.left" size={17} color={tokens.blu} />
          <Text style={[styles.editorBackText, { color: tokens.blu, fontSize: fs(14) }]}>Saved</Text>
        </Pressable>
        <Text style={[styles.editorHeadTitle, { color: tokens.t1, fontSize: fs(14) }]}>New folder</Text>
        <View style={styles.editorHeaderRight}>
          <Pressable
            onPress={handleCreate}
            disabled={!name.trim()}
            style={[styles.doneBtn, { backgroundColor: tokens.blu, opacity: name.trim() ? 1 : 0.5 }]}
          >
            <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Create</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.editorBody}>
        <TextInput
          style={[styles.titleInput, { color: tokens.t1, fontSize: fs(19) }]}
          placeholder="Folder name"
          placeholderTextColor={tokens.t3}
          value={name}
          onChangeText={setName}
          autoFocus
          autoCapitalize="sentences"
          returnKeyType="done"
          onSubmitEditing={handleCreate}
          maxLength={60}
        />
      </View>
    </KeyboardAvoidingView>
  )
}

function BookmarkRow({
  item,
  tokens,
  selectMode,
  selected,
  onPress,
  onRemove,
  onFolder,
  onShare,
}: {
  item: BookmarkAC
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onRemove: () => void
  onFolder: () => void
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

  const handleSwipeRemove = () => {
    translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    swiped.current = false
    onRemove()
  }

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.removeBg}>
        <Pressable style={styles.removeAction} onPress={handleSwipeRemove}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable
            style={[styles.bookmarkRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
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
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <View style={styles.metaActionRow}>
                  <Text style={[styles.savedAt, { color: tokens.t4, fontSize: fs(11) }]} numberOfLines={1}>
                    Saved{' '}
                    {new Date(item.savedAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })}
                    {item.office ? ` · ${item.office}` : ''}
                  </Text>
                  {!selectMode && (
                    <View style={styles.metaActions}>
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

type OfflineSort = 'recent' | 'az'

// Dedicated Offline tab (Premium) — a single, clearly-labeled place to find,
// sort, and manage every AC downloaded for reading with no network connection.
// Previously this was a small icon-strip easy to miss at the top of "All";
// this replaces it with a real list, matching every other list in the app.
function OfflineListView({
  downloads,
  tokens,
  onOpen,
  onFolder,
  onRemove,
  onShare,
}: {
  downloads: DownloadedAC[]
  tokens: ReturnType<typeof useTheme>['tokens']
  onOpen: (item: DownloadedAC) => void
  onFolder: (item: DownloadedAC) => void
  onRemove: (item: DownloadedAC) => void
  onShare: (item: DownloadedAC) => void
}) {
  const fs = useFS()
  const [sort, setSort] = useState<OfflineSort>('recent')

  const sorted = useMemo(() => {
    const list = [...downloads]
    if (sort === 'az') {
      list.sort((a, b) => a.document_number.localeCompare(b.document_number, undefined, { numeric: true }))
    } else {
      list.sort((a, b) => new Date(b.downloadedAt).getTime() - new Date(a.downloadedAt).getTime())
    }
    return list
  }, [downloads, sort])

  if (downloads.length === 0) {
    return (
      <View style={styles.center}>
        <Icon name="arrow.down.circle" size={40} color={tokens.t4} />
        <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No downloads yet</Text>
        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
          Open any Advisory Circular and tap "Download" to save it here for reading with no connection.
        </Text>
      </View>
    )
  }

  return (
    <FlatList
      data={sorted}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      ListHeaderComponent={
        <View style={styles.offlineHeaderRow}>
          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
            {downloads.length} DOWNLOADED AC{downloads.length !== 1 ? 'S' : ''}
          </Text>
          <View style={styles.sortToggle}>
            {(['recent', 'az'] as OfflineSort[]).map((s) => (
              <Pressable
                key={s}
                style={[styles.sortBtn, sort === s && { backgroundColor: tokens.blu }]}
                onPress={() => setSort(s)}
              >
                <Text style={[styles.sortBtnText, { color: sort === s ? '#fff' : tokens.t3, fontSize: fs(11) }]}>
                  {s === 'recent' ? 'Recent' : 'A–Z'}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      }
      renderItem={({ item }) => (
        <OfflineRow
          item={item}
          tokens={tokens}
          onPress={() => onOpen(item)}
          onFolder={() => onFolder(item)}
          onRemove={() => onRemove(item)}
          onShare={() => onShare(item)}
        />
      )}
    />
  )
}

function OfflineRow({
  item,
  tokens,
  onPress,
  onFolder,
  onRemove,
  onShare,
}: {
  item: DownloadedAC
  tokens: ReturnType<typeof useTheme>['tokens']
  onPress: () => void
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

  const handleSwipeRemove = () => {
    translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    swiped.current = false
    onRemove()
  }

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.removeBg}>
        <Pressable style={styles.removeAction} onPress={handleSwipeRemove}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>

      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable
            style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
            onPress={handlePress}
          >
            <View style={[styles.offlineIcon, { backgroundColor: tokens.bdim }]}>
              <Icon name="doc.text" size={18} color={tokens.blu} />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12.5) }]}>{item.document_number}</Text>
              <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={[styles.savedAt, { color: tokens.t4, fontSize: fs(11) }]}>
                {formatBytes(item.size)} · Downloaded{' '}
                {new Date(item.downloadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable onPress={onFolder} hitSlop={8} style={styles.actionBtn}>
                <Icon name="folder.badge.plus" size={22} color={tokens.t3} />
              </Pressable>
              <Pressable onPress={onShare} hitSlop={8} style={styles.actionBtn}>
                <Icon name="square.and.arrow.up" size={19} color={tokens.t3} />
              </Pressable>
            </View>
          </Pressable>
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

function EmptyState({
  tokens,
  signedIn,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  signedIn: boolean
}) {
  const fs = useFS()
  return (
    <View style={styles.center}>
      <Icon name="bookmark" size={40} color={tokens.t4} />
      <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No saved ACs yet</Text>
      <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
        Tap the bookmark icon on any Advisory Circular to save it here.
        {!signedIn ? ' Sign in to sync across devices.' : ''}
      </Text>
      {!signedIn && (
        <Pressable
          style={[styles.signInBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr, borderWidth: 1 }]}
          onPress={() => router.push('/auth')}
        >
          <Text style={[styles.signInBtnText, { color: tokens.blu, fontSize: fs(15) }]}>Sign In</Text>
        </Pressable>
      )}
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

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
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, marginTop: 4, maxWidth: 300 },
  signInBtn: {
    marginTop: 16,
    borderRadius: 13,
    paddingVertical: 13,
    paddingHorizontal: 24,
  },
  signInBtnText: { fontWeight: '600', fontSize: 15 },

  segWrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  seg: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 3,
    gap: 2,
  },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 8,
  },
  segText: { fontSize: 13, fontWeight: '600' },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selectBtn: { fontSize: 13, fontWeight: '600' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 12.5 },

  editorRoot: { zIndex: 100 },
  editorHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1, gap: 8 },
  editorBack: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 64 },
  editorBackText: { fontSize: 14, fontWeight: '500' },
  editorHeadTitle: { flex: 1, textAlign: 'center', fontWeight: '600', fontSize: 14 },
  editorHeaderRight: { flexDirection: 'row', alignItems: 'center', minWidth: 64, justifyContent: 'flex-end' },
  doneBtn: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  doneBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  editorBody: { padding: 16, paddingBottom: 40 },
  titleInput: { fontSize: 19, fontWeight: '700', paddingVertical: 4, marginBottom: 10 },

  syncWrap: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 2 },
  syncRow: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, gap: 8 },
  // Label + switch share their own row so a long badge/pill combo below can
  // never push the Switch past the right edge of the screen — the switch has
  // a fixed intrinsic size and marginLeft:auto pins it, but only within a row
  // that otherwise holds nothing but a short, single-line label.
  syncTopRow: { flexDirection: 'row', alignItems: 'center' },
  syncLabel: { fontWeight: '600', fontSize: 13, flexShrink: 1 },
  syncSwitch: { marginLeft: 'auto', flexShrink: 0 },
  syncBadgeRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  premBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2 },
  premText: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
  statusPill: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2 },
  statusPillText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.3 },

  list: { padding: 12, paddingBottom: 32 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingLeft: 2,
  },

  offlineIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  offlineHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sortToggle: { flexDirection: 'row', gap: 4 },
  sortBtn: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 8 },
  sortBtnText: { fontSize: 11, fontWeight: '600' },

  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
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
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  // BookmarkRow (Saved → All) — column layout with actions spread along the
  // bottom, matching Recents. Kept separate from `row` above (still used by
  // OfflineRow's side-by-side icon/body/actions layout) so that one doesn't
  // clobber the other.
  bookmarkRow: {
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
  rowBody: { flex: 1, gap: 4 },
  acNum: { fontWeight: '700', fontSize: 12.5 },
  rowTitle: { fontWeight: '500', fontSize: 15, lineHeight: 21 },
  savedAt: { fontSize: 11, flexShrink: 1 },
  rowActions: { flexDirection: 'column', alignItems: 'center', gap: 22, paddingTop: 2 },
  // Shares the metadata line with the AC's saved-date/office text instead of
  // a separate divided row below — cuts the extra vertical space each card
  // took up just to host two icons.
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
  selectAction: { fontSize: 13, fontWeight: '600' },
  selectIconRow: { flexDirection: 'row', alignItems: 'center', gap: 24 },
})
