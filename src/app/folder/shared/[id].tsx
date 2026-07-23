import { useEffect, useState, useCallback } from 'react'
import { View, Text, SectionList, Pressable, ActivityIndicator, Alert, StyleSheet, Modal, ScrollView } from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { supabase } from '@/lib/supabase'
import { getSharedFolderACItems, getSharedFolderNoteItems, leaveSharedFolder, markSharedFolderViewed } from '@/lib/sharedFolders'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { getACIndex, detectACs, ACIndexEntry } from '@/lib/acIndex'

interface ACRow {
  id: string
  document_number: string
  title: string
  cancels: string[]
  changed_block_indices: number[] | null
  date_issued: string | null
}

interface NoteRow {
  id: string
  title: string
  body: string
  linked_ac: string | null
  updated_at: string
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
  const { tokens } = useTheme()
  const fs = useFS()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { badgeDays } = useBadgeLifespan()
  const [folderName, setFolderName] = useState('')
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [acs, setAcs] = useState<ACRow[]>([])
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [removed, setRemoved] = useState(false)
  const [openNote, setOpenNote] = useState<NoteRow | null>(null)
  const [acIndex, setAcIndex] = useState<ACIndexEntry[]>([])

  // Same AC index the owner's own Notes tab uses to auto-link every AC
  // mention in a note's body, not just the single linked_ac field -- a
  // collaborator should see the same auto-linked chips the owner does.
  useEffect(() => { getACIndex().then(setAcIndex) }, [])

  const load = useCallback(async () => {
    if (typeof id !== 'string') return
    setLoading(true)
    const [{ data: folder }, acItems, noteItems] = await Promise.all([
      supabase.from('synced_folders').select('name').eq('id', id).eq('deleted', false).maybeSingle(),
      getSharedFolderACItems(id),
      getSharedFolderNoteItems(id),
    ])
    if (!folder) {
      setRemoved(true)
      setLoading(false)
      return
    }
    setFolderName(folder.name)

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
      setAcs(acRows ?? [])
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
      setNotes(noteRows ?? [])
    } else {
      setNotes([])
    }
    setLoading(false)
  }, [id])

  useFocusEffect(useCallback(() => { load() }, [load]))

  // Clears the unread dot in Saved > Shared > With Me the moment the
  // collaborator actually opens this folder -- fire-and-forget, not
  // load-bearing for the screen itself.
  useEffect(() => {
    if (typeof id === 'string') markSharedFolderViewed(id)
  }, [id])

  const handleLeave = () => {
    if (typeof id !== 'string') return
    Alert.alert('Leave Shared Folder', `You'll lose access to "${folderName}". You can rejoin later with a new invite link.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: async () => {
          await leaveSharedFolder(id)
          router.back()
        },
      },
    ])
  }

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
        <Icon name="person.2.fill" size={13} color={tokens.t3} />
        <Text style={[styles.badgeText, { color: tokens.t3, fontSize: fs(12) }]}>
          {ownerName ? `Shared by ${ownerName} — view only` : 'Shared with you — view only'}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : removed ? (
        <View style={styles.center}>
          <Icon name="folder" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>
            This folder is no longer shared
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13) }]}>
            The owner deleted it or stopped sharing.
          </Text>
        </View>
      ) : acs.length === 0 && notes.length === 0 ? (
        <View style={styles.center}>
          <Icon name="folder" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(15) }]}>Nothing here yet</Text>
        </View>
      ) : (
        <SectionList
          sections={[
            ...(acs.length ? [{ title: 'ADVISORY CIRCULARS', data: acs }] : []),
            ...(notes.length ? [{ title: 'NOTES', data: notes }] : []),
          ]}
          keyExtractor={(item: ACRow | NoteRow) => item.id}
          contentContainerStyle={styles.list}
          renderSectionHeader={({ section }) =>
            acs.length && notes.length ? (
              <Text style={[styles.sectionHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title}</Text>
            ) : null
          }
          renderItem={({ item }) =>
            'document_number' in item ? (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/ac/${item.id}`)}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.rowNumBadgeWrap}>
                    <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]}>
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
                  <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                    {item.title}
                  </Text>
                </View>
                <Icon name="chevron.right" size={14} color={tokens.t4} />
              </Pressable>
            ) : (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => setOpenNote(item)}
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
                        <Icon name="link" size={9} color={tokens.blu} />
                        <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {item.linked_ac}</Text>
                      </View>
                    )}
                  </View>
                </View>
                <Icon name="chevron.right" size={14} color={tokens.t4} />
              </Pressable>
            )
          }
        />
      )}

      <Modal visible={!!openNote} transparent animationType="fade" onRequestClose={() => setOpenNote(null)}>
        <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
            <View style={styles.modalHeader}>
              <View style={[styles.typeBadge, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
                <Text style={[styles.typeBadgeText, { color: tokens.grn, fontSize: fs(9.5) }]}>NOTE</Text>
              </View>
              <Pressable onPress={() => setOpenNote(null)} hitSlop={10}>
                <Icon name="xmark" size={18} color={tokens.t3} />
              </Pressable>
            </View>
            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 20 }}>
              <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(18) }]}>
                {openNote?.title || 'Untitled'}
              </Text>
              <Text style={[styles.modalBody, { color: tokens.t2, fontSize: fs(14.5) }]}>{openNote?.body}</Text>

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
                            <Icon name="link" size={9} color={tokens.blu} />
                            <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {doc}</Text>
                          </Pressable>
                        )
                      })}
                    </View>
                  </View>
                )
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
})
