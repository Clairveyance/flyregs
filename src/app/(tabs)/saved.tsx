import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { View, Text, Image, FlatList, Pressable, TextInput, StyleSheet, Switch, KeyboardAvoidingView, Keyboard, Platform, Share, RefreshControl } from 'react-native'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useIsTablet } from '@/context/responsive'
import { useAuth } from '@/context/auth'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { supabase } from '@/lib/supabase'
import { ScreenHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { Icon } from '@/components/Icon'
import { getBookmarks, removeBookmark, removeManyBookmarks, routeForBookmark, bookmarkItemType, BookmarkAC } from '@/lib/bookmarks'
import { highlightSnippet } from '@/lib/acShare'
import { getDownloads, removeDownload, formatBytes, DownloadedAC, downloadItemType, routeForDownload } from '@/lib/downloads'
import { REG_TYPE, RegType } from '@/lib/regTypes'
import {
  getFolders,
  getFolderItemCounts,
  createFolder,
  deleteFolder,
  addManyToFolder,
  unshareFolder,
  reorderFolders,
  Folder,
  DUPLICATE_FOLDER_NAME,
  PLUS_FOLDER_CAP,
  FolderItemType,
} from '@/lib/folders'
import { isSyncEnabled, enableSync, disableSync } from '@/lib/sync'
import { getMyCollaborations, getMySharedFolders, getOrCreateShareLink, confirmFolderShared, SharedFolderSummary, SharedByMeFolder } from '@/lib/sharedFolders'
import { FolderListView } from '@/components/FolderListView'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions, ShareableAC, ShareableNote, ShareableReg } from '@/lib/share'
import { toRegShareType } from '@/lib/regShare'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix, rowTitle } from '@/lib/titleFormat'
import { useCachedImage } from '@/lib/imageCache'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useConfirm } from '@/components/ConfirmDialog'

type Tab = 'all' | 'folders' | 'shared' | 'offline'

// Highlighter yellow is the one accent family in this screen that isn't a
// theme token -- under Red Shift it's recolored into the same rust-tone
// language as theme.tsx's redshiftTokens rather than staying a literal
// yellow (R+G both high, exactly what red-shift needs to avoid).
const HIGHLIGHT_BG = 'rgba(255, 213, 0, 0.12)'
const HIGHLIGHT_BDR = 'rgba(255, 213, 0, 0.4)'
const HIGHLIGHT_TEXT = '#8a6d00'
const HIGHLIGHT_BG_REDSHIFT = 'rgba(224, 86, 46, 0.16)'
const HIGHLIGHT_BDR_REDSHIFT = 'rgba(224, 86, 46, 0.45)'
const HIGHLIGHT_TEXT_REDSHIFT = '#FF9A6B'

