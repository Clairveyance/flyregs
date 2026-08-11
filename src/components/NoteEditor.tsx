import { useState, useEffect, useMemo, useRef } from 'react'
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, KeyboardAvoidingView, Keyboard, Platform, Animated, PanResponder, Dimensions, ActivityIndicator } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { ACBody } from '@/components/ACBody'
import { FigureViewer } from '@/components/FigureViewer'
import { FormulaRefViewer } from '@/components/FormulaRefViewer'
import { ACBlock, previewBlockCount } from '@/lib/acFormat'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { supabase } from '@/lib/supabase'
import { getACIndex, ACIndexEntry, detectACs } from '@/lib/acIndex'
import { getFarIndex, getAimIndex, getAdIndex, getPcgIndex, detectFARs, detectAIMs, detectADs, detectPCGs, PcgIndexEntry } from '@/lib/regIndex'
import { RegPreviewPane } from '@/components/RegPreviewPane'
import type { AcFigure, FormulaRef } from '@/types'
import type { Note } from '@/lib/notes'
import { router } from 'expo-router'
import { useScreenActions } from '@/context/screenActions'
import { useIsTablet } from '@/context/responsive'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'

// ─── Constants ────────────────────────────────────────────────────────────────

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
  // Truncated to a free-preview slice for non-Plus tiers server-side -- see
  // gotcha_tier_gate_client_side_only.md. pdf_blocks_total_count is the
  // TRUE count, unaffected by that truncation.
  pdf_blocks: ACBlock[] | null
  pdf_blocks_total_count: number
  cancels: string[]
  changed_block_indices: number[] | null
}

// ─── Note editor ──────────────────────────────────────────────────────────────
//
// Extracted out of notes.tsx (BB-080) so it can be opened inline from other
// screens too -- folder/[id].tsx previously navigated away to the Notes tab
// (router.push({ pathname: '/(tabs)/notes', params: { openId } })) just to
// edit a note found inside a folder, which meant "back" left the folder
// screen instead of returning to it. Any caller that owns its own list of
// Notes (notes.tsx, folder/[id].tsx) can now mount this directly.

