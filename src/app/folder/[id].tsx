import { useState, useCallback, useRef, useEffect } from 'react'
import * as Sentry from '@sentry/react-native'
import { View, Text, SectionList, Pressable, TextInput, Share, StyleSheet, Platform, RefreshControl, Modal, KeyboardAvoidingView, ActivityIndicator, Keyboard, AppState } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
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
  getFolderCollabMode, setFolderCollabMode, setCollaboratorMode, FolderCollabMode, resolveForeignFolderEntries, resolveForeignNoteEntries, updateSharedNote,
  useFolderRealtime, inviteCollaboratorByCallsign, buildShareLink,
} from '@/lib/sharedFolders'
import { syncFolderFromCloud } from '@/lib/sync'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix, rowTitle } from '@/lib/titleFormat'
import { useConfirm } from '@/components/ConfirmDialog'
import { getNotes, updateNotes, type Note } from '@/lib/notes'
import { syncPushNote, syncPushNoteDeletes } from '@/lib/syncPush'
import { NoteEditor } from '@/components/NoteEditor'
import { BulkInviteContactPicker } from '@/components/BulkInviteContactPicker'
import { FindFriendsPickerBody } from '@/components/FindFriendsSheet'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { sendCollaborationInvitePush } from '@/lib/notifications'
import { resolveCallsignToUserId } from '@/lib/contactMatch'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

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
  const insets = useSafeAreaInsets()
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
  // Item titles and collaborator names on this screen can run long and get
  // cut off the same way FAR Part titles do -- one shared hook/card pair for
  // the whole screen, same as far/index.tsx's own long-press preview,
  // threaded down into SwipeableACRow/SwipeableNoteRow below.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

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
    const unresolvedAc: FolderItem[] = []
    const unresolvedNotes: FolderItem[] = []

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
        else unresolvedNotes.push(item)
      } else {
        const bm = bookmarkMap.get(item.item_id)
        if (bm) acs.push({ kind: 'ac', data: bm, folderItem: item })
        else unresolvedAc.push(item)
      }
    }

    // Self-heal helper: only for an item that's ALSO failed to resolve
    // against the real remote source of truth below -- see the big comment
    // on unresolvedAc/unresolvedNotes for why a purely local cache miss is
    // never enough on its own anymore.
    const selfHeal = (trulyOrphaned: FolderItem[]) => {
      if (typeof id === 'string' && trulyOrphaned.length) {
        removeManyFromFolder(id, trulyOrphaned.map((o) => ({ itemType: o.item_type, itemId: o.item_id }))).catch(() => {})
      }
    }

    // Anything not resolved from THIS device's own local cache -- a
    // collaborator's item, or this SAME account's own item/note added from a
    // second device and not yet pulled down here -- gets one more chance
    // against the real remote source of truth before being treated as gone.
    //
    // 2026-08-21 fix: this used to split purely on item.authorId (present =
    // "foreign, resolve remotely, never self-heal"; absent = "mine, and if
    // it's not in MY local cache it must be orphaned, self-heal-delete it
    // immediately, fire-and-forget, right here in loadLocal") -- but
    // authorId only tells you WHO added something, never whether it still
    // exists. A same-account item/note added from a second device is
    // authorId-less and legitimately absent from THIS device's local
    // bookmark/note cache until the app's own separate mergeBookmarks/
    // mergeNotes pass catches up: syncFolderFromCloud (called right after
    // this loadLocal, in load() below) only pulls folder_item pointers +
    // this folder's own notes, never bookmarks, and pullAndMergeAll's own
    // mergeBookmarks/mergeFolderItems race independently (Promise.all, no
    // shared ordering) at app launch. Landing here in that exact window used
    // to read as "doesn't exist," permanently deleting a real item both
    // locally and on the server -- via a fire-and-forget call this same
    // function kicked off -- before the item ever had a chance to sync down.
    // RC + Adriana real-device/TestFlight reports, same day: items vanishing
    // unpredictably for both a shared folder's owner and its collaborator,
    // different items each time, not in the same order -- exactly the shape
    // a timing-dependent race like this produces, not a fixed, repeatable
    // bug. Only an item that ALSO fails to resolve remotely is genuinely
    // gone and safe to self-heal.
    if (unresolvedAc.length) {
      resolveForeignFolderEntries(unresolvedAc).then((resolved) => {
        const byId = new Map(resolved.map((r) => [r.id, r]))
        const resolvedEntries: ACEntry[] = []
        const trulyOrphaned: FolderItem[] = []
        for (const item of unresolvedAc) {
          const data = byId.get(item.item_id)
          if (data) resolvedEntries.push({ kind: 'ac', data, folderItem: item })
          else trulyOrphaned.push(item)
        }
        setAcEntries([...acs, ...resolvedEntries])
        selfHeal(trulyOrphaned)
      }).catch(() => setAcEntries(acs))
    } else {
      setAcEntries(acs)
    }

    if (unresolvedNotes.length) {
      resolveForeignNoteEntries(unresolvedNotes).then((resolved) => {
        const byId = new Map(resolved.map((r) => [r.id, r]))
        const resolvedEntries: NoteEntry[] = []
        const trulyOrphaned: FolderItem[] = []
        for (const item of unresolvedNotes) {
          const note = byId.get(item.item_id)
          if (note) resolvedEntries.push({ kind: 'note', data: note, folderItem: item })
          else trulyOrphaned.push(item)
        }
        setNoteEntries([...notesList, ...resolvedEntries])
        selfHeal(trulyOrphaned)
      }).catch(() => setNoteEntries(notesList))
    } else {
      setNoteEntries(notesList)
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

  // RC + Adriana real-device/TestFlight reports, 2026-08-21 (RC: "massive
  // delay in shared notes with rewrite access... needs to be immediate";
  // Adriana: "I see your edits but you can't see mine after the file is
  // shared") -- the SAME "massive delay" phrase RC used for the 2026-08-16
  // report the AppState listener below was built for, recurring despite
  // that fix. Traced the actual data path (both directions) live against
  // the real DB/Realtime stack: a collaborator's note edit and the owner's
  // own force-pushed edit both land correctly and both fire a genuine
  // postgres_changes push to the OTHER side within the same session --
  // there's no asymmetry in the write path or the RLS/Realtime
  // authorization itself. What's still missing is a bound on how long this
  // screen can go WITHOUT any of its 3 existing triggers (focus, realtime,
  // AppState foreground) firing at all: a user who stays on this exact
  // screen, in the foreground, for an extended stretch (which is exactly
  // "reviewing a shared folder together") never re-focuses and never
  // backgrounds, and Realtime's own websocket can silently stop delivering
  // events well before either of those happens -- an hourly access-token
  // refresh that never reaches the channel (supabase-js requires an
  // explicit realtime.setAuth() call this codebase doesn't make), a
  // carrier/Wi-Fi handoff, or any other silent drop -- with nothing here to
  // notice or recover until the next focus/background cycle. A periodic
  // re-sync while this screen is genuinely focused closes that gap: worst
  // case, an edit is picked up within one interval instead of only on the
  // next navigation or app-switch, regardless of whether Realtime happens
  // to still be alive.
  useFocusEffect(useCallback(() => {
    load()
    const interval = setInterval(load, 45_000)
    return () => clearInterval(interval)
  }, [load]))

  // Live push on top of the pull-on-focus above -- sees a collaborator's
  // edit (item add/remove, note create/edit) while this screen is already
  // open, not just on the next focus.
  useFolderRealtime(typeof id === 'string' ? id : undefined, load)

  // RC real-device report 2026-08-16: "massive delay" seeing a collaborator's
  // edits, sometimes indefinitely. useFocusEffect only fires on REACT
  // NAVIGATION focus, never on the OS backgrounding/foregrounding the whole
  // app -- a real phone gets locked/backgrounded constantly while this
  // screen stays the topmost route, so it never unfocuses/refocuses in the
  // navigation sense. The websocket the realtime hook above depends on also
  // doesn't reliably survive iOS suspending the app (confirmed: this app had
  // zero AppState-driven refresh anywhere, see saved.tsx's own comment on
  // that gap for entitlements). Belt-and-suspenders: force a fresh pull the
  // moment the app comes back to the foreground, regardless of whether the
  // realtime socket reconnected cleanly on its own.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load()
    })
    return () => sub.remove()
  }, [load])

  useEffect(() => {
    // AC-only -- advisory_circulars.id is a uuid column, and a FAR/AIM/P-CG/AD
    // folder item's id (e.g. "91.13", "AAM") isn't one. Passing a non-uuid
    // string into .in('id', ...) throws a Postgres error for the WHOLE
    // query, not just a no-match for that one id -- which was silently
    // zeroing out badge data for real AC entries too, the moment any
    // non-AC item was also saved in the folder. Same bug, same fix as
    // recents.tsx's own badge-fetch effect (acEntries' `kind: 'ac'` is a
    // generic "resolves through bookmarks" label, not a guarantee every
    // entry is actually an AC -- see loadLocal's own comment above).
    const ids = [...new Set(
      acEntries.filter((e) => e.folderItem.item_type === 'ac').map((e) => e.data.acId ?? e.data.id)
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
        confirm({ title: 'Folder already exists', message: `You already have a folder named "${renameText.trim()}". Choose a different name.`, cancelLabel: null })
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
      message: `Delete "${folder.name}"? The bookmarks and notes inside will not be deleted.`,
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
  // Only one AC/note row's swipe stays open at a time -- swiping row B open
  // now springs row A shut instead of leaving it stuck open indefinitely
  // (RC, real device: swipe-to-remove "clunky and getting stuck").
  const [openSwipeId, setOpenSwipeId] = useState<string | null>(null)

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

  // RC: "since the receiver has to have a FR account... it's not bad to
  // suggest there too (like with a/c sharing) that they create a Callsign.
  // scope it a build it. should be fairly straightforward since you
  // already built it in the a/c area." Second, optional way to share a
  // folder alongside the existing anonymous-link "Invite" header icon --
  // this one targets one specific FlyRegs account by name instead of
  // handing out a link anyone could redeem, which is what makes the
  // pending/greyed "INVITED" roster state below possible at all.
  const [callsignModalVisible, setCallsignModalVisible] = useState(false)
  const [inviteCallsign, setInviteCallsign] = useState('')
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [callsignBusy, setCallsignBusy] = useState(false)
  // Mirrors my-aircraft/[id].tsx's identical fix (RC, real device,
  // 2026-08-15) -- see that file's comment for the full rationale.
  const [callsignCheck, setCallsignCheck] = useState<'idle' | 'checking' | 'found' | 'not_found'>('idle')
  useEffect(() => {
    const trimmed = inviteCallsign.trim()
    if (!trimmed) { setCallsignCheck('idle'); return }
    setCallsignCheck('checking')
    const t = setTimeout(() => {
      resolveCallsignToUserId(trimmed)
        .then((userId) => setCallsignCheck(userId ? 'found' : 'not_found'))
        .catch(() => setCallsignCheck('idle'))
    }, 400)
    return () => clearTimeout(t)
  }, [inviteCallsign])
  // BB-078: pick several contacts at once instead of sending the invite
  // link one person at a time via the plain OS share sheet.
  const [bulkInviteVisible, setBulkInviteVisible] = useState(false)
  const bulkInviteTokenRef = useRef<string | null>(null)
  // RC: "build out the rest of the contact/invite path" -- a third way
  // into the same Callsign field above, for when the inviter doesn't
  // already know the exact Callsign but knows the person's in their phone.
  // A step WITHIN the callsign modal, not a second <Modal> -- two RN
  // <Modal>s both wanting to be visible at once is a known iOS
  // presentation deadlock (see my-aircraft/[id].tsx's shareStep comment);
  // Find Friends briefly reintroduced exactly that bug as its own always-
  // separate Modal before this (RC, real device: "find friends doesn't do
  // anyting. won't tap").
  const [findFriendsStep, setFindFriendsStep] = useState(false)

  // The header's own "Invite" icon -- offers both invite methods up front
  // (link vs. named Callsign) rather than always defaulting to the
  // anonymous link, so a folder that's never been shared yet still has a
  // way to reach the Callsign flow (the in-roster shortcut below only
  // exists once folder.shared is already true).
  //
  // RC re-report, 2026-08-22: "Invite by Callsign" from THIS icon (not the
  // in-roster shortcut, which calls openCallsignInvite directly and was
  // never broken) "doesn't click, doesn't do anything." Root cause: this
  // action sheet is ConfirmDialog's own <Modal>; runChoice there calls
  // `await c.onPress()` and only closes that Modal (via closeIfCurrent)
  // AFTER onPress returns. openCallsignInvite is synchronous, so calling it
  // directly here sets callsignModalVisible=true in the SAME commit as this
  // sheet's Modal is still visible=true -- the exact "two RN <Modal>s both
  // wanting to be visible at once" iOS presentation deadlock already
  // diagnosed and fixed once for Find Friends (see callsignModalVisible's
  // own findFriendsStep comment below) and for shareStep in
  // my-aircraft/[id].tsx -- just never caught here, since this specific
  // sheet-to-modal handoff is a different call site than either of those.
  // openBulkInvite doesn't hit this by accident (its real getOrCreateShareLink
  // network round-trip gives closeIfCurrent time to run first); Callsign
  // has no such gap. Deferring past this sheet's fade-out (animationType
  // "fade" on ConfirmDialog's Modal) guarantees the ordering without
  // touching the shared ConfirmDialog component.
  const handleInviteChoice = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    confirm({
      title: 'Invite to this folder',
      choices: [
        { label: 'Invite by Link', onPress: handleInvite },
        { label: 'Invite by Callsign', onPress: () => { setTimeout(openCallsignInvite, 300) } },
        { label: 'Invite Multiple (Contacts)', onPress: openBulkInvite },
      ],
    })
  }

  // BB-078, RC real-device beta report: "we need to allow a bulk-add ...
  // tapping the group icon currently just opens the plain iOS share sheet."
  // Gets (or creates) the same anonymous link handleInvite would use, then
  // hands it to a real multi-select contact picker that queues one native
  // SMS compose sheet per selected person -- never one message to a shared
  // thread, which would expose every invitee's number to every other one.
  const openBulkInvite = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    if (!folder) return
    try {
      const { token } = await getOrCreateShareLink(folder.id)
      bulkInviteTokenRef.current = token
      setBulkInviteVisible(true)
    } catch {
      confirm({ title: 'Error', message: 'Could not create an invite link. Try again in a moment.', cancelLabel: null })
    }
  }

  const handleBulkInviteSent = async (sentCount: number) => {
    setBulkInviteVisible(false)
    if (sentCount > 0 && folder && bulkInviteTokenRef.current) {
      // Same "shared" signal as handleInvite -- only counts once a real
      // send actually happened, not just because the picker was opened.
      await confirmFolderShared(folder.id, bulkInviteTokenRef.current)
    }
    if (sentCount > 0) {
      confirm({ title: 'Invites sent', message: `Sent to ${sentCount} contact${sentCount === 1 ? '' : 's'}.`, cancelLabel: null })
    } else {
      // Every native compose sheet in the queue got cancelled -- without
      // this the picker just closed with zero feedback, indistinguishable
      // from "did that actually work?" (BB-0xx-adjacent gap, found during
      // the 2026-08-11 app-wide cleanup pass, not a real-device report).
      confirm({ title: 'No invites sent', message: 'Every message was cancelled before sending. Nothing was shared.', cancelLabel: null })
    }
  }

  const openCallsignInvite = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    setInviteCallsign('')
    setInviteError(null)
    setFindFriendsStep(false)
    setCallsignModalVisible(true)
  }

  const submitCallsignInvite = async () => {
    if (!folder) return
    setCallsignBusy(true)
    setInviteError(null)
    let invite: Awaited<ReturnType<typeof inviteCollaboratorByCallsign>>
    try {
      invite = await inviteCollaboratorByCallsign(folder.id, inviteCallsign)
    } catch (e: any) {
      setInviteError(e?.message ?? 'Could not create invite')
      setCallsignBusy(false)
      return
    }
    setCallsignModalVisible(false)
    // A named invite IS the "shared" signal, unlike the anonymous link's
    // handleInvite (which only counts as shared once the owner actually
    // sends/copies it) -- there's no equivalent ambiguity here: creating
    // this row already required knowing exactly who it's for.
    await confirmFolderShared(folder.id, invite.token)
    // Push the resolved user directly instead of the OS share sheet --
    // same fix and same reasoning as my-aircraft/[id].tsx's submitInvite
    // (RC, real device, 2026-08-15).
    sendCollaborationInvitePush(invite.userId, 'folder', folder.name, invite.token).catch(() => {})
    confirm({ title: 'Invite sent', message: `Sent to @${invite.callsign}.`, cancelLabel: null })
    getFolderCollaborators(folder.id).then(setCollaborators).catch(() => {})
    setCallsignBusy(false)
  }

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
        title: 'Invite link ready', message: 'Copy or share this link:', linkMessage: link,
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
    // updateNotes (not a plain getNotes-then-saveNotes pair) -- reads and
    // writes atomically under a lock shared with sync.ts's mergeNotes, so a
    // background sync merge landing between the old read and write can't
    // silently revert this edit. See notes.ts's own comment on updateNotes.
    await updateNotes((fresh) => fresh.map((n) => (n.id === updated.id ? updated : n)))
    setNoteEntries((prev) => prev.map((e) => (e.data.id === updated.id ? { ...e, data: updated } : e)))
    if (updated.authorId) {
      // Fire-and-forget by design, same as notes.tsx's identical pattern --
      // but updateSharedNote can now throw (RLS can silently drop this
      // write, see its own comment). Track rather than let it become a
      // bare unhandled rejection with zero visibility.
      updateSharedNote(updated.id, { title: updated.title, body: updated.body }).catch((err) => Sentry.captureException(err))
    } else {
      // force = folder?.shared, matching addManyToFolder/removeFromFolder's
      // own convention (folders.ts) -- this note lives inside a folder a
      // collaborator may be reading right now, so its edit has to reach the
      // cloud regardless of whether the owner's personal, unrelated
      // Back-up & Sync toggle happens to be on. Bare syncPushNote(updated)
      // silently no-ops when that toggle is off (currentUserId's
      // `!force && !isSyncEnabled()` check in syncPush.ts) -- real bug found
      // 2026-08-16: an owner's own edits to their own notes inside a shared
      // folder never reached collaborators at all, permanently, not just
      // delayed, unless Back-up & Sync happened to already be on.
      syncPushNote(updated, folder?.shared ?? false)
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
        await updateNotes((fresh) => fresh.filter((n) => n.id !== note.id))
        syncPushNoteDeletes([note.id])
        removeItemsFromAllFolders('note', [note.id])
        setNoteEntries((prev) => prev.filter((e) => e.data.id !== note.id))
        setEditorNote(null)
      },
    })

  const activeCollaborators = collaborators.filter((c) => !c.leftAt)
  const leftCollaborators = collaborators.filter((c) => c.leftAt)
  const joinedCollaboratorCount = activeCollaborators.filter((c) => c.accepted).length
  // RC (real device, 2026-08-15): "once i invite someone to a folder, i
  // should see that list of people here - showing me who i've invited...
  // I thought we already built this?" It WAS built (the per-row clock icon
  // a few lines down already distinguishes pending from joined) but two
  // things hid it: the header said "No one has joined yet" for a fresh
  // pending invite (joinedCollaboratorCount is accepted-only), and the
  // roster itself sat behind a manual expand tap defaulting closed --
  // unlike my-aircraft/[id].tsx's equivalent roster, which is always
  // visible the moment collaborators.length > 0. Auto-expanding on a real
  // invite (not on every render, so a user who deliberately collapses it
  // isn't fought) matches that same always-visible behavior.
  useEffect(() => {
    if (activeCollaborators.length > 0) setCollabExpanded(true)
  }, [activeCollaborators.length])

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
      <Pressable onPress={handleInviteChoice} hitSlop={10} style={styles.headerBtn} disabled={invitingBusy}>
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
          // Invite/Rename/Delete all guard on `folder` internally, so
          // showing them before it resolves was tappable-but-silently-inert
          // dead chrome -- matches my-aircraft/[id].tsx's not-found state,
          // which falls back to the default drawer icon the same way.
          right={folder ? rightSlot : undefined}
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
                : joinedCollaboratorCount === 0
                ? `${activeCollaborators.length} ${activeCollaborators.length === 1 ? 'invite' : 'invites'} pending`
                : `${joinedCollaboratorCount} ${joinedCollaboratorCount === 1 ? 'person has' : 'people have'} joined`}
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

          {/* RC: "it's not bad to suggest there too (like with a/c sharing)
              that they create a Callsign" -- second, optional way to share
              alongside the anonymous link above, for targeting one specific
              FlyRegs account by name. Always visible next to the mode
              toggle, same reasoning as that toggle's own comment. */}
          <Pressable style={styles.callsignInviteRow} onPress={openCallsignInvite}>
            <Icon name="at" size={fs(13)} color={tokens.blu} />
            <Text style={[styles.callsignInviteText, { color: tokens.blu, fontSize: fs(12.5) }]}>Invite by Callsign</Text>
          </Pressable>

          {collabExpanded && (
            <>
              {activeCollaborators.map((c) => (
                <View key={c.userId} style={[styles.collabRow, { borderTopColor: tokens.bdr, opacity: c.accepted ? 1 : 0.5 }]}>
                  {/* Opened indicator: filled when they've viewed the folder
                      at least once (same field driving the With Me unread
                      dot), hollow otherwise -- lets the owner tell "joined,
                      hasn't looked yet" from "joined and has actually seen
                      it," the same distinction WhatsApp's delivered/read
                      ticks draw. A pending Callsign invite (accepted false)
                      shows a clock instead -- unlike the anonymous link
                      (which genuinely carries no recipient identity until
                      redeemed), THIS row exists precisely because the app
                      does know who it's for and that they haven't accepted
                      yet, same as my-aircraft/[id].tsx's roster. */}
                  <Icon
                    name={!c.accepted ? 'clock' : c.lastViewedAt ? 'eye.fill' : 'eye.slash'}
                    size={fs(13)}
                    color={c.accepted && c.lastViewedAt ? tokens.grn : tokens.t4}
                  />
                  <Pressable
                    style={{ flex: 1 }}
                    onLongPress={(e) => showPreview(c.displayLabel, e)}
                    onPressOut={hidePreview}
                    delayLongPress={350}
                  >
                    <Text style={[styles.collabEmail, { color: c.accepted ? tokens.t1 : tokens.t3, fontSize: fs(13.5) }]} numberOfLines={1}>
                      {c.displayLabel}
                    </Text>
                  </Pressable>
                  {c.accepted ? (
                    // BB-077: this specific person's own access --
                    // independent of the "new invites get" default above and
                    // of any other collaborator on this same folder.
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
                  ) : (
                    <View style={[styles.roleBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bdr }]}>
                      <Text style={[styles.roleBadgeText, { color: tokens.t3, fontSize: fs(10) }]}>INVITED</Text>
                    </View>
                  )}
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
                      <Pressable
                        style={{ flex: 1 }}
                        onLongPress={(e) => showPreview(c.displayLabel, e)}
                        onPressOut={hidePreview}
                        delayLongPress={350}
                      >
                        <Text style={[styles.collabEmail, { color: tokens.red, fontSize: fs(13.5) }]} numberOfLines={1}>
                          {c.displayLabel}
                        </Text>
                      </Pressable>
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
                isOpen={openSwipeId === item.folderItem.id}
                onSwipeOpen={() => setOpenSwipeId(item.folderItem.id)}
                onSwipeClose={() => setOpenSwipeId((cur) => (cur === item.folderItem.id ? null : cur))}
                onPress={() => router.push(routeForBookmark(item.data, item.data.blockText ? { hlId: item.data.id } : undefined) as any)}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareAC(item.data)}
                showPreview={showPreview}
                hidePreview={hidePreview}
                consumeLongPress={consumeLongPress}
              />
            ) : (
              <SwipeableNoteRow
                entry={item}
                tokens={tokens}
                isOpen={openSwipeId === item.folderItem.id}
                onSwipeOpen={() => setOpenSwipeId(item.folderItem.id)}
                onSwipeClose={() => setOpenSwipeId((cur) => (cur === item.folderItem.id ? null : cur))}
                onPress={() => setEditorNote({ ...item.data })}
                onRemove={() => handleRemove(item.folderItem)}
                onMove={() => handleMove(item.folderItem)}
                onShare={() => handleShareNote(item.data)}
                showPreview={showPreview}
                hidePreview={hidePreview}
                consumeLongPress={consumeLongPress}
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
      {/* Mirrors my-aircraft/[id].tsx's own callsign step exactly (single
          text field + Invite action) -- no role-picker step needed here
          since a folder's per-invitee access already has its own
          default+override mechanism (NEW INVITES GET + setCollaboratorMode
          after they join), unlike aircraft's viewer/editor choice. */}
      <Modal visible={callsignModalVisible} animationType="slide" transparent onRequestClose={() => setCallsignModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalBackdrop}>
          {/* RC, real device: same "invite box sits too low, competing with
              the home-indicator gesture bar" fix as the aircraft screen's
              identical modal -- see that file's comment for the full
              reasoning. */}
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: insets.bottom + 16 }]}>
            {findFriendsStep ? (
              // Bounded so a long contact match list scrolls WITHIN the
              // card instead of growing it past the screen -- modalCard
              // itself has no height cap since the callsign form's own
              // content is short and fixed.
              <View style={{ maxHeight: 420 }}>
                <FindFriendsPickerBody
                  onClose={() => setFindFriendsStep(false)}
                  onSelect={(callsign) => { setInviteCallsign(callsign); setInviteError(null); setFindFriendsStep(false) }}
                />
              </View>
            ) : (
              <>
                <View style={styles.modalHeader}>
                  <Pressable onPress={() => setCallsignModalVisible(false)} hitSlop={10}>
                    <Text style={{ color: tokens.t3, fontSize: fs(14.5) }}>Cancel</Text>
                  </Pressable>
                  <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>Invite by Callsign</Text>
                  <Pressable onPress={submitCallsignInvite} hitSlop={10} disabled={callsignBusy || callsignCheck !== 'found'}>
                    {callsignBusy ? <ActivityIndicator color={tokens.blu} /> : (
                      <Text style={{ color: callsignCheck === 'found' ? tokens.blu : tokens.t4, fontWeight: '700', fontSize: fs(14.5) }}>Invite</Text>
                    )}
                  </Pressable>
                </View>
                <Text style={{ color: tokens.t3, fontSize: fs(13) }}>
                  Their Callsign, exactly as it appears in FlyRegs. They'll need their own Premium subscription and a Callsign set to join.
                </Text>
                <TextInput
                  value={inviteCallsign}
                  onChangeText={setInviteCallsign}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Callsign"
                  placeholderTextColor={tokens.t4}
                  style={[styles.inviteInput, { color: tokens.t1, borderColor: inviteError || callsignCheck === 'not_found' ? tokens.red : tokens.bdr, fontSize: ifs(15) }]}
                />
                {callsignCheck === 'checking' && <Text style={{ color: tokens.t3, fontSize: fs(12.5) }}>Checking…</Text>}
                {callsignCheck === 'found' && <Text style={{ color: tokens.grn, fontSize: fs(12.5) }}>Callsign found</Text>}
                {callsignCheck === 'not_found' && <Text style={{ color: tokens.red, fontSize: fs(12.5) }}>No FlyRegs user with this Callsign</Text>}
                {inviteError && <Text style={{ color: tokens.red, fontSize: fs(12.5) }}>{inviteError}</Text>}
                <Pressable
                  style={styles.findFriendsLink}
                  hitSlop={10}
                  onPress={() => { Keyboard.dismiss(); setFindFriendsStep(true) }}
                >
                  <Icon name="person.2.fill" size={fs(13)} color={tokens.blu} />
                  <Text style={{ color: tokens.blu, fontSize: fs(12.5), fontWeight: '600' }}>Find Friends from Contacts</Text>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <BulkInviteContactPicker
        visible={bulkInviteVisible}
        onClose={() => setBulkInviteVisible(false)}
        message={bulkInviteTokenRef.current ? buildShareLink(bulkInviteTokenRef.current) : ''}
        onSent={handleBulkInviteSent}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

// ── Swipeable AC row ──────────────────────────────────────────────────────────

function SwipeableACRow({
  entry, tokens, badgeData, badgeDays, isOpen, onSwipeOpen, onSwipeClose, onPress, onRemove, onMove, onShare,
  showPreview, hidePreview, consumeLongPress,
}: {
  entry: ACEntry
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeData?: { cancels: string[]; changed_block_indices: number[] | null; date_issued: string | null; document_number: string }
  badgeDays: number
  /** True when a DIFFERENT row's swipe was opened after this one -- springs
   * this row shut instead of leaving it stuck open indefinitely. */
  isOpen: boolean
  onSwipeOpen: () => void
  onSwipeClose: () => void
  onPress: () => void
  onRemove: () => void
  onMove: () => void
  onShare: () => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const translateX = useSharedValue(0)

  // Native-thread gesture-handler + Reanimated, not the JS-thread
  // PanResponder this replaced -- RC, real device: "the swipe to Remove
  // function in a folder is clunky and getting stuck." Same proven pattern
  // FolderListView.tsx's own swipeable rows already use.
  useEffect(() => {
    if (!isOpen && translateX.value !== 0) translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-84, e.translationX))
    })
    .onEnd((e) => {
      // Matches SwipeToDelete.tsx's own reversing check (RC, real device: a
      // swipe past threshold then dragged back left before release was
      // reading as a fresh swipe off the raw endpoint, "forcing" the row
      // open instead of letting the give-up motion just close it) -- this
      // row and its sibling duplicated the pre-fix -42px/no-reversing
      // version instead of using the shared component, so they never picked
      // the fix up. Found in the post-build-31 consistency sweep.
      const reversing = e.translationX < 0 && e.velocityX > 300
      if (!reversing && e.translationX < -48) {
        translateX.value = withSpring(-76, { damping: 18, stiffness: 280 })
        runOnJS(onSwipeOpen)()
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
        runOnJS(onSwipeClose)()
      }
    })

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }))

  const handlePress = () => {
    if (translateX.value < -1) {
      translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
      onSwipeClose()
    } else {
      onPress()
    }
  }

  const { data: item } = entry

  return (
    <View style={styles.swipeWrap}>
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
        <Pressable style={styles.removeAction} onPress={() => {
          translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
          onSwipeClose()
          onRemove()
        }}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={rowStyle}>
        <Pressable
          style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={() => {
            if (consumeLongPress()) return
            handlePress()
          }}
          onLongPress={(e) => {
            const title = rowTitle(item.document_number, item.title)
            if (title) showPreview(title, e)
          }}
          onPressOut={hidePreview}
          delayLongPress={350}
        >
          <View style={[styles.typeBadge, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
            <Text style={[styles.typeBadgeText, { color: tokens.blu, fontSize: fs(9.5) }]}>
              {/* Optional-chained, not a bare index -- this exact "new
                  content type ships, one lookup table doesn't get the new
                  key" gap has broken shared-folder rendering twice before
                  (dictionary, then cfr49; see getSharedFolderDictionaryItems'
                  and getSharedFolderCfr49Items' own comments in
                  sharedFolders.ts). An unmapped type here used to throw
                  synchronously mid-render (Cannot read 'label' of
                  undefined) instead of just rendering blank -- investigated
                  2026-08-16 as a lead for 3 unexplained real-device
                  RCTFatal crashes opening a folder; not proven as their
                  cause (no Sentry stack trace landed to confirm), but this
                  exact shape is a real, live crash risk regardless. */}
              {REG_TYPE[bookmarkItemType(item) as RegType]?.label ?? ''}
            </Text>
          </View>
          <View style={styles.rowBody}>
            <View style={styles.rowNumBadgeWrap}>
              {/* numberOfLines={1}, corpus-wide reg-number sweep: this row
                  spans every bookmark type (FAR/AIM/AC/AD/LOI/cfr49), and a
                  FAR range-span document_number (up to 17 chars) had no cap
                  here before. */}
              <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12) }]} numberOfLines={1}>
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
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

