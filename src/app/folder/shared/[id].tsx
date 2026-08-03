import { useEffect, useState, useCallback } from 'react'
import { View, Text, SectionList, Pressable, ActivityIndicator, Alert, StyleSheet, Modal, ScrollView } from 'react-native'
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { supabase } from '@/lib/supabase'
import {
  getSharedFolderACItems, getSharedFolderNoteItems, leaveSharedFolder, markSharedFolderViewed,
  getSharedFolderFARItems, getSharedFolderAIMItems, getSharedFolderPCGItems, getSharedFolderADItems, getSharedFolderLOIItems,
  getSharedFolderDictionaryItems,
} from '@/lib/sharedFolders'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { stripFarPrefix } from '@/lib/titleFormat'
import { getACIndex, detectACs, ACIndexEntry } from '@/lib/acIndex'
import { getFarIndex, getAimIndex, getAdIndex, getPcgIndex, detectFARs, detectAIMs, detectADs, detectPCGs, PcgIndexEntry } from '@/lib/regIndex'

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

// FAR/AIM/P-CG/AD/LOI item, normalized to one shape -- `label` is the
// short id (section/paragraph number, term, AD number) shown the same way
// document_number is for AC, `route` is the exact path this file already
// uses for AC (direct navigation, not RegPreviewPane -- matches this
// screen's own existing pattern rather than notes.tsx's newer preview-pane
// one, since a shared-folder row here has always just pushed straight to
// the detail screen).
interface RegRow {
  id: string
  regType: 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary'
  label: string
  title: string
  route: string
}

const REG_SECTION_TITLE: Record<RegRow['regType'], string> = {
  far: 'FEDERAL AVIATION REGULATIONS',
  aim: 'AERONAUTICAL INFORMATION MANUAL',
  pcg: 'PILOT/CONTROLLER GLOSSARY',
  ad: 'AIRWORTHINESS DIRECTIVES',
  loi: 'LEGAL INTERPRETATIONS',
  dictionary: 'AVIATION DICTIONARY',
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
  const [regs, setRegs] = useState<RegRow[]>([])
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [removed, setRemoved] = useState(false)
  const [openNote, setOpenNote] = useState<NoteRow | null>(null)
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
    const [{ data: folder }, acItems, noteItems, farItems, aimItems, pcgItems, adItems, loiItems, dictItems] = await Promise.all([
      supabase.from('synced_folders').select('name').eq('id', id).eq('deleted', false).maybeSingle(),
      getSharedFolderACItems(id),
      getSharedFolderNoteItems(id),
      getSharedFolderFARItems(id),
      getSharedFolderAIMItems(id),
      getSharedFolderPCGItems(id),
      getSharedFolderADItems(id),
      getSharedFolderLOIItems(id),
      getSharedFolderDictionaryItems(id),
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
    const [farRows, aimRows, pcgRows, adRows, loiRows, dictRows] = await Promise.all([
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
        ? supabase.from('airworthiness_directives').select('ad_number, title').in('ad_number', adIds)
        : Promise.resolve({ data: [] }),
      loiIds.length
        ? supabase.from('legal_interpretations').select('slug, title').in('slug', loiIds)
        : Promise.resolve({ data: [] }),
      // dictionary_terms keys on slug, same as pcg/loi -- matches what
      // dictionary/[slug].tsx passes to FolderPicker as itemId.
      dictIds.length
        ? supabase.from('dictionary_terms').select('slug, term').in('slug', dictIds)
        : Promise.resolve({ data: [] }),
    ])
    setRegs([
      ...(farRows.data ?? []).map((r: any): RegRow => ({ id: r.section_number, regType: 'far', label: `§ ${r.section_number}`, title: r.title, route: `/far/${r.section_number}` })),
      ...(aimRows.data ?? []).map((r: any): RegRow => ({ id: r.paragraph_number, regType: 'aim', label: r.paragraph_number, title: r.title ?? '', route: `/aim/${r.paragraph_number}` })),
      ...(pcgRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, regType: 'pcg', label: r.term, title: r.term, route: `/pcg/${r.slug}` })),
      ...(adRows.data ?? []).map((r: any): RegRow => ({ id: r.ad_number, regType: 'ad', label: r.ad_number, title: r.title, route: `/ad/${r.ad_number}` })),
      ...(loiRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, regType: 'loi', label: r.slug, title: r.title, route: `/loi/${r.slug}` })),
      ...(dictRows.data ?? []).map((r: any): RegRow => ({ id: r.slug, regType: 'dictionary', label: r.term, title: r.term, route: `/dictionary/${r.slug}` })),
    ])

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

  const sections: { title: string; data: (ACRow | NoteRow | RegRow)[] }[] = [
    ...(acs.length ? [{ title: 'ADVISORY CIRCULARS', data: acs as (ACRow | NoteRow | RegRow)[] }] : []),
    ...(['far', 'aim', 'pcg', 'ad', 'loi', 'dictionary'] as const)
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
          {ownerName ? `Shared by ${ownerName} — view only` : 'Shared with you — view only'}
        </Text>
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
          renderSectionHeader={({ section }) =>
            sections.length > 1 ? (
              <Text style={[styles.sectionHeader, { color: tokens.t3, fontSize: fs(11) }]}>{section.title}</Text>
            ) : null
          }
          renderItem={({ item }) =>
            'regType' in item ? (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(item.route as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowDoc, { color: tokens.blu, fontSize: fs(13) }]}>{item.label}</Text>
                  {item.regType !== 'pcg' && (
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
                      {stripFarPrefix(item.title)}
                    </Text>
                  )}
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            ) : 'document_number' in item ? (
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
                    {stripFarPrefix(item.title)}
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
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
                        <Icon name="link" size={fs(9)} color={tokens.blu} />
                        <Text style={[styles.acChipText, { color: tokens.blu, fontSize: fs(10.5) }]}>AC {item.linked_ac}</Text>
                      </View>
                    )}
                  </View>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )
          }
        />
        </TabletContainer>
      )}

      <Modal visible={!!openNote} transparent animationType="fade" onRequestClose={() => setOpenNote(null)}>
        <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
            <View style={styles.modalHeader}>
              <View style={[styles.typeBadge, { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }]}>
                <Text style={[styles.typeBadgeText, { color: tokens.grn, fontSize: fs(9.5) }]}>NOTE</Text>
              </View>
              <Pressable onPress={() => setOpenNote(null)} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
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
