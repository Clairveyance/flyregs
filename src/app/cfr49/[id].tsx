import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Keyboard } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { printReg } from '@/lib/printReg'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb, PrevNextFooter, TableNavBar, ChangedBanner } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'
import { DetailActionRow } from '@/components/DetailMeta'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { getSemanticRelated, mergeRelated } from '@/lib/relatedContent'
import { getLatestRevision, changedParagraphIndices, type ContentRevision } from '@/lib/whatsChanged'
import { normalizeRegBody } from '@/lib/regTextFormat'
import { fetchMnemonicAnchors, MnemonicAnchor } from '@/lib/regMnemonics'
import { useConfirm } from '@/components/ConfirmDialog'
import { naturalCompare } from '@/lib/naturalSort'

// 49 CFR (NTSB/TSA/HMR) detail screen -- mirrors far/[id].tsx's structure
// and feature set closely (bookmark, highlight, folder, download, print,
// tables, prev/next, MagicLink cross-refs) per RC's standing "every
// feature behaves identically everywhere" rule, see
// sync/migrations_cfr49_schema.sql's header for the build's full context.
// Deliberately different from far/[id].tsx in two ways:
//   - No Share button: buildRegShareLink/toRegShareType (regShare.ts)
//     require a website-side VALID_TYPES update this pass doesn't include;
//     bookmark/highlight/folder/download/print all work independently.
//   - No tablet SplitPane path: iPad is paused until after beta.
// Cross-ref bars and semantic-related will read empty until the citation-
// extraction and embeddings passes (search/MagicLink wiring) land -- same
// "0 is a real, always-shown state" convention as every other type here.

interface Cfr49Section {
  section_number: string
  part: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
  body_text: string | null
}

