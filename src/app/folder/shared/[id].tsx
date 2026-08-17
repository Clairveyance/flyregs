import { useEffect, useState, useCallback } from 'react'
import { View, Text, SectionList, Pressable, ActivityIndicator, StyleSheet, Modal, ScrollView, TextInput, RefreshControl, KeyboardAvoidingView, Platform, AppState } from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  getSharedFolderACItems, getSharedFolderNoteItems, leaveSharedFolder, markSharedFolderViewed,
  getSharedFolderFARItems, getSharedFolderAIMItems, getSharedFolderPCGItems, getSharedFolderADItems, getSharedFolderLOIItems,
  getSharedFolderDictionaryItems, getSharedFolderCfr49Items, FolderCollabMode, removeSharedFolderItem, addSharedFolderNote, updateSharedNote,
  resolveMissingAsHighlights, useFolderRealtime, SharedNoteAccessLostError,
} from '@/lib/sharedFolders'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix } from '@/lib/titleFormat'
import { getACIndex, detectACs, ACIndexEntry } from '@/lib/acIndex'
import { getFarIndex, getAimIndex, getAdIndex, getPcgIndex, detectFARs, detectAIMs, detectADs, detectPCGs, PcgIndexEntry } from '@/lib/regIndex'
import { useConfirm } from '@/components/ConfirmDialog'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface ACRow {
  id: string
  /** The synced_folder_items row's own id -- distinct from `id` (the AC's
   * own id). Removal targets this row, never the AC itself. */
  itemRowId: string
  document_number: string
  title: string
  cancels: string[]
  changed_block_indices: number[] | null
  date_issued: string | null
  /** Set only when this row is a highlight resolved via synced_bookmarks --
   * see resolveMissingAsHighlights. `id` above is the highlight bookmark's
   * own synthetic id (needed for removal), `acId` is the real
   * advisory_circulars.id needed to actually open the document. */
  acId?: string
  blockText?: string
  blockLabel?: string | null
  blockSnippet?: string
}

interface NoteRow {
  id: string
  itemRowId: string
  title: string
  body: string
  linked_ac: string | null
  updated_at: string
}

// Same highlighter-yellow accent Saved uses for its own H/L tag (see
// saved.tsx) -- kept as local constants here too since it isn't a theme
// token, just matched exactly so a highlight looks the same everywhere it
// shows up.
const HIGHLIGHT_BG = 'rgba(255, 213, 0, 0.12)'
const HIGHLIGHT_BDR = 'rgba(255, 213, 0, 0.4)'
// #8a6d00 (dark mustard) reads fine against Light's near-white bg (~4.9:1)
// but measured ~3:1 against Dark's near-black bg -- under WCAG AA's 4.5:1
// for text this small. Same gap and same fix as saved.tsx's identical tag.
const HIGHLIGHT_TEXT = '#8a6d00'
const HIGHLIGHT_TEXT_DARK = '#E0C040'
const HIGHLIGHT_BG_REDSHIFT = 'rgba(224, 86, 46, 0.16)'
const HIGHLIGHT_BDR_REDSHIFT = 'rgba(224, 86, 46, 0.45)'
const HIGHLIGHT_TEXT_REDSHIFT = '#FF9A6B'

// FAR/AIM/P-CG/AD/LOI item, normalized to one shape -- `label` is the
// short id (section/paragraph number, term, AD number) shown the same way
// document_number is for AC, `route` is the exact path this file already
// uses for AC (direct navigation, not RegPreviewPane -- matches this
// screen's own existing pattern rather than notes.tsx's newer preview-pane
// one, since a shared-folder row here has always just pushed straight to
// the detail screen).
interface RegRow {
  id: string
  itemRowId: string
  regType: 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary' | 'cfr49'
  label: string
  title: string
  route: string
  /** Set only when this row is a highlight resolved via synced_bookmarks --
   * same meaning as ACRow's own fields above. */
  blockText?: string
  blockLabel?: string | null
  blockSnippet?: string
}

