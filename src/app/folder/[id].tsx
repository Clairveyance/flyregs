import { useState, useCallback, useRef, useEffect } from 'react'
import {
  View,
  Text,
  SectionList,
  Pressable,
  TextInput,
  Alert,
  Share,
  StyleSheet,
  Animated,
  PanResponder,
} from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import {
  getFolders,
  getItemsInFolder,
  renameFolder,
  deleteFolder,
  removeFromFolder,
  removeManyFromFolder,
  addToFolder,
  Folder,
  FolderItem,
  DUPLICATE_FOLDER_NAME,
} from '@/lib/folders'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { getBookmarks, BookmarkAC } from '@/lib/bookmarks'
import { useShareActions } from '@/lib/share'
import { getOrCreateShareLink, getFolderCollaborators, removeCollaborator, FolderCollaborator } from '@/lib/sharedFolders'
import { isSyncEnabled } from '@/lib/sync'
import { isOcrScanned } from '@/lib/ocrScannedACs'

// ── Local Note type (mirrors notes.tsx — local-first AsyncStorage notes) ──────
interface Note {
  id: string
  title: string
  body: string
  linked_ac: string | null
  updated_at: string
}

const NOTES_KEY = '@flyregs/notes'

// ── Unified entry for the mixed-content list ──────────────────────────────────
type ACEntry  = { kind: 'ac';   data: BookmarkAC;  folderItem: FolderItem }
type NoteEntry = { kind: 'note'; data: Note;        folderItem: FolderItem }
type Entry = ACEntry | NoteEntry

