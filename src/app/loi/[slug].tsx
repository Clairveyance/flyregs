import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share, Keyboard } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import { supabase } from '@/lib/supabase'
import { resolveGatedStorageUrl } from '@/lib/gatedStorage'
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
import { BackToBreadcrumb, TableNavBar, OfflineCopyBanner, ChangedBanner } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { getLatestRevision, changedParagraphIndices, type ContentRevision } from '@/lib/whatsChanged'
import { MetaChip, MetaChipRow, DetailSection, DetailActionRow } from '@/components/DetailMeta'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { getSemanticRelated, mergeRelated } from '@/lib/relatedContent'
import { buildRegShareLink } from '@/lib/regShare'
import { isDownloaded, addDownload, removeDownload, findDownload, type DownloadedAC } from '@/lib/downloads'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { humanizeLoiTitle } from '@/lib/titleFormat'
import { useConfirm } from '@/components/ConfirmDialog'

// LOI detail screen. Per the expansion plan's explicit priority reframe:
// citation-driven discovery from a FAR page (the Related LOIs MagicLink
// bar, far/[id].tsx) is the actual payoff here, not a polished standalone
// browse experience -- this screen exists so that tapping through from
// there lands somewhere real, and so a direct search hit (loi/index.tsx)
// has somewhere to open. No Prev/Next footer (unlike far/[id].tsx) --
// LOIs have no natural ordering the way FAR sections or AIM paragraphs do.

interface LegalInterpretation {
  slug: string
  title: string
  addressee: string | null
  year: number | null
  issued_date: string | null
  source_url: string
  pdf_url_cached: string | null
  cfr_part_reference: string | null
  cfr_section_reference: string | null
  summary: string | null
  body_text: string | null
  ocr_quality_score: number | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

// humanizeLoiTitle now lives in @/lib/titleFormat, shared with the LOI
// browse/list screens (loi/index.tsx, loi/year/[year].tsx) -- see that
// file's comment for why this needed to move out of being local to just
// this screen.

export default function LoiDetailScreen() {
  const { slug, hl } = useLocalSearchParams<{ slug: string; hl?: string }>()
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
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
  const { hasProAccess, isPremium, loading: authLoading } = useAuth()
  const [loi, setLoi] = useState<LegalInterpretation | null>(null)
  // Set only when `loi` above is being served from the offline cache, not
  // a live fetch -- see far/[id].tsx's identical comment. Legal
  // interpretations have no content_revisions logging AT ALL (RevisionDocType
  // doesn't include 'loi' -- they're point-in-time legal opinions, not
  // amended text the way FAR/AD are), so this only ever drives the plain
  // "Downloaded on {date}" disclosure, never a staleness claim.
  const [offlineCopy, setOfflineCopy] = useState<DownloadedAC | null>(null)
  // Split so the interpretation text can render as soon as the fast
  // citation query resolves, without waiting on the much slower semantic
  // "related content" RPC -- see the loading effect below for why.
  // mergeRelated() is pure and safe to call with whichever of these two has
  // filled in so far.
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
  const [scrollY, setScrollY] = useState(0)
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  // See PlainTextBody's onActiveTableChange comment. LOI has no
  // PrevNextFooter (LOIs aren't sequentially numbered like FAR/AIM/AD
  // sections), so this bar just floats at the bottom with nothing to stack
  // above -- still an improvement over the old inline-after-every-table
  // placement.
  const [activeTable, setActiveTable] = useState<{ ord: number; total: number; prevIndex: number | null; nextIndex: number | null } | null>(null)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Same Study-bookmark passage seeding FAR/AIM/P-CG/AD do. LOI was missing
  // this on BOTH ends -- routeForBookmark's own loi branch returned a bare
  // `/loi/<slug>` with no hl at all, unlike every other non-AC type -- so both
  // halves are wired here and there. Latent like AD's (LOI isn't a study type
  // today), fixed together so all five PlainTextBody screens behave the same.
  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [slug])

  useEffect(() => {
    if (slug) isBookmarked(slug).then(setBookmarked)
    if (slug) isDownloaded(slug).then(setDownloaded)
  }, [slug])