export function NoteEditor({
  note, tokens, onSave, onClose, onDelete, onShare, onFolder, backLabel = 'Notes',
}: {
  note: Note
  tokens: ReturnType<typeof useTheme>['tokens']
  onSave: (n: Note) => void
  onClose: () => void
  onDelete?: () => void
  onShare?: () => void
  onFolder?: () => void
  /** What the back control reads -- defaults to 'Notes' for notes.tsx's own
   * usage. A caller that opens this inline from somewhere else (e.g. a
   * folder detail screen, BB-080) should pass its own screen name so
   * "back" doesn't falsely promise a return to the Notes tab. */
  backLabel?: string
}) {
  const insets = useSafeAreaInsets()
  const fs = useFS()
  const ifs = useInputFS()
  const isTablet = useIsTablet()
  const { hasPlusAccess, hasProAccess } = useAuth()
  const { badgeDays } = useBadgeLifespan()
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [acIndex, setACIndex] = useState<ACIndexEntry[]>([])
  const [farIndex, setFarIndex] = useState<string[]>([])
  const [aimIndex, setAimIndex] = useState<string[]>([])
  const [adIndex, setAdIndex] = useState<string[]>([])
  const [pcgIndex, setPcgIndex] = useState<PcgIndexEntry[]>([])
  // Generic single-document preview for the non-AC auto-linked chips below
  // (AC keeps its own bespoke drag-gesture pane, openAcPane/paneAC --
  // untouched here to avoid regressing already-working behavior). Route
  // strings match linkifyText's own convention ("/far/91.3", "/aim/4-3-13",
  // "/ad/2018-02-04", "/pcg/abeam").
  const [previewRoute, setPreviewRoute] = useState<string | null>(null)

  useEffect(() => {
    getACIndex().then(setACIndex)
    getFarIndex().then(setFarIndex)
    getAimIndex().then(setAimIndex)
    getAdIndex().then(setAdIndex)
    getPcgIndex().then(setPcgIndex)
  }, [])

  // AC bottom sheet state
  const [paneAC, setPaneAC] = useState<string | null>(null)
  const [paneData, setPaneData] = useState<ACPreview | null>(null)
  const [paneLoading, setPaneLoading] = useState(false)
  const paneScrollRef = useRef<ScrollView>(null)

  // Figures & Tables / Formulas for the pane's AC -- same two queries and
  // same Pro gate as the full AC detail screen (ac/[id].tsx). Without these,
  // this inline preview always rendered ACBody with figures/formulaRefs
  // undefined, so the "Figures & Tables" box under Contents silently never
  // appeared here even for ACs that do have one on the full detail screen.
  const [paneFigures, setPaneFigures] = useState<AcFigure[] | null>(null)
  const [paneFormulaRefs, setPaneFormulaRefs] = useState<FormulaRef[] | null>(null)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [viewerFormulaRef, setViewerFormulaRef] = useState<FormulaRef | null>(null)

  useEffect(() => {
    if (!paneData?.id) { setPaneFigures(null); setPaneFormulaRefs(null); return }
    setPaneFigures(null)
    supabase
      .from('ac_figures')
      .select('id,label,caption,page,image_url')
      .eq('ac_id', paneData.id)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setPaneFigures((data as AcFigure[]) ?? []))
    setPaneFormulaRefs(null)
    supabase
      .from('ac_formula_refs')
      .select('id,label,note,page,image_url')
      .eq('ac_id', paneData.id)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setPaneFormulaRefs((data as FormulaRef[]) ?? []))
  }, [paneData?.id])

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
    // Otherwise the keyboard stays up behind the sheet with no way to drag
    // it down without tapping the scrim, which also closes the sheet itself
    // -- forcing a tap-dismiss-then-retap-the-link cycle just to read the
    // AC. Dismissing it the moment the sheet opens means there's never
    // anything left to drag out of the way in the first place.
    Keyboard.dismiss()
    setPaneAC(acNum)
    setPaneData(null)
    setPaneLoading(true)
    snapTo(REST)

    // _gated view returns only the free-preview slice of pdf_blocks for
    // non-Plus tiers server-side -- see gotcha_tier_gate_client_side_only.md.
    // Previously fetched the raw table with no tier check at all: this pane
    // rendered a referenced AC's ENTIRE text under a "FULL TEXT" label to
    // every tier, unlike ac/[id].tsx's own already-correct preview limit.
    supabase
      .from('advisory_circulars_gated')
      .select('id,document_number,title,description,date_issued,office,pdf_blocks,pdf_blocks_total_count,cancels,changed_block_indices')
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
  const fars = useMemo(() => detectFARs(body, farIndex), [body, farIndex])
  const aims = useMemo(() => detectAIMs(body, aimIndex), [body, aimIndex])
  const ads = useMemo(() => detectADs(body, adIndex), [body, adIndex])
  const pcgs = useMemo(() => detectPCGs(body, pcgIndex), [body, pcgIndex])
  const linkedAC = acs[0] ?? null

  const handleDone = () => {
    if (!title.trim() && !body.trim()) { onClose(); return }
    onSave({ ...note, title: title.trim() || 'Untitled', body, linked_ac: linkedAC })
  }

  // RC, annotated iPad screenshot: Back/Folder/Share/Delete/Done circled,
  // moved to the bottom bar. Registers while this editor is mounted;
  // clears on unmount, at which point the caller's own useScreenActions
  // call re-asserts its own bottom-bar actions.
  useScreenActions(
    [
      { key: 'back', label: backLabel, onPress: onClose },
      ...(onFolder ? [{ key: 'folder', icon: 'folder.badge.plus', onPress: onFolder }] : []),
      ...(onShare ? [{ key: 'share', icon: 'square.and.arrow.up', onPress: onShare }] : []),
      ...(onDelete ? [{ key: 'delete', icon: 'trash', onPress: onDelete, variant: 'destructive' as const }] : []),
      { key: 'done', label: 'Done', onPress: handleDone, variant: 'primary' as const },
    ],
    [!!onFolder, !!onShare, !!onDelete]
  )

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
        {/* On iPad, Back/Folder/Share/Delete/Done all move to the bottom
            bar (useScreenActions above) -- RC, annotated screenshot: "all
            things like this need to find their way to the bottom of the
            screen." Phone keeps this header exactly as it was. */}
        {!isTablet && (
          <Pressable onPress={onClose} style={styles.editorBack} hitSlop={8}>
            <Icon name="chevron.left" size={fs(17)} color={tokens.blu} />
            <Text style={[styles.editorBackText, { color: tokens.blu, fontSize: fs(14) }]}>{backLabel}</Text>
          </Pressable>
        )}
        <Text style={[styles.editorHeadTitle, { color: tokens.t1, fontSize: fs(14) }, isTablet && { textAlign: 'left' }]}>
          {note.id ? 'Edit note' : 'New note'}
        </Text>
        {!isTablet && (
          <View style={styles.editorHeaderRight}>
            {onFolder && (
              <Pressable onPress={onFolder} hitSlop={10} style={styles.editorDeleteBtn}>
                <Icon name="folder.badge.plus" size={fs(21)} color={tokens.blu} />
              </Pressable>
            )}
            {onShare && (
              <Pressable onPress={onShare} hitSlop={10} style={styles.editorDeleteBtn}>
                <Icon name="square.and.arrow.up" size={fs(20)} color={tokens.blu} />
              </Pressable>
            )}
            {onDelete && (
              <Pressable onPress={onDelete} hitSlop={10} style={styles.editorDeleteBtn}>
                <Icon name="trash" size={fs(21)} color={tokens.red} />
              </Pressable>
            )}
            <Pressable onPress={handleDone} style={[styles.doneBtn, { backgroundColor: tokens.blu }]}>
              <Text style={[styles.doneBtnText, { fontSize: fs(13) }]}>Done</Text>
            </Pressable>
          </View>
        )}
      </View>

      {/* Body */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.editorBody}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <TextInput
          style={[styles.titleInput, { color: tokens.t1, fontSize: ifs(19) }]}
          placeholder="Title"
          placeholderTextColor={tokens.t3}
          value={title}
          onChangeText={setTitle}
          autoCapitalize="sentences"
          returnKeyType="next"
        />
        <View style={[styles.editorDivider, { backgroundColor: tokens.bdr }]} />
        <TextInput
          style={[styles.bodyInput, { color: tokens.t1, fontSize: ifs(15), lineHeight: fs(15) * 1.6 }]}
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
                  <Icon name="link" size={fs(11)} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>AC {ac}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Same auto-link idea as ACs above, generalized to the other 4
            reg types (see regIndex.ts) -- each opens the generic
            RegPreviewPane instead of the AC-specific drag pane. */}
        {fars.length > 0 && (
          <View style={styles.detectedSection}>
            <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED FARS</Text>
            <View style={styles.detectedChips}>
              {fars.map((f) => (
                <Pressable
                  key={f}
                  style={[styles.detectedChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={() => setPreviewRoute(`/far/${f}`)}
                >
                  <Icon name="link" size={fs(11)} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>§ {f}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {aims.length > 0 && (
          <View style={styles.detectedSection}>
            <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED AIM</Text>
            <View style={styles.detectedChips}>
              {aims.map((a) => (
                <Pressable
                  key={a}
                  style={[styles.detectedChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={() => setPreviewRoute(`/aim/${a}`)}
                >
                  <Icon name="link" size={fs(11)} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>¶ {a}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {ads.length > 0 && (
          <View style={styles.detectedSection}>
            <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED ADS</Text>
            <View style={styles.detectedChips}>
              {ads.map((a) => (
                <Pressable
                  key={a}
                  style={[styles.detectedChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={() => setPreviewRoute(`/ad/${a}`)}
                >
                  <Icon name="link" size={fs(11)} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>AD {a}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {pcgs.length > 0 && (
          <View style={styles.detectedSection}>
            <Text style={[styles.detectedLabel, { color: tokens.t3, fontSize: fs(11) }]}>AUTO-LINKED P/CG TERMS</Text>
            <View style={styles.detectedChips}>
              {pcgs.map((p) => (
                <Pressable
                  key={p.slug}
                  style={[styles.detectedChip, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={() => setPreviewRoute(`/pcg/${p.slug}`)}
                >
                  <Icon name="link" size={fs(11)} color={tokens.blu} />
                  <Text style={[styles.detectedChipText, { color: tokens.blu, fontSize: fs(12.5) }]}>{p.term}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      <RegPreviewPane route={previewRoute} onClose={() => setPreviewRoute(null)} />

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
              {paneData
                ? `AC ${paneData.document_number}${isOcrScanned(paneData.document_number) ? ' *' : ''}`
                : `AC ${paneAC}`}
            </Text>
            {paneData && isWithinBadgeLifespan(paneData.date_issued, badgeDays) && (() => {
              const badge = getBadgeStyle(getBadgeKind(paneData), tokens)
              return (
                <View style={[styles.paneBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
                  <Text style={[styles.paneBadgeText, { color: badge.color, fontSize: fs(9) }]}>{badge.label}</Text>
                </View>
              )
            })()}
            <Pressable onPress={closeAcPane} hitSlop={8}>
              <Icon name="xmark" size={fs(16)} color={tokens.t3} />
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
                {paneData.description
                  ? splitIntoDisplayParagraphs(paneData.description).map((para, i, arr) => (
                      <Text
                        key={i}
                        style={[styles.paneDesc, { color: tokens.t2, fontSize: fs(13) }, i < arr.length - 1 && { marginBottom: 8 }]}
                      >
                        {para}
                      </Text>
                    ))
                  : null}

                <Pressable
                  style={[styles.paneOpenBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
                  onPress={openFullAC}
                >
                  <Icon name="doc.text" size={fs(15)} color={tokens.blu} />
                  <Text style={[styles.paneOpenText, { color: tokens.blu, fontSize: fs(13) }]}>
                    Open full Advisory Circular
                  </Text>
                  <Icon name="chevron.right" size={fs(13)} color={tokens.blu} />
                </Pressable>

                {paneData.pdf_blocks && paneData.pdf_blocks.length > 0 ? (
                  <>
                    {/* Label matches what's actually shown -- pdf_blocks is
                        already truncated to the free preview for non-Plus,
                        same as ac/[id].tsx's own "FULL TEXT" vs preview
                        distinction. */}
                    <Text style={[styles.paneFullLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>
                      {hasPlusAccess ? 'FULL TEXT' : 'PREVIEW'}
                    </Text>
                    <ACBody
                      blocks={paneData.pdf_blocks}
                      bodyLimit={hasPlusAccess ? undefined : previewBlockCount(paneData.pdf_blocks_total_count)}
                      hasProAccess={hasProAccess}
                      scrollRef={paneScrollRef}
                      figures={hasPlusAccess ? (paneFigures ?? undefined) : undefined}
                      formulaRefs={hasPlusAccess ? (paneFormulaRefs ?? undefined) : undefined}
                      onOpenFigure={hasPlusAccess ? setViewerFigure : undefined}
                      onOpenFormulaRef={hasPlusAccess ? setViewerFormulaRef : undefined}
                    />
                    {!hasPlusAccess && paneData.pdf_blocks_total_count > previewBlockCount(paneData.pdf_blocks_total_count) && (
                      <Pressable onPress={() => { closeAcPane(); router.push('/paywall') }}>
                        <Text style={[styles.paneOpenText, { color: tokens.gold, fontSize: fs(12.5) }]}>
                          Unlock the rest with Plus →
                        </Text>
                      </Pressable>
                    )}
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

      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      <FormulaRefViewer formulaRef={viewerFormulaRef} onClose={() => setViewerFormulaRef(null)} />
    </KeyboardAvoidingView>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
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
  paneBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, marginRight: 10 },
  paneBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
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