const REG_SECTION_TITLE: Record<RegRow['regType'], string> = {
  far: 'FEDERAL AVIATION REGULATIONS',
  aim: 'AERONAUTICAL INFORMATION MANUAL',
  pcg: 'PILOT/CONTROLLER GLOSSARY',
  ad: 'AIRWORTHINESS DIRECTIVES',
  loi: 'LEGAL INTERPRETATIONS',
  dictionary: 'AVIATION DICTIONARY',
  cfr49: '49 CFR',
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  const days = Math.floor(secs / 86400)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// Read-only view of a folder someone else shared with you — no rename,
// delete, add, or remove controls, only opening each AC (which is still
// gated the same as anywhere else in the app: full text needs your OWN
// Pro/Premium subscription, being invited here doesn't unlock it).
export default function SharedFolderDetail() {
  const { tokens, redShift, resolved } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so these confirms (and the deletes behind them) were
  // invisible and untestable in the Browser pane. See ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { session } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const [folderName, setFolderName] = useState('')
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [collabMode, setCollabMode] = useState<FolderCollabMode>('read_only')
  const [acs, setAcs] = useState<ACRow[]>([])
  const [regs, setRegs] = useState<RegRow[]>([])
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [removed, setRemoved] = useState(false)
  const [openNote, setOpenNote] = useState<NoteRow | null>(null)
  // Item titles on this screen can run long and get cut off the same way
  // FAR Part titles do -- same hook/card pair as far/index.tsx's own
  // long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()
  const [noteEditing, setNoteEditing] = useState(false)
  const [noteEditTitle, setNoteEditTitle] = useState('')
  const [noteEditBody, setNoteEditBody] = useState('')
  const [addNoteVisible, setAddNoteVisible] = useState(false)
  const [newNoteTitle, setNewNoteTitle] = useState('')
  const [newNoteBody, setNewNoteBody] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const canWrite = collabMode === 'read_write'
  const [acIndex, setAcIndex] = useState<ACIndexEntry[]>([])
  const [farIndex, setFarIndex] = useState<string[]>([])
  const [aimIndex, setAimIndex] = useState<string[]>([])
  const [adIndex, setAdIndex] = useState<string[]>([])
  const [pcgIndex, setPcgIndex] = useState<PcgIndexEntry[]>([])

  // Same indexes the owner's own Notes tab uses to auto-link every AC/FAR/
  // AIM/AD/P-CG mention in a note's body, not just the single linked_ac
  // field -- a collaborator should see the same auto-linked chips the
  // owner does.
  useEffect(() => {
    getACIndex().then(setAcIndex)
    getFarIndex().then(setFarIndex)
    getAimIndex().then(setAimIndex)
    getAdIndex().then(setAdIndex)
    getPcgIndex().then(setPcgIndex)
  }, [])

  const load = useCallback(async () => {
    if (typeof id !== 'string') return
    setLoading(true)
    // Per-invitee mode, not the folder's owner-set default (BB-077 added a
    // per-collaborator collab_mode specifically so one person can have
    // write access and another read-only on the same folder -- reading
    // synced_folders.collab_mode here instead showed every collaborator
    // the OWNER's current "new invites get..." default, which drifts from
    // an already-accepted collaborator's real access the moment the owner
    // changes that default afterward (invite_folder_collaborator/
    // join_shared_folder both freeze collab_mode on the folder_collaborators
    // row at invite/accept time, they never retroactively update it). A
    // collaborator can read their own row -- confirmed live, RLS scopes it
    // to auth.uid() -- so this is safe without a new policy.
    const myId = session?.user.id
    const [{ data: folder }, { data: myCollab }, acItems, noteItems, farItems, aimItems, pcgItems, adItems, loiItems, dictItems, cfr49Items] = await Promise.all([
      supabase.from('synced_folders').select('name, collab_mode').eq('id', id).eq('deleted', false).maybeSingle(),
      myId
        ? supabase.from('folder_collaborators').select('collab_mode').eq('folder_id', id).eq('user_id', myId).is('left_at', null).maybeSingle()
        : Promise.resolve({ data: null }),
      getSharedFolderACItems(id),
      getSharedFolderNoteItems(id),
      getSharedFolderFARItems(id),
      getSharedFolderAIMItems(id),
      getSharedFolderPCGItems(id),
      getSharedFolderADItems(id),
      getSharedFolderLOIItems(id),
      getSharedFolderDictionaryItems(id),
      getSharedFolderCfr49Items(id),
    ])
    if (!folder) {
      setRemoved(true)
      setLoading(false)
      return
    }
    setFolderName(folder.name)
    // Falls back to the folder default only if my own collaborator row
    // somehow didn't resolve (e.g. RLS/network hiccup) -- never the other
    // way around, since the per-invitee value is the one the backend
    // actually enforces on every write.
    setCollabMode(((myCollab?.collab_mode ?? folder.collab_mode) as FolderCollabMode) ?? 'read_only')

    // Best-effort -- owner name is a nice-to-have, not load-bearing.
    try {
      const { data } = await supabase.rpc('get_shared_folder_owners', { p_folder_ids: [id] })
      setOwnerName(data?.[0]?.out_owner_display_name ?? null)
    } catch {
      setOwnerName(null)
    }

    const acIds = acItems.map((i) => i.item_id)
    if (acIds.length) {
      const { data: acRows } = await supabase
        .from('advisory_circulars')
        .select('id, document_number, title, cancels, changed_block_indices, date_issued')
        .in('id', acIds)
      const matched = new Set((acRows ?? []).map((r) => r.id))
      // Anything left unmatched is a highlight, not a missing AC -- see
      // resolveMissingAsHighlights' own comment for why item_id doesn't
      // resolve directly for those.
      const acHl = await resolveMissingAsHighlights('ac', acIds.filter((i) => !matched.has(i)), () => '')
      setAcs([
        ...(acRows ?? []).map((r) => ({ ...r, itemRowId: acItems.find((i) => i.item_id === r.id)?.id ?? '' })),
        ...acHl.map((h): ACRow => ({
          id: h.id,
          itemRowId: acItems.find((i) => i.item_id === h.id)?.id ?? '',
          document_number: h.document_number,
          title: h.title,
          cancels: [],
          changed_block_indices: null,
          date_issued: h.date_issued,
          acId: h.acId,
          blockText: h.blockText,
          blockLabel: h.blockLabel ?? null,
          blockSnippet: h.blockSnippet,
        })),
      ])
    } else {
      setAcs([])
    }

    const noteIds = noteItems.map((i) => i.item_id)
    if (noteIds.length) {
      const { data: noteRows } = await supabase
        .from('synced_notes')
        .select('id, title, body, linked_ac, updated_at')
        .in('id', noteIds)
        .eq('deleted', false)
      setNotes((noteRows ?? []).map((r) => ({ ...r, itemRowId: noteItems.find((i) => i.item_id === r.id)?.id ?? '' })))
    } else {
      setNotes([])
    }

    // Each type's item_id matches exactly what that type's own detail
    // screen passes as FolderPicker's itemId (section_number/paragraph_
    // number/slug/ad_number) -- see far/[id].tsx, aim/[id].tsx, pcg/[id].tsx,
    // ad/[id].tsx, loi/[slug].tsx. Fetched in parallel, one query per type,
    // same shape as the AC fetch above.
    const farIds = farItems.map((i) => i.item_id)
    const aimIds = aimItems.map((i) => i.item_id)
    const pcgIds = pcgItems.map((i) => i.item_id)
    const adIds = adItems.map((i) => i.item_id)
    const loiIds = loiItems.map((i) => i.item_id)
    const dictIds = dictItems.map((i) => i.item_id)
    const cfr49Ids = cfr49Items.map((i) => i.item_id)
    const [farRows, aimRows, pcgRows, adRows, loiRows, dictRows, cfr49Rows] = await Promise.all([
      farIds.length
        ? supabase.from('far_sections').select('section_number, title').in('section_number', farIds)
        : Promise.resolve({ data: [] }),
      aimIds.length
        ? supabase.from('aim_paragraphs').select('paragraph_number, title').in('paragraph_number', aimIds)
        : Promise.resolve({ data: [] }),
      pcgIds.length
        ? supabase.from('pcg_terms').select('slug, term').in('slug', pcgIds)
        : Promise.resolve({ data: [] }),
      adIds.length
        ? supabase.from('airworthiness_directives').select('ad_number, subject_heading').in('ad_number', adIds)
        : Promise.resolve({ data: [] }),
      loiIds.length
        ? supabase.from('legal_interpretations').select('slug, title').in('slug', loiIds)
        : Promise.resolve({ data: [] }),
      // dictionary_terms keys on slug, same as pcg/loi -- matches what
      // dictionary/[slug].tsx passes to FolderPicker as itemId.
      dictIds.length
        ? supabase.from('dictionary_terms').select('slug, term').in('slug', dictIds)
        : Promise.resolve({ data: [] }),
      cfr49Ids.length
        ? supabase.from('cfr49_sections').select('section_number, title').in('section_number', cfr49Ids)
        : Promise.resolve({ data: [] }),
    ])
    const rowIdFor = (list: { id: string; item_id: string }[], itemId: string) => list.find((i) => i.item_id === itemId)?.id ?? ''

    // Same highlight fallback as the AC block above -- an item_id that
    // missed the direct table lookup above is a highlight, not a deleted
    // doc. Dictionary has no highlight support (single-block definitions),
    // so it's excluded here.
    const farMatched = new Set((farRows.data ?? []).map((r: any) => r.section_number))
    const aimMatched = new Set((aimRows.data ?? []).map((r: any) => r.paragraph_number))
    const pcgMatched = new Set((pcgRows.data ?? []).map((r: any) => r.slug))
    const adMatched = new Set((adRows.data ?? []).map((r: any) => r.ad_number))
    const loiMatched = new Set((loiRows.data ?? []).map((r: any) => r.slug))
    const cfr49Matched = new Set((cfr49Rows.data ?? []).map((r: any) => r.section_number))
    const [farHl, aimHl, pcgHl, adHl, loiHl, cfr49Hl] = await Promise.all([
      resolveMissingAsHighlights('far', farIds.filter((i) => !farMatched.has(i)), () => ''),
      resolveMissingAsHighlights('aim', aimIds.filter((i) => !aimMatched.has(i)), () => ''),
      resolveMissingAsHighlights('pcg', pcgIds.filter((i) => !pcgMatched.has(i)), () => ''),
      resolveMissingAsHighlights('ad', adIds.filter((i) => !adMatched.has(i)), () => ''),
      resolveMissingAsHighlights('loi', loiIds.filter((i) => !loiMatched.has(i)), () => ''),
      resolveMissingAsHighlights('cfr49', cfr49Ids.filter((i) => !cfr49Matched.has(i)), () => ''),
    ])
    // Routes use acId (the real section/paragraph/slug/ad number the
    // highlight points back to), never document_number -- for P/CG those
    // diverge (document_number holds the display term, acId the real slug).
    const hlRoute = (base: string, h: { acId?: string; blockText?: string }) =>
      `${base}/${h.acId}${h.blockText ? `?hl=${encodeURIComponent(h.blockText)}` : ''}`
    setRegs([
      ...(farRows.data ?? []).map((r: any): RegRow => ({ id: r.section_number, itemRowId: rowIdFor(farItems, r.section_number), regType: 'far', label: `§ ${r.section_number}`, title: r.title, route: `/far/${r.section_number}` })),
      ...(aimRows.data ?? []).map((r: any): RegRow => ({ id: r.paragraph_number, itemRowId: rowIdFor(aimItems, r.paragraph_number), regType: 'aim', label: r.paragraph_number, title: r.title ?? '', route: `/aim/${r.paragraph_number}` })),
      ...(pcgRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, itemRowId: rowIdFor(pcgItems, r.slug), regType: 'pcg', label: r.term, title: r.term, route: `/pcg/${r.slug}` })),
      ...(adRows.data ?? []).map((r: any): RegRow => ({ id: r.ad_number, itemRowId: rowIdFor(adItems, r.ad_number), regType: 'ad', label: r.ad_number, title: r.subject_heading, route: `/ad/${r.ad_number}` })),
      ...(loiRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, itemRowId: rowIdFor(loiItems, r.slug), regType: 'loi', label: r.slug, title: r.title, route: `/loi/${r.slug}` })),
      ...(dictRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, itemRowId: rowIdFor(dictItems, r.slug), regType: 'dictionary', label: r.term, title: r.term, route: `/dictionary/${r.slug}` })),
      ...(cfr49Rows.data ?? []).map((r: any): RegRow => ({ id: r.section_number, itemRowId: rowIdFor(cfr49Items, r.section_number), regType: 'cfr49', label: `§ ${r.section_number}`, title: r.title, route: `/cfr49/${r.section_number}` })),
      ...farHl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(farItems, h.id), regType: 'far', label: `§ ${h.document_number}`, title: h.title, route: hlRoute('/far', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
      ...aimHl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(aimItems, h.id), regType: 'aim', label: h.document_number, title: h.title, route: hlRoute('/aim', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
      ...pcgHl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(pcgItems, h.id), regType: 'pcg', label: h.document_number, title: h.title, route: hlRoute('/pcg', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
      ...adHl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(adItems, h.id), regType: 'ad', label: h.document_number, title: h.title, route: hlRoute('/ad', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
      ...loiHl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(loiItems, h.id), regType: 'loi', label: h.document_number, title: h.title, route: hlRoute('/loi', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
      ...cfr49Hl.map((h): RegRow => ({ id: h.id, itemRowId: rowIdFor(cfr49Items, h.id), regType: 'cfr49', label: `§ ${h.document_number}`, title: h.title, route: hlRoute('/cfr49', h), blockText: h.blockText, blockLabel: h.blockLabel, blockSnippet: h.blockSnippet })),
    ])

    setLoading(false)
  }, [id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  // Live push on top of the pull-on-focus above -- sees the owner's edits
  // (or another collaborator's) while this screen is already open, not
  // just on the next focus.
  useFolderRealtime(typeof id === 'string' ? id : undefined, load)

  // Bug #5, RC real-device report 2026-08-16: "if the owner edits ... the
  // receiver can't see" it. Same fix/reasoning as the owner's own
  // folder/[id].tsx: useFocusEffect only fires on REACT NAVIGATION focus,
  // never on the OS backgrounding/foregrounding the app while this stays
  // the topmost route, and this app had zero AppState-driven data refresh
  // anywhere. Force a fresh pull on foreground regardless of whether the
  // realtime socket above reconnected cleanly on its own.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') load()
    })
    return () => sub.remove()
  }, [load])

  // Clears the unread dot in Saved > Shared > With Me the moment the
  // collaborator actually opens this folder -- fire-and-forget, not
  // load-bearing for the screen itself.
  useEffect(() => {
    if (typeof id === 'string') markSharedFolderViewed(id)
  }, [id])

  const handleLeave = () => {
    if (typeof id !== 'string') return
    confirm({
      title: 'Leave Shared Folder',
      message: `You'll lose access to "${folderName}". You can rejoin later with the invite link.`,
      confirmLabel: 'Leave',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await leaveSharedFolder(id)
        router.back()
      },
    })
  }

  // Deleted rather than removed from just this device -- there's no local
  // copy of someone else's folder to remove FROM, this is the real row.
  // RLS (editors_manage_shared_folder_items) allows this for any active
  // collaborator on a read_write folder, not only the person who added it.
  const handleRemoveItem = (itemRowId: string, label: string) => {
    confirm({
      title: 'Remove Item',
      message: `Remove ${label} from this folder? Everyone sharing it loses this item.`,
      confirmLabel: 'Remove',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await removeSharedFolderItem(itemRowId)
        setAcs((prev) => prev.filter((r) => r.itemRowId !== itemRowId))
        setRegs((prev) => prev.filter((r) => r.itemRowId !== itemRowId))
        setNotes((prev) => prev.filter((r) => r.itemRowId !== itemRowId))
      },
    })
  }

  const handleOpenNote = (note: NoteRow) => {
    setOpenNote(note)
    setNoteEditing(false)
    setNoteEditTitle(note.title)
    setNoteEditBody(note.body)
  }

  const handleSaveNoteEdit = async () => {
    if (!openNote) return
    try {
      await updateSharedNote(openNote.id, { title: noteEditTitle.trim() || 'Untitled', body: noteEditBody })
      const updated = { ...openNote, title: noteEditTitle.trim() || 'Untitled', body: noteEditBody, updated_at: new Date().toISOString() }
      setNotes((prev) => prev.map((n) => (n.id === openNote.id ? updated : n)))
      setOpenNote(updated)
      setNoteEditing(false)
    } catch (err) {
      // A stale "retry in a moment" message here would be actively wrong --
      // if the owner downgraded this account to read-only while this note
      // was open, the write can never succeed no matter how many times it's
      // retried. Found in the post-build-31 sweep: this used to look like a
      // real save (no error thrown), silently dropping the edit entirely.
      if (err instanceof SharedNoteAccessLostError) {
        confirm({ title: 'No longer editable', message: 'This folder was switched to read-only, so your changes here couldn’t be saved. Reload the folder to see the current version.', cancelLabel: null })
        setNoteEditing(false)
        load()
        return
      }
      confirm({ title: 'Error', message: 'Could not save. Try again in a moment.', cancelLabel: null })
    }
  }

  const handleAddNote = async () => {
    if (typeof id !== 'string' || !newNoteTitle.trim()) return
    setSavingNote(true)
    try {
      await addSharedFolderNote(id, newNoteTitle.trim(), newNoteBody)
      setAddNoteVisible(false)
      setNewNoteTitle('')
      setNewNoteBody('')
      load()
    } catch {
      confirm({ title: 'Error', message: 'Could not add the note. Try again in a moment.', cancelLabel: null })
    }
    setSavingNote(false)
  }

  const sections: { title: string; data: (ACRow | NoteRow | RegRow)[] }[] = [
    ...(acs.length ? [{ title: 'ADVISORY CIRCULARS', data: acs as (ACRow | NoteRow | RegRow)[] }] : []),
    ...(['far', 'aim', 'pcg', 'ad', 'loi', 'dictionary', 'cfr49'] as const)
      .map((regType) => ({ title: REG_SECTION_TITLE[regType], data: regs.filter((r) => r.regType === regType) as (ACRow | NoteRow | RegRow)[] }))
      .filter((s) => s.data.length > 0),
    ...(notes.length ? [{ title: 'NOTES', data: notes as (ACRow | NoteRow | RegRow)[] }] : []),
  ]

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={folderName}
        onBack={() => router.back()}
        right={
          <Pressable onPress={handleLeave} hitSlop={10}>
            <Icon name="rectangle.portrait.and.arrow.right" size={fs(20)} color={tokens.t3} />
          </Pressable>
        }
      />
      <View style={[styles.badgeRow, { borderBottomColor: tokens.bdr }]}>
        <Icon name="person.2.fill" size={fs(13)} color={tokens.t3} />
        <Text style={[styles.badgeText, { color: tokens.t3, fontSize: fs(12) }]}>
          {ownerName ? `Shared by ${ownerName}` : 'Shared with you'} — {canWrite ? 'you can edit' : 'view only'}
        </Text>
        {canWrite && (
          <Pressable onPress={() => setAddNoteVisible(true)} hitSlop={8} style={styles.addNoteBtn}>
            <Icon name="plus" size={fs(13)} color={tokens.blu} />
            <Text style={[styles.addNoteBtnText, { color: tokens.blu, fontSize: fs(12) }]}>Note</Text>
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : removed ? (
        <View style={styles.center}>
          <Icon name="folder" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>
            This folder is no longer shared
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13) }]}>
            The owner deleted it or stopped sharing.
          </Text>
        </View>
      ) : acs.length === 0 && notes.length === 0 && regs.length === 0 ? (
        <View style={styles.center}>
          <Icon name="folder" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>Nothing here yet</Text>
        </View>
      ) : (
        <TabletContainer>
        <SectionList
          sections={sections}
          keyExtractor={(item: ACRow | NoteRow | RegRow) => ('regType' in item ? `${item.regType}-${item.id}` : item.id)}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
          renderSectionHeader={({ section }) =>
            sections.length > 1 ? (
              <Text style={[styles.sectionHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title}</Text>
            ) : null
          }
          renderItem={({ item }) =>
            'regType' in item ? (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  router.push(item.route as any)
                }}
                onLongPress={(e) => {
                  // RC, real device: "verify every reg list actually HAS the
                  // tap-hold feature." Same bug shape found in MagicLinkPod's
                  // own LOI case: this used to skip showPreview entirely
                  // whenever item.blockText was set, reasoned "the title
                  // Text isn't even rendered in that state, nothing to
                  // preview" -- true for rowTitle, but false for what
                  // actually IS rendered instead: the highlightTag below,
                  // whose blockSnippet is capped at numberOfLines={1} and
                  // routinely longer than that (it's a real passage snippet,
                  // not a short label). item.blockText holds the complete,
                  // untruncated highlighted passage, so previewing THAT is
                  // the direct fix -- long-press now shows the full
                  // highlight instead of silently doing nothing.
                  if (item.blockText) showPreview(item.blockText, e, item.blockLabel ? `§ ${item.blockLabel}` : undefined)
                  else if (item.regType !== 'pcg') showPreview(stripFarPrefix(item.title), e)
                }}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <View style={{ flex: 1 }}>
                  {/* numberOfLines={1}, corpus-wide reg-number sweep:
                      item.label can be a FAR/cfr49 "§ N.NNN" (up to 17+2
                      chars for a range span) with no cap of its own before. */}
                  <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]} numberOfLines={1}>{item.label}</Text>
                  {item.blockText ? (
                    <View style={[styles.highlightTag, { backgroundColor: redShift ? HIGHLIGHT_BG_REDSHIFT : HIGHLIGHT_BG, borderColor: redShift ? HIGHLIGHT_BDR_REDSHIFT : HIGHLIGHT_BDR }]}>
                      <Icon name="highlighter" size={fs(11)} color={redShift ? HIGHLIGHT_TEXT_REDSHIFT : resolved === 'dark' ? HIGHLIGHT_TEXT_DARK : HIGHLIGHT_TEXT} />
                      <Text style={[styles.highlightTagText, { color: redShift ? HIGHLIGHT_TEXT_REDSHIFT : resolved === 'dark' ? HIGHLIGHT_TEXT_DARK : HIGHLIGHT_TEXT, fontSize: fs(10.5) }]} numberOfLines={1}>
                        {item.blockLabel ? `§ ${item.blockLabel} ` : ''}{item.blockSnippet}
                      </Text>
                    </View>
                  ) : item.regType !== 'pcg' && (
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                      {stripFarPrefix(item.title)}
                    </Text>
                  )}
                </View>
                {canWrite && (
                  <Pressable onPress={() => handleRemoveItem(item.itemRowId, item.label)} hitSlop={8} style={styles.removeBtn}>
                    <Icon name="trash" size={fs(15)} color={tokens.t4} />
                  </Pressable>
                )}
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            ) : 'document_number' in item ? (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  const acId = item.acId ?? item.id
                  const hlText = item.blockText ? `?hlText=${encodeURIComponent(item.blockText.slice(0, 120))}` : ''
                  router.push(`/ac/${acId}${hlText}` as any)
                }}
                onLongPress={(e) => {
                  // Same fix as the RegRow case above -- item.blockText's
                  // own passage is what's actually on screen (as a clipped
                  // highlightTag) whenever it's set, not the title.
                  if (item.blockText) showPreview(item.blockText, e, item.blockLabel ? `§ ${item.blockLabel}` : undefined)
                  else showPreview(stripFarPrefix(item.title), e)
                }}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.rowNumBadgeWrap}>
                    <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]} numberOfLines={1}>
                      {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
                    </Text>
                    {isWithinBadgeLifespan(item.date_issued, badgeDays) && (() => {
                      const badge = getBadgeStyle(getBadgeKind(item), tokens)
                      return (
                        <View style={[styles.rowNumBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
                          <Text style={[styles.rowNumBadgeText, { color: badge.color, fontSize: fs(8) }]}>{badge.label}</Text>
                        </View>
                      )
                    })()}
                  </View>
                  {item.blockText ? (
                    <View style={[styles.highlightTag, { backgroundColor: redShift ? HIGHLIGHT_BG_REDSHIFT : HIGHLIGHT_BG, borderColor: redShift ? HIGHLIGHT_BDR_REDSHIFT : HIGHLIGHT_BDR }]}>
                      <Icon name="highlighter" size={fs(11)} color={redShift ? HIGHLIGHT_TEXT_REDSHIFT : resolved === 'dark' ? HIGHLIGHT_TEXT_DARK : HIGHLIGHT_TEXT} />
                      <Text style={[styles.highlightTagText, { color: redShift ? HIGHLIGHT_TEXT_REDSHIFT : resolved === 'dark' ? HIGHLIGHT_TEXT_DARK : HIGHLIGHT_TEXT, fontSize: fs(10.5) }]} numberOfLines={1}>
                        {item.blockLabel ? `§ ${item.blockLabel} ` : ''}{item.blockSnippet}
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                      {stripFarPrefix(item.title)}
                    </Text>
                  )}
                </View>
                {canWrite && (
                  <Pressable onPress={() => handleRemoveItem(item.itemRowId, item.document_number)} hitSlop={8} style={styles.removeBtn}>
                    <Icon name="trash" size={fs(15)} color={tokens.t4} />
                  </Pressable>
                )}
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            ) : (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  handleOpenNote(item)
                }}
                onLongPress={(e) => showPreview(item.title || 'Untitled', e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <View style={[styles.typeBadge, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
                  <Text style={[styles.typeBadgeText, { color: tokens.grn, fontSize: fs(9.5) }]}>NOTE</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                    {item.title || 'Untitled'}
                  </Text>
                  <Text style={[styles.noteBody, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={2}>
                    {item.body}
                  </Text>
                  <View style={styles.rowFooter}>
                    <Text style={[styles.rowMeta, { color: tokens.t4, fontSize: fs(11) }]}>{timeAgo(item.updated_at)}</Text>
                    {item.linked_ac && (
                      <View style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                        <Icon name="link" size={fs(9)} color={tokens.blu} />
                        <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {item.linked_ac}</Text>
                      </View>
                    )}
                  </View>
                </View>
                {canWrite && (
                  <Pressable onPress={() => handleRemoveItem(item.itemRowId, item.title || 'this note')} hitSlop={8} style={styles.removeBtn}>
                    <Icon name="trash" size={fs(15)} color={tokens.t4} />
                  </Pressable>
                )}
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )
          }
        />
        </TabletContainer>
      )}

      <Modal visible={!!openNote} transparent animationType="fade" onRequestClose={() => setOpenNote(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
            <View style={styles.modalHeader}>
              <View style={[styles.typeBadge, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
                <Text style={[styles.typeBadgeText, { color: tokens.grn, fontSize: fs(9.5) }]}>NOTE</Text>
              </View>
              {canWrite && (
                <Pressable onPress={() => (noteEditing ? handleSaveNoteEdit() : setNoteEditing(true))} hitSlop={10} style={styles.modalEditBtn}>
                  <Icon name={noteEditing ? 'checkmark' : 'pencil'} size={fs(17)} color={tokens.blu} />
                </Pressable>
              )}
              <Pressable onPress={() => setOpenNote(null)} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>
            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 20 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
              {noteEditing ? (
                <>
                  <TextInput
                    style={[styles.modalTitleInput, { color: tokens.t1, fontSize: ifs(18), borderColor: tokens.bdr2 }]}
                    value={noteEditTitle}
                    onChangeText={setNoteEditTitle}
                    placeholder="Title"
                    placeholderTextColor={tokens.t3}
                  />
                  <TextInput
                    style={[styles.modalBodyInput, { color: tokens.t2, fontSize: ifs(14.5), borderColor: tokens.bdr2 }]}
                    value={noteEditBody}
                    onChangeText={setNoteEditBody}
                    placeholder="Note"
                    placeholderTextColor={tokens.t3}
                    multiline
                  />
                </>
              ) : (
                <>
                  <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(18) }]}>
                    {openNote?.title || 'Untitled'}
                  </Text>
                  <Text style={[styles.modalBody, { color: tokens.t2, fontSize: fs(14.5) }]}>{openNote?.body}</Text>
                </>
              )}

              {/* Every AC mentioned in the body, auto-linked exactly like the
                  owner's own Notes tab — not just the single linked_ac field,
                  which only ever stores the first mention. */}
              {(() => {
                const mentioned = openNote ? detectACs(openNote.body, acIndex) : []
                if (!mentioned.length) return null
                return (
                  <View style={styles.modalChipSection}>
                    <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED ACS</Text>
                    <View style={styles.detectedChips}>
                      {mentioned.map((doc) => {
                        const entry = acIndex.find((e) => e.document_number === doc)
                        return (
                          <Pressable
                            key={doc}
                            style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                            disabled={!entry}
                            onPress={() => {
                              if (!entry) return
                              setOpenNote(null)
                              router.push(`/ac/${entry.id}`)
                            }}
                          >
                            <Icon name="link" size={fs(9)} color={tokens.blu} />
                            <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {doc}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  </View>
                )
              })()}

              {(() => {
                const fars = openNote ? detectFARs(openNote.body, farIndex) : []
                if (!fars.length) return null
                return (
                  <View style={styles.modalChipSection}>
                    <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED FARS</Text>
                    <View style={styles.detectedChips}>
                      {fars.map((f) => (
                        <Pressable
                          key={f}
                          style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                          onPress={() => { setOpenNote(null); router.push(`/far/${f}`) }}
                        >
                          <Icon name="link" size={fs(9)} color={tokens.blu} />
                          <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>FAR {f}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )
              })()}

              {(() => {
                const aims = openNote ? detectAIMs(openNote.body, aimIndex) : []
                if (!aims.length) return null
                return (
                  <View style={styles.modalChipSection}>
                    <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED AIM</Text>
                    <View style={styles.detectedChips}>
                      {aims.map((a) => (
                        <Pressable
                          key={a}
                          style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                          onPress={() => { setOpenNote(null); router.push(`/aim/${a}`) }}
                        >
                          <Icon name="link" size={fs(9)} color={tokens.blu} />
                          <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AIM {a}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )
              })()}

              {(() => {
                const ads = openNote ? detectADs(openNote.body, adIndex) : []
                if (!ads.length) return null
                return (
                  <View style={styles.modalChipSection}>
                    <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED ADS</Text>
                    <View style={styles.detectedChips}>
                      {ads.map((a) => (
                        <Pressable
                          key={a}
                          style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                          onPress={() => { setOpenNote(null); router.push(`/ad/${a}`) }}
                        >
                          <Icon name="link" size={fs(9)} color={tokens.blu} />
                          <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AD {a}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )
              })()}

              {(() => {
                const pcgs = openNote ? detectPCGs(openNote.body, pcgIndex) : []
                if (!pcgs.length) return null
                return (
                  <View style={styles.modalChipSection}>
                    <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED P/CG TERMS</Text>
                    <View style={styles.detectedChips}>
                      {pcgs.map((p) => (
                        <Pressable
                          key={p.slug}
                          style={[styles.acChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                          onPress={() => { setOpenNote(null); router.push(`/pcg/${p.slug}`) }}
                        >
                          <Icon name="link" size={fs(9)} color={tokens.blu} />
                          <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>{p.term}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                )
              })()}
            </ScrollView>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={addNoteVisible} transparent animationType="fade" onRequestClose={() => setAddNoteVisible(false)}>
        {/* BB-085, RC real-device beta report: "the note/text input box is
            locked/stuck on the screen. it can't adjust, the k/b blocks part
            of it, you can't move or hide the k/b, and can't even get to the
            Done/Save blue button." Root cause: this Add Note modal had
            neither a KeyboardAvoidingView nor a ScrollView -- a vertically-
            centered card with an empty multiline body input and no keyboard
            accommodation at all, unlike the sibling view/edit-note modal
            above (which already scrolls). KeyboardAvoidingView shifts the
            whole centered card up so the keyboard doesn't just cover
            whatever's behind it; the inner ScrollView is the fallback for
            whatever's still too tall once the card itself has been shifted
            as far as it can go. */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
            <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
              <View style={styles.modalHeader}>
                <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(16) }]}>New Note</Text>
                <Pressable onPress={() => setAddNoteVisible(false)} hitSlop={10}>
                  <Icon name="xmark" size={fs(18)} color={tokens.t3} />
                </Pressable>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false}>
                <TextInput
                  style={[styles.modalTitleInput, { color: tokens.t1, fontSize: ifs(18), borderColor: tokens.bdr2 }]}
                  value={newNoteTitle}
                  onChangeText={setNewNoteTitle}
                  placeholder="Title"
                  placeholderTextColor={tokens.t3}
                  autoFocus
                />
                <TextInput
                  style={[styles.modalBodyInput, { color: tokens.t2, fontSize: ifs(14.5), borderColor: tokens.bdr2 }]}
                  value={newNoteBody}
                  onChangeText={setNewNoteBody}
                  placeholder="Note"
                  placeholderTextColor={tokens.t3}
                  multiline
                />
                <Pressable
                  style={[styles.saveNoteBtn, { backgroundColor: tokens.blu, opacity: newNoteTitle.trim() && !savingNote ? 1 : 0.5 }]}
                  onPress={handleAddNote}
                  disabled={!newNoteTitle.trim() || savingNote}
                >
                  <Text style={[styles.saveNoteBtnText, { fontSize: fs(14) }]}>{savingNote ? 'Adding…' : 'Add Note'}</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badgeText: { fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptyTitle: { fontWeight: '600', textAlign: 'center' },
  emptySub: { textAlign: 'center', marginTop: 2 },
  list: { padding: 16, gap: 10 },
  sectionHeader: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 6, marginTop: 4 },
  noteBody: { marginTop: 3, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowDoc: { fontWeight: '700', marginBottom: 2 },
  rowNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  rowNumBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  rowNumBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  rowTitle: { fontWeight: '500' },
  highlightTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginTop: 2,
    maxWidth: '100%',
  },
  highlightTagText: { fontWeight: '700', flexShrink: 1 },
  typeBadge: {
    borderRadius: 5,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  typeBadgeText: { fontWeight: '800', letterSpacing: 0.3 },
  rowFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  rowMeta: {},
  acChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  acChipText: { fontWeight: '700' },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: {
    width: '100%',
    maxHeight: '75%',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  modalScroll: {},
  modalTitle: { fontWeight: '700', marginBottom: 10 },
  modalBody: { lineHeight: 21 },
  modalChipSection: { marginTop: 16 },
  detectedLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 },
  detectedChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  addNoteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 'auto', paddingVertical: 3, paddingHorizontal: 6 },
  addNoteBtnText: { fontWeight: '600' },
  removeBtn: { padding: 4 },
  modalEditBtn: { marginLeft: 'auto', marginRight: 12, padding: 2 },
  headerTitle: { flex: 1, fontWeight: '700' },
  modalTitleInput: { fontWeight: '700', marginBottom: 10, borderWidth: 1, borderRadius: 8, padding: 8 },
  modalBodyInput: { lineHeight: 21, borderWidth: 1, borderRadius: 8, padding: 8, minHeight: 100, textAlignVertical: 'top' },
  saveNoteBtn: { borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 4 },
  saveNoteBtnText: { color: '#fff', fontWeight: '600' },
})
