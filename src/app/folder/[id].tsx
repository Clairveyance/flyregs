import { useState, useCallback, useRef, useEffect } from 'react'
import { View, Text, SectionList, Pressable, TextInput, Share, StyleSheet, Animated, PanResponder, Platform, RefreshControl } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  getFolders,
  getItemsInFolder,
  renameFolder,
  deleteFolder,
  removeFromFolder,
  removeManyFromFolder,
  addToFolder,
  removeItemsFromAllFolders,
  Folder,
  FolderItem,
  DUPLICATE_FOLDER_NAME,
} from '@/lib/folders'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { getBookmarks, routeForBookmark, bookmarkItemType, BookmarkAC } from '@/lib/bookmarks'
import { useShareActions, ShareableAC } from '@/lib/share'
import { toRegShareType } from '@/lib/regShare'
import { REG_TYPE, RegType } from '@/lib/regTypes'
import { highlightSnippet } from '@/lib/acShare'
import {
  getOrCreateShareLink, confirmFolderShared, getFolderCollaborators, removeCollaborator, FolderCollaborator,
  getFolderCollabMode, setFolderCollabMode, setCollaboratorMode, FolderCollabMode, resolveForeignFolderEntries, updateSharedNote,
  useFolderRealtime,
} from '@/lib/sharedFolders'
import { syncFolderFromCloud } from '@/lib/sync'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix, rowTitle } from '@/lib/titleFormat'
import { useConfirm } from '@/components/ConfirmDialog'
import { getNotes, saveNotes, type Note } from '@/lib/notes'
import { syncPushNote, syncPushNoteDeletes } from '@/lib/syncPush'
import { NoteEditor } from '@/components/NoteEditor'

// ── Unified entry for the mixed-content list ──────────────────────────────────
type ACEntry  = { kind: 'ac';   data: BookmarkAC;  folderItem: FolderItem }
type NoteEntry = { kind: 'note'; data: Note;        folderItem: FolderItem }
type Entry = ACEntry | NoteEntry

