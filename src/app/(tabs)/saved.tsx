import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  View,
  Text,
  Image,
  FlatList,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  Switch,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { supabase } from '@/lib/supabase'
import { blockText } from '@/lib/acFormat'
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
  DUPLICATE_FOLDER_NAME,
} from '@/lib/folders'
import { getNotes } from '@/lib/notes'
import { isSyncEnabled, enableSync, disableSync } from '@/lib/sync'
import { getMyCollaborations, getMySharedFolders, unshareFolder, SharedFolderSummary, SharedByMeFolder } from '@/lib/sharedFolders'
import { FolderListView } from '@/components/FolderListView'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions, ShareableAC, ShareableNote } from '@/lib/share'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { useCachedImage } from '@/lib/imageCache'
import { getAvatarPreset } from '@/lib/avatarPresets'

type Tab = 'all' | 'folders' | 'shared' | 'offline'

export default function SavedScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { session, isPro, isPremium } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const { shareAC, shareMany } = useShareActions()
  const [tab, setTab] = useState<Tab>('all')
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)

  useEffect(() => {
    isSyncEnabled().then(setSyncEnabled)
  }, [])
  const [bookmarks, setBookmarks] = useState<BookmarkAC[]>([])
  // acIds that have at least one highlight saved SOMEWHERE (a highlight is its
  // own separate BookmarkAC row, keyed by a synthetic id, not the AC's own id
  // -- see BookmarkAC's comment on that distinction). Used to flag a whole-
  // document bookmark row with "contains a highlight" even though the actual
  // highlight itself lives in a different row the reader may never scroll to
  // -- without this, a highlight saved via long-press has zero visibility
  // outside opening the AC itself and happening to scroll to the exact spot.
  const highlightAcIds = useMemo(
    () => new Set(bookmarks.filter((b) => b.blockText && b.acId).map((b) => b.acId!)),
    [bookmarks]
  )
  const [downloads, setDownloads] = useState<DownloadedAC[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [collaborations, setCollaborations] = useState<SharedFolderSummary[]>([])
  const [sharedByMe, setSharedByMe] = useState<SharedByMeFolder[]>([])
  const [sharedSubTab, setSharedSubTab] = useState<'withMe' | 'fromMe'>('withMe')
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
  // Highlight ids whose saved section no longer matches anything in the AC's
  // CURRENT content (the FAA revised that exact paragraph since it was
  // saved) — see the "Section changed" row indicator below and the matching
  // FAQ entry. Content-based, same blockText() identity used everywhere else
  // this session (changed_block_indices, the highlight-to-block matcher).
  const [staleHighlightIds, setStaleHighlightIds] = useState<Set<string>>(new Set())
  // NEW/UPD/VER badge data for each bookmarked AC, keyed by the AC's own id
  // (a highlight's `id` is a synthetic per-highlight value, so it's keyed by
  // `acId` instead -- see BookmarkAC's own comment on that distinction).
  // Bookmarks are local-storage snapshots taken at save time and never
  // carry cancels/changed_block_indices, so this always re-fetches live --
  // otherwise a badge could get stuck showing (or never show) the status an
  // AC had back when it was first saved, defeating the entire point of a
  // "this changed" indicator.
  const [badgeDataById, setBadgeDataById] = useState<Record<string, {
    cancels: string[]
    changed_block_indices: number[] | null
    date_issued: string | null
    document_number: string
  }>>({})

  useEffect(() => {
    const ids = [...new Set(bookmarks.map((b) => b.acId ?? b.id))]
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
  }, [bookmarks])

  useEffect(() => {
    const highlights = bookmarks.filter((b) => b.blockText && b.acId)
    if (highlights.length === 0) {
      setStaleHighlightIds(new Set())
      return
    }
    const acIds = [...new Set(highlights.map((h) => h.acId!))]
    supabase
      .from('advisory_circulars')
      .select('id, pdf_blocks')
      .in('id', acIds)
      .then(({ data }) => {
        if (!data) return
        const blockTextSetByAc = new Map<string, Set<string>>()
        for (const row of data) {
          blockTextSetByAc.set(row.id, new Set((row.pdf_blocks ?? []).map(blockText)))
        }
        const stale = new Set<string>()
        for (const h of highlights) {
          const set = blockTextSetByAc.get(h.acId!)
          if (!set || !set.has(h.blockText!)) stale.add(h.id)
        }
        setStaleHighlightIds(stale)
      })
  }, [bookmarks])

  const load = useCallback(() => {
    getBookmarks().then(setBookmarks)
    getDownloads().then(setDownloads)
    Promise.all([getFolders(), getFolderItemCounts()]).then(([f, c]) => {
      setFolders(f)
      setFolderCounts(c)
    })
    // Joining a shared folder is open to any tier (only the owner needs
    // Premium to create one), so this is gated on being signed in, not Premium.
    if (session?.user?.id) {
      getMyCollaborations().then(setCollaborations)
      getMySharedFolders().then(setSharedByMe)
    }
  }, [session?.user?.id])

  useFocusEffect(useCallback(() => {
    load()
    // The sync flag can change in the background (applyRemoteSyncPreference,
    // triggered on app launch from context/auth.tsx, isn't awaited there so
    // this screen's initial mount can render before it finishes) — re-check
    // on every focus rather than only once on mount.
    isSyncEnabled().then(setSyncEnabled)
  }, [load]))

  // The stored sync_enabled flag doesn't get flipped off automatically if a
  // Premium subscription lapses -- self-correct so the UI (and syncPush.ts's
  // own live isPremium check) both agree with reality instead of the row
  // claiming "Synced" forever off a stale local flag.
  const displaySyncEnabled = syncEnabled && isPremium
  useEffect(() => {
    if (syncEnabled && !isPremium) {
      disableSync()
      setSyncEnabled(false)
    }
  }, [syncEnabled, isPremium])

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

  const handleBulkAddToFolder = async (folderIds: string[]) => {
    const ids = [...selected]
    // Sequential, not Promise.all -- addManyToFolder does its own read-modify-
    // write on the shared folder_items list, so concurrent calls for different
    // folders would race and clobber each other (only the last write survives).
    for (const folderId of folderIds) {
      await addManyToFolder(folderId, 'ac', ids)
    }
    setFolderSheetVisible(false)
    setSelected(new Set())
    setSelectMode(false)
    // Fetch fresh rather than reading the `folders` state var -- if the user
    // created a brand-new folder inside FolderSelectSheet during this same
    // session, that folder's id is in folderIds but isn't in this screen's
    // `folders` state yet (only FolderSelectSheet's own local list knew about
    // it), so the .find() below would silently miss it and fall through to
    // the generic "Added to folder" toast instead of naming it. `load()`
    // below fixes the same staleness for the Folders tab itself, which
    // otherwise wouldn't show the new folder until the next screen focus.
    const allFolders = await getFolders()
    const names = folderIds.map((id) => allFolders.find((f) => f.id === id)?.name).filter(Boolean)
    setConfirmLabel(
      names.length === 1 ? `Added to ${names[0]}` : names.length > 1 ? 'Added to multiple folders' : 'Added to folder'
    )
    setConfirmTick((t) => t + 1)
    load()
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

  const handleCreateFolder = async (name: string): Promise<boolean> => {
    try {
      await createFolder(name)
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        Alert.alert('Folder Already Exists', `You already have a folder named "${name}". Choose a different name.`)
        return false
      }
      throw e
    }
    setNewFolderVisible(false)
    load()
    return true
  }

  const handleUnshare = (item: SharedByMeFolder) => {
    Alert.alert(
      'Stop Sharing',
      `Remove everyone's access to "${item.folder_name}"? The folder itself won't be deleted -- you can share it again later with a new invite link.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop Sharing',
          style: 'destructive',
          onPress: async () => {
            await unshareFolder(item.folder_id)
            setSharedByMe((prev) => prev.filter((f) => f.folder_id !== item.folder_id))
          },
        },
      ]
    )
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
        right={!isPro ? undefined : tab === 'all' ? rightSlot : tab === 'folders' ? folderRightSlot : undefined}
      />

      {/* Segmented control */}
      <View style={styles.segWrap}>
        <View style={[styles.seg, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {(['all', 'folders', 'shared', 'offline'] as Tab[]).map((t) => (
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
                {t === 'all' ? 'All' : t === 'folders' ? 'Folders' : t === 'shared' ? 'Shared' : 'Offline'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Back up & sync row */}
      {tab === 'all' && isPro && (
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
              <View style={[styles.premBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                <Text style={[styles.premText, { color: tokens.gold, fontSize: fs(9.5) }]}>PREMIUM</Text>
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
      )}

      {tab === 'all' ? (
        !isPro ? (
          <ProWall tokens={tokens} label="Bookmarks" />
        ) : (
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
                    stale={staleHighlightIds.has(item.id)}
                    hasHighlight={!item.blockText && highlightAcIds.has(item.id)}
                    badgeData={badgeDataById[item.acId ?? item.id]}
                    badgeDays={badgeDays}
                    onPress={selectMode ? () => toggleRow(item.id) : () => router.push(
                      item.blockText ? `/ac/${item.acId}?hlId=${encodeURIComponent(item.id)}` : `/ac/${item.acId ?? item.id}`
                    )}
                    onRemove={() => handleRemove(item)}
                    onFolder={() => setPickerAC(item)}
                    onShare={() => handleShare(item)}
                  />
                )}
              />
            )}
          </>
        )
      ) : tab === 'folders' ? (
        !isPro ? (
          <ProWall tokens={tokens} label="Folders" />
        ) : (
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
        )
      ) : tab === 'shared' ? (
        <>
          <View style={styles.subSegWrap}>
            <View style={[styles.subSeg, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              {(['withMe', 'fromMe'] as const).map((s) => (
                <Pressable
                  key={s}
                  style={[styles.subSegBtn, sharedSubTab === s && { backgroundColor: tokens.blu }]}
                  onPress={() => setSharedSubTab(s)}
                >
                  <Text style={[styles.subSegText, { color: sharedSubTab === s ? '#fff' : tokens.t3, fontSize: fs(12.5) }]}>
                    {s === 'withMe' ? 'With Me' : 'From Me'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {sharedSubTab === 'withMe' ? (
            collaborations.length === 0 ? (
              <View style={styles.center}>
                <Icon name="person.2.fill" size={40} color={tokens.t4} />
                <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Nothing shared with you yet</Text>
                <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                  When someone invites you to a folder, it'll show up here.
                </Text>
              </View>
            ) : (
              <FlatList
                data={collaborations}
                keyExtractor={(c) => c.folder_id}
                contentContainerStyle={styles.sharedList}
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.sharedRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                    onPress={() => router.push(`/folder/shared/${item.folder_id}`)}
                  >
                    <OwnerAvatar
                      cacheKey={item.folder_id}
                      avatarUrl={item.ownerAvatarUrl}
                      presetId={item.ownerAvatarPreset}
                      name={item.ownerDisplayName}
                      tokens={tokens}
                      fs={fs}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.sharedRowText, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                        {item.folder_name}
                      </Text>
                      {item.ownerDisplayName && (
                        <Text style={[styles.sharedRowSub, { color: tokens.t3, fontSize: fs(11.5) }]} numberOfLines={1}>
                          Shared by {item.ownerDisplayName}
                        </Text>
                      )}
                    </View>
                    <Icon name="chevron.right" size={14} color={tokens.t4} />
                  </Pressable>
                )}
              />
            )
          ) : sharedByMe.length === 0 ? (
            <View style={styles.center}>
              <Icon name="person.2.fill" size={40} color={tokens.t4} />
              <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>You haven't shared anything yet</Text>
              <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                Open a folder in the Folders tab and tap the people icon to invite someone.
              </Text>
            </View>
          ) : (
            <FlatList
              data={sharedByMe}
              keyExtractor={(c) => c.folder_id}
              contentContainerStyle={styles.sharedList}
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.sharedRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                  onPress={() => router.push(`/folder/${item.folder_id}`)}
                >
                  <Icon name="folder" size={18} color={tokens.t2} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sharedRowText, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                      {item.folder_name}
                    </Text>
                    <Text style={{ color: tokens.t4, fontSize: fs(11.5) }}>
                      {item.collaboratorCount} {item.collaboratorCount === 1 ? 'person' : 'people'}
                    </Text>
                  </View>
                  <Pressable onPress={() => handleUnshare(item)} hitSlop={10} style={{ padding: 4 }}>
                    <Icon name="xmark.circle" size={20} color={tokens.t4} />
                  </Pressable>
                </Pressable>
              )}
            />
          )}
        </>
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
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
      />

      {/* Folder picker for offline downloads */}
      <FolderPicker
        visible={pickerDownloadId !== null}
        itemType="ac"
        itemId={pickerDownloadId ?? ''}
        onClose={() => setPickerDownloadId(null)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={(() => {
          const d = downloads.find((x) => x.id === pickerDownloadId)
          return d ? {
            document_number: d.document_number,
            title: d.title,
            date_issued: null,
            office: null,
            subject_series: d.subject_series,
          } : undefined
        })()}
      />

      {/* Bulk folder picker */}
      <FolderSelectSheet
        visible={folderSheetVisible}
        title={`Add ${selected.size} AC${selected.size !== 1 ? 's' : ''} to Folder`}
        onConfirm={handleBulkAddToFolder}
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
  onCreate: (name: string) => void | Promise<boolean>
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

      <Pressable style={styles.editorBody} onPress={Keyboard.dismiss}>
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
      </Pressable>
    </KeyboardAvoidingView>
  )
}

function BookmarkRow({
  item,
  tokens,
  selectMode,
  selected,
  stale,
  hasHighlight,
  badgeData,
  badgeDays,
  onPress,
  onRemove,
  onFolder,
  onShare,
}: {
  item: BookmarkAC
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  stale?: boolean
  hasHighlight?: boolean
  badgeData?: { cancels: string[]; changed_block_indices: number[] | null; date_issued: string | null; document_number: string }
  badgeDays: number
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
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={2}>
                  {item.title}
                </Text>
                {item.blockText ? (
                  <>
                    <View style={[styles.highlightTag, { backgroundColor: 'rgba(255, 213, 0, 0.12)', borderColor: 'rgba(255, 213, 0, 0.4)' }]}>
                      <Text style={{ color: '#8a6d00', fontWeight: '700', fontSize: fs(10.5) }}>
                        {item.blockLabel ? `§ ${item.blockLabel} ` : 'HIGHLIGHT '}
                      </Text>
                      <Text numberOfLines={1} style={{ color: tokens.t2, fontSize: fs(11.5), flex: 1 }}>
                        {item.blockSnippet}
                      </Text>
                    </View>
                    {stale && (
                      <View style={styles.staleTag}>
                        <Icon name="exclamationmark.triangle" size={11} color="#b45309" />
                        <Text style={{ color: '#b45309', fontSize: fs(10.5), fontWeight: '600' }}>
                          Section changed — won't jump to this spot anymore
                        </Text>
                      </View>
                    )}
                  </>
                ) : hasHighlight ? (
                  <View style={[styles.highlightTag, { backgroundColor: 'rgba(255, 213, 0, 0.12)', borderColor: 'rgba(255, 213, 0, 0.4)' }]}>
                    <Icon name="highlighter" size={11} color="#8a6d00" />
                    <Text style={{ color: '#8a6d00', fontWeight: '700', fontSize: fs(10.5), marginLeft: 4 }}>
                      Contains a highlighted section
                    </Text>
                  </View>
                ) : null}
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
              <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12.5) }]}>
                  {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
                </Text>
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

// Small circular badge showing who shared a folder -- their photo if set,
// else their chosen preset (vector icon+color, see avatarPresets.ts), else an
// initial -- same three-way fallback used everywhere else in the app
// (Drawer, My Account), sourced from get_shared_folder_owners since a
// collaborator's own avatar/preset picks are otherwise invisible to RLS.
function OwnerAvatar({
  cacheKey,
  avatarUrl,
  presetId,
  name,
  tokens,
  fs,
}: {
  cacheKey: string
  avatarUrl?: string | null
  presetId?: string | null
  name?: string | null
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const initial = name ? name.charAt(0).toUpperCase() : '?'
  const preset = getAvatarPreset(presetId)
  // Cached by folder id (not the owner's user id, which this screen never
  // sees) -- still gives the same "download once, show instantly, refresh
  // in the background" behavior as the user's own avatar elsewhere. Presets
  // never go through this cache -- pure vector icon+color, no network fetch.
  const cachedUrl = useCachedImage(avatarUrl ? `folder_owner_${cacheKey}` : null, avatarUrl ?? null)
  return cachedUrl ? (
    <Image source={{ uri: cachedUrl }} style={styles.ownerAvatarImg} />
  ) : preset ? (
    <View style={[styles.ownerAvatarFallback, { backgroundColor: preset.color }]}>
      <Icon name={preset.icon} size={16} color="#fff" />
    </View>
  ) : (
    <View style={[styles.ownerAvatarFallback, { backgroundColor: tokens.blu }]}>
      <Text style={[styles.ownerAvatarText, { fontSize: fs(13) }]}>{initial}</Text>
    </View>
  )
}

// Full wall for a Pro-gated tab, matching the pattern already used by the
// whole Notes tab and the Offline sub-tab -- viewing/organizing existing
// bookmarks or folders is the Pro feature just as much as creating new ones,
// so a downgraded user gets the same "upgrade to see this" treatment here
// instead of free continued access to whatever they saved while still Pro.
function ProWall({ tokens, label }: { tokens: ReturnType<typeof useTheme>['tokens']; label: string }) {
  const fs = useFS()
  return (
    <View style={styles.center}>
      <Icon name="lock.fill" size={36} color={tokens.blu} />
      <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>{label} is a Pro feature</Text>
      <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
        Upgrade to Pro to unlock {label.toLowerCase()}.
      </Text>
      <Pressable
        style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
        onPress={() => router.push('/paywall')}
      >
        <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Upgrade to Pro</Text>
      </Pressable>
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
  sharedList: { padding: 16, gap: 10 },
  sharedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sharedRowText: { fontWeight: '600' },
  sharedRowSub: { marginTop: 2 },
  ownerAvatarImg: { width: 30, height: 30, borderRadius: 15 },
  ownerAvatarFallback: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  ownerAvatarText: { color: '#fff', fontWeight: '700' },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8, textAlign: 'center' },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, marginTop: 4, maxWidth: 300 },
  upgradeBtn: { marginTop: 8, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28 },
  upgradeBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
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

  subSegWrap: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 10, alignItems: 'center' },
  subSeg: {
    flexDirection: 'row',
    borderRadius: 9,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 2,
    gap: 2,
  },
  subSegBtn: { paddingHorizontal: 16, paddingVertical: 6, borderRadius: 7 },
  subSegText: { fontSize: 12.5, fontWeight: '600' },

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
  rowNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  rowBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
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
  highlightTag: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  staleTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },

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