// ── Swipeable Note row ────────────────────────────────────────────────────────

function SwipeableNoteRow({
  entry, tokens, isOpen, onSwipeOpen, onSwipeClose, onPress, onRemove, onMove, onShare,
  showPreview, hidePreview, consumeLongPress,
}: {
  entry: NoteEntry
  tokens: ReturnType<typeof useTheme>['tokens']
  isOpen: boolean
  onSwipeOpen: () => void
  onSwipeClose: () => void
  onPress: () => void
  onRemove: () => void
  onMove: () => void
  onShare: () => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const translateX = useSharedValue(0)

  useEffect(() => {
    if (!isOpen && translateX.value !== 0) translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-84, e.translationX))
    })
    .onEnd((e) => {
      // Matches SwipeToDelete.tsx's own reversing check (RC, real device: a
      // swipe past threshold then dragged back left before release was
      // reading as a fresh swipe off the raw endpoint, "forcing" the row
      // open instead of letting the give-up motion just close it) -- this
      // row and its sibling duplicated the pre-fix -42px/no-reversing
      // version instead of using the shared component, so they never picked
      // the fix up. Found in the post-build-31 consistency sweep.
      const reversing = e.translationX < 0 && e.velocityX > 300
      if (!reversing && e.translationX < -48) {
        translateX.value = withSpring(-76, { damping: 18, stiffness: 280 })
        runOnJS(onSwipeOpen)()
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
        runOnJS(onSwipeClose)()
      }
    })

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }))

  const handlePress = () => {
    if (translateX.value < -1) {
      translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
      onSwipeClose()
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
          translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
          onSwipeClose()
          onRemove()
        }}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Remove</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={rowStyle}>
        <Pressable
          style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={() => {
            if (consumeLongPress()) return
            handlePress()
          }}
          onLongPress={(e) => showPreview(note.title || 'Untitled', e)}
          onPressOut={hidePreview}
          delayLongPress={350}
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
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Same tap-target fix as notes.tsx/saved.tsx/recents.tsx's All/None-vs-
  // Done: all 3 of these icon buttons carry hitSlop={10}, so the old gap:4
  // let adjacent buttons' real tappable zones overlap by up to 16px --
  // worse than the text-button case since there are 3 buttons here, not 2.
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 24 },
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
  callsignInviteRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 12 },
  callsignInviteText: { fontWeight: '600' },
  roleBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 3 },
  roleBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  // Same 4 style shapes as my-aircraft/[id].tsx's own callsign-invite modal
  // -- kept as this screen's own copy rather than a shared import since
  // neither screen exports its StyleSheet.
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, gap: 10 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  modalTitle: { fontWeight: '700' },
  inviteInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontWeight: '600' },
  findFriendsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 4, paddingVertical: 6 },
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
