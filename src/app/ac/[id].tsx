import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Share,
} from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { ACBody, ACBodyHandle } from '@/components/ACBody'
import { addRecent } from '@/lib/recents'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { getDownloads, isDownloaded, addDownload, removeDownload } from '@/lib/downloads'
import { collapseDictationDuplicate } from '@/lib/dictation'
import { blockText, ACBlock } from '@/lib/acFormat'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { FigureViewer } from '@/components/FigureViewer'
import { FormulaRefViewer } from '@/components/FormulaRefViewer'
import { isOcrScanned, ocrScannedSeq, OCR_SCANNED_TOTAL } from '@/lib/ocrScannedACs'
import type { AdvisoryCircular, AcFigure, FormulaRef } from '@/types'

// Maps a block to the fields a highlight bookmark needs — chapter headings
// return null (not "content" worth saving) so long-press only does anything
// on section/item/paragraph blocks, matching what ACBody wires onLongPress to.
function highlightMeta(b: ACBlock): { kind: 'section' | 'item' | 'para'; label: string | null; snippet: string } | null {
  switch (b.kind) {
    case 'section':
      return { kind: 'section', label: b.label, snippet: (b.title || b.body || '').slice(0, 100) }
    case 'item':
      return { kind: 'item', label: b.label, snippet: (b.title || b.body || '').slice(0, 100) }
    case 'para':
      return { kind: 'para', label: null, snippet: (b.text || '').slice(0, 100) }
    default:
      return null
  }
}

// Free-tier body preview: a proportional slice of the document, floored/capped
// so short ACs still withhold a meaningful chunk and long ACs (some run
// 1000+ blocks) don't give away an overwhelming free portion.
function previewBlockCount(totalBlocks: number): number {
  return Math.min(12, Math.max(3, Math.ceil(totalBlocks * 0.2)))
}

