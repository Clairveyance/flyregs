import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Animated,
  PanResponder,
  Dimensions,
  ActivityIndicator,
} from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { ACBody } from '@/components/ACBody'
import { ACBlock } from '@/lib/acFormat'
import { supabase } from '@/lib/supabase'
import { FolderPicker } from '@/components/FolderPicker'
import { FolderSelectSheet } from '@/components/FolderSelectSheet'
import { addManyToFolder, getFolders } from '@/lib/folders'
import { getACIndex, ACIndexEntry } from '@/lib/acIndex'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useShareActions } from '@/lib/share'
import { getNotes, saveNotes, makeNoteId, type Note } from '@/lib/notes'
import { isSyncEnabled, enableSync, disableSync } from '@/lib/sync'
import { syncPushNote, syncPushNoteDeletes } from '@/lib/syncPush'

// ─── Constants ────────────────────────────────────────────────────────────────

// Candidate shape only — e.g. "61-65K", "20-172", "135-17". Real ACs are
// validated afterwards against the live AC index so arbitrary number pairs
// (phone numbers, dates, ratios) never get linked.
const AC_PATTERN = /\b(\d{1,3}-\d{1,4}[A-Za-z]{0,2})\b/g
const SCREEN_H = Dimensions.get('window').height
// AC reference sheet: full height anchored to the bottom, peeking at PEEK.
// Dragging only moves the top edge — the bottom stays pinned, so it never
// detaches from the screen bottom no matter how far up you pull.
const SHEET_H = Math.round(SCREEN_H * 0.85)
const PEEK = Math.round(SCREEN_H * 0.52)
const REST = SHEET_H - PEEK // resting translateY (collapsed, peeking)

// ─── Types ────────────────────────────────────────────────────────────────────

interface ACPreview {
  id: string
  document_number: string
  title: string
  description: string | null
  date_issued: string | null
  office: string | null
  pdf_blocks: ACBlock[] | null
}

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

// A candidate is only a real AC reference when it's a *complete* number, not a
// truncation of a longer one. "120-9" is a literal string-prefix of "120-90",
// "120-92", etc., but those are different ACs — so a plain startsWith() check
// would wrongly link "120-9". We require the real document_number to either
// equal the candidate exactly, or continue with a revision letter (not another
// digit) right after it — that's what distinguishes "120-90" (which should
// match "120-90"/"120-90A"/...) from "120-9" (which should match nothing).
function isValidACCandidate(candidate: string, index: ACIndexEntry[]): boolean {
  const lc = candidate.toLowerCase()
  return index.some((e) => {
    const doc = e.document_number.toLowerCase()
    if (doc === lc) return true
    if (!doc.startsWith(lc)) return false
    const nextChar = doc[lc.length]
    return nextChar === undefined || !/[0-9]/.test(nextChar)
  })
}

function detectACs(text: string, index: ACIndexEntry[]): string[] {
  if (index.length === 0) return []
  const candidates = [...text.matchAll(AC_PATTERN)].map((m) => m[1])
  const found = candidates.filter((c) => isValidACCandidate(c, index))
  return [...new Set(found)]
}


// ─── Screen ──────────────────────────────────────────────────────────────────