export default function FolderDetail() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPremium } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const { shareAC, shareNote } = useShareActions()
  const { id } = useLocalSearchParams<{ id: string }>()

  const [folder, setFolder] = useState<Folder | null>(null)
  const [acEntries, setAcEntries] = useState<ACEntry[]>([])
  // Same live-lookup as Saved/Recents -- folder items resolve through local
  // bookmark snapshots with no cancels/changed_block_indices of their own.
  const [badgeDataById, setBadgeDataById] = useState<Record<string, {
    cancels: string[]
    changed_block_indices: number[] | null
    date_issued: string | null
    document_number: string
  }>>({})
  const [noteEntries, setNoteEntries] = useState<NoteEntry[]>([])

  const [renaming, setRenaming] = useState(false)
  const [renameText, setRenameText] = useState('')
  const [dismissTop, setDismissTop] = useState(0)
  const [collaborators, setCollaborators] = useState<FolderCollaborator[]>([])
  const [collabExpanded, setCollabExpanded] = useState(false)

  const load = useCallback(async () => {
    const [folders, items, bookmarks, notesRaw] = await Promise.all([
      getFolders(),
      getItemsInFolder(id),
      getBookmarks(),
      AsyncStorage.getItem(NOTES_KEY),
    ])

    const thisFolder = folders.find((f) => f.id === id) ?? null
    setFolder(thisFolder)

    const notes: Note[] = notesRaw ? JSON.parse(notesRaw) : []
    const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
    const noteMap = new Map(notes.map((n) => [n.id, n]))

    const acs: ACEntry[] = []
    const notesList: NoteEntry[] = []
    const orphaned: FolderItem[] = []

    for (const item of items) {
      if (item.item_type === 'ac') {
        const bm = bookmarkMap.get(item.item_id)
        if (bm) acs.push({ kind: 'ac', data: bm, folderItem: item })
        else orphaned.push(item)
      } else {
        const note = noteMap.get(item.item_id)
        if (note) notesList.push({ kind: 'note', data: note, folderItem: item })
        else orphaned.push(item)
      }
    }

    setAcEntries(acs)
    setNoteEntries(notesList)

    // Self-heal: a folder_item pointing at an AC/note that was unbookmarked or
    // deleted elsewhere (before removeItemFromAllFolders existed to prevent
    // this) lingers and inflates the folder's shown count in Saved without
    // ever appearing here. Prune it now that we've confirmed its target is
    // really gone, so the count is correct the next time Saved loads.
    if (typeof id === 'string' && orphaned.length) {
      removeManyFromFolder(id, orphaned.map((o) => ({ itemType: o.item_type, itemId: o.item_id }))).catch(() => {})
    }

    // Only owned, previously-shared folders have collaborators to show — a
    // folder that's never been shared has no share_token and this RPC just
    // returns an empty list, so it's safe to always attempt.
    if (typeof id === 'string') {
      getFolderCollaborators(id).then(setCollaborators).catch(() => setCollaborators([]))
    }
  }, [id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  useEffect(() => {
    const ids = [...new Set(acEntries.map((e) => e.data.acId ?? e.data.id))]
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
  }, [acEntries])

  const startRename = () => {
    if (!folder) return
    setRenameText(folder.name)
    setRenaming(true)
  }

  const handleRename = async () => {
    if (!renameText.trim() || !folder) { setRenaming(false); return }
    try {
      await renameFolder(folder.id, renameText.trim())
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        Alert.alert('Folder Already Exists', `You already have a folder named "${renameText.trim()}". Choose a different name.`)
        return
      }
      throw e
    }
    setFolder((f) => f ? { ...f, name: renameText.trim() } : f)
    setRenaming(false)
  }

  const cancelRename = () => setRenaming(false)

  const handleDeleteFolder = () => {
    if (!folder) return
    Alert.alert(
      'Delete Folder',
      `Delete "${folder.name}"? The ACs and notes inside will not be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteFolder(folder.id)
            router.back()
          },
        },
      ]
    )
  }

  const handleRemove = (item: FolderItem) => {
    const label = item.item_type === 'ac' ? 'this AC' : 'this note'
    Alert.alert('Remove from Folder', `Remove ${label} from the folder?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeFromFolder(folder!.id, item.item_type, item.item_id)
          if (item.item_type === 'ac') {
            setAcEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
          } else {
            setNoteEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
          }
        },
      },
    ])
  }

  const [moveItem, setMoveItem] = useState<FolderItem | null>(null)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')

  const handleMove = (item: FolderItem) => setMoveItem(item)

  const handleConfirmMove = async (destFolderIds: string[]) => {
    if (!moveItem || !folder) { setMoveItem(null); return }
    const item = moveItem
    setMoveItem(null)
    // Sequential, not Promise.all -- addToFolder/removeFromFolder each do their
    // own read-modify-write on the shared folder_items list (see folders.ts).
    for (const destId of destFolderIds) {
      await addToFolder(destId, item.item_type, item.item_id)
    }
    await removeFromFolder(folder.id, item.item_type, item.item_id)
    if (item.item_type === 'ac') {
      setAcEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
    } else {
      setNoteEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
    }
    // Confirm WHERE it actually landed -- without this the item just
    // silently vanished from the list on Done, with no visible cue of which
    // folder it moved to (matching the same "Added to X" pattern used for
    // adding to a folder elsewhere in the app, just worded for a move).
    const allFolders = await getFolders()
    const names = destFolderIds.map((fid) => allFolders.find((f) => f.id === fid)?.name).filter(Boolean)
    setConfirmLabel(
      names.length === 1 ? `Moved to ${names[0]}` : names.length > 1 ? 'Moved to multiple folders' : 'Moved'
    )
    setConfirmTick((t) => t + 1)
  }

  const [invitingBusy, setInvitingBusy] = useState(false)

  const handleInvite = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    if (!folder) return
    if (!(await isSyncEnabled())) {
      Alert.alert(
        'Turn on Back up & sync first',
        'Inviting others requires this folder to exist in the cloud. Turn on Back up & sync in Saved, then try again.'
      )
      return
    }
    setInvitingBusy(true)
    try {
      const link = await getOrCreateShareLink(folder.id)
      await Share.share({
        message: `Join my "${folder.name}" folder on FlyRegs — view-only access to the ACs I've saved there. You'll need your own Pro or Premium subscription to read full AC text.\n\n${link}`,
      })
    } catch {
      Alert.alert('Error', 'Could not create an invite link. Try again in a moment.')
    }
    setInvitingBusy(false)
  }

  const handleRemoveCollaborator = (c: FolderCollaborator) => {
    if (!folder) return
    Alert.alert('Remove Access', `Remove ${c.email} from "${folder.name}"? They can rejoin later with a new invite link.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeCollaborator(folder.id, c.userId)
          setCollaborators((prev) => prev.filter((x) => x.userId !== c.userId))
        },
      },
    ])
  }

  const handleShareAC = (item: BookmarkAC) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareAC(item)
  }

  const handleShareNote = (note: Note) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareNote(note)
  }

  const totalCount = acEntries.length + noteEntries.length

  const sections = [
    ...(acEntries.length > 0
      ? [{ title: `SAVED ACS (${acEntries.length})`, data: acEntries as Entry[] }]
      : []),
    ...(noteEntries.length > 0
      ? [{ title: `NOTES (${noteEntries.length})`, data: noteEntries as Entry[] }]
      : []),
  ]

  const rightSlot = (
    <View style={styles.headerRight}>
      <Pressable onPress={handleInvite} hitSlop={10} style={styles.headerBtn} disabled={invitingBusy}>
        <Icon name="person.2.fill" size={fs(21)} color={tokens.t2} />
      </Pressable>
      <Pressable onPress={startRename} hitSlop={10} style={styles.headerBtn}>
        <Icon name="pencil" size={fs(21)} color={tokens.t2} />
      </Pressable>
      <Pressable onPress={handleDeleteFolder} hitSlop={10} style={styles.headerBtn}>
        <Icon name="trash" size={fs(21)} color={tokens.t4} />
      </Pressable>
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <View onLayout={(e) => setDismissTop(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <OverlayHeader
          title={folder?.name ?? 'Folder'}
          onBack={() => router.back()}
          right={rightSlot}
        />

        {/* Inline rename bar */}
        {renaming && (
          <View style={[styles.renameBar, { backgroundColor: tokens.bg2, borderBottomColor: tokens.bdr }]}>
            <TextInput
              style={[styles.renameInput, { color: tokens.t1, fontSize: fs(15) }]}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleRename}
              maxLength={60}
              placeholder="Folder name"
              placeholderTextColor={tokens.t3}
            />
            <Pressable onPress={handleRename} hitSlop={8}>
              <Icon name="checkmark.circle.fill" size={22} color={tokens.blu} />
            </Pressable>
            <Pressable onPress={() => setRenameText('')} hitSlop={8}>
              <Icon name="xmark.circle.fill" size={22} color={tokens.t3} />
            </Pressable>
          </View>
        )}
      </View>

      {collaborators.length > 0 && (
        <View style={[styles.collabSection, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}>
          <Pressable style={styles.collabHeader} onPress={() => setCollabExpanded((v) => !v)}>
            <Icon name="person.2.fill" size={15} color={tokens.t2} />
            <Text style={[styles.collabHeaderText, { color: tokens.t2, fontSize: fs(13) }]}>
              {collaborators.length} {collaborators.length === 1 ? 'person has' : 'people have'} joined
            </Text>
            <Icon name={collabExpanded ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t3} />
          </Pressable>
          {collabExpanded && collaborators.map((c) => (
            <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr }]}>
              <Text style={[styles.collabEmail, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                {c.email}
              </Text>
              <Pressable onPress={() => handleRemoveCollaborator(c)} hitSlop={8}>
                <Icon name="xmark.circle" size={18} color={tokens.t4} />
              </Pressable>
            </View>
          ))}
        </View>
      )}

      {totalCount === 0 ? (
        <View style={styles.empty}>
          <Icon name="folder" size={40} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Folder is empty</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Add ACs from the Saved tab or notes from the Notes tab using the folder icon on each card.
          </Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.folderItem.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11) }]}>{section.title}</Text>
          )}
          renderItem={({ item }) =>
            item.kind === 'ac' ? (
              <SwipeableACRow
                entry={item}
                tokens={tokens}
                badgeData={badgeDataById[item.data.acId ?? item.data.id]}
                badgeDays={badgeDays}
                onPress={() => router.push(
                  item.data.blockText
                    ? `/ac/${item.data.acId}?hlId=${encodeURIComponent(item.data.id)}`
                    : `/ac/${item.data.acId ?? item.data.id}`
                )}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareAC(item.data)}
              />
            ) : (
              <SwipeableNoteRow
                entry={item}
                tokens={tokens}
                onPress={() => router.push({ pathname: '/(tabs)/notes', params: { openId: item.data.id } })}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareNote(item.data)}
              />
            )
          }
        />
      )}

      {/* Tapping anywhere below the header/rename-bar while renaming cancels
          the edit without saving -- sits on top of the list so it also
          blocks accidentally opening an item mid-rename. */}
      {renaming && (
        <Pressable
          style={[StyleSheet.absoluteFill, { top: dismissTop }]}
          onPress={cancelRename}
        />
      )}

      <FolderSelectSheet
        visible={moveItem !== null}
        title="Move to Folder"
        excludeFolderId={folder?.id}
        onConfirm={handleConfirmMove}
        onClose={() => setMoveItem(null)}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

// ── Swipeable AC row ──────────────────────────────────────────────────────────

function SwipeableACRow({
  entry, tokens, badgeData, badgeDays, onPress, onRemove, onMove, onShare,
}: {
  entry: ACEntry
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeData?: { cancels: string[]; changed_block_indices: number[] | null; date_issued: string | null; document_number: string }
  badgeDays: number
  onPress: () => void
  onRemove: () => void
  onMove: () => void
  onShare: () => void
}) {
  const fs = useFS()
  const translateX = useRef(new Animated.Value(0)).current
  const swiped = useRef(false)

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        translateX.setValue(Math.min(0, Math.max(-84, g.dx)))
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -42) {
          Animated.spring(translateX, { toValue: -76, useNativeDriver: true, damping: 18, stiffness: 280 }).start()
          swiped.current = true
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 280 }).start()
          swiped.current = false
        }
      },
    })
  ).current

  const handlePress = () => {
    if (swiped.current) {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start()
      swiped.current = false
    } else {
      onPress()
    }
  }

  const { data: item } = entry

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.removeBg}>
        <Pressable style={styles.removeAction} onPress={() => {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start()
          swiped.current = false
          onRemove()
        }}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
        <Pressable
          style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={handlePress}
        >
          <View style={[styles.typeBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
            <Text style={[styles.typeBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>AC</Text>
          </View>
          <View style={styles.rowBody}>
            <View style={styles.rowNumBadgeWrap}>
              <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12) }]}>
                {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
              </Text>
              {badgeData && isWithinBadgeLifespan(badgeData.date_issued, badgeDays) && (() => {
                const badge = getBadgeStyle(getBadgeKind(badgeData), tokens)
                return (
                  <View style={[styles.rowNumBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
                    <Text style={[styles.rowNumBadgeText, { color: badge.color, fontSize: fs(8) }]}>{badge.label}</Text>
                  </View>
                )
              })()}
            </View>
            <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>{item.title}</Text>
            {item.office && (
              <Text style={[styles.rowMeta, { color: tokens.t4, fontSize: fs(11) }]}>{item.office}</Text>
            )}
          </View>
          <Pressable onPress={onMove} hitSlop={8} style={styles.rowShareBtn}>
            <Icon name="folder" size={fs(17)} color={tokens.t3} />
          </Pressable>
          <Pressable onPress={onShare} hitSlop={8} style={styles.rowShareBtn}>
            <Icon name="square.and.arrow.up" size={fs(17)} color={tokens.t3} />
          </Pressable>
        </Pressable>
      </Animated.View>
    </View>
  )
}

// ── Swipeable Note row ────────────────────────────────────────────────────────

function SwipeableNoteRow({
  entry, tokens, onPress, onRemove, onMove, onShare,
}: {
  entry: NoteEntry
  tokens: ReturnType<typeof useTheme>['tokens']
  onPress: () => void
  onRemove: () => void
  onMove: () => void
  onShare: () => void
}) {
  const fs = useFS()
  const translateX = useRef(new Animated.Value(0)).current
  const swiped = useRef(false)

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        translateX.setValue(Math.min(0, Math.max(-84, g.dx)))
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -42) {
          Animated.spring(translateX, { toValue: -76, useNativeDriver: true, damping: 18, stiffness: 280 }).start()
          swiped.current = true
        } else {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, damping: 18, stiffness: 280 }).start()
          swiped.current = false
        }
      },
    })
  ).current

  const handlePress = () => {
    if (swiped.current) {
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start()
      swiped.current = false
    } else {
      onPress()
    }
  }

  const { data: note } = entry

  function timeAgo(iso: string): string {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    const days = Math.floor(secs / 86400)
    if (days === 1) return 'yesterday'
    if (days < 7) return `${days} days ago`
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.removeBg}>
        <Pressable style={styles.removeAction} onPress={() => {
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start()
          swiped.current = false
          onRemove()
        }}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>
      <Animated.View style={{ transform: [{ translateX }] }} {...pan.panHandlers}>
        <Pressable
          style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={handlePress}
        >
          <View style={[styles.typeBadge, { backgroundColor: tokens.gdim ?? 'rgba(52,211,153,.10)', borderColor: tokens.gbdr ?? 'rgba(52,211,153,.24)' }]}>
            <Text style={[styles.typeBadgeText, { color: tokens.grn, fontSize: fs(9.5) }]}>NOTE</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
              {note.title || 'Untitled'}
            </Text>
            <Text style={[styles.rowPreview, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={2}>
              {note.body}
            </Text>
            <View style={styles.rowFooter}>
              <Text style={[styles.rowMeta, { color: tokens.t4, fontSize: fs(11) }]}>{timeAgo(note.updated_at)}</Text>
              {note.linked_ac && (
                <View style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                  <Icon name="link" size={9} color={tokens.blu} />
                  <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {note.linked_ac}</Text>
                </View>
              )}
            </View>
          </View>
          <Pressable onPress={onMove} hitSlop={8} style={styles.rowShareBtn}>
            <Icon name="folder" size={fs(17)} color={tokens.t3} />
          </Pressable>
          <Pressable onPress={onShare} hitSlop={8} style={styles.rowShareBtn}>
            <Icon name="square.and.arrow.up" size={fs(17)} color={tokens.t3} />
          </Pressable>
        </Pressable>
      </Animated.View>
    </View>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerBtn: { padding: 6 },

  collabSection: { marginHorizontal: 16, marginTop: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  collabHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  collabHeaderText: { flex: 1, fontWeight: '600' },
  collabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  collabEmail: { flex: 1 },

  renameBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  renameInput: { flex: 1, fontSize: 15, fontWeight: '500', paddingVertical: 2 },

  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8, textAlign: 'center' },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 300 },

  list: { padding: 12, paddingBottom: 40 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    marginTop: 8,
    marginBottom: 6,
    paddingLeft: 2,
  },

  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  removeBg: {
    position: 'absolute',
    top: 0, bottom: 0, right: 0,
    width: 76,
    backgroundColor: '#F87171',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeAction: {
    flex: 1, width: '100%',
    justifyContent: 'center', alignItems: 'center',
  },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 12 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
  },
  rowShareBtn: { padding: 6, flexShrink: 0 },
  typeBadge: {
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  typeBadgeText: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.4 },
  rowBody: { flex: 1, gap: 3 },
  acNum: { fontWeight: '700', fontSize: 12 },
  rowNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowNumBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  rowNumBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  rowTitle: { fontWeight: '500', fontSize: 14, lineHeight: 20 },
  rowPreview: { fontSize: 12.5, lineHeight: 18 },
  rowFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  rowMeta: { fontSize: 11 },
  acChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    borderRadius: 6, borderWidth: 1,
    paddingHorizontal: 5, paddingVertical: 1,
  },
  acChipText: { fontSize: 10.5, fontWeight: '600' },
})