export default function ACDetailScreen() {
  const { id, hlId } = useLocalSearchParams<{ id: string; hlId?: string }>()
  const { tokens } = useTheme()
  const { isPro, isPremium } = useAuth()
  const fs = useFS()
  const scrollRef = useRef<ScrollView>(null)
  const acBodyRef = useRef<ACBodyHandle>(null)
  const [ac, setAC] = useState<AdvisoryCircular | null>(null)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  const [figures, setFigures] = useState<AcFigure[] | null>(null)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [formulaRefs, setFormulaRefs] = useState<FormulaRef[] | null>(null)
  const [viewerFormulaRef, setViewerFormulaRef] = useState<FormulaRef | null>(null)
  const [changedIdx, setChangedIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [scrollY, setScrollY] = useState(0)
  const { badgeDays } = useBadgeLifespan()

  const [acSearch, setAcSearch] = useState('')
  // The raw input updates instantly for a responsive typing feel, but the
  // expensive full-document phrase-match + highlight pass in ACBody only runs
  // against this debounced value. Without debouncing, every single keystroke
  // re-scanned the ENTIRE document body synchronously on the JS thread — for
  // large ACs (some run 1000+ blocks) that's enough work per keystroke to
  // freeze the app long enough to look like a crash.
  const [acSearchDebounced, setAcSearchDebounced] = useState('')
  const acSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [matchCount, setMatchCount] = useState(0)
  const [matchIdx, setMatchIdx] = useState(0)

  const handleMatchCount = useCallback((n: number) => setMatchCount(n), [])

  // Deliberately does NOT force matchCount to 0 here. It used to — but a
  // dictation "stop" (mic button, or losing focus) can redeliver the exact
  // same text via onChangeText with nothing actually different. When that
  // happens, the debounce timer below calls setAcSearchDebounced(t) with a
  // value that's === what it already was, so React bails on the update and
  // ACBody never re-runs its match count — leaving matchCount permanently
  // stuck at the 0 this handler had just forced, with no further event to
  // ever correct it (this was the "stuck on No results until you delete and
  // retype" bug). matchCount is now owned entirely by ACBody's onMatchCount
  // callback — it only changes when the debounced query actually changes.
  const handleAcSearchChange = useCallback((raw: string) => {
    const t = collapseDictationDuplicate(raw)
    setAcSearch(t)
    setMatchIdx(0)
    if (acSearchDebounceRef.current) clearTimeout(acSearchDebounceRef.current)
    acSearchDebounceRef.current = setTimeout(() => setAcSearchDebounced(t), 300)
  }, [])

  const clearSearch = useCallback(() => {
    if (acSearchDebounceRef.current) clearTimeout(acSearchDebounceRef.current)
    setAcSearch('')
    setAcSearchDebounced('')
    setMatchCount(0)
    setMatchIdx(0)
  }, [])

  const goToPrev = useCallback(() => {
    if (matchCount === 0) return
    const next = (matchIdx - 1 + matchCount) % matchCount
    setMatchIdx(next)
    acBodyRef.current?.scrollToMatch(next)
  }, [matchIdx, matchCount])

  const goToNext = useCallback(() => {
    if (matchCount === 0) return
    const next = (matchIdx + 1) % matchCount
    setMatchIdx(next)
    acBodyRef.current?.scrollToMatch(next)
  }, [matchIdx, matchCount])

  // When a search produces matches, jump to the first one so a highlight is
  // visible immediately instead of just the counter. Keyed on matchCount (which
  // only changes when the query changes, not when navigating), and debounced so
  // it scrolls once after typing settles rather than on every keystroke.
  useEffect(() => {
    if (matchCount === 0) return
    const t = setTimeout(() => acBodyRef.current?.scrollToMatch(0), 200)
    return () => clearTimeout(t)
  }, [matchCount])

  useEffect(() => {
    supabase
      .from('advisory_circulars')
      .select('id,document_number,title,date_issued,office,subject_series,description,pdf_blocks,pdf_url_cached,pdf_url_faa,change_number,status,cancels,document_id,updated_at,changed_block_indices')
      .eq('id', id)
      .single()
      .then(async ({ data, error }) => {
        if (!error && data) {
          const loaded = data as AdvisoryCircular
          setAC(loaded)
          addRecent({
            id: loaded.id,
            document_number: loaded.document_number,
            title: loaded.title,
            date_issued: loaded.date_issued,
            subject_series: loaded.subject_series,
          })
        } else {
          // Live fetch failed (most likely: no network). Fall back to a
          // downloaded offline copy if this AC was saved for offline reading —
          // otherwise the Download feature stores content it can never show.
          const downloads = await getDownloads()
          const cached = downloads.find((d) => d.id === id)
          if (cached) {
            setAC({
              id: cached.id,
              document_number: cached.document_number,
              title: cached.title,
              subject_series: cached.subject_series,
              pdf_blocks: cached.pdf_blocks ?? null,
              date_issued: null,
              office: null,
              description: null,
              pdf_text: null,
              pdf_url_cached: null,
              pdf_url_faa: null,
              change_number: 0,
              status: 'active',
              cancels: [],
              document_id: null,
              updated_at: '',
              changed_block_indices: null,
            })
          }
        }
        setLoading(false)
      })
    isBookmarked(id).then(setBookmarked)
    isDownloaded(id).then(setDownloaded)
    getHighlightsForAC(id).then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
    setFigures(null)
    supabase
      .from('ac_figures')
      .select('id,label,caption,page,image_url')
      .eq('ac_id', id)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setFigures((data as AcFigure[]) ?? []))
    // Separate query, separate table -- deliberately not combined with the
    // ac_figures fetch above so this can never interfere with the Figures &
    // Tables pipeline (see FormulaRef type comment in src/types/index.ts).
    setFormulaRefs(null)
    supabase
      .from('ac_formula_refs')
      .select('id,label,note,page,image_url')
      .eq('ac_id', id)
      .order('sort_order', { ascending: true })
      .then(({ data }) => setFormulaRefs((data as FormulaRef[]) ?? []))
  }, [id])

  // Opened from a highlight row in Saved (?hlId=<highlight bookmark id>) —
  // jump straight to that block instead of landing at the top like a normal
  // bookmark open. Runs once per hlId, after pdf_blocks is actually available
  // (cold navigation vs. an already-mounted screen both need to wait for it).
  const jumpedToHighlight = useRef<string | null>(null)
  useEffect(() => {
    if (!hlId || !ac?.pdf_blocks) return
    if (jumpedToHighlight.current === hlId) return
    getHighlightsForAC(ac.id).then((hs) => {
      const target = hs.find((h) => h.id === hlId)
      if (!target?.blockText) return
      const idx = ac.pdf_blocks!.findIndex((b) => blockText(b) === target.blockText)
      if (idx === -1) return
      jumpedToHighlight.current = hlId
      setTimeout(() => acBodyRef.current?.scrollToBlockIndex(idx), 250)
    })
  }, [hlId, ac?.id, ac?.pdf_blocks])

  const handleDownload = async () => {
    if (!ac) return
    if (!isPremium && !downloaded) {
      router.push('/paywall?tier=premium')
      return
    }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(ac.id)
      return
    }
    setDownloaded(true) // optimistic
    // pdf_blocks is already loaded in `ac` (it's part of the main fetch above) —
    // that's also exactly what ACBody renders, so caching it here is what
    // actually makes the offline copy readable with no network connection.
    await addDownload({
      id: ac.id,
      document_number: ac.document_number,
      title: ac.title,
      subject_series: ac.subject_series,
      size: ac.pdf_blocks ? JSON.stringify(ac.pdf_blocks).length : 24_000,
      pdf_blocks: ac.pdf_blocks ?? null,
    })
  }

  const handleShare = async () => {
    if (!isPremium) {
      router.push('/paywall?tier=premium')
      return
    }
    if (!ac) return
    try {
      await Share.share({
        title: `AC ${ac.document_number}`,
        message: `AC ${ac.document_number}: ${ac.title}\n\nhttps://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_${ac.document_number}.pdf`,
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const handleToggleBookmark = async () => {
    if (!ac) return
    if (!isPro) {
      router.push('/paywall')
      return
    }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: ac.id,
      document_number: ac.document_number,
      title: ac.title,
      date_issued: ac.date_issued,
      office: ac.office,
      subject_series: ac.subject_series,
    })
    setBookmarked(next)
  }

  // Long-press a section/item/paragraph block (see ACBody's onLongPress wiring)
  // to save/remove a highlight. Checked on every call, not just once at mount —
  // same rule the rest of the app's tier gates follow: a downgraded former-Pro
  // user must be blocked from creating NEW highlights immediately, not just
  // prevented from seeing the ones they already saved (that's enforced by the
  // Saved tab's existing ProWall, unrelated to this handler).
  //
  // toggleInFlight + a time cooldown both guard against a single physical
  // long-press producing more than one add/remove cycle — some RN Web
  // Pressable long-press timer paths fired onLongPress repeatedly for what
  // was really one held gesture during testing (confirmed via localStorage:
  // dozens of calls logged for a single press-and-release). A pure in-flight
  // flag isn't enough since each toggle's AsyncStorage round-trip resolves
  // fast enough that rapid repeat-fires can still slip through between
  // calls — the 800ms cooldown blocks anything else in that same gesture.
  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (block: ACBlock) => {
    if (!ac) return
    if (!isPro) {
      router.push('/paywall')
      return
    }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
    const meta = highlightMeta(block)
    if (!meta) return
    const contentKey = blockText(block)
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    const existing = await findHighlight(ac.id, contentKey)
    if (existing) {
      await removeHighlight(existing.id)
    } else {
      await addHighlight({
        acId: ac.id,
        document_number: ac.document_number,
        title: ac.title,
        date_issued: ac.date_issued,
        office: ac.office,
        subject_series: ac.subject_series,
        blockKind: meta.kind,
        blockLabel: meta.label,
        blockSnippet: meta.snippet,
        blockText: contentKey,
      })
    }
    const highlights = await getHighlightsForAC(ac.id)
    setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [ac, isPro])

  // Copy is deliberately NOT Pro-gated, unlike highlighting — it only ever
  // copies a block that's already rendered on screen for this reader (Free
  // Copy/Highlight is a Pro feature as a whole — gated at the long-press entry
  // point below, not per-action, so Copy can't be used as a back door around
  // the Highlight paywall.
  const handleCopyBlock = useCallback(async (block: ACBlock) => {
    const meta = highlightMeta(block)
    if (!meta) return
    const text = blockText(block)
    if (!text) return
    await Clipboard.setStringAsync(text)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }, [])

  // Long-press entry point: offers Copy alongside the existing Highlight
  // toggle instead of replacing it, so the one gesture now does both without
  // adding new on-screen buttons to every block. Pro-gated up front so a Free
  // user is routed straight to the paywall, same as tapping Highlight used to.
  const handleBlockLongPress = useCallback((block: ACBlock, index: number) => {
    const meta = highlightMeta(block)
    if (!meta) return
    if (!isPro) { router.push('/paywall'); return }
    const isHighlighted = highlightedBlockTexts.has(blockText(block))
    Alert.alert('', undefined, [
      { text: 'Copy Text', onPress: () => handleCopyBlock(block) },
      {
        text: isHighlighted ? 'Remove Highlight' : 'Highlight',
        onPress: () => handleToggleHighlight(block),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }, [isPro, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight])

  // Jump nav between the blocks the "What's New" diff flagged as changed —
  // mirrors the existing in-doc search prev/next pattern below (goToPrev/
  // goToNext), just targeting changed_block_indices instead of search matches.
  const changedList = ac?.changed_block_indices ?? []
  const goToPrevChanged = useCallback(() => {
    if (changedList.length === 0) return
    const next = (changedIdx - 1 + changedList.length) % changedList.length
    setChangedIdx(next)
    acBodyRef.current?.scrollToBlockIndex(changedList[next])
  }, [changedIdx, changedList])
  const goToNextChanged = useCallback(() => {
    if (changedList.length === 0) return
    const next = (changedIdx + 1) % changedList.length
    setChangedIdx(next)
    acBodyRef.current?.scrollToBlockIndex(changedList[next])
  }, [changedIdx, changedList])

  // Short label for each changed block, used in the summary banner (e.g.
  // "1.2, 4.3.1, 5.1.4") — falls back to a truncated chapter heading for
  // blocks that don't have a section/item label (chapter/para).
  const changedLabels = useMemo(() => {
    if (!ac?.pdf_blocks) return []
    return changedList.map((idx) => {
      const b = ac.pdf_blocks![idx]
      if (!b) return null
      if (b.kind === 'section' || b.kind === 'item') return b.label
      if (b.kind === 'chapter') return b.text.length > 24 ? b.text.slice(0, 24) + '…' : b.text
      return null
    }).filter((l): l is string => !!l)
  }, [ac?.pdf_blocks, changedList])

  const openPDF = async () => {
    if (!isPro) {
      router.push('/paywall')
      return
    }
    const url =
      ac?.pdf_url_cached ??
      ac?.pdf_url_faa ??
      `https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_${ac?.document_number}.pdf`
    try {
      if (Platform.OS === 'web') {
        window.open(url, '_blank') // preview sandbox only allows localhost
      } else {
        await WebBrowser.openBrowserAsync(url)
      }
    } catch {
      Linking.openURL(url).catch(() =>
        Alert.alert('Could not open PDF', 'Please try again later.')
      )
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
          <Icon name="arrow.up.circle" size={21} color={tokens.t3} />
        </Pressable>
      )}
      <Pressable onPress={handleShare} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="square.and.arrow.up" size={21} color={isPremium ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon
          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
          size={21}
          color={bookmarked ? tokens.blu : tokens.t2}
        />
      </Pressable>
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={ac?.document_number ?? 'Advisory Circular'}
        onBack={() => router.back()}
        right={headerRight}
      />

      {/* Sticky in-AC search — Pro only, only shown when AC has searchable content */}
      {!loading && isPro && ac?.pdf_blocks && ac.pdf_blocks.length > 0 && (
        <View style={[styles.stickySearch, { backgroundColor: tokens.bg, borderBottomColor: tokens.bdr }]}>
          <View
            style={[
              styles.acSearchBar,
              {
                backgroundColor: tokens.bg2,
                borderColor: acSearch.length >= 2 ? tokens.blu : tokens.bdr2,
              },
            ]}
          >
            <View style={styles.acSearchRow}>
              <Icon name="magnifyingglass" size={15} color={tokens.t3} />
              <View style={[styles.acSearchScope, { backgroundColor: tokens.bdim }]}>
                <Text style={[styles.acSearchScopeText, { color: tokens.blu, fontSize: fs(9) }]}>IN DOC</Text>
              </View>
              <TextInput
                style={[
                  styles.acSearchInput,
                  { color: tokens.t1, fontSize: fs(15) },
                  Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : undefined,
                ]}
                placeholder="Search..."
                placeholderTextColor={tokens.t4}
                value={acSearch}
                onChangeText={handleAcSearchChange}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                clearButtonMode="never"
              />
              {acSearch.length > 0 && (
                <Pressable hitSlop={10} onPress={clearSearch} style={{ padding: 6 }}>
                  <Icon name="xmark" size={14} color={tokens.t3} />
                </Pressable>
              )}
            </View>
            {acSearch.length >= 2 && (
              <View style={[styles.acSearchResultRow, { borderTopColor: tokens.bdr2 }]}>
                {matchCount > 0 ? (
                  <>
                    <Text style={[styles.acSearchCount, { color: tokens.t3, fontSize: fs(12.5) }]}>
                      {matchIdx + 1}/{matchCount} results
                    </Text>
                    <View style={styles.acSearchNav}>
                      <Pressable hitSlop={14} onPress={goToPrev} style={{ padding: 8 }}>
                        <Icon name="chevron.up" size={18} color={tokens.t2} />
                      </Pressable>
                      <Pressable hitSlop={14} onPress={goToNext} style={{ padding: 8 }}>
                        <Icon name="chevron.down" size={18} color={tokens.t2} />
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <Text style={[styles.acSearchCount, { color: tokens.t4, fontSize: fs(12.5) }]}>No results</Text>
                )}
              </View>
            )}
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !ac ? (
        <View style={styles.center}>
          <Text style={{ color: tokens.t3, fontSize: fs(14) }}>AC not found.</Text>
        </View>
      ) : (
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={e => setScrollY(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={100}
        >
          {/* Badge row */}
          <View style={styles.badgeRow}>
            <ACBadge ac={ac} tokens={tokens} badgeDays={badgeDays} />
            {ac.change_number > 0 && (
              <View style={[styles.changePill, { backgroundColor: tokens.bg3 }]}>
                <Text style={[styles.changePillText, { color: tokens.t3, fontSize: fs(11) }]}>
                  Change {ac.change_number}
                </Text>
              </View>
            )}
          </View>

          {/* AC Number + Title */}
          <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(17) }]}>{ac.document_number}</Text>
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(19), lineHeight: fs(19) * 1.37 }]}>{ac.title}</Text>

          {/* Meta chips */}
          <View style={styles.metaRow}>
            {ac.date_issued && (
              <MetaChip
                label="Issued"
                value={new Date(ac.date_issued).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
                tokens={tokens}
              />
            )}
            {ac.office && (
              <MetaChip label="Office" value={ac.office} tokens={tokens} />
            )}
            {ac.subject_series && (
              <MetaChip label="Series" value={ac.subject_series} tokens={tokens} />
            )}
          </View>

          {/* Updated-content banner */}
          {changedList.length > 0 && (
            <View style={[styles.updateBanner, { backgroundColor: tokens.bdim, borderColor: tokens.blu }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                <Icon name="sparkles" size={14} color={tokens.blu} style={{ marginTop: 2 }} />
                <Text style={[styles.updateBannerText, { color: tokens.t1, fontSize: fs(12.5) }]}>
                  This AC was updated — {changedList.length} section{changedList.length === 1 ? '' : 's'} changed
                  {changedLabels.length > 0 ? ` (${changedLabels.join(', ')})` : ''}.
                </Text>
              </View>
              {changedList.length > 1 && (
                <View style={styles.updateBannerNav}>
                  <Text style={[styles.updateBannerNavCount, { color: tokens.t2, fontSize: fs(11.5) }]}>
                    {changedIdx + 1}/{changedList.length}
                  </Text>
                  <Pressable onPress={goToPrevChanged} hitSlop={10} style={{ padding: 4 }}>
                    <Icon name="chevron.up" size={16} color={tokens.blu} />
                  </Pressable>
                  <Pressable onPress={goToNextChanged} hitSlop={10} style={{ padding: 4 }}>
                    <Icon name="chevron.down" size={16} color={tokens.blu} />
                  </Pressable>
                </View>
              )}
            </View>
          )}

          {/* Scanned-original disclaimer -- sets expectations for old ACs
              whose source is a scanned paper original with an OCR text layer,
              so garbled words read as an explained limitation of the source
              document rather than a FlyRegs bug. The formula-refs sentence is
              a separate condition (an AC could have flagged formulas without
              being OCR-scanned, in principle) so the banner still renders if
              only one of the two is true. */}
          {(isOcrScanned(ac.document_number) || (formulaRefs && formulaRefs.length > 0)) && (
            <View style={[styles.scanBanner, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Icon name="doc.text" size={14} color={tokens.t3} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                {isOcrScanned(ac.document_number) && (
                  <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5) }]}>
                    * This AC's source is a scanned original — some words in the extracted text may be
                    misread from the scan. The original PDF is the authoritative source.
                  </Text>
                )}
                {formulaRefs && formulaRefs.length > 0 && (
                  <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5) }]}>
                    Formulas flagged as too complex to transcribe reliably are available to view
                    directly in the "Formulas to Verify" section below.
                  </Text>
                )}
                {isOcrScanned(ac.document_number) && (
                  <Text style={[styles.scanBannerSeq, { color: tokens.t4, fontSize: fs(11) }]}>
                    {ocrScannedSeq(ac.document_number)}/{OCR_SCANNED_TOTAL}
                  </Text>
                )}
              </View>
            </View>
          )}

          {/* Description */}
          {ac.description ? (
            <Section title="Description" tokens={tokens}>
              <Text style={[styles.body, { color: tokens.t2, fontSize: fs(16), lineHeight: fs(16) * 1.44 }]}>{ac.description}</Text>
            </Section>
          ) : null}

          {/* Cancels */}
          {ac.cancels && ac.cancels.length > 0 ? (
            <Section title="Cancels" tokens={tokens}>
              {ac.cancels.map((num) => (
                <Text key={num} style={[styles.cancelItem, { color: tokens.t2, fontSize: fs(14) }]}>
                  • {num}
                </Text>
              ))}
            </Section>
          ) : null}

          {/* Action buttons */}
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.pdfBtn, { backgroundColor: tokens.blu, flex: 1 }]}
              onPress={openPDF}
            >
              <Icon name="doc.text" size={17} color="#fff" />
              <Text style={[styles.pdfBtnText, { color: '#fff', fontSize: fs(15) }]}>Open PDF</Text>
            </Pressable>

            <Pressable
              style={[
                styles.downloadBtn,
                downloaded
                  ? { backgroundColor: tokens.gdim, borderColor: tokens.gbdr }
                  : { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 },
              ]}
              onPress={handleDownload}
            >
              <Icon
                name={downloaded ? 'checkmark.circle' : 'arrow.down.circle'}
                size={17}
                color={downloaded ? tokens.grn : tokens.t2}
              />
              <Text
                style={[
                  styles.downloadBtnText,
                  { color: downloaded ? tokens.grn : tokens.t1, fontSize: fs(14) },
                ]}
              >
                {downloaded ? 'Saved offline' : 'Download'}
              </Text>
            </Pressable>
          </View>

          {/* Full text — free readers get the Contents + a proportional preview
              of the beginning, then a gate; Pro gets the complete document. */}
          {ac.pdf_blocks && ac.pdf_blocks.length > 0 ? (
            <View style={styles.fullTextSection}>
              <View style={[styles.fullTextDivider, { backgroundColor: tokens.bdr }]} />
              <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>FULL TEXT</Text>
              <ACBody
                ref={acBodyRef}
                blocks={ac.pdf_blocks}
                bodyLimit={isPro ? undefined : previewBlockCount(ac.pdf_blocks.length)}
                scrollRef={scrollRef}
                highlightQuery={isPro && acSearchDebounced.length >= 2 ? acSearchDebounced : undefined}
                onMatchCount={handleMatchCount}
                activeMatch={matchCount > 0 ? matchIdx : -1}
                changedIndices={ac.changed_block_indices}
                highlightedBlockTexts={isPro ? highlightedBlockTexts : undefined}
                onToggleHighlight={handleBlockLongPress}
                figures={isPro ? (figures ?? undefined) : undefined}
                onOpenFigure={isPro ? setViewerFigure : undefined}
                formulaRefs={isPro ? (formulaRefs ?? undefined) : undefined}
                onOpenFormulaRef={isPro ? setViewerFormulaRef : undefined}
              />
              {!isPro && ac.pdf_blocks.length > previewBlockCount(ac.pdf_blocks.length) && (
                <Pressable
                  style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                  onPress={() => router.push('/paywall')}
                >
                  <Icon name="lock.fill" size={20} color={tokens.blu} />
                  <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Continue reading with Pro</Text>
                  <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                    You're reading a preview. Upgrade to Pro for the complete text, with full search and navigation.
                  </Text>
                  <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                    <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Upgrade to Pro</Text>
                  </View>
                </Pressable>
              )}
            </View>
          ) : (
            <Text style={[styles.body, { color: tokens.t4, marginTop: 8, textAlign: 'center', fontSize: fs(13) }]}>
              Full text is not available for this AC — use Open PDF above.
            </Text>
          )}

          {/* Footer */}
          <Text style={[styles.footer, { color: tokens.t4, fontSize: fs(11.5) }]}>
            Source: FAA.gov ·{' '}
            {ac.updated_at
              ? `Updated ${new Date(ac.updated_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                })}`
              : 'Not yet updated'}
          </Text>
        </ScrollView>
      )}
      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      <FormulaRefViewer formulaRef={viewerFormulaRef} onClose={() => setViewerFormulaRef(null)} />
    </View>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ACBadge({
  ac,
  tokens,
  badgeDays,
}: {
  ac: AdvisoryCircular
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
}) {
  const fs = useFS()
  const isUpd = ac.cancels && ac.cancels.length > 0

  if (!isWithinBadgeLifespan(ac.date_issued, badgeDays)) return null

  return (
    <View
      style={[
        styles.badge,
        isUpd
          ? { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }
          : { backgroundColor: tokens.gdim, borderColor: tokens.gbdr },
      ]}
    >
      <Text style={[styles.badgeText, { color: isUpd ? tokens.blu : tokens.grn, fontSize: fs(9.5) }]}>
        {isUpd ? 'UPD' : 'NEW'}
      </Text>
    </View>
  )
}