export default function NotesScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro, isPremium, session } = useAuth()
  const { shareNote, shareMany } = useShareActions()
  const { openId } = useLocalSearchParams<{ openId?: string }>()
  const [notes, setNotes] = useState<Note[]>([])
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

  useEffect(() => {
    getNotes().then(setNotes)
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
    if (!isPro || typeof openId !== 'string' || openId === openedIdRef.current) return
    const note = notes.find((n) => n.id === openId)
    if (note) {
      openedIdRef.current = openId
      setEditorNote({ ...note })
    }
  }, [openId, notes, isPro])

  const persist = useCallback((updated: Note[]) => {
    setNotes(updated)
    saveNotes(updated)
  }, [])

  const openNew = () => {
    if (!isPro) { router.push('/paywall'); return }
    setEditorNote({ id: '', title: '', body: '', linked_ac: null, updated_at: '' })
  }

  const openExisting = (note: Note) => {
    if (!isPro) { router.push('/paywall'); return }
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
    syncPushNote(saved)
    setEditorNote(null)
  }

  const deleteNote = (id: string) => {
    persist(notes.filter((n) => n.id !== id))
    syncPushNoteDeletes([id])
  }

  const confirmDelete = (id: string) =>
    Alert.alert('Delete Note', 'This note will be permanently deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteNote(id) },
    ])

  const confirmDeleteSelected = () => {
    const count = selected.size
    Alert.alert(`Delete ${count} Note${count > 1 ? 's' : ''}`, "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const ids = [...selected]
          persist(notes.filter((n) => !selected.has(n.id)))
          syncPushNoteDeletes(ids)
          setSelected(new Set())
          setSelectMode(false)
        },
      },
    ])
  }

  const toggleSelect = () => {
    if (selectMode) { setSelectMode(false); setSelected(new Set()) }
    else setSelectMode(true)
  }

  const handleBulkAddToFolder = async (folderId: string) => {
    const ids = [...selected]
    await addManyToFolder(folderId, 'note', ids)
    setFolderSheetVisible(false)
    setSelected(new Set())
    setSelectMode(false)
    const folder = (await getFolders()).find((f) => f.id === folderId)
    setConfirmLabel(folder ? `Added to ${folder.name}` : 'Added to folder')
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

  const toggleSync = async (v: boolean) => {
    // Back up & sync is a Premium feature — turning it on without Premium opens
    // the paywall (works on web too, where Alert.alert is a no-op).
    if (v && !isPremium) {
      router.push('/paywall?tier=premium')
      return // leave the switch off
    }
    if (v && session?.user?.id) {
      setSyncBusy(true)
      await enableSync(session.user.id)
      setNotes(await getNotes())
      setSyncBusy(false)
    } else {
      await disableSync()
    }
    setSyncEnabled(v)
  }

  const rightSlot = isPro ? (
    <View style={styles.headerRight}>
      <Pressable onPress={toggleSelect} hitSlop={8}>
        <Text style={[styles.selectBtnText, { color: tokens.blu, fontSize: fs(13) }]}>
          {selectMode ? 'Done' : 'Select'}
        </Text>
      </Pressable>
      {!selectMode && (
        <Pressable onPress={openNew} style={[styles.addBtn, { backgroundColor: tokens.blu }]}>
          <Icon name="plus" size={13} color="#fff" />
          <Text style={[styles.addBtnText, { fontSize: fs(12.5) }]}>New</Text>
        </Pressable>
      )}
    </View>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Notes" right={rightSlot} />

      {!isPro ? (
        <View style={[styles.empty, { padding: 32 }]}>
          <Icon name="lock.fill" size={36} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Notes is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Upgrade to Pro to create personal notes and link them directly to any AC.
          </Text>
          <Pressable
            style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]}
            onPress={() => router.push('/paywall')}
          >
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Upgrade to Pro</Text>
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
                    value={syncEnabled}
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

          {/* Notes list */}
          {notes.length === 0 ? (
            <View style={styles.empty}>
              <Icon name="square.and.pencil" size={36} color={tokens.t4} />
              <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No notes yet</Text>
              <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                Tap + New to start. Mention an AC like "61-65K" and it auto-links.
              </Text>
            </View>
          ) : (
            <FlatList
              data={notes}
              keyExtractor={(n) => n.id}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <SwipeableNoteCard
                  note={item}
                  tokens={tokens}
                  selectMode={selectMode}
                  selected={selected.has(item.id)}
                  onPress={() => openExisting(item)}
                  onDelete={() => confirmDelete(item.id)}
                  onFolder={() => setPickerNote(item)}
                  onShare={() => handleShare(item)}
                />
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
              <Icon name="trash" size={fs(23)} color="#ef4444" />
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
                  Alert.alert('Delete Note', "This can't be undone.", [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => { deleteNote(editorNote.id); setEditorNote(null) } },
                  ])
              : undefined
          }
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
        onSelect={handleBulkAddToFolder}
        onClose={() => setFolderSheetVisible(false)}
      />

      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

// ─── Swipeable note card ──────────────────────────────────────────────────────

function SwipeableNoteCard({
  note, tokens, selectMode, selected, onPress, onDelete, onFolder, onShare,
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onDelete: () => void
  onFolder?: () => void
  onShare?: () => void
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
      <View style={styles.deleteBg}>
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
          />
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

// ─── Note card ────────────────────────────────────────────────────────────────

function NoteCard({
  note, tokens, selectMode, selected, onPress, onFolder, onShare,
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  selectMode: boolean
  selected: boolean
  onPress: () => void
  onFolder?: () => void
  onShare?: () => void
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={onPress}
    >
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
              <Icon name="link" size={10} color={tokens.blu} />
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

// ─── Note editor ──────────────────────────────────────────────────────────────

function NoteEditor({
  note, tokens, onSave, onClose, onDelete,
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  onSave: (n: Note) => void
  onClose: () => void
  onDelete?: () => void
}) {
  const insets = useSafeAreaInsets()
  const fs = useFS()
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [acIndex, setACIndex] = useState<ACIndexEntry[]>([])

  useEffect(() => {
    getACIndex().then(setACIndex)
  }, [])

  // AC bottom sheet state
  const [paneAC, setPaneAC] = useState<string | null>(null)
  const [paneData, setPaneData] = useState<ACPreview | null>(null)
  const [paneLoading, setPaneLoading] = useState(false)
  const paneScrollRef = useRef<ScrollView>(null)

  // The sheet is full-height (SHEET_H) and pinned to the bottom. translateY
  // slides it: SHEET_H = fully closed (off bottom), REST = collapsed/peeking,
  // 0 = fully expanded. Because only the top edge moves, the bottom never lifts.
  const paneY = useRef(new Animated.Value(SHEET_H)).current
  const panBase = useRef(SHEET_H) // resting translateY; updated on each snap

  const SPRING = { damping: 24, stiffness: 240, mass: 0.7, useNativeDriver: true }

  const scrimOpacity = paneY.interpolate({
    inputRange: [0, SHEET_H],
    outputRange: [0.5, 0],
    extrapolate: 'clamp',
  })

  const snapTo = (target: number) => {
    panBase.current = target
    Animated.spring(paneY, { toValue: target, ...SPRING }).start()
  }

  const openAcPane = (acNum: string) => {
    setPaneAC(acNum)
    setPaneData(null)
    setPaneLoading(true)
    snapTo(REST)

    supabase
      .from('advisory_circulars')
      .select('id,document_number,title,description,date_issued,office,pdf_blocks')
      .ilike('document_number', `${acNum}%`)
      .order('document_number', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setPaneData(data as ACPreview | null)
        setPaneLoading(false)
      })
  }

  const closeAcPane = () => {
    panBase.current = SHEET_H
    Animated.timing(paneY, { toValue: SHEET_H, duration: 220, useNativeDriver: true }).start(() => {
      setPaneAC(null)
      setPaneData(null)
    })
  }

  const gripPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, { dy }) => Math.abs(dy) > 2,
      onPanResponderMove: (_, { dy }) => {
        const newY = Math.min(SHEET_H, Math.max(0, panBase.current + dy))
        paneY.setValue(newY)
      },
      onPanResponderRelease: (_, { dy, vy }) => {
        const tentative = Math.min(SHEET_H, Math.max(0, panBase.current + dy))
        // Flick down hard, or dragged well below the collapsed rest → close.
        if (vy > 1.2 || tentative > REST + PEEK * 0.45) {
          closeAcPane()
          return
        }
        // Otherwise snap to whichever of expanded(0) / collapsed(REST) is nearer.
        snapTo(tentative < REST / 2 ? 0 : REST)
      },
    })
  ).current

  const acs = useMemo(() => detectACs(body, acIndex), [body, acIndex])
  const linkedAC = acs[0] ?? null

  const handleDone = () => {
    if (!title.trim() && !body.trim()) { onClose(); return }
    onSave({ ...note, title: title.trim() || 'Untitled', body, linked_ac: linkedAC })
  }

  // Save the note, then open the full AC detail screen.
  const openFullAC = () => {
    if (!paneData) return
    const id = paneData.id
    handleDone()
    setTimeout(() => router.push(`/ac/${id}`), 60)
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[StyleSheet.absoluteFill, styles.editorRoot, { backgroundColor: tokens.bg }]}
    >
      {/* Header */}
      <View style={[styles.editorHeader, { backgroundColor: tokens.bg2, borderBottomColor: tokens.bdr, paddingTop: insets.top + 14 }]}>
        <Pressable onPress={onClose} style={styles.editorBack} hitSlop={8}>
          <Icon name="chevron.left" size={17} color={tokens.blu} />
          <Text style={[styles.editorBackText, { color: tokens.blu, fontSize: fs(14) }]}>Notes</Text>
        </Pressable>
        <Text style={[styles.editorHeadTitle, { color: tokens.t1, fontSize: fs(14) }]}>
          {note.id ? 'Edit note' : 'New note'}
        </Text>
        <View style={styles.editorHeaderRight}>
          {onDelete && (
            <Pressable onPress={onDelete} hitSlop={10} style={styles.editorDeleteBtn}>
              <Icon name="trash" size={fs(21)} color="#ef4444" />
            </Pressable>
          )}
          <Pressable onPress={handleDone} style={[styles.doneBtn, { backgroundColor: tokens.blu }]}>
            <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Done</Text>
          </Pressable>
        </View>
      </View>

      {/* Body */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.editorBody}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          style={[styles.titleInput, { color: tokens.t1, fontSize: fs(19) }]}
          placeholder="Title"
          placeholderTextColor={tokens.t3}
          value={title}
          onChangeText={setTitle}
          autoCapitalize="sentences"
          returnKeyType="next"
        />
        <View style={[styles.editorDivider, { backgroundColor: tokens.bdr }]} />
        <TextInput
          style={[styles.bodyInput, { color: tokens.t1, fontSize: fs(15), lineHeight: fs(15) * 1.6 }]}
          placeholder={'Start writing… mention an AC like "61-65K" and it\'ll auto-link.\n\nOn iOS, use your keyboard\'s dictation button to speak notes aloud.'}
          placeholderTextColor={tokens.t3}
          value={body}
          onChangeText={setBody}
          multiline
          autoCapitalize="sentences"
          textAlignVertical="top"
        />

        {/* Auto-linked AC chips */}
        {acs.length > 0 && (
          <View style={styles.detectedSection}>
            <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED ACS</Text>
            <View style={styles.detectedChips}>
              {acs.map((ac) => (
                <Pressable
                  key={ac}
                  style={[styles.detectedChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={() => openAcPane(ac)}
                >
                  <Icon name="link" size={11} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>AC {ac}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* Scrim behind pane */}
      {paneAC !== null && (
        <Animated.View
          style={[StyleSheet.absoluteFill, styles.paneScrim, { opacity: scrimOpacity }]}
          pointerEvents="box-none"
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={closeAcPane} />
        </Animated.View>
      )}

      {/* AC reference bottom sheet */}
      {paneAC !== null && (
        <Animated.View
          style={[
            styles.pane,
            { backgroundColor: tokens.bg2, borderTopColor: tokens.bdr2 },
            { transform: [{ translateY: paneY }] },
          ]}
        >
          {/* Grip — PanResponder target */}
          <View style={styles.gripArea} {...gripPan.panHandlers}>
            <View style={[styles.gripBar, { backgroundColor: tokens.t3 }]} />
          </View>

          {/* Pane header */}
          <View style={[styles.paneHeader, { borderBottomColor: tokens.bdr }]}>
            <Text style={[styles.paneTitle, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
              {paneData ? `AC ${paneData.document_number}` : `AC ${paneAC}`}
            </Text>
            <Pressable onPress={closeAcPane} hitSlop={8}>
              <Icon name="xmark" size={16} color={tokens.t3} />
            </Pressable>
          </View>

          {/* Pane body */}
          <ScrollView ref={paneScrollRef} style={{ flex: 1 }} contentContainerStyle={styles.paneBody}>
            {paneLoading ? (
              <ActivityIndicator color={tokens.blu} style={{ marginTop: 24 }} />
            ) : paneData ? (
              <>
                <Text style={[styles.paneACTitle, { color: tokens.t1, fontSize: fs(15) }]}>{paneData.title}</Text>
                {paneData.date_issued && (
                  <Text style={[styles.paneMeta, { color: tokens.t3, fontSize: fs(11.5) }]}>
                    {paneData.office ? `${paneData.office} · ` : ''}
                    Issued {new Date(paneData.date_issued).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })}
                  </Text>
                )}
                {paneData.description ? (
                  <Text style={[styles.paneDesc, { color: tokens.t2, fontSize: fs(13) }]}>{paneData.description}</Text>
                ) : null}

                <Pressable
                  style={[styles.paneOpenBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={openFullAC}
                >
                  <Icon name="doc.text" size={15} color={tokens.blu} />
                  <Text style={[styles.paneOpenText, { color: tokens.blu, fontSize: fs(13) }]}>
                    Open full Advisory Circular
                  </Text>
                  <Icon name="chevron.right" size={13} color={tokens.blu} />
                </Pressable>

                {paneData.pdf_blocks && paneData.pdf_blocks.length > 0 ? (
                  <>
                    <Text style={[styles.paneFullLabel, { color: tokens.t3 }]}>FULL TEXT</Text>
                    <ACBody
                      blocks={paneData.pdf_blocks}
                      scrollRef={paneScrollRef}
                    />
                  </>
                ) : (
                  <Text style={[styles.paneDrag, { color: tokens.t4, fontSize: fs(11) }]}>
                    Full text isn't available for this AC. Open it to view the PDF.
                  </Text>
                )}
              </>
            ) : (
              <Text style={[styles.paneDesc, { color: tokens.t3, fontSize: fs(13) }]}>
                AC {paneAC} not found in library.
              </Text>
            )}
          </ScrollView>
        </Animated.View>
      )}
    </KeyboardAvoidingView>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },


  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  selectBtnText: { fontSize: 13, fontWeight: '600' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 12.5 },

  syncWrap: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
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

  // Swipeable wrapper
  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  deleteBg: {
    position: 'absolute', top: 0, bottom: 0, right: 0, width: 84,
    backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center',
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

  // Editor
  editorRoot: { zIndex: 100 },
  editorHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 14, borderBottomWidth: 1, gap: 8 },
  editorBack: { flexDirection: 'row', alignItems: 'center', gap: 2, minWidth: 64 },
  editorBackText: { fontSize: 14, fontWeight: '500' },
  editorHeadTitle: { flex: 1, textAlign: 'center', fontWeight: '600', fontSize: 14 },
  editorHeaderRight: { flexDirection: 'row', alignItems: 'center', minWidth: 64, justifyContent: 'flex-end' },
  editorDeleteBtn: { marginRight: 12 },
  doneBtn: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7 },
  doneBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  editorBody: { padding: 16, paddingBottom: 40 },
  titleInput: { fontSize: 19, fontWeight: '700', paddingVertical: 4, marginBottom: 10 },
  editorDivider: { height: 1, marginBottom: 12 },
  bodyInput: { fontSize: 15, lineHeight: 24, minHeight: 200, paddingVertical: 4 },
  detectedSection: { marginTop: 20 },
  detectedLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 8 },
  detectedChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  detectedChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  detectedChipText: { fontSize: 12.5, fontWeight: '600' },

  // AC bottom sheet
  paneScrim: { backgroundColor: '#000', zIndex: 9 },
  pane: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    height: SHEET_H,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 1,
    zIndex: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: -8 }, shadowOpacity: 0.28, shadowRadius: 16, elevation: 20,
  },
  gripArea: { alignItems: 'center', paddingTop: 10, paddingBottom: 6, cursor: 'grab' } as any,
  gripBar: { width: 40, height: 4, borderRadius: 2 },
  paneHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1 },
  paneTitle: { flex: 1, fontWeight: '700', fontSize: 13.5 },
  paneBody: { padding: 14, paddingBottom: 24 },
  paneACTitle: { fontWeight: '600', fontSize: 15, lineHeight: 22, marginBottom: 6 },
  paneMeta: { fontSize: 11.5, marginBottom: 12 },
  paneDesc: { fontSize: 13, lineHeight: 20 },
  paneDrag: { fontSize: 11, marginTop: 20, textAlign: 'center', lineHeight: 16 },
  paneOpenBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingVertical: 10, paddingHorizontal: 12,
    marginTop: 14,
  },
  paneOpenText: { flex: 1, fontSize: 13, fontWeight: '600' },
  paneFullLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, marginTop: 18, marginBottom: 8 },
})
