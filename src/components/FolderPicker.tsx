import React, { useState, useEffect, useRef } from 'react'
import { Modal, View, Text, FlatList, Pressable, TextInput, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { Icon } from '@/components/Icon'
import {
  getFolders,
  getFoldersForItem,
  getFolderItemCounts,
  addToFolder,
  removeFromFolder,
  createFolder,
  Folder,
  FolderItemType,
  DUPLICATE_FOLDER_NAME,
  PRO_FOLDER_CAP,
} from '@/lib/folders'
import {
  getMyCollaborations,
  addExistingItemToSharedFolder,
  removeExistingItemFromSharedFolder,
  getSharedFolderMembership,
  SharedFolderSummary,
  SEED_NOTE_NOT_SHAREABLE,
} from '@/lib/sharedFolders'
import { addManyBookmarks, BookmarkAC } from '@/lib/bookmarks'
import { useConfirm } from '@/components/ConfirmDialog'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// BB-082: a folder shared with you (with read/write access) previously
// couldn't appear here at all -- this picker only ever called getFolders()
// (this account's own local folders), so a folder you'd joined literally
// had no way to show up, even though the server-side RLS already fully
// supports a read_write collaborator inserting into it
// (editors_manage_shared_folder_items, see sharedFolders.ts). Read-only
// collaborations are deliberately excluded -- offering a folder here that
// would just fail on tap is worse than not showing it.
type PickerRow = { kind: 'own'; folder: Folder } | { kind: 'shared'; folder: SharedFolderSummary }

interface Props {
  visible: boolean
  itemType: FolderItemType
  itemId: string
  onClose: () => void
  /** Called on close with a ready-to-show confirmation message, only if at
   * least one folder was added to during this session (not on remove-only,
   * not if nothing changed). */
  onAdded?: (message: string) => void
  /** Display metadata for this item, needed ONLY when it isn't already
   * guaranteed to be a bookmark (e.g. opened from Recents or Offline
   * downloads, as opposed to the Saved > All list itself). If the item isn't
   * already bookmarked, adding it to a folder also ensures a bookmark exists
   * using this data — the folder-detail screen resolves any non-'note' item's
   * title/label via the bookmarks list, so without this a folder item added
   * from a non-bookmark source silently disappears from its own folder (and
   * gets permanently pruned by the orphaned-item self-heal in folder/[id].tsx).
   * Omit when itemType is 'note', or when the item is already known to be a
   * bookmark (harmless to pass anyway -- addManyBookmarks no-ops if already
   * present). itemType is threaded onto the bookmark automatically -- never
   * include it in the object passed here. */
  acMeta?: Omit<BookmarkAC, 'id' | 'savedAt' | 'itemType'>
}

export function FolderPicker({ visible, itemType, itemId, onClose, onAdded, acMeta }: Props) {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { hasPlusAccess, hasProAccess, isPremium } = useAuth()
  // Plus and Pro share the same folder cap (PRO_FOLDER_CAP) -- the
  // "you've hit the cap" messaging below needs the reader's OWN current
  // plan name, not a hardcoded "Pro" that would misname it for a Plus
  // subscriber hitting the identical limit. Matches saved.tsx's planName.
  const planName = hasProAccess ? 'Pro' : 'Plus'
  const [folders, setFolders] = useState<Folder[]>([])
  // Folder names (user-created) can run long and get cut off the same way
  // FAR Part titles do -- same hook/card pair as far/index.tsx's own
  // long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()
  // Found in the 2026-08-14 night-rules gating sweep: this picker listed
  // EVERY own folder as a normal tap target, including ones over a
  // downgraded user's cap -- tapping one silently no-op'd server-side
  // (the RLS fix earlier that same night), which is exactly the "offer a
  // folder that would just fail on tap" problem this file's own BB-082
  // comment already identified and solved for read-only shared folders,
  // just not for over-cap own folders. getFolders() is already sorted by
  // sort_order (see lib/folders.ts), matching saved.tsx's own
  // `folders.slice(0, folderCap)` exactly, so slicing the same way here
  // keeps "which folders are usable" consistent between the two screens.
  const folderCap = isPremium ? Infinity : PRO_FOLDER_CAP
  const visibleFolders = folders.slice(0, folderCap)
  const lockedFolderCount = folders.length - visibleFolders.length
  const [sharedFolders, setSharedFolders] = useState<SharedFolderSummary[]>([])
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({})
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set())
  const [addedNames, setAddedNames] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  // BB-070 audit: handleCreate is reachable from BOTH the TextInput's
  // onSubmitEditing (hitting Return) and the Create button's onPress --
  // hitting Return then tapping Create before the first request resolves
  // fired createFolder() twice, matching the same double-tap-race class of
  // bug already fixed for printReg.ts (BB-083) and ReminderFormModal
  // (BB-094).
  const [submittingCreate, setSubmittingCreate] = useState(false)
  const inputRef = useRef<TextInput>(null)

  useEffect(() => {
    if (!visible) return
    // Folders are a Plus feature end-to-end, not just creation -- a user who
    // downgraded after already having folders could otherwise keep adding to
    // them via this picker (opened from Saved, Recents, and AC detail) with
    // no gate at all, since only the "New Folder" button below checked hasPlusAccess.
    // This is only a backstop -- every call site should gate synchronously
    // before ever setting visible=true (see recents.tsx's handleFolder). A
    // delayed setTimeout(...) push used to live here instead of an immediate
    // one; a second tap shortly after the first, while that delayed push was
    // still pending, landed mid-close and silently no-op'd (BB-006).
    if (!hasPlusAccess) {
      onClose()
      router.push('/paywall?tier=plus')
      return
    }
    setAddedNames([])
    load()
  }, [visible, itemId, hasPlusAccess])

  useEffect(() => {
    if (creating) setTimeout(() => inputRef.current?.focus(), 80)
  }, [creating])

  const load = async () => {
    const [allFolders, memberFolderIds, counts, collaborations] = await Promise.all([
      getFolders(),
      getFoldersForItem(itemType, itemId),
      getFolderItemCounts(),
      getMyCollaborations(),
    ])
    const writable = collaborations.filter((c) => c.collabMode === 'read_write')
    setFolders(allFolders)
    setSharedFolders(writable)
    setMemberIds(new Set(memberFolderIds))
    setItemCounts(counts)
    if (writable.length) {
      const foreignMembers = await getSharedFolderMembership(writable.map((w) => w.folder_id), itemType, itemId)
      setMemberIds((prev) => new Set([...prev, ...foreignMembers]))
    }
  }

  // Multi-select: tapping a folder toggles membership without closing, so
  // the user can add to several folders in one visit. The sheet only closes
  // via Done (or the backdrop/X), at which point a single summarized toast
  // fires for everything added this session.
  const toggle = async (folder: Folder) => {
    if (memberIds.has(folder.id)) {
      await removeFromFolder(folder.id, itemType, itemId)
      setMemberIds((prev) => { const s = new Set(prev); s.delete(folder.id); return s })
      setAddedNames((prev) => prev.filter((n) => n !== folder.name))
      setItemCounts((prev) => ({ ...prev, [folder.id]: Math.max(0, (prev[folder.id] ?? 1) - 1) }))
    } else {
      if (acMeta) await addManyBookmarks([{ id: itemId, itemType, ...acMeta }])
      await addToFolder(folder.id, itemType, itemId)
      setMemberIds((prev) => new Set([...prev, folder.id]))
      setAddedNames((prev) => [...prev, folder.name])
      setItemCounts((prev) => ({ ...prev, [folder.id]: (prev[folder.id] ?? 0) + 1 }))
    }
  }

  // Foreign-folder counterpart to toggle() -- no acMeta/addManyBookmarks step
  // here: a foreign folder's contents resolve on the OWNER's side via
  // resolveForeignFolderEntries reading the real content tables directly,
  // never through MY bookmarks, so there's nothing local to seed.
  const toggleShared = async (folder: SharedFolderSummary) => {
    const id = folder.folder_id
    if (memberIds.has(id)) {
      await removeExistingItemFromSharedFolder(id, itemType, itemId)
      setMemberIds((prev) => { const s = new Set(prev); s.delete(id); return s })
      setAddedNames((prev) => prev.filter((n) => n !== folder.folder_name))
    } else {
      try {
        await addExistingItemToSharedFolder(id, itemType, itemId)
      } catch (e) {
        if (e instanceof Error && e.message === SEED_NOTE_NOT_SHAREABLE) {
          confirm({ title: "Can't Share This Note", message: 'This is one of the starter demo notes -- create your own note to share into this folder.', cancelLabel: null })
          return
        }
        throw e
      }
      setMemberIds((prev) => new Set([...prev, id]))
      setAddedNames((prev) => [...prev, folder.folder_name])
    }
  }

  const handleCreate = async () => {
    if (submittingCreate) return
    const name = newName.trim()
    if (!name) return
    setSubmittingCreate(true)
    try {
      await doCreate(name)
    } finally {
      setSubmittingCreate(false)
    }
  }

  const doCreate = async (name: string) => {
    // Plus/Pro are both capped at PRO_FOLDER_CAP folders, Premium unlimited --
    // same rule saved.tsx's own "New Folder" enforces (see PRO_FOLDER_CAP in
    // lib/folders.ts). This picker had no cap check at all, so a user
    // could keep creating folders past 3 from any detail screen's "Add to
    // Folder" menu, bypassing the exact upgrade lever the paywall advertises.
    if (!isPremium && folders.length >= PRO_FOLDER_CAP) {
      setCreating(false)
      confirm({
        title: 'Folder limit reached',
        message: `${planName} includes ${PRO_FOLDER_CAP} folders. Upgrade to Premium for unlimited.`,
        confirmLabel: 'Upgrade to Premium',
        onConfirm: () => { handleClose(); router.push('/paywall?tier=premium') },
      })
      return
    }
    let folder: Folder
    try {
      folder = await createFolder(name)
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        confirm({ title: 'Folder already exists', message: `You already have a folder named "${name}". Choose a different name.`, cancelLabel: null })
        return
      }
      throw e
    }
    if (acMeta) await addManyBookmarks([{ id: itemId, itemType, ...acMeta }])
    await addToFolder(folder.id, itemType, itemId)
    setFolders((prev) => [...prev, folder])
    setMemberIds((prev) => new Set([...prev, folder.id]))
    setAddedNames((prev) => [...prev, folder.name])
    setItemCounts((prev) => ({ ...prev, [folder.id]: 1 }))
    setNewName('')
    setCreating(false)
  }

  const cancelCreate = () => { setCreating(false); setNewName('') }

  const handleClose = () => {
    if (addedNames.length === 1) onAdded?.(`Added to ${addedNames[0]}`)
    else if (addedNames.length > 1) onAdded?.('Added to multiple folders')
    setCreating(false)
    setNewName('')
    onClose()
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.avoidingView}
      >
        <Pressable style={[StyleSheet.absoluteFill, styles.backdrop]} onPress={handleClose} />
        <View style={[styles.sheet, { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr2 }]}>
          {/* Grip */}
          <View style={styles.gripRow}>
            <View style={[styles.grip, { backgroundColor: tokens.t3 }]} />
          </View>

          {/* Header */}
          <View style={[styles.header, { borderBottomColor: tokens.bdr }]}>
            <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(15) }]}>Add to Folder(s)</Text>
            <Pressable onPress={handleClose} style={[styles.doneBtn, { backgroundColor: tokens.blu }]} hitSlop={4}>
              <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Done</Text>
            </Pressable>
          </View>

          {/* Folder list -- own folders first, then any read/write shared-with-me
              folders (BB-082). Single FlatList (not two nested lists) so the
              sheet scrolls as one unit. */}
          {visibleFolders.length === 0 && sharedFolders.length === 0 && !creating ? (
            <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13) }]}>
              No folders yet — create one below.
            </Text>
          ) : (
            <FlatList
              data={[
                ...visibleFolders.map((f): PickerRow => ({ kind: 'own', folder: f })),
                ...sharedFolders.map((f): PickerRow => ({ kind: 'shared', folder: f })),
              ]}
              ListFooterComponent={
                lockedFolderCount > 0 ? (
                  <Text style={[styles.lockedNote, { color: tokens.t3, fontSize: fs(12) }]}>
                    {lockedFolderCount} folder{lockedFolderCount === 1 ? '' : 's'} not shown — over your plan's folder limit.
                  </Text>
                ) : null
              }
              keyExtractor={(row) => (row.kind === 'own' ? row.folder.id : row.folder.folder_id)}
              style={styles.list}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              renderItem={({ item: row }) => {
                if (row.kind === 'own') {
                  const item = row.folder
                  const isMember = memberIds.has(item.id)
                  return (
                    <Pressable
                      style={[styles.folderRow, { borderBottomColor: tokens.bdr }]}
                      onPress={() => {
                        if (consumeLongPress()) return
                        toggle(item)
                      }}
                      onLongPress={(e) => showPreview(item.name, e)}
                      onPressOut={hidePreview}
                      delayLongPress={350}
                    >
                      <Icon
                        name={isMember ? 'folder.fill' : 'folder'}
                        size={fs(19)}
                        color={isMember ? tokens.blu : tokens.t3}
                      />
                      <View style={styles.folderNameRow}>
                        <Text style={[styles.folderName, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                          {item.name}
                        </Text>
                        {!!itemCounts[item.id] && (
                          <Text style={[styles.folderCount, { color: tokens.t3, fontSize: fs(13) }]}>
                            ({itemCounts[item.id]})
                          </Text>
                        )}
                      </View>
                      {isMember && (
                        <Icon name="checkmark" size={fs(14)} color={tokens.blu} />
                      )}
                    </Pressable>
                  )
                }
                const item = row.folder
                const isMember = memberIds.has(item.folder_id)
                return (
                  <Pressable
                    style={[styles.folderRow, { borderBottomColor: tokens.bdr }]}
                    onPress={() => {
                      if (consumeLongPress()) return
                      toggleShared(item)
                    }}
                    onLongPress={(e) => showPreview(item.folder_name, e)}
                    onPressOut={hidePreview}
                    delayLongPress={350}
                  >
                    <Icon
                      name={isMember ? 'folder.fill' : 'folder'}
                      size={fs(19)}
                      color={isMember ? tokens.blu : tokens.t3}
                    />
                    <View style={styles.folderNameRow}>
                      <Text style={[styles.folderName, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                        {item.folder_name}
                      </Text>
                      {!!item.ownerDisplayName && (
                        <Text style={[styles.folderCount, { color: tokens.t3, fontSize: fs(12) }]} numberOfLines={1}>
                          Shared by {item.ownerDisplayName}
                        </Text>
                      )}
                    </View>
                    {isMember && (
                      <Icon name="checkmark" size={fs(14)} color={tokens.blu} />
                    )}
                  </Pressable>
                )
              }}
            />
          )}

          {/* Create row */}
          {creating ? (
            <View style={[styles.createRow, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
              <TextInput
                ref={inputRef}
                style={[styles.nameInput, { color: tokens.t1, borderColor: tokens.bdr2, backgroundColor: tokens.inp ?? tokens.bg, fontSize: ifs(14) }]}
                placeholder="Folder name"
                placeholderTextColor={tokens.t3}
                value={newName}
                onChangeText={setNewName}
                returnKeyType="done"
                onSubmitEditing={handleCreate}
                maxLength={60}
              />
              <Pressable
                onPress={handleCreate}
                disabled={submittingCreate}
                style={[styles.createBtn, { backgroundColor: tokens.blu, opacity: newName.trim() && !submittingCreate ? 1 : 0.5 }]}
              >
                <Text style={[styles.createBtnText, { fontSize: fs(13) }]}>Create</Text>
              </Pressable>
              <Pressable onPress={cancelCreate} hitSlop={8}>
                <Icon name="xmark" size={fs(15)} color={tokens.t3} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              style={[styles.newFolderRow, { borderTopColor: tokens.bdr }]}
              onPress={() => {
                if (!hasPlusAccess) { handleClose(); router.push('/paywall?tier=plus'); return }
                setCreating(true)
              }}
            >
              <Icon name="folder.badge.plus" size={fs(19)} color={tokens.blu} />
              <Text style={[styles.newFolderText, { color: tokens.blu, fontSize: fs(14.5) }]}>New Folder</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  avoidingView: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    maxHeight: '70%',
    marginBottom: 100,
  },
  gripRow: { alignItems: 'center', paddingTop: 10, paddingBottom: 4 },
  grip: { width: 38, height: 4, borderRadius: 2 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { flex: 1, fontWeight: '600', fontSize: 15 },
  doneBtn: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  doneBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  list: { maxHeight: 300 },
  emptyText: { fontSize: 13, textAlign: 'center', paddingVertical: 24, paddingHorizontal: 20 },
  lockedNote: { textAlign: 'center', paddingVertical: 12, paddingHorizontal: 20 },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  folderNameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  folderName: { flexShrink: 1, fontSize: 14.5, fontWeight: '500' },
  folderCount: { fontSize: 13, fontWeight: '500' },
  newFolderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
  newFolderText: { fontSize: 14.5, fontWeight: '600' },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  nameInput: {
    flex: 1,
    height: 38,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  createBtn: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  createBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
})