export default function SavedScreen() {
  const { tokens, redShift } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so these confirms (and the deletes behind them) were
  // invisible and untestable in the Browser pane. See ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  // iPad creative pass: same flexWrap-grid idea already shipped for Recents
  // (85f6ed5) and Notes (349ded4) -- applied here to the All/Bookmarks tab,
  // the one RC named directly ("Bookmarks/Recents/Notes"). Folders/Shared/
  // Offline are deliberately left as their existing single-column lists for
  // now (each has its own distinct card shape -- FolderListView, the
  // OwnerAvatar shared-rows -- and grid-ifying all of them well is a bigger
  // job than a single night-rules pass; not a call to rush unilaterally).
  const isTablet = useIsTablet()
  // Bookmarks/Folders are Plus-tier (hasPlusAccess); cloud sync is Pro-tier
  // (isPro); shared/collaborative folders and offline stay Premium-only --
  // see flyregs_decisions.md's pricing pivot.
  const { session, isPro, isPremium, hasPlusAccess } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const { shareAC, shareReg, shareMany } = useShareActions()
  const [tab, setTab] = useState<Tab>('all')
  const { tab: tabParam, sub: subParam } = useLocalSearchParams<{ tab?: string; sub?: string }>()
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [syncBusy, setSyncBusy] = useState(false)

  useEffect(() => {
    isSyncEnabled().then(setSyncEnabled)
  }, [])
  const [bookmarks, setBookmarks] = useState<BookmarkAC[]>([])
  // acId -> one highlight bookmark for that AC (a highlight is its own
  // separate BookmarkAC row, keyed by a synthetic id, not the AC's own id --
  // see BookmarkAC's comment on that distinction). Used both to flag a whole-
  // document bookmark row with "contains a highlight" (the actual highlight
  // otherwise lives in a different row the reader may never scroll to) AND to
  // let tapping that row jump straight to it -- the flag alone isn't enough;
  // a reader who sees "contains a highlight" reasonably expects tapping it to
  // actually take them there, not just to the top of the document again. If
  // an AC has more than one highlight, this jumps to the first one found;
  // the reader can still reach any of the others via their own separate rows.
  const highlightByAcId = useMemo(() => {
    const m = new Map<string, BookmarkAC>()
    // Scoped to itemType 'ac' -- highlights now exist for every content
    // type (see bookmarks.ts), and this map feeds ONLY the AC whole-doc
    // "contains a highlight" merged-row treatment below. Without the
    // itemType check, a FAR/AIM/AD/LOI highlight sharing an id string with
    // some unrelated AC could theoretically attach its highlight to the
    // wrong document's row.
    for (const b of bookmarks) {
      if (b.blockText && b.acId && bookmarkItemType(b) === 'ac' && !m.has(b.acId)) m.set(b.acId, b)
    }
    return m
  }, [bookmarks])
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
  const [folderReorderMode, setFolderReorderMode] = useState(false)
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
    // AC-only -- stale_highlight_ac_ids only knows how to diff against
    // advisory_circulars' own pdf_blocks/changed_block_indices. A FAR/AIM/
    // AD/LOI highlight's acId isn't a real advisory_circulars.id, so
    // without this filter every one of those would be sent as a useless
    // probe the RPC can never match.
    const highlights = bookmarks.filter((b) => b.blockText && b.acId && bookmarkItemType(b) === 'ac')
    if (highlights.length === 0) {
      setStaleHighlightIds(new Set())
      return
    }
    // TIER LEAK, fixed 2026-08-05 during the pre-beta gating audit: this
    // used to `.from('advisory_circulars').select('id, pdf_blocks')` on the
    // RAW table and diff client-side. pdf_blocks is exactly the column
    // advisory_circulars_gated redacts for non-Plus, so a Free account with
    // AC highlights was sent the complete text of every one of those ACs.
    // Nothing rendered it -- it only built a Set to compare against -- which
    // is why it survived earlier gate audits: the screen looked correct
    // while the payload crossed the wire anyway.
    //
    // Reading the _gated view instead would have traded the leak for a
    // broken feature (non-Plus sees only blocks 0-1, so every deeper
    // highlight would report stale). So the comparison moved server-side
    // and only booleans come back -- see sync/migrations_stale_highlight_rpc.sql.
    supabase
      .rpc('stale_highlight_ac_ids', {
        probes: highlights.map((h) => ({ ac_id: h.acId, block_text: h.blockText })),
      })
      .then(({ data }) => {
        if (!data) return
        const staleByKey = new Set(
          (data as any[]).filter((r) => r.out_stale).map((r) => `${r.out_ac_id}::${r.out_block_text}`),
        )
        const stale = new Set<string>()
        for (const h of highlights) {
          if (staleByKey.has(`${h.acId}::${h.blockText}`)) stale.add(h.id)
        }
        setStaleHighlightIds(stale)
      })
  }, [bookmarks])

  // The cap has to apply on READ, not just on create. It used to be checked
  // only inside handleCreateFolder, which meant a Premium account that
  // downgraded kept every folder it had made -- visible, openable, and
  // still accepting new items -- because nothing ever re-checked the cap
  // after the folders already existed. Exactly the shape of the aircraft
  // cap bug (gotcha_tier_caps_create_time_only.md); this is the other half
  // of it that was left open.
  //
  // Nothing is deleted and nothing is chosen FOR the user: folders already
  // have a user-controlled drag order, so the ones past the cap are simply
  // not shown, and reorder mode deliberately shows them all again -- that's
  // how you pick which three stay live. Same "you choose, we delete
  // nothing" principle as the aircraft downgrade.
  const folderCap = isPremium ? Infinity : PLUS_FOLDER_CAP
  const visibleFolders = folderReorderMode ? folders : folders.slice(0, folderCap)
  const lockedFolderCount = folders.length - Math.min(folders.length, folderCap)

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

  // Lets a caller (join/[token].tsx after a successful join) land directly
  // on Shared > With Me instead of wherever this persistent tab screen's
  // state happened to be left -- a useState initializer alone wouldn't
  // re-fire on a later navigation into an already-mounted tab screen, so
  // this has to be a focus effect, same lesson as Home's justConfirmed toast.
  useFocusEffect(useCallback(() => {
    if (tabParam === 'all' || tabParam === 'folders' || tabParam === 'shared' || tabParam === 'offline') {
      setTab(tabParam)
    }
    if (subParam === 'withMe' || subParam === 'fromMe') {
      setSharedSubTab(subParam)
    }
  }, [tabParam, subParam]))

  // The stored sync_enabled flag doesn't get flipped off automatically if a
  // Pro/Premium subscription lapses -- self-correct so the UI (and syncPush.ts's
  // own live isPro check) both agree with reality instead of the row claiming
  // "Synced" forever off a stale local flag. Sync moved from Premium to Pro.
  const displaySyncEnabled = syncEnabled && isPro
  useEffect(() => {
    if (syncEnabled && !isPro) {
      disableSync()
      setSyncEnabled(false)
    }
  }, [syncEnabled, isPro])

  const toggleSync = async (v: boolean) => {
    if (v && !isPro) { router.push('/paywall'); return }
    // Optimistic -- flips the Switch immediately on the user's own gesture,
    // same as every standard iOS toggle. It used to wait for the full
    // enableSync() push+pull round trip before ever updating, which made a
    // simple tap feel stuck/unresponsive for anyone with more than a
    // trivial amount of local data to push.
    setSyncEnabled(v)
    if (v && session?.user?.id) {
      setSyncBusy(true)
      try {
        await enableSync(session.user.id)
        load()
      } catch {
        setSyncEnabled(false)
        confirm({ title: 'Error', message: "Couldn't turn on Back up & sync. Try again in a moment.", cancelLabel: null })
      }
      setSyncBusy(false)
    } else {
      disableSync().catch(() => {})
    }
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
    confirm({
      title: 'Remove Bookmark',
      message: `Remove AC ${item.document_number} from your saved list?`,
      confirmLabel: 'Remove',
      destructive: true,
      // Single-step: a bookmark is one tap to recreate from the document
      // itself, so a second confirm is friction without a matching risk.
      twoStep: false,
      onConfirm: async () => {
        setBookmarks((prev) => prev.filter((b) => b.id !== item.id))
        await removeBookmark(item.id)
      },
    })
  }

  const handleBulkDelete = () => {
    const count = selected.size
    confirm({
      title: `Remove ${count} Bookmark${count > 1 ? 's' : ''}`,
      message: "They'll be removed from Saved but not deleted.",
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        const ids = [...selected]
        setBookmarks((prev) => prev.filter((b) => !selected.has(b.id)))
        setSelected(new Set())
        setSelectMode(false)
        await removeManyBookmarks(ids)
      },
    })
  }

  // A DownloadedAC names its type `type`, but handleShare (shared with the
  // bookmark rows) reads `itemType`. Passing a download straight through left
  // itemType undefined, which defaults to 'ac' -- so sharing a downloaded
  // FAR/AIM/P-CG/AD/LOI produced an AC link to an id that is not an AC. Map
  // the field across explicitly.
  const shareDownload = (item: DownloadedAC) => handleShare({ ...item, itemType: downloadItemType(item) })

  const handleRemoveDownload = (item: DownloadedAC) => {
    confirm({
      title: 'Remove Download',
      message: `Remove the offline copy of ${item.document_number}? You can download it again any time.`,
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        setDownloads((prev) => prev.filter((d) => d.id !== item.id))
        await removeDownload(item.id)
      },
    })
  }

  const handleBulkAddToFolder = async (folderIds: string[]) => {
    // Selected ids span whatever mix of types the user multi-selected (AC,
    // FAR, AIM, P/CG, AD, LOI, dictionary) -- hardcoding 'ac' here used to
    // file every non-AC item under the wrong type (same class of bug fixed
    // for highlights in resolveForeignFolderEntries; this is the bulk-add
    // sibling of that, and broader -- it hit any non-AC selection, not just
    // highlights). Group by each bookmark's own real itemType instead.
    const bookmarkMap = new Map(bookmarks.map((b) => [b.id, b]))
    const idsByType = new Map<FolderItemType, string[]>()
    for (const id of selected) {
      const bm = bookmarkMap.get(id)
      const type = bm ? bookmarkItemType(bm) : 'ac'
      idsByType.set(type, [...(idsByType.get(type) ?? []), id])
    }
    // Sequential, not Promise.all -- addManyToFolder does its own read-modify-
    // write on the shared folder_items list, so concurrent calls for different
    // folders (or different types within the same folder) would race and
    // clobber each other (only the last write survives).
    for (const folderId of folderIds) {
      for (const [type, typeIds] of idsByType) {
        await addManyToFolder(folderId, type, typeIds)
      }
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

  // A highlight bookmark's own `id` is a synthetic value, never a real
  // advisory_circulars.id (see resolveBookmarkACId's comment) -- passing it
  // straight through built a share link the recipient's app could never
  // resolve, landing on a real "AC not found" screen. Also carries the
  // highlight's own passage snippet so the recipient's copy both jumps to
  // AND highlights that block, same as "Share Passage" from the AC screen.
  const toShareableAC = (item: { id: string; document_number: string; title: string; acId?: string; blockText?: string }): ShareableAC => ({
    id: item.acId ?? item.id,
    document_number: item.document_number,
    title: item.title,
    highlightSnippet: item.blockText ? highlightSnippet(item.blockText) : undefined,
  })

  // Returns null for the types that don't share through the generic reg/
  // page (see toRegShareType) rather than casting them into one that does.
  const toShareableReg = (item: { id: string; document_number: string; title: string; itemType?: BookmarkAC['itemType'] }): ShareableReg | null => {
    const type = toRegShareType(bookmarkItemType(item))
    if (!type) return null
    return { type, id: item.id, label: item.document_number, title: item.title }
  }

  // Shared between AC bookmark rows and OfflineListView's DownloadedAC rows
  // (offline downloads are AC-only, so they never carry itemType at all --
  // bookmarkItemType's "absent means 'ac'" default handles that transparently).
  const handleShare = (item: { id: string; document_number: string; title: string; acId?: string; blockText?: string; itemType?: BookmarkAC['itemType'] }) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const type = bookmarkItemType(item)
    // Highlights are AC-only (see BookmarkAC's own comment) and their share
    // flow carries the passage snippet through buildACShareLink -- keep
    // that path as-is. Every other type now routes through the same
    // buildRegShareLink each type's own detail screen already uses,
    // instead of silently no-op'ing (confirmed live: tapping Share on a
    // FAR/AIM/P-CG/AD bookmark here did nothing at all).
    if (type === 'ac') { shareAC(toShareableAC(item)); return }
    const reg = toShareableReg(item)
    if (reg) shareReg(reg)
  }

  const handleBulkShare = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const selectedItems = bookmarks.filter((b) => selected.has(b.id))
    const acs = selectedItems.filter((b) => bookmarkItemType(b) === 'ac')
    const regs = selectedItems.filter((b) => bookmarkItemType(b) !== 'ac')
    if (acs.length === 0 && regs.length === 0) return
    shareMany(acs.map(toShareableAC), [], regs.map(toShareableReg).filter((r): r is ShareableReg => r !== null))
    setSelected(new Set())
    setSelectMode(false)
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  const toggleFolderSelect = () => {
    if (folderSelectMode) { setFolderSelectMode(false); setSelectedFolders(new Set()) }
    else { setFolderReorderMode(false); setFolderSelectMode(true) }
  }

  // Mutually exclusive with folderSelectMode (see toggleFolderSelect) --
  // dragging while some rows show bulk-action checkboxes would be a
  // confusing state to be in, so entering one exits the other.
  const toggleFolderReorder = () => {
    if (folderReorderMode) { setFolderReorderMode(false) }
    else { setFolderSelectMode(false); setSelectedFolders(new Set()); setFolderReorderMode(true) }
  }

  const handleFolderReorder = async (orderedIds: string[]) => {
    const next = await reorderFolders(orderedIds)
    setFolders(next)
  }

  const toggleFolderRow = (id: string) => {
    setSelectedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleCreateFolder = async (name: string): Promise<boolean> => {
    // Plus is capped at PLUS_FOLDER_CAP folders; Premium is unlimited -- see
    // flyregs_decisions.md's pricing pivot.
    if (folders.length >= folderCap) {
      confirm({
        title: 'Folder limit reached',
        message: `Plus includes ${PLUS_FOLDER_CAP} folders. Upgrade to Premium for unlimited.`,
        confirmLabel: 'Upgrade to Premium',
        onConfirm: () => router.push('/paywall?tier=premium'),
      })
      return false
    }
    try {
      await createFolder(name)
    } catch (e) {
      if (e instanceof Error && e.message === DUPLICATE_FOLDER_NAME) {
        confirm({ title: 'Folder Already Exists', message: `You already have a folder named "${name}". Choose a different name.`, cancelLabel: null })
        return false
      }
      throw e
    }
    setNewFolderVisible(false)
    load()
    return true
  }

  const handleUnshare = (item: SharedByMeFolder) => {
    confirm({
      title: 'Stop Sharing',
      message: `Remove everyone's access to "${item.folder_name}"? The folder itself won't be deleted -- you can share it again later with a new invite link.`,
      confirmLabel: 'Stop Sharing',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await unshareFolder(item.folder_id)
        setSharedByMe((prev) => prev.filter((f) => f.folder_id !== item.folder_id))
      },
    })
  }

  const handleDeleteFolder = (folder: Folder) => {
    confirm({
      title: 'Delete Folder',
      message: `Delete "${folder.name}"? The ACs and notes inside will not be deleted.`,
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await deleteFolder(folder.id)
        load()
      },
    })
  }

  // Real folder sharing -- generates the same persistent join/<token> invite
  // link folder/[id].tsx's own "Invite" button does, so it actually creates
  // a collaborator relationship and shows up in the recipient's With Me
  // (and this folder's own From Me) the moment it's shared. This row-level
  // share icon on the Folders list used to call resolveFolderContents() +
  // shareMany() instead -- a completely different, one-shot "share a bundle
  // of individual item links" mechanism that never created any collaborator
  // row at all. Since this is the MORE discoverable "share a folder" button
  // (right on the list, no need to open the folder first), that mismatch is
  // almost certainly why shared folders never showed up on the recipient's
  // end no matter how many times it was tried -- the wrong flow was firing.
  const handleShareFolder = async (folder: Folder) => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    let link: string, token: string
    try {
      ;({ link, token } = await getOrCreateShareLink(folder.id))
    } catch {
      confirm({ title: 'Error', message: 'Could not create an invite link. Try again in a moment.', cancelLabel: null })
      return
    }
    try {
      const result = await Share.share({ message: link })
      // Don't mark this shared (and thus visible in From Me) until the send
      // actually goes through -- see sharedFolders.ts's confirmFolderShared.
      if (Platform.OS !== 'ios' || result.action === Share.sharedAction) {
        await confirmFolderShared(folder.id, token)
      }
    } catch {
      // The link above was already created (just not yet confirmed shared)
      // -- a Share.share failure here (no share target, sheet error, web
      // preview) is not the same failure as never having a link. Same
      // reasoning as folder/[id].tsx's own handleInvite.
      confirm({ title: 'Invite Link Ready', message: 'Copy or share this link:', linkMessage: link, cancelLabel: null })
      await confirmFolderShared(folder.id, token)
    }
  }

  const handleBulkShareFolders = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    const ids = [...selectedFolders]
    let entries: { link: string; token: string }[]
    try {
      entries = await Promise.all(ids.map((id) => getOrCreateShareLink(id)))
    } catch {
      confirm({ title: 'Error', message: 'Could not create invite links. Try again in a moment.', cancelLabel: null })
      return
    }
    const confirmAll = () => Promise.all(ids.map((id, i) => confirmFolderShared(id, entries[i].token)))
    try {
      const result = await Share.share({ message: entries.map((e) => e.link).join('\n\n') })
      if (Platform.OS !== 'ios' || result.action === Share.sharedAction) await confirmAll()
    } catch {
      confirm({ title: 'Invite Links Ready', message: 'Copy or share these links:', linkMessage: entries.map((e) => e.link), cancelLabel: null })
      await confirmAll()
    }
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
      {(folderSelectMode || folderReorderMode) ? (
        <Pressable onPress={folderReorderMode ? toggleFolderReorder : toggleFolderSelect} hitSlop={8}>
          <Text style={[styles.selectBtn, { color: tokens.blu, fontSize: fs(13) }]}>Done</Text>
        </Pressable>
      ) : (
        <HeaderOverflowMenu
          items={[
            { icon: 'checkmark.circle', label: 'Select Folders', onPress: toggleFolderSelect },
            { icon: 'arrow.up.arrow.down', label: 'Reorder Folders', onPress: toggleFolderReorder },
          ]}
        />
      )}
      {!folderSelectMode && !folderReorderMode && (
        <Pressable
          onPress={() => (hasPlusAccess ? setNewFolderVisible(true) : router.push('/paywall'))}
          style={[styles.addBtn, { backgroundColor: tokens.blu }]}
        >
          <Icon name="plus" size={fs(13)} color="#fff" />
          <Text style={[styles.addBtnText, { fontSize: fs(12.5) }]}>New</Text>
        </Pressable>
      )}
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader
        title="Saved"
        right={!hasPlusAccess ? undefined : tab === 'all' ? rightSlot : tab === 'folders' ? folderRightSlot : undefined}
      />
      <TabletContainer>

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
                setFolderReorderMode(false)
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
      {tab === 'all' && hasPlusAccess && (
        <View style={styles.syncWrap}>
          <View style={[styles.syncRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}>
            <View style={styles.syncTopRow}>
              <Text style={[styles.syncLabel, { color: tokens.t1, fontSize: fs(13) }]}>Back up & sync</Text>
              {/* Switch stays mounted throughout -- swapping it for a spinner
                  while busy used to yank the control out from under the
                  user's own finger mid-tap/drag, which is what actually made
                  this feel "sticky." disabled (not unmounted) keeps the
                  thumb sitting still in its new position during the push. */}
              <Switch
                value={displaySyncEnabled}
                onValueChange={toggleSync}
                disabled={syncBusy}
                trackColor={{ true: tokens.blu, false: undefined }}
                thumbColor="#fff"
                style={styles.syncSwitch}
              />
            </View>
            <View style={styles.syncBadgeRow}>
              {/* Back up & sync gates on isPro (toggleSync above, and
                  account.tsx), and the paywall sells it under Pro -- this
                  badge said PREMIUM, so a Pro subscriber looking at the
                  toggle they'd already paid for was told it was a tier up. */}
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
      )}

      {tab === 'all' ? (
        !hasPlusAccess ? (
          <ProWall tokens={tokens} label="Bookmarks" />
        ) : (
          <>
            {bookmarks.length === 0 ? (
              <EmptyState tokens={tokens} signedIn={!!session} />
            ) : (
              <FlatList
                // iPad creative pass: 2-up grid instead of one narrow column,
                // same idea already shipped for Recents/Notes. numColumns
                // needs a `key` change to remount cleanly (RN requirement).
                key={isTablet ? 'grid' : 'list'}
                data={bookmarks}
                keyExtractor={(item) => item.id}
                numColumns={isTablet ? 2 : 1}
                columnWrapperStyle={isTablet ? styles.gridRow : undefined}
                contentContainerStyle={styles.list}
                refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
                ListHeaderComponent={
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                    {bookmarks.length} SAVED ITEM{bookmarks.length !== 1 ? 'S' : ''}
                  </Text>
                }
                renderItem={({ item }) => {
                  // Highlights/jump-targets only exist for AC bookmarks today
                  // (see BookmarkAC's comment) -- non-AC types skip straight
                  // to routeForBookmark's plain whole-doc route.
                  const otherHighlight = bookmarkItemType(item) === 'ac' && !item.blockText ? highlightByAcId.get(item.id) : undefined
                  const jumpTarget = item.blockText
                    ? { hlId: item.id }
                    : otherHighlight
                    ? { hlId: otherHighlight.id }
                    : undefined
                  return (
                    <View style={isTablet ? styles.gridCell : undefined}>
                      <BookmarkRow
                        item={item}
                        tokens={tokens}
                        redShift={redShift}
                        selectMode={selectMode}
                        selected={selected.has(item.id)}
                        stale={staleHighlightIds.has(item.id)}
                        hasHighlight={!!otherHighlight}
                        badgeData={bookmarkItemType(item) === 'ac' ? badgeDataById[item.acId ?? item.id] : undefined}
                        badgeDays={badgeDays}
                        onPress={selectMode ? () => toggleRow(item.id) : () => router.push(routeForBookmark(item, jumpTarget) as any)}
                        onRemove={() => handleRemove(item)}
                        onFolder={() => setPickerAC(item)}
                        onShare={() => handleShare(item)}
                      />
                    </View>
                  )
                }}
              />
            )}
          </>
        )
      ) : tab === 'folders' ? (
        !hasPlusAccess ? (
          <ProWall tokens={tokens} label="Folders" />
        ) : (
          <>
          {lockedFolderCount > 0 && !folderReorderMode && (
            <View style={[styles.folderCapCard, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
              <Icon name="lock.fill" size={fs(20)} color={tokens.gold} />
              <Text style={[styles.folderCapTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>
                {lockedFolderCount} folder{lockedFolderCount === 1 ? '' : 's'} locked
              </Text>
              <Text style={[styles.folderCapBody, { color: tokens.t3, fontSize: fs(13) }]}>
                {`Plus includes ${PLUS_FOLDER_CAP} folders. Nothing has been deleted — use ⋯ › Reorder Folders to drag the ${PLUS_FOLDER_CAP} you want to the top, or go Premium for unlimited.`}
              </Text>
              <Pressable
                style={[styles.folderCapBtn, { backgroundColor: tokens.gold }]}
                onPress={() => router.push('/paywall?tier=premium' as any)}
              >
                <Text style={[styles.folderCapBtnText, { fontSize: fs(13.5) }]}>See Premium</Text>
              </Pressable>
            </View>
          )}
          <FolderListView
            folders={visibleFolders}
            counts={folderCounts}
            selectMode={folderSelectMode}
            selected={selectedFolders}
            onToggleSelect={toggleFolderRow}
            onOpen={(folder) => router.push(`/folder/${folder.id}`)}
            onRenamed={load}
            onDelete={handleDeleteFolder}
            onShare={handleShareFolder}
            reorderMode={folderReorderMode}
            onReorder={handleFolderReorder}
            onCreateFolder={() => setNewFolderVisible(true)}
          />
          </>
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
                <Icon name="person.2.fill" size={fs(40)} color={tokens.t4} />
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
                refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
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
                      redShift={redShift}
                      fs={fs}
                    />
                    <View style={{ flex: 1 }}>
                      <View style={styles.sharedRowTitleRow}>
                        {item.isUnread && <View style={[styles.unreadDot, { backgroundColor: tokens.blu }]} />}
                        <Text style={[styles.sharedRowText, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                          {item.folder_name}
                        </Text>
                      </View>
                      {item.ownerDisplayName && (
                        <Text style={[styles.sharedRowSub, { color: tokens.t3, fontSize: fs(11.5) }]} numberOfLines={1}>
                          Shared by {item.ownerDisplayName}
                        </Text>
                      )}
                    </View>
                    <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                  </Pressable>
                )}
              />
            )
          ) : sharedByMe.length === 0 ? (
            <View style={styles.center}>
              <Icon name="person.2.fill" size={fs(40)} color={tokens.t4} />
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
              refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.sharedRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                  onPress={() => router.push(`/folder/${item.folder_id}`)}
                >
                  <Icon name="folder" size={fs(18)} color={tokens.t2} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.sharedRowText, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                      {item.folder_name}
                    </Text>
                    <Text style={{ color: tokens.t4, fontSize: fs(11.5) }}>
                      {item.collaboratorCount} {item.collaboratorCount === 1 ? 'person' : 'people'}
                    </Text>
                  </View>
                  <Pressable onPress={() => handleUnshare(item)} hitSlop={10} style={{ padding: 4 }}>
                    <Icon name="xmark.circle" size={fs(20)} color={tokens.t4} />
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
          onOpen={(item) => router.push(routeForDownload(item) as any)}
          onFolder={(item) => setPickerDownloadId(item.id)}
          onRemove={handleRemoveDownload}
          onShare={shareDownload}
          onRefresh={load}
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
        itemType={pickerAC ? bookmarkItemType(pickerAC) : 'ac'}
        itemId={pickerAC?.id ?? ''}
        onClose={() => setPickerAC(null)}
        // RC: "make sure all folders update their content count right away
        // -- there has seemed to be some delay." Root cause: this picker is
        // opened and closed entirely within THIS screen (no navigation, no
        // refocus), so the normal fix -- Saved's own useFocusEffect re-running
        // load() on return -- never fires here. onAdded only showed a
        // confirmation toast before; it now also re-pulls folder counts so
        // the Folders tab reflects the add immediately, not on some later,
        // unrelated focus event.
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1); getFolderItemCounts().then(setFolderCounts) }}
      />

      {/* Folder picker for offline downloads */}
      <FolderPicker
        visible={pickerDownloadId !== null}
        itemType={downloadItemType(downloads.find((x) => x.id === pickerDownloadId) ?? {})}
        itemId={pickerDownloadId ?? ''}
        onClose={() => setPickerDownloadId(null)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1); getFolderItemCounts().then(setFolderCounts) }}
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
        title={`Add ${selected.size} Item${selected.size !== 1 ? 's' : ''} to Folder`}
        onConfirm={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
      </TabletContainer>
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
  const ifs = useInputFS()
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
          <Icon name="chevron.left" size={fs(17)} color={tokens.blu} />
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
          style={[styles.titleInput, { color: tokens.t1, fontSize: ifs(19) }]}
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
  redShift,
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
  redShift: boolean
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
                {rowTitle(item.document_number, item.title) ? (
                  <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={2}>
                    {rowTitle(item.document_number, item.title)}
                  </Text>
                ) : null}
                {item.blockText ? (
                  <>
                    <View style={[styles.highlightTag, { backgroundColor: redShift ? HIGHLIGHT_BG_REDSHIFT : HIGHLIGHT_BG, borderColor: redShift ? HIGHLIGHT_BDR_REDSHIFT : HIGHLIGHT_BDR }]}>
                      <Text style={{ color: redShift ? HIGHLIGHT_TEXT_REDSHIFT : HIGHLIGHT_TEXT, fontWeight: '700', fontSize: fs(10.5) }}>
                        {item.blockLabel ? `§ ${item.blockLabel} ` : 'HIGHLIGHT '}
                      </Text>
                      <Text numberOfLines={1} style={{ color: tokens.t2, fontSize: fs(11.5), flex: 1 }}>
                        {item.blockSnippet}
                      </Text>
                    </View>
                    {stale && (
                      <View style={styles.staleTag}>
                        <Icon name="exclamationmark.triangle" size={fs(11)} color={tokens.amb} />
                        <Text style={{ color: tokens.amb, fontSize: fs(10.5), fontWeight: '600' }}>
                          Section changed — won't jump to this spot anymore
                        </Text>
                      </View>
                    )}
                  </>
                ) : hasHighlight ? (
                  <View style={[styles.highlightTag, { backgroundColor: redShift ? HIGHLIGHT_BG_REDSHIFT : HIGHLIGHT_BG, borderColor: redShift ? HIGHLIGHT_BDR_REDSHIFT : HIGHLIGHT_BDR }]}>
                    <Icon name="highlighter" size={fs(11)} color={redShift ? HIGHLIGHT_TEXT_REDSHIFT : HIGHLIGHT_TEXT} />
                    <Text style={{ color: redShift ? HIGHLIGHT_TEXT_REDSHIFT : HIGHLIGHT_TEXT, fontWeight: '700', fontSize: fs(10.5), marginLeft: 4 }}>
                      Tap to view highlighted section
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
  onRefresh,
}: {
  downloads: DownloadedAC[]
  tokens: ReturnType<typeof useTheme>['tokens']
  onOpen: (item: DownloadedAC) => void
  onFolder: (item: DownloadedAC) => void
  onRemove: (item: DownloadedAC) => void
  onShare: (item: DownloadedAC) => void
  onRefresh: () => void
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
        <Icon name="arrow.down.circle" size={fs(40)} color={tokens.t4} />
        <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No downloads yet</Text>
        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
          Open any AC, FAR, AIM, P/CG, AD, or LOI and tap "Download" to save it here for reading with no connection.
        </Text>
      </View>
    )
  }

  return (
    <FlatList
      data={sorted}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.list}
      refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={tokens.t3} />}
      ListHeaderComponent={
        <View style={styles.offlineHeaderRow}>
          <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
            {downloads.length} DOWNLOADED DOCUMENT{downloads.length !== 1 ? 'S' : ''}
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
              <Icon name={REG_TYPE[downloadItemType(item) as RegType].icon} size={fs(18)} color={tokens.blu} />
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(12.5) }]}>
                  {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
                </Text>
              {rowTitle(item.document_number, item.title) ? (
                <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={2}>
                  {rowTitle(item.document_number, item.title)}
                </Text>
              ) : null}
              <Text style={[styles.savedAt, { color: tokens.t4, fontSize: fs(11) }]}>
                {formatBytes(item.size)} · Downloaded{' '}
                {new Date(item.downloadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable onPress={onFolder} hitSlop={8} style={styles.actionBtn}>
                <Icon name="folder.badge.plus" size={fs(22)} color={tokens.t3} />
              </Pressable>
              <Pressable onPress={onShare} hitSlop={8} style={styles.actionBtn}>
                <Icon name="square.and.arrow.up" size={fs(19)} color={tokens.t3} />
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
  redShift,
  fs,
}: {
  cacheKey: string
  avatarUrl?: string | null
  presetId?: string | null
  name?: string | null
  tokens: ReturnType<typeof useTheme>['tokens']
  redShift: boolean
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
    <View style={[styles.ownerAvatarFallback, { backgroundColor: avatarColorFor(preset, redShift) }]}>
      <Icon name={preset.icon} size={fs(16)} color="#fff" />
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
      <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
      <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>{label} is a Plus feature</Text>
      <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
        Unlock Plus to use {label.toLowerCase()}.
      </Text>
      <Pressable
        style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
        onPress={() => router.push('/paywall')}
      >
        <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
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
      <Icon name="bookmark" size={fs(40)} color={tokens.t4} />
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
  folderCapCard: {
    borderRadius: 14, borderWidth: 1, padding: 16, marginHorizontal: 16, marginTop: 12,
    alignItems: 'center', gap: 8,
  },
  folderCapTitle: { fontWeight: '700', textAlign: 'center' },
  folderCapBody: { textAlign: 'center', lineHeight: 18 },
  folderCapBtn: { borderRadius: 11, paddingHorizontal: 18, paddingVertical: 9, marginTop: 2 },
  folderCapBtnText: { color: '#000', fontWeight: '700' },
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
  sharedRowTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  unreadDot: { width: 7, height: 7, borderRadius: 3.5 },
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
  gridRow: { gap: 12 },
  gridCell: { flex: 1 },
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