interface Cfr49Part {
  part: string
  label: string
  family: string
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

const FAMILY_LABEL: Record<string, string> = { HMR: 'HMR', NTSB: 'NTSB', TSA: 'TSA' }

export default function Cfr49SectionScreen() {
  const { id, hl } = useLocalSearchParams<{ id: string; hl?: string }>()
  const { tokens } = useTheme()
  const confirm = useConfirm()
  const fs = useFS()
  // `loading: authLoading` -- every tier gate in this file is guarded with
  // `if (!authLoading)` before it navigates. isPro/isPremium/isUnlocked all
  // START false and only become authoritative once auth's own `loading`
  // resolves: on cold launch, and again on the SIGNED_IN event a Face ID
  // sign-in raises (see context/auth.tsx's own comment on that). This screen
  // is reachable by share link and by push-notification deep link, so a real
  // subscriber genuinely can be looking at it, and tapping its header
  // controls, inside that window -- and the un-guarded gates would have sent
  // them to a paywall for a tier they already pay for. Doing nothing for the
  // fraction of a second it takes to resolve is the lesser evil; a second tap
  // once entitlements land behaves normally. Same principle as
  // (tabs)/index.tsx's HobbsHeaderButton, which refuses to act on the same
  // transient false.
  const { hasPlusAccess, hasProAccess, isPremium, loading: authLoading } = useAuth()
  const [section, setSection] = useState<Cfr49Section | null>(null)
  const [part, setPart] = useState<Cfr49Part | null>(null)
  // Split so the section text can render as soon as the fast citation query
  // resolves, without waiting on the much slower semantic "related content"
  // RPC -- see the loading effect below for why. mergeRelated() is pure and
  // safe to call with whichever of these two has filled in so far.
  const [citationRelated, setCitationRelated] = useState<RelatedItem[]>([])
  const [semanticRelated, setSemanticRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [backTo, setBackTo] = useState<string | null>(null)
  const [siblingSections, setSiblingSections] = useState<string[]>([])
  const [scrollY, setScrollY] = useState(0)
  const [tablesExpanded, setTablesExpanded] = useState(false)
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  const [activeTable, setActiveTable] = useState<{ ord: number; total: number; prevIndex: number | null; nextIndex: number | null } | null>(null)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  useEffect(() => {
    if (id) isDownloaded(id).then(setDownloaded)
  }, [id])

  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

  const [revision, setRevision] = useState<ContentRevision | null>(null)
  useEffect(() => {
    if (!id) return
    getLatestRevision('cfr49', id).then(setRevision).catch(() => setRevision(null))
  }, [id])

  const [mnemonicAnchors, setMnemonicAnchors] = useState<MnemonicAnchor[]>([])
  useEffect(() => {
    if (!id) return
    fetchMnemonicAnchors('cfr49', id).then(setMnemonicAnchors).catch(() => setMnemonicAnchors([]))
  }, [id])

  const changedIdx = useMemo(
    () => changedParagraphIndices(section?.body_text ?? '', revision?.addedText ?? null),
    [section?.body_text, revision],
  )
  const [changedCursor, setChangedCursor] = useState(0)
  const jumpToChanged = (dir: 1 | -1) => {
    if (changedIdx.length === 0) return
    const next = (changedCursor + dir + changedIdx.length) % changedIdx.length
    setChangedCursor(next)
    setTimeout(() => bodyRef.current?.scrollToParagraph(changedIdx[next]), 60)
  }

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
  }, [id])

  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!id) return
    getHighlightsForAC(id, 'cfr49').then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [id])
  const [pendingHighlight, setPendingHighlight] = useState<string | null>(null)

  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    // Reset both -- otherwise a fast nav between two sections (Prev/Next)
    // can briefly show the PREVIOUS section's related content under the
    // new one's header while the new fetches are in flight.
    setCitationRelated([])
    setSemanticRelated([])

    // Fast path: the section text itself + its citations. This is the only
    // thing that should gate the page opening -- previously this was one
    // single Promise.all with the semantic "related content" RPC below,
    // which meant the actual section text (what the user tapped in to
    // read) waited on a decorative "related content" feature that has
    // nothing to do with reading the section. RC, real device: "content
    // retrieval... taking too long, several seconds just to get a page
    // open... tighten all flows, reduce waste."
    Promise.all([
      supabase
        .from('cfr49_sections')
        .select('section_number, part, subpart_letter, subpart_title, title, body_text')
        .eq('section_number', id)
        .single(),
      supabase
        .from('document_citations_gated')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.cfr49,cited_id.eq.${id}),and(citing_type.eq.cfr49,citing_id.eq.${id})`),
    ]).then(async ([secRes, citRes]) => {
      if (!secRes.error && secRes.data) {
        const s = secRes.data as Cfr49Section
        setSection(s)
        supabase.from('cfr49_parts').select('part, label, family').eq('part', s.part).single()
          .then(({ data }) => { if (data) setPart(data as Cfr49Part) })
        addRecent({
          id: s.section_number,
          itemType: 'cfr49',
          document_number: `§ ${s.section_number}`,
          title: s.title ?? '',
          date_issued: null,
          subject_series: null,
        })
      } else {
        const cached = await findDownload(id)
        if (cached) {
          setSection({
            section_number: cached.document_number.replace(/^§\s*/, ''),
            part: cached.subject_series ?? '',
            subpart_letter: null,
            subpart_title: null,
            title: cached.title,
            body_text: cached.body_text ?? null,
          })
        }
      }
      if (!citRes.error && citRes.data) {
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'cfr49' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'cfr49' && r.cited_id === id))
        setCitationRelated(other)
      }
      setLoading(false)
    })

    // Slow path: semantic "related content" (embedding similarity search).
    // Decoupled from the fast path above so it never blocks the section
    // text -- it merges into the MagicLink pod whenever it happens to
    // resolve.
    getSemanticRelated('cfr49', id).then(setSemanticRelated)
  }, [id])

  useEffect(() => {
    if (!section?.part) return
    supabase
      .from('cfr49_sections')
      .select('section_number')
      .eq('part', section.part)
      .then(({ data }) => {
        if (data) {
          setSiblingSections(
            (data as { section_number: string }[])
              .map((r) => r.section_number)
              .sort((a, b) => naturalCompare(a, b)),
          )
        }
      })
  }, [section?.part])

  const siblingIdx = section ? siblingSections.indexOf(section.section_number) : -1
  const prevSection = siblingIdx > 0 ? siblingSections[siblingIdx - 1] : null
  const nextSection = siblingIdx >= 0 && siblingIdx < siblingSections.length - 1 ? siblingSections[siblingIdx + 1] : null

  const body = section?.body_text ?? ''
  const currentLabel = section ? `§ ${section.section_number}` : undefined
  const bodyParagraphs = normalizeRegBody(body).split(/\n\n+/).filter((p) => p.trim())
  const LEADING_MARKER_RE = /^(\([a-zA-Z0-9]{1,4}\)|[a-zA-Z0-9]{1,3}\.)\s+/
  const tables = bodyParagraphs
    .map((para, i) => ({ para, i }))
    .filter(({ para }) => para.split('\n').filter((l) => l.includes(' | ')).length >= 2)
    .map(({ i }, n, arr) => {
      const marker = bodyParagraphs[i - 1]?.match(LEADING_MARKER_RE)?.[1]
      return { paraIndex: i, label: marker ? `Table ${marker}` : arr.length > 1 ? `Table ${n + 1}` : 'Table' }
    })
  const tableCount = tables.length

  const related = mergeRelated(citationRelated, semanticRelated)
  const farRefs = related.filter((r) => r.cited_type === 'far')
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')

  const handleToggleBookmark = async () => {
    if (!section) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setBookmarked((prev) => !prev)
    const next = await toggleBookmark({
      id: section.section_number,
      itemType: 'cfr49',
      document_number: `§ ${section.section_number}`,
      title: section.title ?? '',
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (paraText: string) => {
    if (!section) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      const existing = await findHighlight(section.section_number, paraText, 'cfr49')
      if (existing) {
        await removeHighlight(existing.id)
      } else {
        await addHighlight({
          acId: section.section_number,
          itemType: 'cfr49',
          document_number: `§ ${section.section_number}`,
          title: section.title ?? '',
          date_issued: null,
          office: null,
          subject_series: null,
          blockKind: 'para',
          blockLabel: null,
          blockSnippet: paraText.slice(0, 100),
          blockText: paraText,
        })
      }
      const highlights = await getHighlightsForAC(section.section_number, 'cfr49')
      setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [section, hasPlusAccess, authLoading])

  const handleCopyBlock = useCallback(async (paraText: string) => {
    await Clipboard.setStringAsync(paraText)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }, [])

  const handleBlockLongPress = useCallback((paraText: string) => {
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setPendingHighlight(paraText)
    const isHighlighted = highlightedBlockTexts.has(paraText)
    confirm({
      title: 'Passage',
      choices: [
        { label: 'Copy Text', onPress: () => { setPendingHighlight(null); handleCopyBlock(paraText) } },
        {
          label: isHighlighted ? 'Remove Highlight' : 'Highlight',
          onPress: () => { setPendingHighlight(null); handleToggleHighlight(paraText) },
        },
      ],
      onCancel: () => setPendingHighlight(null),
    })
  }, [hasPlusAccess, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight, authLoading])

  const handleOpenFolderPicker = () => {
    if (!section) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setFolderPickerVisible(true)
  }

  const handleDownload = async () => {
    if (!section) return
    if (!isPremium && !downloaded) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(section.section_number)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: section.section_number,
        type: 'cfr49',
        document_number: `§ ${section.section_number}`,
        title: section.title ?? '',
        subject_series: section.part,
        size: (section.body_text ?? '').length,
        body_text: section.body_text ?? null,
      })
      setDownloaded(true)
    } catch {
      confirm({ title: 'Error', message: "Couldn't save this section for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  const handlePrint = async () => {
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (!section) return
    try {
      await printReg({
        documentNumber: `§ ${section.section_number}`,
        title: section.title,
        body: section.body_text ?? '',
        kindLabel: part ? FAMILY_LABEL[part.family] ?? '49 CFR' : '49 CFR',
      })
    } catch (err) {
      Sentry.captureException(err)
    }
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          hitSlop={12}
          style={{ padding: 4 }}
        >
          <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
        </Pressable>
      )}
      <HeaderOverflowMenu
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasPlusAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasPlusAccess },
        ]}
      />
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon
          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
          size={fs(21)}
          color={bookmarked ? tokens.blu : tokens.t2}
        />
      </Pressable>
    </View>
  )

  const familyLabel = part ? FAMILY_LABEL[part.family] ?? '49 CFR' : '49 CFR'

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`${familyLabel} — Part ${section?.part ?? id?.split('.')[0] ?? ''}`} onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && section && (
        <InDocSearchBar
          query={inDocSearch.query}
          onQueryChange={inDocSearch.onQueryChange}
          onClear={inDocSearch.onClear}
          matchCount={inDocSearch.matchCount}
          matchIdx={inDocSearch.matchIdx}
          onPrev={inDocSearch.goToPrev}
          onNext={inDocSearch.goToNext}
        />
      )}
      {!loading && section && (
        <ChangedBanner
          count={changedIdx.length}
          currentIdx={changedCursor}
          onPrev={() => jumpToChanged(-1)}
          onNext={() => jumpToChanged(1)}
          label={`Updated — ${changedIdx.length} paragraph${changedIdx.length === 1 ? '' : 's'} changed`}
        />
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !section ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Section not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
          scrollEventThrottle={100}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => Keyboard.dismiss()}
        >
          {section.subpart_title && (
            <Text style={[styles.subpart, { color: tokens.t3, fontSize: fs(12) }]}>{section.subpart_title}</Text>
          )}
          <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(15) }]}>§ {section.section_number}</Text>
          {section.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{(section.title ?? '').replace(/^§\s*[\d.]+\s*/, '')}</Text>
          )}

          <View style={{ marginTop: 18 }}>
            <DetailActionRow
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          </View>

          <View style={[styles.barsWrap]}>
            <Pressable
              style={[styles.tablesBar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => {
                if (tableCount > 0) setTablesExpanded((e) => !e)
              }}
              disabled={tableCount === 0}
            >
              <Icon name="photo" size={fs(15)} color={tokens.t3} />
              <Text style={[styles.tablesBarLabel, { color: tableCount > 0 ? tokens.blu : tokens.t1, fontSize: fs(13) }]}>
                {tableCount === 1 ? 'Table' : 'Tables'}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={[styles.tablesBarCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{tableCount}</Text>
              {tableCount > 0 && <Icon name={tablesExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.blu} />}
            </Pressable>
            {tablesExpanded && tableCount > 0 && (
              <View style={[styles.tablesList, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {tables.map((t, i) => (
                  <Pressable
                    key={t.paraIndex}
                    style={[styles.tablesListRow, i > 0 && { borderTopWidth: 1, borderTopColor: tokens.bdr }]}
                    onPress={() => {
                      setTablesExpanded(false)
                      bodyRef.current?.scrollToParagraph(t.paraIndex)
                    }}
                  >
                    <Icon name="square.grid.2x2" size={fs(13)} color={tokens.blu} />
                    <Text style={{ color: tokens.t1, fontSize: fs(13.5), fontWeight: '600', flex: 1 }}>
                      {t.label}{currentLabel ? ` — ${currentLabel}` : ''}
                    </Text>
                    <Icon name="chevron.right" size={fs(11)} color={tokens.t4} />
                  </Pressable>
                ))}
              </View>
            )}
            <MagicLinkPod
              bars={[
                { icon: 'book.closed.fill', label: 'Related FARs', items: farRefs },
                { icon: 'megaphone.fill', label: 'Related ACs', items: acRefs },
                { icon: 'map.fill', label: 'AIM references', items: aimRefs },
                { icon: 'headset', label: 'P/CG terms', items: pcgRefs },
                { icon: 'wrench.and.screwdriver.fill', label: 'Related ADs', items: adRefs },
                { icon: 'envelope.open.fill', label: 'Related LOIs', items: loiRefs },
              ]}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
            />
          </View>

          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              changedIndices={changedIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
              viewportHeight={scrollViewportHeight}
              mnemonicAnchors={mnemonicAnchors}
              highlightedBlockTexts={highlightedBlockTexts}
              onToggleHighlight={(paraText) => handleBlockLongPress(paraText)}
              pendingBlockText={pendingHighlight}
              scrollY={scrollY}
              onActiveTableChange={setActiveTable}
            />
          ) : /reserved/i.test(section.title || '') ? (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>
              This section is currently reserved — it has no active regulatory text.
            </Text>
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this section.</Text>
          )}
        </ScrollView>
        </TabletContainer>
      )}
      {activeTable && (
        <TableNavBar
          ord={activeTable.ord}
          total={activeTable.total}
          onPrev={activeTable.prevIndex != null ? () => bodyRef.current?.scrollToParagraph(activeTable.prevIndex!) : null}
          onNext={activeTable.nextIndex != null ? () => bodyRef.current?.scrollToParagraph(activeTable.nextIndex!) : null}
        />
      )}
      {section && (
        <PrevNextFooter
          prevLabel={prevSection ? `§ ${prevSection}` : null}
          nextLabel={nextSection ? `§ ${nextSection}` : null}
          onPrev={() => prevSection && router.replace(`/cfr49/${prevSection}` as any)}
          onNext={() => nextSection && router.replace(`/cfr49/${nextSection}` as any)}
        />
      )}
      <FolderPicker
        visible={folderPickerVisible}
        itemType="cfr49"
        itemId={section?.section_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={section ? {
          document_number: `§ ${section.section_number}`,
          title: section.title ?? '',
          date_issued: null,
          office: null,
          subject_series: null,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  subpart: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  secNum: { fontWeight: '600', fontSize: 15 },
  title: { fontWeight: '600', fontSize: 17, marginTop: 2, marginBottom: 14, lineHeight: 23 },
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  tablesBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  tablesBarLabel: { fontWeight: '600' },
  tablesBarCount: { fontWeight: '500' },
  tablesList: { borderRadius: 12, borderWidth: 1, marginTop: -4, overflow: 'hidden' },
  tablesListRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 11 },
  body: { fontSize: 14.5, lineHeight: 22 },
})
