import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Image, Share } from 'react-native'
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
import { FigureViewer } from '@/components/FigureViewer'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { resolveAimFigureGlobally } from '@/lib/regPreview'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb, PrevNextFooter } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'
import { DetailActionRow } from '@/components/DetailMeta'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { buildRegShareLink } from '@/lib/regShare'
import { getLatestRevision, changedParagraphIndices, splitParagraphs, type ContentRevision } from '@/lib/whatsChanged'
import { useConfirm } from '@/components/ConfirmDialog'
import type { AcFigure } from '@/types'

// Natural-sort AIM paragraph numbers ("4-3-2" before "4-10-1") for
// Prev/Next -- same comparator aim/chapter/[chapter].tsx already uses.
function compareParagraphNumbers(a: string, b: string): number {
  const ap = a.split('-').map(Number)
  const bp = b.split('-').map(Number)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0
    const bv = bp[i] ?? 0
    if (!isNaN(av) && !isNaN(bv) && av !== bv) return av - bv
  }
  return a.localeCompare(b)
}

interface AimParagraph {
  paragraph_number: string
  chapter: string
  section_title: string | null
  title: string | null
  body_text: string | null
  reference_text: string | null
}

interface AimFigureRow {
  id: string
  label: string | null
  caption: string | null
  image_url: string
  sort_order: number
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

export default function AimParagraphScreen() {
  const { id, hl } = useLocalSearchParams<{ id: string; hl?: string }>()
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { hasPlusAccess, hasProAccess, isPremium } = useAuth()
  const [para, setPara] = useState<AimParagraph | null>(null)
  const [figures, setFigures] = useState<AimFigureRow[]>([])
  const [figuresExpanded, setFiguresExpanded] = useState(false)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  // Normalized AcFigure[] for FigureViewer's Prev/Next Fig navigation --
  // matches the {id,label,caption,page,image_url} shape the onOpenFigure
  // handlers below already build one-off per tap.
  const figuresForViewer = useMemo(
    () => figures.map((f) => ({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })),
    [figures],
  )
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [backTo, setBackTo] = useState<string | null>(null)
  const [siblingParagraphs, setSiblingParagraphs] = useState<string[]>([])
  const [scrollY, setScrollY] = useState(0)
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Opened from a Study Mode flashcard bookmark, which stored the passage
  // the Q/A came from (see study.tsx + routeForBookmark). Seeding the in-doc
  // search with it reuses the existing highlight + auto-scroll-to-first-match
  // path, so the reg opens AT that passage rather than at the top. Runs once
  // per distinct hl value; a normal visit has no param and is unaffected.
  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

  // What's Changed parity with AC: pull this document's most recent
  // revision so the changed paragraphs can be flagged inline and jumped to.
  // AC gets this from its own changed_block_indices column; FAR/AIM have no
  // such column, so the indices are derived from the revision's added_text.
  const [revision, setRevision] = useState<ContentRevision | null>(null)
  useEffect(() => {
    if (!id) return
    getLatestRevision('aim', id).then(setRevision).catch(() => setRevision(null))
  }, [id])

  const changedIdx = useMemo(
    () => changedParagraphIndices(para?.body_text ?? '', revision?.addedText ?? null),
    [para?.body_text, revision],
  )
  const [changedCursor, setChangedCursor] = useState(0)
  const jumpToChanged = (dir: 1 | -1) => {
    if (changedIdx.length === 0) return
    const next = (changedCursor + dir + changedIdx.length) % changedIdx.length
    setChangedCursor(next)
    setTimeout(() => bodyRef.current?.scrollToParagraph(changedIdx[next]), 60)
  }

  // Consumed once per screen instance (on mount / id change), not on every
  // render -- see navBreadcrumb.ts's single-slot design.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
  }, [id])

  // Passage-level highlighting -- see far/[id].tsx's identical comment.
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!id) return
    getHighlightsForAC(id, 'aim').then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [id])
  // The passage currently under the Copy/Highlight menu -- see
  // PlainTextBody's pendingBlockText comment.
  const [pendingHighlight, setPendingHighlight] = useState<string | null>(null)

  useEffect(() => {
    if (id) isDownloaded(id).then(setDownloaded)
  }, [id])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase
        .from('aim_paragraphs')
        .select('paragraph_number, chapter, section_title, title, body_text, reference_text')
        .eq('paragraph_number', id)
        .single(),
      supabase
        .from('aim_figures')
        .select('id, label, caption, image_url, sort_order')
        .eq('paragraph_number', id)
        .order('sort_order'),
      supabase
        .from('document_citations')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.aim,cited_id.eq.${id}),and(citing_type.eq.aim,citing_id.eq.${id})`),
    ]).then(async ([paraRes, figRes, citRes]) => {
      if (!paraRes.error && paraRes.data) {
        const p = paraRes.data as AimParagraph
        setPara(p)
        addRecent({
          id: p.paragraph_number,
          itemType: 'aim',
          document_number: p.paragraph_number,
          title: p.title ?? '',
          date_issued: null,
          subject_series: null,
        })
      } else {
        // No network (or the row is gone): fall back to the offline copy if
        // this paragraph was downloaded. Without this branch "Download" is
        // write-only storage -- the user saves a paragraph, loses signal,
        // opens it, and gets an empty screen, which is the exact case the
        // feature exists for. Figures aren't cached (their bytes live in
        // Storage), so the offline view is the text itself.
        const cached = await findDownload(id)
        if (cached) {
          setPara({
            paragraph_number: cached.document_number,
            chapter: cached.subject_series ?? '',
            section_title: null,
            title: cached.title,
            body_text: cached.body_text ?? null,
            reference_text: null,
          })
        }
      }
      if (!figRes.error && figRes.data) setFigures(figRes.data as AimFigureRow[])
      if (!citRes.error && citRes.data) {
        // Normalize to "the OTHER document" regardless of which side of the
        // row this paragraph is on -- confirmed a real bug: the old query
        // only ever selected cited_type/cited_id, so a row matched via
        // "someone else cites ME" (cited_type=aim, cited_id=my own id) was
        // displayed as if it pointed at itself, instead of showing who the
        // real citing document was. Self-citations (a paragraph appearing on
        // both sides, if that data existed) are dropped rather than shown.
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'aim' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'aim' && r.cited_id === id))
        setRelated(other)
      }
      setLoading(false)
    })
  }, [id])

  // Sibling paragraph numbers within this paragraph's own chapter, for
  // Prev/Next -- a lightweight second query once the chapter is known.
  useEffect(() => {
    if (!para?.chapter) return
    supabase
      .from('aim_paragraphs')
      .select('paragraph_number')
      .eq('chapter', para.chapter)
      .then(({ data }) => {
        if (data) {
          setSiblingParagraphs(
            (data as { paragraph_number: string }[])
              .map((r) => r.paragraph_number)
              .sort(compareParagraphNumbers),
          )
        }
      })
  }, [para?.chapter])

  const siblingIdx = para ? siblingParagraphs.indexOf(para.paragraph_number) : -1
  const prevParagraph = siblingIdx > 0 ? siblingParagraphs[siblingIdx - 1] : null
  const nextParagraph = siblingIdx >= 0 && siblingIdx < siblingParagraphs.length - 1 ? siblingParagraphs[siblingIdx + 1] : null

  const body = para?.body_text ?? ''
  const currentLabel = para ? para.paragraph_number : undefined

  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  // AIM-to-AIM is the single most common citation type in this corpus (89
  // rows) but previously had no bar to surface in at all -- confirmed live,
  // a real coverage gap, not correctly-empty data.
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')

  const handleToggleBookmark = async () => {
    if (!para) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: para.paragraph_number,
      itemType: 'aim',
      document_number: para.paragraph_number,
      title: para.title ?? '',
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  // Same guard as far/[id].tsx's identical handler -- see its comment.
  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (paraText: string) => {
    if (!para) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      const existing = await findHighlight(para.paragraph_number, paraText, 'aim')
      if (existing) {
        await removeHighlight(existing.id)
      } else {
        await addHighlight({
          acId: para.paragraph_number,
          itemType: 'aim',
          document_number: para.paragraph_number,
          title: para.title ?? '',
          date_issued: null,
          office: null,
          subject_series: null,
          blockKind: 'para',
          blockLabel: null,
          blockSnippet: paraText.slice(0, 100),
          blockText: paraText,
        })
      }
      const highlights = await getHighlightsForAC(para.paragraph_number, 'aim')
      setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [para, hasPlusAccess])

  const handleCopyBlock = useCallback(async (paraText: string) => {
    await Clipboard.setStringAsync(paraText)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }, [])

  const handleBlockLongPress = useCallback((paraText: string) => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
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
  }, [hasPlusAccess, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight])

  // Gated synchronously here, not just relying on FolderPicker's own
  // internal backstop -- same rule as ac/[id].tsx's handleOpenFolderPicker,
  // so a free-tier tap always at least shows the paywall rather than
  // risking a silent no-op.
  const handleOpenFolderPicker = () => {
    if (!para) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  // Premium-gated like AC/AD/LOI. The `!downloaded` guard on the paywall
  // check is deliberate and matches the others: a user who lapses from
  // Premium can still REMOVE what they already saved, rather than being
  // stuck with undeletable offline copies behind a paywall.
  const handleDownload = async () => {
    if (!para) return
    if (!isPremium && !downloaded) { router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(para.paragraph_number)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: para.paragraph_number,
        type: 'aim',
        document_number: para.paragraph_number,
        title: para.title ?? '',
        // subject_series is a free-form slot on DownloadedAC; AIM reuses it to
        // carry the chapter so the offline header reads "AIM — Chapter 11"
        // instead of a bare "AIM — Chapter".
        subject_series: para.chapter,
        size: (para.body_text ?? '').length,
        body_text: para.body_text ?? null,
      })
      setDownloaded(true)
    } catch {
      confirm({ title: 'Error', message: "Couldn't save this paragraph for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise -- until now the app had no print at all, only the share
  // sheet (which exports a LINK, not the text).
  const handlePrint = async () => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!para) return
    try {
      await printReg({
        documentNumber: `AIM ${para.paragraph_number}`,
        title: para.title,
        body: para.body_text ?? '',
        kindLabel: 'AIM',
      })
    } catch (err) {
      // See ac/[id].tsx's handlePrint for the full reasoning -- expo-print
      // on iOS can reject AFTER the system print sheet already opened and
      // was used, so alerting the user that it "couldn't open" is often
      // just wrong by the time this fires. Log only, don't tell them
      // something untrue.
      Sentry.captureException(err)
    }
  }

  const handleShare = async () => {
    // Share/export is a PLUS feature (paywall PLUS_FEATURES), not Premium.
    // Gating it on isPremium bounced a Plus buyer to a Premium upsell for
    // something they had already paid for.
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!para) return
    try {
      await Share.share({
        title: para.paragraph_number,
        message: buildRegShareLink('aim', para.paragraph_number, para.paragraph_number, para.title ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
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
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasPlusAccess },
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

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        // Confirmed live: a bare "Chapter 4" header gives no indication
        // which document you're even in (AIM? FAR? something else?) once
        // the app spans multiple regulatory sources — every other
        // detail screen's header carries its own source prefix (P/CG's
        // says "Pilot/Controller Glossary" outright), this was the one
        // silent exception.
        title={para?.chapter?.startsWith('A') ? `AIM — Appendix ${para.chapter.slice(1)}` : `AIM — Chapter ${para?.chapter ?? ''}`}
        onBack={() => router.back()}
        right={headerRight}
      />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && para && (
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

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !para ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Paragraph not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
          scrollEventThrottle={100}
        >
          {para.section_title && (
            <Text style={[styles.section, { color: tokens.t3, fontSize: fs(12) }]}>{para.section_title}</Text>
          )}
          <Text style={[styles.paraNum, { color: tokens.blu, fontSize: fs(15) }]}>{para.paragraph_number}</Text>
          {para.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{para.title}</Text>
          )}

          {/* Download only -- the AIM is scraped from FAA HTML and has no
              PDF of its own to open, so this renders full width rather than
              pairing with an "Open PDF" that couldn't work. */}
          <View style={{ marginTop: 18 }}>
            <DetailActionRow
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          </View>

          <View style={styles.barsWrap}>
            {/* Figures & Tables isn't a MagicLink -- it's this document's own
                figures, not a cross-document citation, so it keeps the plain
                (non-glowing) bar style instead of MagicLinkPod. */}
            <Pressable
              style={[styles.bar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => setFiguresExpanded((e) => !e)}
              disabled={figures.length === 0}
            >
              <View style={styles.barLeft}>
                <Icon name="photo" size={fs(15)} color={tokens.t3} />
                <Text style={[styles.barLabel, { color: tokens.t1, fontSize: fs(13) }]}>Figures & Tables</Text>
              </View>
              <View style={{ flex: 1 }} />
              <Text style={[styles.barCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{figures.length}</Text>
              {figures.length > 0 && (
                <Icon name={figuresExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.t4} />
              )}
            </Pressable>
            <MagicLinkPod
              bars={[
                { icon: 'arrow.up.right.square', label: 'Related AIM', items: aimRefs },
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'list.bullet', label: 'FAR references', items: farRefs },
                { icon: 'questionmark.circle', label: 'P/CG terms', items: pcgRefs },
                { icon: 'wrench.and.screwdriver', label: 'Related ADs', items: adRefs },
                { icon: 'checkmark.seal.fill', label: 'Related LOIs', items: loiRefs },
              ]}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
            />
          </View>

          {/* Confirmed a real, live UX bug: this used to render at the very
              bottom of the ScrollView (after the body text AND the
              References section), completely disconnected from the toggle
              bar above -- tapping "Figures & Tables" gave no visible
              feedback near the tap, and the actual thumbnail only appeared
              after scrolling all the way down. Moved to render immediately
              below its own toggle bar, where an expand/collapse action is
              expected to show its result. */}
          {figuresExpanded && figures.length > 0 && (
            <View style={styles.figuresWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.figScroll}>
                {figures.map((f) => (
                  <Pressable
                    key={f.id}
                    style={[styles.figCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
                  >
                    <Image source={{ uri: f.image_url }} style={styles.figThumb} resizeMode="cover" />
                    <Text style={[styles.figLabel, { color: tokens.t1, fontSize: fs(11.5) }]} numberOfLines={1}>{f.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

            {changedIdx.length > 0 && (
              <View style={[styles.changedBanner, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}>
                <Icon name="doc.badge.clock" size={fs(13)} color={tokens.blu} />
                <Text style={[styles.changedBannerText, { color: tokens.blu, fontSize: fs(12.5) }]}>
                  Updated — {changedIdx.length} paragraph{changedIdx.length === 1 ? '' : 's'} changed
                </Text>
                <Pressable onPress={() => jumpToChanged(-1)} hitSlop={8}>
                  <Icon name="chevron.up" size={fs(14)} color={tokens.blu} />
                </Pressable>
                <Pressable onPress={() => jumpToChanged(1)} hitSlop={8}>
                  <Icon name="chevron.down" size={fs(14)} color={tokens.blu} />
                </Pressable>
              </View>
            )}
          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              figures={figures}
              onOpenFigure={(f) => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
              resolveFigureGlobally={resolveAimFigureGlobally}
              currentLabel={currentLabel}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              changedIndices={changedIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
              viewportHeight={scrollViewportHeight}
              highlightedBlockTexts={highlightedBlockTexts}
              onToggleHighlight={(paraText) => handleBlockLongPress(paraText)}
              pendingBlockText={pendingHighlight}
            />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this paragraph.</Text>
          )}

          {/* AIM's own "REFERENCE-" boxes — e.g. "REFERENCE- FAA Advisory
              Circular (AC) 90-66, Non-Towered Airport Flight Operations."
              These were being extracted into document_citations (feeding
              the bars' counts above) but never actually SHOWN anywhere —
              confirmed live as a real, significant gap: a paragraph could
              read "Related ACs: 1" with the referenced AC nowhere visible
              or tappable on the page. \n -> \n\n because reference_text
              joins its lines with a single newline (PlainTextBody splits
              paragraphs on a blank line). */}
          {para.reference_text && (
            <View style={styles.refsWrap}>
              <Text style={[styles.refsLabel, { color: tokens.t1, fontSize: fs(13) }]}>References</Text>
              <PlainTextBody text={para.reference_text.replace(/\n/g, '\n\n')} />
            </View>
          )}

        </ScrollView>
        </TabletContainer>
      )}
      {para && (
        <PrevNextFooter
          prevLabel={prevParagraph}
          nextLabel={nextParagraph}
          onPrev={() => prevParagraph && router.replace(`/aim/${prevParagraph}` as any)}
          onNext={() => nextParagraph && router.replace(`/aim/${nextParagraph}` as any)}
        />
      )}

      <FigureViewer figure={viewerFigure} figures={figuresForViewer} onNavigate={setViewerFigure} onClose={() => setViewerFigure(null)} />
      <FolderPicker
        visible={folderPickerVisible}
        itemType="aim"
        itemId={para?.paragraph_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={para ? {
          document_number: para.paragraph_number,
          title: para.title ?? '',
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
  changedBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  changedBannerText: { fontWeight: '700', flex: 1 },

  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  section: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  paraNum: { fontWeight: '600', fontSize: 15 },
  title: { fontWeight: '600', fontSize: 17, marginTop: 2, marginBottom: 14, lineHeight: 23 },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` so the space above the first bar
  // (Figures & Tables) and the space between it and MagicLink read as one
  // consistent rhythm -- confirmed live as a real complaint (RC, annotated
  // screenshot): the two gaps were 14px and 10px, visibly uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  barLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { fontSize: 13 },
  barCount: { fontSize: 12.5 },
  body: { fontSize: 14.5, lineHeight: 22 },
  refsWrap: { marginTop: 20 },
  refsLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  figuresWrap: { marginTop: 22 },
  figuresLabel: { fontWeight: '600', fontSize: 14, marginBottom: 10 },
  figScroll: { gap: 10 },
  figCard: { width: 130, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  figThumb: { width: '100%', height: 90 },
  figLabel: { fontSize: 11.5, padding: 8 },
})