  // Passage-level highlighting -- see far/[id].tsx's identical comment.
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!slug) return
    getHighlightsForAC(slug, 'loi').then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [slug])
  // The passage currently under the Copy/Highlight menu -- see
  // PlainTextBody's pendingBlockText comment.
  const [pendingHighlight, setPendingHighlight] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    setLoading(true)
    // Reset both -- otherwise a fast nav between two interpretations can
    // briefly show the PREVIOUS one's related content under the new one's
    // header while the new fetches are in flight.
    setCitationRelated([])
    setSemanticRelated([])

    // Fast path: the interpretation text itself + its citations. This is
    // the only thing that should gate the page opening -- previously this
    // was one single Promise.all with the semantic "related content" RPC
    // below, which meant the actual interpretation text (what the user
    // tapped in to read) waited on a decorative "related content" feature
    // that has nothing to do with reading it. RC, real device: "content
    // retrieval... taking too long, several seconds just to get a page
    // open... tighten all flows, reduce waste."
    Promise.all([
      // _gated view redacts body_text server-side for non-Pro tiers -- see
      // gotcha_tier_gate_client_side_only.md.
      supabase
        .from('legal_interpretations_gated')
        .select('slug, title, addressee, year, issued_date, source_url, pdf_url_cached, cfr_part_reference, cfr_section_reference, summary, body_text, ocr_quality_score')
        .eq('slug', slug)
        .single(),
      // Same both-directions + normalize-to-"the other document" pattern
      // as ad/[id].tsx and far/[id].tsx. An LOI cites OUT to FAR sections
      // (loi_citation_extract.py, owns loi->far), to ACs it names in prose
      // (loi_ac_citations.py, owns loi->ac), to P/CG terms it references
      // (pcg_term_links.py, owns loi->pcg), and, since 2026-08-12, to OTHER
      // LOIs it names by footnote (loi_loi_citations.py, name+year matched
      // against legal_interpretations.slug). The query stayed symmetric
      // from the start so each new citation type just worked once its
      // extractor shipped -- but the UI side didn't keep up: found
      // 2026-08-12 that this screen only ever rendered farRefs (and, after
      // that day's own fix, loiRefs) -- the real loi->ac (33 rows) and
      // loi->pcg (24 rows) data was being fetched into `related` the whole
      // time and silently dropped on the floor, never reaching a bar.
      supabase
        .from('document_citations_gated')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.loi,cited_id.eq.${slug}),and(citing_type.eq.loi,citing_id.eq.${slug})`),
    ]).then(async ([loiRes, citRes]) => {
      if (!loiRes.error && loiRes.data) {
        const l = loiRes.data as LegalInterpretation
        setLoi(l)
        setOfflineCopy(null)
        addRecent({
          id: l.slug,
          itemType: 'loi',
          document_number: humanizeLoiTitle(l.title),
          title: l.summary ?? humanizeLoiTitle(l.title),
          date_issued: l.issued_date,
          subject_series: null,
        })
      } else {
        // No network (or the row is gone): fall back to the offline copy.
        // This branch was MISSING -- handleDownload wrote an offline copy
        // that nothing ever read back, so a downloaded LOI still showed an
        // empty screen with no connection. Only AC had a cache-read path.
        const cached = await findDownload(slug)
        if (cached) {
          setLoi({
            // cached.title, NOT cached.document_number. document_number holds
            // the raw SLUG, which the render then re-humanizes -- so offline a
            // letter titled "Counsil 2012" online rendered as "counsil 2012".
            // cached.title is already the humanized form.
            ...(cached.meta ?? {}),
            slug: cached.id,
            title: cached.title,
            body_text: cached.body_text ?? null,
          } as LegalInterpretation)
          setOfflineCopy(cached)
        }
      }
      if (!citRes.error && citRes.data) {
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'loi' && r.citing_id === slug
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'loi' && r.cited_id === slug))
        setCitationRelated(other)
      }
      setLoading(false)
    })

    // Slow path: semantic "related content" (embedding similarity search).
    // Decoupled from the fast path above so it never blocks the
    // interpretation text -- it merges into the MagicLink pod whenever it
    // happens to resolve.
    getSemanticRelated('loi', slug).then(setSemanticRelated)
    // Keyed on the ENTITLEMENT too, not just the id. The _gated view
    // returns a truncated/redacted payload for a non-entitled viewer, and
    // hasProAccess starts false on cold launch and flips when the entitlement
    // resolves -- or the moment the user buys from the gate, since the
    // paywall is PUSHED over this still-mounted screen and writes straight
    // to the shared auth context. Without refetching, a paying user read a
    // preview slice under a heading that says FULL TEXT, with nothing on
    // screen indicating anything was missing.
  }, [slug, hasProAccess])

  const body = loi?.body_text ?? ''
  // What's Changed -- sync/loi_scraper.py only started logging real
  // content_revisions rows for LOI in the 2026-08-29 corpus-freshness
  // sweep (every other content scraper already did); this is the read
  // side, same pattern as ad/[id].tsx's identical addition.
  const [revision, setRevision] = useState<ContentRevision | null>(null)
  useEffect(() => {
    if (!slug) return
    getLatestRevision('loi', slug).then(setRevision).catch(() => setRevision(null))
  }, [slug])
  const changedIdx = useMemo(
    () => changedParagraphIndices(body, revision?.addedText ?? null),
    [body, revision],
  )
  const [changedCursor, setChangedCursor] = useState(0)
  const jumpToChanged = (dir: 1 | -1) => {
    if (changedIdx.length === 0) return
    const next = (changedCursor + dir + changedIdx.length) % changedIdx.length
    setChangedCursor(next)
    setTimeout(() => bodyRef.current?.scrollToParagraph(changedIdx[next]), 60)
  }
  const currentLabel = loi ? humanizeLoiTitle(loi.title) : undefined
  const related = mergeRelated(citationRelated, semanticRelated)
  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  const cfr49Refs = related.filter((r) => r.cited_type === 'cfr49')

  // LOI's own actions gate on hasProAccess, not the app-wide hasPlusAccess
  // every other content type's print/share/bookmark/folder uses -- since
  // the body text itself now requires Pro (see the body-render block
  // below), letting a Plus-only user bookmark/print/share/folder an
  // interpretation they can't even read would be incoherent.
  const handleToggleBookmark = async () => {
    if (!loi) return
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    setBookmarked((prev) => !prev)
    const next = await toggleBookmark({
      id: loi.slug,
      itemType: 'loi',
      document_number: humanizeLoiTitle(loi.title),
      title: loi.summary ?? humanizeLoiTitle(loi.title),
      date_issued: loi.issued_date,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  // Same guard as far/[id].tsx's identical handler -- see its comment.
  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (paraText: string) => {
    if (!loi) return
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      const existing = await findHighlight(loi.slug, paraText, 'loi')
      if (existing) {
        await removeHighlight(existing.id)
      } else {
        await addHighlight({
          acId: loi.slug,
          itemType: 'loi',
          document_number: humanizeLoiTitle(loi.title),
          title: loi.summary ?? humanizeLoiTitle(loi.title),
          date_issued: loi.issued_date,
          office: null,
          subject_series: null,
          blockKind: 'para',
          blockLabel: null,
          blockSnippet: paraText.slice(0, 100),
          blockText: paraText,
        })
      }
      const highlights = await getHighlightsForAC(loi.slug, 'loi')
      setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [loi, hasProAccess, authLoading])

  const handleCopyBlock = useCallback(async (paraText: string) => {
    await Clipboard.setStringAsync(paraText)
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
  }, [])

  const handleBlockLongPress = useCallback((paraText: string) => {
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    setPendingHighlight(paraText)
    const isHighlighted = highlightedBlockTexts.has(paraText)
    confirm({
      title: 'Passage',
      choices: [
        // `return`, not a bare call: ConfirmDialog's runChoice() awaits
        // whatever onPress returns inside a try/catch, so returning the
        // promise is what routes a rejection into the dialog's own error
        // text instead of leaving it unhandled. Both handlers below can
        // genuinely reject -- handleCopyBlock awaits Clipboard/Haptics, and
        // handleToggleHighlight is try/FINALLY with no catch of its own.
        // ac/[id].tsx's identical menu already had the correct shape (a
        // concise arrow body, which returns implicitly); these six were the
        // block-bodied copies that silently dropped it.
        { label: 'Copy Text', onPress: () => { setPendingHighlight(null); return handleCopyBlock(paraText) } },
        {
          label: isHighlighted ? 'Remove Highlight' : 'Highlight',
          onPress: () => { setPendingHighlight(null); return handleToggleHighlight(paraText) },
        },
      ],
      onCancel: () => setPendingHighlight(null),
    })
  }, [hasProAccess, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight, authLoading])

  const handleOpenFolderPicker = () => {
    if (!loi) return
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    setFolderPickerVisible(true)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise app-wide -- but see the hasProAccess comment above for why
  // LOI specifically is the one exception, gated at Pro instead.
  const handlePrint = async () => {
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    if (!loi) return
    try {
      await printReg({
        documentNumber: humanizeLoiTitle(loi.title),
        title: loi.summary,
        body: loi.body_text ?? '',
        kindLabel: 'LOI',
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
    // Share/export is a PLUS feature app-wide (paywall PLUS_FEATURES), but
    // LOI is gated at Pro instead -- see the hasProAccess comment above.
    if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
    if (!loi) return
    try {
      // No 4th (title/description) arg: loi.summary is a raw OCR sentence,
      // present on well under half the corpus and frequently truncated
      // mid-clause when it is ("...request for legal interpretation of 14
      // C.") -- unlike every other reg type's title (a real short section/
      // AC title), it was never a usable one-line description. Omitting it
      // lets the website's own already-built fallback apply instead
      // (reg/index.php: $ogDescription = $shareTitle ?: $typeName --
      // renders "Legal Interpretation", same clean-and-short shape every
      // other type gets when it has no title override).
      await Share.share({
        title: humanizeLoiTitle(loi.title),
        message: buildRegShareLink('loi', loi.slug, humanizeLoiTitle(loi.title)),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  // Same simple text-only offline copy as AD -- see downloads.ts's
  // DownloadedItemType comment.
  const handleDownload = async () => {
    if (!loi) return
    if (!isPremium && !downloaded) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(loi.slug)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: loi.slug,
        type: 'loi',
        document_number: loi.slug,
        title: humanizeLoiTitle(loi.title),
        subject_series: null,
        size: (loi.body_text ?? '').length,
        body_text: loi.body_text ?? null,
        // ocr_quality_score drives the "this letter's source is a scanned
        // original -- some words may be misread, the original PDF is
        // authoritative" banner. Dropping it offline removed an ACCURACY
        // DISCLOSURE from precisely the copy being read where the PDF cannot
        // be consulted (~a third of the corpus is scanned).
        meta: {
          summary: loi.summary ?? null,
          ocr_quality_score: loi.ocr_quality_score ?? null,
          addressee: loi.addressee ?? null,
          year: loi.year ?? null,
          cfr_part_reference: loi.cfr_part_reference ?? null,
        },
      })
      setDownloaded(true)
    } catch (err) {
      confirm({ title: 'Error', message: "Couldn't save this interpretation for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })} hitSlop={12} style={{ padding: 4 }}>
          <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
        </Pressable>
      )}
      <HeaderOverflowMenu
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasProAccess },
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasProAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasProAccess },
        ]}
      />
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon name={bookmarked ? 'bookmark.fill' : 'bookmark'} size={fs(21)} color={bookmarked ? tokens.blu : tokens.t2} />
      </Pressable>
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Legal Interpretation" onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {offlineCopy && <OfflineCopyBanner downloadedAt={offlineCopy.downloadedAt} stale={false} />}
      {!loading && loi && changedIdx.length > 0 && (
        <ChangedBanner
          count={changedIdx.length}
          currentIdx={changedCursor}
          onPrev={() => jumpToChanged(-1)}
          onNext={() => jumpToChanged(1)}
          label={`Updated — ${changedIdx.length} paragraph${changedIdx.length === 1 ? '' : 's'} changed`}
        />
      )}
      {/* Pro-gated, matching ac/[id].tsx's own sticky search -- LOI body
          text has NO free preview at all, so a lower-tier user previously
          saw a live, typable "IN DOC" search bar above a locked document:
          harmless (nothing renders for it to match against, body_text is
          redacted server-side), but a confusing dead control that
          undercut the screen's own "no preview at all" messaging right
          below it. Found in the 2026-08-14 comprehensive gating re-audit. */}
      {!loading && loi && hasProAccess && (
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
      ) : !loi ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Interpretation not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
          scrollEventThrottle={100}
          // Matches ac/[id].tsx's own ScrollView -- was missing here (and on
          // far/aim/ad/pcg's identical setup), so dragging the doc content
          // down while the in-doc search keyboard was up did nothing; the
          // native interactive-dismiss gesture only exists when this prop is
          // set. keyboardShouldPersistTaps alongside it for the same reason
          // BB-092 needed it elsewhere: without it a tap on the search bar's
          // prev/next buttons just dismisses the keyboard instead of firing.
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => Keyboard.dismiss()}
        >
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17), lineHeight: fs(17) * 1.41 }]}>{humanizeLoiTitle(loi.title)}</Text>

          {/* Unified with AC/AD's own meta-chip row -- was a bare text
              line for addressee/year plus a separate CFR-ref line, visually
              inconsistent with every other content type. See DetailMeta.tsx. */}
          <MetaChipRow>
            {loi.addressee && <MetaChip label="Addressee" value={loi.addressee} tokens={tokens} />}
            {loi.year && <MetaChip label="Year" value={String(loi.year)} tokens={tokens} />}
            {loi.cfr_part_reference && (
              <MetaChip
                label="CFR"
                value={loi.cfr_section_reference ? `${loi.cfr_part_reference} — ${loi.cfr_section_reference}` : loi.cfr_part_reference}
                tokens={tokens}
              />
            )}
          </MetaChipRow>

          {/* Same pattern/style as AC's scanned-original banner
              (ocrScannedACs.ts) -- LOIs are decades-old scanned FAA
              correspondence, and scripts/loi_quality_scan.py's per-doc
              ocr_quality_score (dictionary-miss ratio + spurious
              mid-word-space detection) already exists to identify which
              ones are notably affected. 3.0 is the same "notably garbled"
              cutoff that script's own analysis anchored on -- not every
              LOI has visible issues, so this only shows for the ~1/3 that
              score at or above it, not a blanket claim on the whole corpus. */}
          {loi.ocr_quality_score != null && loi.ocr_quality_score >= 3.0 && (
            <View style={[styles.scanBanner, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Icon name="doc.text" size={fs(14)} color={tokens.t3} style={{ marginTop: 2 }} />
              <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
                * This letter's source is a scanned original — some words in the extracted text may be
                misread from the scan. The original PDF is the authoritative source.
              </Text>
            </View>
          )}

          {loi.summary && (
            <DetailSection title="Summary" tokens={tokens}>
              {splitIntoDisplayParagraphs(loi.summary).map((para, i, arr) => (
                <Text
                  key={i}
                  style={[
                    styles.summary,
                    { color: tokens.t2, fontSize: fs(14.5), lineHeight: fs(14.5) * 1.45 },
                    i < arr.length - 1 && { marginBottom: 10 },
                  ]}
                >
                  {para}
                </Text>
              ))}
            </DetailSection>
          )}

          {/* Unified position/style with AC/AD: Open PDF + Download,
              same weight, same place, right before MagicLink. */}
          {loi.pdf_url_cached && (
            <DetailActionRow
              // LOI full text is gated at Pro (task #138) -- same leak and
              // same fix as ad/[id].tsx's openPDF: the raw cached PDF has
              // the same legal text the Pro paywall below is guarding, and
              // every other action on this screen already checks
              // hasProAccess before this one did.
              onOpenPdf={async () => {
                if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
                // pdf_url_cached lives in the private legal-interpretations
                // bucket now -- needs a freshly-signed URL. Falls back to
                // source_url (the FAA DRS original, already public) if
                // signing fails for any reason, same shape as AC's openPDF.
                const url = (await resolveGatedStorageUrl(loi.pdf_url_cached)) ?? loi.source_url
                if (!url) return
                router.push({ pathname: '/pdf-viewer', params: { url, title: loi.title } } as any)
              }}
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          )}

          <View style={[styles.barsWrap, { marginTop: 14 }]}>
            <MagicLinkPod
              bars={[
                { icon: 'book.closed.fill', label: 'FAR references', items: farRefs },
                { icon: 'megaphone.fill', label: 'Related ACs', items: acRefs },
                { icon: 'headset', label: 'P/CG terms', items: pcgRefs },
                { icon: 'envelope.open.fill', label: 'Related Interpretations', items: loiRefs },
                { icon: 'building.columns.fill', label: 'Related 49 CFR', items: cfr49Refs },
              ]}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
            />
          </View>

          {/* Branch on hasProAccess FIRST, not on body's truthiness -- same
              reasoning and same fix as ad/[id].tsx's identical bug: body_text
              is redacted server-side for non-Pro tiers now (see
              gotcha_tier_gate_client_side_only.md), so body is ALWAYS falsy
              for a genuine non-Pro viewer post-fix. The old
              `body && hasProAccess` / `body && !hasProAccess` pair required
              body to be truthy for EITHER branch to fire, permanently
              hiding the pay-gate (every real LOI has body_text at the
              raw-table level -- confirmed 0/1055 null) behind the generic
              "No text available" fallback instead. */}
          {hasProAccess ? (
            body ? (
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
                highlightedBlockTexts={highlightedBlockTexts}
                onToggleHighlight={(paraText) => handleBlockLongPress(paraText)}
                pendingBlockText={pendingHighlight}
                scrollY={scrollY}
                onActiveTableChange={setActiveTable}
              />
            ) : (
              <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5), lineHeight: fs(14.5) * 1.52 }]}>No text available for this interpretation.</Text>
            )
          ) : (
            // No partial preview -- same call as AD's, and for the same
            // reason: RC's "LOIs are a Pro feature" is the same flat,
            // no-preview-length-specified framing as AD's "not a Free
            // tier," not AC's explicit "preview 2 sections." (Also:
            // paragraph-count-based truncation was tried first and found
            // to not actually limit anything on 719 of 1,054 real LOIs --
            // most of this corpus has 0-2 blank-line breaks in the WHOLE
            // document, so "first 2 paragraphs" was often the entire
            // document. The Summary section above already tells a free
            // reader what this interpretation is about.)
            <Pressable
              style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
              onPress={() => { if (!authLoading) router.push('/paywall?tier=pro') }}
            >
              <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
              <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Read the full interpretation with Pro</Text>
              <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.48 }]}>
                The summary above tells you what this interpretation covers — unlock Pro to read the full text.
              </Text>
              <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Pro</Text>
              </View>
            </Pressable>
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

      <FolderPicker
        visible={folderPickerVisible}
        itemType="loi"
        itemId={loi?.slug ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={loi ? {
          document_number: humanizeLoiTitle(loi.title),
          title: loi.summary ?? humanizeLoiTitle(loi.title),
          date_issued: loi.issued_date,
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: {},
  content: { padding: 16, paddingBottom: 48 },
  meta: { marginBottom: 4, textTransform: 'capitalize' },
  // lineHeight NOT set here -- always overridden inline with fs(17) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  title: { fontWeight: '700', marginBottom: 4, textTransform: 'capitalize' },
  cfrRef: { marginBottom: 4 },
  // Same shape as ac/[id].tsx's scanBanner -- kept visually identical
  // across content types per the feature-consistency standing rule.
  scanBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  scanBannerText: { flex: 1 },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  pdfButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginBottom: 16,
  },
  pdfButtonText: { fontWeight: '600' },
  section: { marginBottom: 18 },
  sectionLabel: { fontWeight: '600', letterSpacing: 0.6, marginBottom: 8 },
  // lineHeight NOT set here -- always overridden inline with fs(14.5) * 1.45
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  summary: {},
  body: { lineHeight: 22 },
  proGate: {
    marginTop: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  proGateTitle: { fontWeight: '700', fontSize: 16, marginTop: 4 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.48
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  proGateSub: { fontSize: 13.5, textAlign: 'center', maxWidth: 260 },
  proGateBtn: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  proGateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
})