export default function FolderDetail() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so these confirms (and the deletes behind them) were
  // invisible and untestable in the Browser pane. See ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { isPremium } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const { shareAC, shareNote, shareReg } = useShareActions()
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
  const [collabMode, setCollabMode] = useState<FolderCollabMode>('read_only')

  // Renders local-first data immediately, no network round-trip in the way
  // of first paint. BB-076, RC real-device beta report: "all general folder
  // content needs to load faster when opening. taking too long" -- root
  // cause was `load()` AWAITING syncFolderFromCloud (a network call)
  // before even the LOCAL data below (getItemsInFolder/getBookmarks/etc,
  // already on-device) rendered, exactly the "show cached data immediately"
  // problem Home's own load() already solved for itself. `load()` below
  // still runs the cloud sync, just after this local render, then re-runs
  // this to pick up anything the sync just pulled in.
  const loadLocal = useCallback(async () => {
    const [folders, items, bookmarks, notes] = await Promise.all([
      getFolders(),
      getItemsInFolder(id),
      getBookmarks(),
      getNotes(),
    ])

    const thisFolder = folders.find((f) => f.id === id) ?? null
    setFolder(thisFolder)

    const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
    const noteMap = new Map(notes.map((n) => [n.id, n]))

    const acs: ACEntry[] = []
    const notesList: NoteEntry[] = []
    const orphaned: FolderItem[] = []
    const foreign: FolderItem[] = []

    for (const item of items) {
      // Every non-'note' item_type (ac/far/aim/pcg/ad) resolves through the
      // same bookmarks list -- checking item_type === 'note' explicitly
      // (rather than === 'ac') matters now that FAR/AIM/P-CG/AD whole-doc
      // bookmarks exist too: the old inverted check treated anything that
      // wasn't literally 'ac' as a note, so a FAR/AIM/P-CG/AD folder item
      // would find nothing in noteMap, get misclassified as orphaned, and
      // get silently self-heal-deleted below on the very next load.
      if (item.item_type === 'note') {
        const note = noteMap.get(item.item_id)
        if (note) notesList.push({ kind: 'note', data: note, folderItem: item })
        else if (!item.authorId) orphaned.push(item)
        // A foreign note not yet locally cached is a transient sync lag,
        // not orphaned -- silently skip rather than self-heal-delete it.
      } else {
        const bm = bookmarkMap.get(item.item_id)
        if (bm) acs.push({ kind: 'ac', data: bm, folderItem: item })
        // A collaborator's item was never in MY bookmarks -- expected, not
        // a sign it's gone. Resolve those separately below instead of
        // treating "not in bookmarkMap" as orphaned, which would otherwise
        // self-heal-delete every collaborator addition on the next load.
        else if (item.authorId) foreign.push(item)
        else orphaned.push(item)
      }
    }

    setNoteEntries(notesList)

    // Self-heal: a folder_item pointing at an AC/note that was unbookmarked or
    // deleted elsewhere (before removeItemFromAllFolders existed to prevent
    // this) lingers and inflates the folder's shown count in Saved without
    // ever appearing here. Prune it now that we've confirmed its target is
    // really gone, so the count is correct the next time Saved loads.
    if (typeof id === 'string' && orphaned.length) {
      removeManyFromFolder(id, orphaned.map((o) => ({ itemType: o.item_type, itemId: o.item_id }))).catch(() => {})
    }

    if (foreign.length) {
      resolveForeignFolderEntries(foreign).then((resolved) => {
        const byId = new Map(resolved.map((r) => [r.id, r]))
        const foreignEntries: ACEntry[] = foreign
          .map((item) => {
            const data = byId.get(item.item_id)
            return data ? { kind: 'ac' as const, data, folderItem: item } : null
          })
          .filter((e): e is ACEntry => e !== null)
        setAcEntries([...acs, ...foreignEntries])
      }).catch(() => setAcEntries(acs))
    } else {
      setAcEntries(acs)
    }

    // Only owned, previously-shared folders have collaborators to show — a
    // folder that's never been shared has no share_token and this RPC just
    // returns an empty list, so it's safe to always attempt.
    if (typeof id === 'string') {
      getFolderCollaborators(id).then(setCollaborators).catch(() => setCollaborators([]))
      getFolderCollabMode(id).then(setCollabMode).catch(() => {})
    }
  }, [id])

  // Pulls in anything a collaborator wrote since the last full sync --
  // getItemsInFolder/getNotes are pure local-first, so without this a
  // collaborator's write would only ever show up here after the next app
  // launch or Back-up & Sync toggle. Runs AFTER the local render above so
  // the network round-trip never blocks first paint; re-runs loadLocal
  // once it finishes so the sync's own results actually show up.
  const load = useCallback(async () => {
    await loadLocal()
    if (typeof id === 'string') {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        await syncFolderFromCloud(id, user.id).catch(() => {})
        await loadLocal()
      }
    }
  }, [id, loadLocal])

  useFocusEffect(useCallback(() => { load() }, [load]))

  // Live push on top of the pull-on-focus above -- sees a collaborator's
  // edit (item add/remove, note create/edit) while this screen is already
  // open, not just on the next focus.
  useFolderRealtime(typeof id === 'string' ? id : undefined, load)

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
        confirm({ title: 'Folder Already Exists', message: `You already have a folder named "${renameText.trim()}". Choose a different name.`, cancelLabel: null })
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
    confirm({
      title: 'Delete Folder',
      message: `Delete "${folder.name}"? The ACs and notes inside will not be deleted.`,
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await deleteFolder(folder.id)
        router.back()
      },
    })
  }

  const handleRemove = (item: FolderItem) => {
    const label = item.item_type === 'note' ? 'this note' : 'this item'
    confirm({
      title: 'Remove from Folder',
      message: `Remove ${label} from the folder? The item itself isn't deleted.`,
      confirmLabel: 'Remove',
      destructive: true,
      // Single-step: this only unfiles, it doesn't delete -- the note or AC
      // survives and can be re-added in one tap.
      twoStep: false,
      onConfirm: async () => {
        await removeFromFolder(folder!.id, item.item_type, item.item_id)
        if (item.item_type === 'note') {
          setNoteEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
        } else {
          setAcEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
        }
      },
    })
  }

  const [moveItem, setMoveItem] = useState<FolderItem | null>(null)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')
  // BB-080: tapping a note used to navigate to the Notes tab
  // (router.push({ pathname: '/(tabs)/notes', params: { openId } })), which
  // meant "back" left this folder screen entirely instead of returning to
  // it. Editing inline here instead, same NoteEditor component notes.tsx
  // uses.
  const [editorNote, setEditorNote] = useState<Note | null>(null)

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
    if (item.item_type === 'note') {
      setNoteEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
    } else {
      setAcEntries((prev) => prev.filter((e) => e.folderItem.id !== item.id))
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
    setInvitingBusy(true)
    let link: string, token: string
    try {
      ;({ link, token } = await getOrCreateShareLink(folder.id))
    } catch {
      confirm({ title: 'Error', message: 'Could not create an invite link. Try again in a moment.', cancelLabel: null })
      setInvitingBusy(false)
      return
    }
    try {
      const result = await Share.share({
        // Just the link -- the join page itself explains what it is; no
        // need to repeat that as a wall of text in the message body too.
        message: link,
      })
      // iOS reports dismissedAction when the sheet is closed without picking
      // a recipient -- don't mark this shared (and thus visible in From Me)
      // until the send actually goes through. Android's Share.share never
      // reports a dismissal (a known RN platform limitation), so there's no
      // equivalent signal to check there.
      if (Platform.OS !== 'ios' || result.action === Share.sharedAction) {
        await confirmFolderShared(folder.id, token)
      }
    } catch {
      // The link above was already created (just not yet confirmed shared)
      // -- a Share.share failure here (no share target on this platform, the
      // sheet erroring, web preview's lack of Share support) is not the
      // same failure as never having a link. Surface the real link instead
      // of a false "could not create" message that would make it look like
      // sharing is broken when it actually isn't. Previously this confirmed
      // "shared" unconditionally the moment this dialog appeared, regardless
      // of whether the person ever actually copied or sent the link -- a
      // folder the owner never really shared (dismissed this dialog without
      // touching it) still showed sharing controls with an empty roster
      // forever, no way to make them go away. Requiring the explicit "Copy
      // Link" tap ties "shared" to a real signal instead of dialog dismissal.
      confirm({
        title: 'Invite Link Ready', message: 'Copy or share this link:', linkMessage: link,
        confirmLabel: 'Copy Link', cancelLabel: 'Not Now',
        onConfirm: async () => {
          await Clipboard.setStringAsync(link)
          await confirmFolderShared(folder.id, token)
        },
      })
    }
    setInvitingBusy(false)
  }

  const handleSetCollabMode = async (mode: FolderCollabMode) => {
    if (!folder || mode === collabMode) return
    setCollabMode(mode) // optimistic -- matches this screen's other toggles
    try {
      await setFolderCollabMode(folder.id, mode)
    } catch {
      setCollabMode((prev) => (prev === mode ? collabMode : prev)) // revert on failure
      confirm({ title: 'Error', message: 'Could not update access. Try again in a moment.', cancelLabel: null })
    }
  }

  // BB-077: per-invitee, not per-folder -- one collaborator can be a viewer
  // while another on the same folder is an editor. Optimistic, matching
  // handleSetCollabMode above.
  const handleSetCollaboratorMode = async (c: FolderCollaborator, mode: FolderCollabMode) => {
    if (!folder || mode === c.collabMode) return
    setCollaborators((prev) => prev.map((x) => (x.userId === c.userId ? { ...x, collabMode: mode } : x)))
    try {
      await setCollaboratorMode(folder.id, c.userId, mode)
    } catch {
      setCollaborators((prev) => prev.map((x) => (x.userId === c.userId ? { ...x, collabMode: c.collabMode } : x)))
      confirm({ title: 'Error', message: 'Could not update access. Try again in a moment.', cancelLabel: null })
    }
  }

  const handleRemoveCollaborator = (c: FolderCollaborator) => {
    if (!folder) return
    // Same invite link works for anyone who has it, indefinitely (there's
    // no per-person one-time token) -- correcting the earlier copy here,
    // which implied a "new" link would be needed to rejoin.
    confirm({
      title: 'Remove Access',
      message: `Remove ${c.displayLabel} from "${folder.name}"? They'll need to use the invite link again to rejoin.`,
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await removeCollaborator(folder.id, c.userId)
        setCollaborators((prev) => prev.filter((x) => x.userId !== c.userId))
      },
    })
  }

  // A highlight bookmark's own `id` is synthetic, never a real
  // advisory_circulars.id -- passing it straight through built a share link
  // the recipient's app could never resolve ("AC not found"). See
  // resolveBookmarkACId's comment in lib/bookmarks.ts.
  const handleShareAC = (item: BookmarkAC) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const type = bookmarkItemType(item)
    // Non-AC folder items now route through buildRegShareLink, same as
    // Saved/Recents' own fix -- was a silent no-op before (see saved.tsx's
    // handleShare comment for the #154 process-flow audit finding).
    if (type !== 'ac') {
      const regType = toRegShareType(type)
      if (regType) shareReg({ type: regType, id: item.id, label: item.document_number, title: item.title })
      return
    }
    const shareable: ShareableAC = {
      id: item.acId ?? item.id,
      document_number: item.document_number,
      title: item.title,
      highlightSnippet: item.blockText ? highlightSnippet(item.blockText) : undefined,
    }
    shareAC(shareable)
  }

  const handleShareNote = (note: Note) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    shareNote(note)
  }

  // Mirrors notes.tsx's handleSave/deleteNote exactly -- a note pulled in
  // because a collaborator placed it in a folder THIS account owns
  // (authorId set, see sync.ts's mergeNotes) isn't mine to upsert; route
  // that edit through updateSharedNote (plain update-by-id) instead of the
  // normal syncPushNote upsert, which keys on (user_id, id) and would
  // create a duplicate row under my own id rather than update the original.
  const handleSaveNote = async (note: Note) => {
    const updated = { ...note, updated_at: new Date().toISOString() }
    const all = await getNotes()
    await saveNotes(all.map((n) => (n.id === updated.id ? updated : n)))
    setNoteEntries((prev) => prev.map((e) => (e.data.id === updated.id ? { ...e, data: updated } : e)))
    if (updated.authorId) {
      updateSharedNote(updated.id, { title: updated.title, body: updated.body })
    } else {
      syncPushNote(updated)
    }
    setEditorNote(null)
  }

  const handleDeleteNote = (note: Note) =>
    confirm({
      title: 'Delete Note',
      message: "This can't be undone.",
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        const all = await getNotes()
        await saveNotes(all.filter((n) => n.id !== note.id))
        syncPushNoteDeletes([note.id])
        removeItemsFromAllFolders('note', [note.id])
        setNoteEntries((prev) => prev.filter((e) => e.data.id !== note.id))
        setEditorNote(null)
      },
    })

  const activeCollaborators = collaborators.filter((c) => !c.leftAt)
  const leftCollaborators = collaborators.filter((c) => c.leftAt)

  const totalCount = acEntries.length + noteEntries.length

  const sections = [
    ...(acEntries.length > 0
      ? [{ title: `SAVED ITEMS (${acEntries.length})`, data: acEntries as Entry[] }]
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
              style={[styles.renameInput, { color: tokens.t1, fontSize: ifs(15) }]}
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
              <Icon name="checkmark.circle.fill" size={fs(22)} color={tokens.blu} />
            </Pressable>
            <Pressable onPress={() => setRenameText('')} hitSlop={8}>
              <Icon name="xmark.circle.fill" size={fs(22)} color={tokens.t3} />
            </Pressable>
          </View>
        )}
      </View>

      {/* Gated on the folder actually being shared (folder.shared, set the
          moment a link is first generated), not on collaborators.length --
          that used to hide this entire section, X-button and all, the
          instant a folder had 0 active members, which is the normal state
          right after sharing and before anyone's joined yet. */}
      {folder?.shared && (
        <View style={[styles.collabSection, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}>
          <Pressable style={styles.collabHeader} onPress={() => setCollabExpanded((v) => !v)}>
            <Icon name="person.2.fill" size={fs(15)} color={tokens.t2} />
            <Text style={[styles.collabHeaderText, { color: tokens.t2, fontSize: fs(13) }]}>
              {activeCollaborators.length === 0
                ? 'No one has joined yet'
                : `${activeCollaborators.length} ${activeCollaborators.length === 1 ? 'person has' : 'people have'} joined`}
            </Text>
            <Icon name={collabExpanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
          </Pressable>

          {/* This is now the DEFAULT a NEW invite link starts at, not a
              blanket setting for everyone already on the folder -- BB-077
              moved actual enforcement to a per-collaborator toggle in each
              row below, since one person may need write access while
              another should stay read-only on the same folder. Always
              visible (not gated behind expand) since it's still the first
              thing to set before sharing a link. */}
          <Text style={[styles.modeSectionLabel, { color: tokens.t3, fontSize: fs(11), borderTopColor: tokens.bdr }]}>NEW INVITES GET</Text>
          <View style={[styles.modeRow, { borderTopColor: tokens.bdr, borderTopWidth: 0, paddingTop: 0 }]}>
            <Pressable
              style={[styles.modeBtn, { backgroundColor: collabMode === 'read_only' ? tokens.bdim : 'transparent', borderColor: tokens.bbdr }]}
              onPress={() => handleSetCollabMode('read_only')}
            >
              <Icon name="eye" size={fs(13)} color={collabMode === 'read_only' ? tokens.blu : tokens.t3} />
              <Text style={[styles.modeBtnText, { color: collabMode === 'read_only' ? tokens.blu : tokens.t3, fontSize: fs(12.5) }]}>Read Only</Text>
            </Pressable>
            <Pressable
              style={[styles.modeBtn, { backgroundColor: collabMode === 'read_write' ? tokens.bdim : 'transparent', borderColor: tokens.bbdr }]}
              onPress={() => handleSetCollabMode('read_write')}
            >
              <Icon name="pencil" size={fs(13)} color={collabMode === 'read_write' ? tokens.blu : tokens.t3} />
              <Text style={[styles.modeBtnText, { color: collabMode === 'read_write' ? tokens.blu : tokens.t3, fontSize: fs(12.5) }]}>Read & Write</Text>
            </Pressable>
          </View>

          {collabExpanded && (
            <>
              {activeCollaborators.map((c) => (
                <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr }]}>
                  {/* Opened indicator: filled when they've viewed the folder
                      at least once (same field driving the With Me unread
                      dot), hollow otherwise -- lets the owner tell "joined,
                      hasn't looked yet" from "joined and has actually seen
                      it," the same distinction WhatsApp's delivered/read
                      ticks draw. There's no third "invited, hasn't joined"
                      state to show here -- a native share-sheet link genuinely
                      carries no recipient identity until someone redeems it,
                      so that state isn't something the app can know. */}
                  <Icon
                    name={c.lastViewedAt ? 'eye.fill' : 'eye.slash'}
                    size={fs(13)}
                    color={c.lastViewedAt ? tokens.grn : tokens.t4}
                  />
                  <Text style={[styles.collabEmail, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                    {c.displayLabel}
                  </Text>
                  {/* BB-077: this specific person's own access -- independent
                      of the "new invites get" default above and of any other
                      collaborator on this same folder. */}
                  <View style={[styles.collabModeToggle, { borderColor: tokens.bbdr }]}>
                    <Pressable
                      style={[styles.collabModeSeg, { backgroundColor: c.collabMode === 'read_only' ? tokens.bdim : 'transparent' }]}
                      onPress={() => handleSetCollaboratorMode(c, 'read_only')}
                      hitSlop={4}
                    >
                      <Icon name="eye" size={fs(12)} color={c.collabMode === 'read_only' ? tokens.blu : tokens.t4} />
                    </Pressable>
                    <Pressable
                      style={[styles.collabModeSeg, { backgroundColor: c.collabMode === 'read_write' ? tokens.bdim : 'transparent' }]}
                      onPress={() => handleSetCollaboratorMode(c, 'read_write')}
                      hitSlop={4}
                    >
                      <Icon name="pencil" size={fs(12)} color={c.collabMode === 'read_write' ? tokens.blu : tokens.t4} />
                    </Pressable>
                  </View>
                  <Pressable onPress={() => handleRemoveCollaborator(c)} hitSlop={8}>
                    <Icon name="xmark.circle" size={fs(18)} color={tokens.t4} />
                  </Pressable>
                </View>
              ))}
              {leftCollaborators.length > 0 && (
                <>
                  <View style={[styles.collabLeftDivider, { borderTopColor: tokens.bdr }]}>
                    <Text style={[styles.collabLeftLabel, { color: tokens.red, fontSize: fs(11) }]}>LEFT THE FOLDER</Text>
                  </View>
                  {leftCollaborators.map((c) => (
                    <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr }]}>
                      <Text style={[styles.collabEmail, { color: tokens.red, fontSize: fs(13.5) }]} numberOfLines={1}>
                        {c.displayLabel}
                      </Text>
                      <Pressable onPress={() => handleRemoveCollaborator(c)} hitSlop={8}>
                        <Icon name="xmark.circle" size={fs(18)} color={tokens.red} />
                      </Pressable>
                    </View>
                  ))}
                </>
              )}
            </>
          )}
        </View>
      )}

      {totalCount === 0 ? (
        <View style={styles.empty}>
          <Icon name="folder" size={fs(40)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Folder is empty</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Add bookmarks from the Saved tab or notes from the Notes tab using the folder icon on each card.
          </Text>
        </View>
      ) : (
        <TabletContainer>
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.folderItem.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11) }]}>{section.title}</Text>
          )}
          renderItem={({ item }) =>
            item.kind === 'ac' ? (
              <SwipeableACRow
                entry={item}
                tokens={tokens}
                badgeData={bookmarkItemType(item.data) === 'ac' ? badgeDataById[item.data.acId ?? item.data.id] : undefined}
                badgeDays={badgeDays}
                onPress={() => router.push(routeForBookmark(item.data, item.data.blockText ? { hlId: item.data.id } : undefined) as any)}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareAC(item.data)}
              />
            ) : (
              <SwipeableNoteRow
                entry={item}
                tokens={tokens}
                onPress={() => setEditorNote({ ...item.data })}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareNote(item.data)}
              />
            )
          }
        />
        </TabletContainer>
      )}

      {/* Note editor overlay -- inline now (BB-080), no navigation away */}
      {editorNote !== null && (
        <NoteEditor
          note={editorNote}
          tokens={tokens}
          backLabel={folder?.name ?? 'Folder'}
          onSave={handleSaveNote}
          onClose={() => setEditorNote(null)}
          onDelete={() => handleDeleteNote(editorNote)}
          onShare={() => handleShareNote(editorNote)}
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
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
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
            <Text style={[styles.typeBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>
              {REG_TYPE[bookmarkItemType(item) as RegType].label}
            </Text>
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
            {rowTitle(item.document_number, item.title) ? (
              <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>{rowTitle(item.document_number, item.title)}</Text>
            ) : null}
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
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
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
                  <Icon name="link" size={fs(9)} color={tokens.blu} />
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
  modeRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 12, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
  modeBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 10, borderWidth: 1, paddingVertical: 8 },
  modeBtnText: { fontWeight: '600' },
  modeSectionLabel: { fontWeight: '700', letterSpacing: 0.4, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  collabModeToggle: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, borderWidth: 1, overflow: 'hidden' },
  collabModeSeg: { paddingHorizontal: 8, paddingVertical: 5 },
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
  collabLeftDivider: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  collabLeftLabel: { fontWeight: '700', letterSpacing: 0.4 },

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