function MetaChip({
  label,
  value,
  tokens,
}: {
  label: string
  value: string
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <View style={[styles.chip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Text style={[styles.chipLabel, { color: tokens.t3, fontSize: fs(10) }]}>{label}</Text>
      <Text style={[styles.chipValue, { color: tokens.t1, fontSize: fs(13) }]}>{value}</Text>
    </View>
  )
}

function Section({
  title,
  tokens,
  children,
}: {
  title: string
  tokens: ReturnType<typeof useTheme>['tokens']
  children: React.ReactNode
}) {
  const fs = useFS()
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // maxWidth + alignSelf keeps AC body text at a comfortable reading width on
  // iPad/large screens — the ScrollView itself still fills the full screen,
  // only the content column is capped and centered.
  content: { padding: 16, paddingBottom: 48, gap: 12, width: '100%', maxWidth: 700, alignSelf: 'center' },

  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: {
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  badgeText: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4 },
  changePill: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  changePillText: { fontSize: 11, fontWeight: '500' },
  updateBanner: {
    flexDirection: 'column',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  updateBannerText: { flex: 1, fontWeight: '600', lineHeight: 17 },
  updateBannerNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  scanBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  scanBannerText: { flex: 1, lineHeight: 17 },
  scanBannerSeq: { marginTop: 4, fontWeight: '600' },
  updateBannerNavCount: { fontWeight: '600', marginRight: 4 },

  acNum: { fontWeight: '800', fontSize: 17, marginTop: 4 },
  title: { fontWeight: '600', fontSize: 19, lineHeight: 26, marginTop: 4 },

  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  chipLabel: { fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  chipValue: { fontSize: 13, fontWeight: '500' },

  section: { gap: 6, marginTop: 4 },
  sectionTitle: { fontSize: 11, fontWeight: '600', letterSpacing: 0.7, marginBottom: 2 },
  body: { fontSize: 16, lineHeight: 23 },
  cancelItem: { fontSize: 14 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  pdfBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 14,
    paddingVertical: 14,
  },
  pdfBtnText: { fontSize: 15, fontWeight: '600' },
  downloadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  downloadBtnText: { fontSize: 14, fontWeight: '600' },
  proBadge: {
    borderRadius: 5,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginLeft: 4,
  },
  proBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#1a1400',
    letterSpacing: 0.5,
  },

  stickySearch: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  acSearchBar: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
    width: '100%',
    maxWidth: 700,
    alignSelf: 'center',
  },
  acSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  acSearchResultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  acSearchNav: { flexDirection: 'row', gap: 14 },
  acSearchScope: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  acSearchScopeText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.6 },
  acSearchInput: { flex: 1, fontSize: 15, paddingVertical: 4 },
  acSearchCount: { fontSize: 12.5, fontWeight: '600' },

  fullTextSection: { marginTop: 16 },
  fullTextDivider: { height: 1, marginBottom: 12 },
  footer: { fontSize: 11.5, textAlign: 'center', marginTop: 20 },

  proGate: {
    marginTop: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  proGateTitle: { fontWeight: '700', fontSize: 16, marginTop: 4 },
  proGateSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 260 },
  proGateBtn: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  proGateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
})
