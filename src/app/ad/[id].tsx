import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share, Keyboard } from 'react-native'
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
import { FigureViewer } from '@/components/FigureViewer'
import { FigureThumb } from '@/components/FigureThumb'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb, PrevNextFooter, TableNavBar, ChangedBanner } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { getLatestRevision, changedParagraphIndices, type ContentRevision } from '@/lib/whatsChanged'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { MetaChip, MetaChipRow, DetailSection, DetailActionRow } from '@/components/DetailMeta'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { buildRegShareLink } from '@/lib/regShare'
import { getSemanticRelated, mergeRelated } from '@/lib/relatedContent'
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'
import { condenseAdSummary, adSummaryWasCondensed, stripAdArtifacts } from '@/lib/adSummary'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { useConfirm } from '@/components/ConfirmDialog'
import type { AcFigure } from '@/types'

interface AdFigureRow {
  id: string
  page_index: number
  image_url: string
}

interface AirworthinessDirective {
  ad_number: string
  document_number: string
  subject_heading: string
  subject: string | null
  make: string | null
  model: string | null
  product_type: string | null
  product_subtype: string | null
  status: string
  effective_date: string | null
  docket_number: string | null
  amendment_number: string | null
  superseded_ad: string | null
  affected_ad: string | null
  superseded_by: string | null
  affected_by: string | null
  summary: string | null
  applicability: string | null
  unsafe_condition: string | null
  body_text: string | null
  pdf_url: string | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

export default function AdScreen() {
  const { id, hl } = useLocalSearchParams<{ id: string; hl?: string }>()
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
  const { hasPlusAccess, hasProAccess, isPremium, loading: authLoading } = useAuth()
  const [ad, setAd] = useState<AirworthinessDirective | null>(null)
  // Split so the AD text can render as soon as the fast citation query
  // resolves, without waiting on the much slower semantic "related content"
  // RPC -- see the loading effect below for why. mergeRelated() is pure and
  // safe to call with whichever of these two has filled in so far.
  const [citationRelated, setCitationRelated] = useState<RelatedItem[]>([])
  const [semanticRelated, setSemanticRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  // See PlainTextBody's onActiveTableChange comment -- drives the bottom
  // TableNavBar rendered above this screen's own PrevNextFooter.
  const [activeTable, setActiveTable] = useState<{ ord: number; total: number; prevIndex: number | null; nextIndex: number | null } | null>(null)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Same Study-bookmark passage seeding FAR/AIM/P-CG do. routeForBookmark
  // already builds `/ad/<id>?hl=<snippet>` for AD bookmarks; this screen was
  // silently dropping it. Not reachable from Study Mode today (StudyItemType
  // is pcg|far|aim|ac, no 'ad'), so unlike the P/CG case this was a latent
  // half-built path rather than a live bug -- wired up anyway so the two ends
  // agree and it can't quietly no-op the day AD becomes studiable or anything
  // else starts passing a passage through.
  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

  const [backTo, setBackTo] = useState<string | null>(null)
  const [figures, setFigures] = useState<AdFigureRow[]>([])
  const [figuresExpanded, setFiguresExpanded] = useState(false)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [prevAd, setPrevAd] = useState<{ ad_number: string } | null>(null)
  const [nextAd, setNextAd] = useState<{ ad_number: string } | null>(null)
  // Normalized AcFigure[] for FigureViewer's Prev/Next Fig navigation --
  // AdFigureRow itself doesn't carry a display label, so build the exact
  // same "Page N of M" shape the two onPress handlers below already
  // construct one-off, for every row up front instead.
  const figuresForViewer = useMemo(
    () => figures.map((f, i) => ({ id: f.id, label: `Page ${i + 1} of ${figures.length}`, caption: null, page: f.page_index, image_url: f.image_url })),
    [figures],
  )

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
    if (id) isDownloaded(id).then(setDownloaded)
  }, [id])

  // Passage-level highlighting -- see far/[id].tsx's identical comment.
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!id) return
    getHighlightsForAC(id, 'ad').then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [id])
  // The passage currently under the Copy/Highlight menu -- see
  // PlainTextBody's pendingBlockText comment.
  const [pendingHighlight, setPendingHighlight] = useState<string | null>(null)

  // Full-page renders of this AD's own source PDF -- unlike AC/AIM, an AD
  // has no per-figure label/caption metadata (its "Table N"/"Figure N"
  // mentions are almost never individually captioned the way AC/AIM
  // figures are), so every page of a candidate AD gets rendered rather
  // than trying to resolve which exact page a mention points to. See
  // sync/backfill_ad_figures.py.
  useEffect(() => {
    if (!id) return
    supabase.from('ad_figures').select('id, page_index, image_url').eq('ad_number', id).order('page_index')
      .then(({ data }) => setFigures((data ?? []) as AdFigureRow[]))
  }, [id])

  // Prev/Next chevrons -- RC: "we should have some next/prev chevrons in
  // the Mn pages... Same for the A/D itself. The P/CG already has this."
  // Unlike P/CG (1,332 rows) or FAR (scoped to one Part), the AD corpus is
  // ~5,000 rows with no natural small grouping to scope to, so fetching
  // every sibling up front the way those two do would mean downloading the
  // whole table on every single AD view. ad_number is a zero-padded
  // "YYYY-WW-NN" string (confirmed live: "2000-01-06" < "2000-01-10" <
  // "2000-02-14" sorts correctly as plain text), so two targeted
  // lt/gt + limit(1) queries find the immediate neighbor directly instead.
  useEffect(() => {
    if (!id) return
    supabase.from('airworthiness_directives').select('ad_number').lt('ad_number', id).order('ad_number', { ascending: false }).limit(1)
      .then(({ data }) => setPrevAd((data?.[0] as { ad_number: string } | undefined) ?? null))
    supabase.from('airworthiness_directives').select('ad_number').gt('ad_number', id).order('ad_number', { ascending: true }).limit(1)
      .then(({ data }) => setNextAd((data?.[0] as { ad_number: string } | undefined) ?? null))
  }, [id])

  // Confirmed a real gap: AD never read the pending breadcrumb at all,
  // unlike far/aim/pcg/ac/loi. Unlike AC, this route param IS already the
  // canonical id (no internal redirect step), so a plain [id]-keyed effect
  // is safe here -- no double-consume race to guard against.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    // Reset both -- otherwise a fast nav between two ADs (Prev/Next) can
    // briefly show the PREVIOUS AD's related content under the new one's
    // header while the new fetches are in flight.
    setCitationRelated([])
    setSemanticRelated([])

    // Fast path: the AD text itself + its citations. This is the only thing
    // that should gate the page opening -- previously this was one single
    // Promise.all with the semantic "related content" RPC below, which
    // meant the actual AD text (what the user tapped in to read) waited on
    // a decorative "related content" feature that has nothing to do with
    // reading the AD. RC, real device: "content retrieval... taking too
    // long, several seconds just to get a page open... tighten all flows,
    // reduce waste."
    Promise.all([
      // _gated view redacts body_text server-side for non-Plus tiers — see
      // gotcha_tier_gate_client_side_only.md. Every other column passes
      // through unchanged.
      supabase
        .from('airworthiness_directives_gated')
        .select(
          'ad_number, document_number, subject_heading, subject, make, model, product_type, product_subtype, status, effective_date, docket_number, amendment_number, superseded_ad, affected_ad, superseded_by, affected_by, summary, applicability, unsafe_condition, body_text, pdf_url',
        )
        .eq('ad_number', id)
        .single(),
      // Both directions — an AD's own text can cite an AC/FAR/AIM section,
      // and (this is the actual valuable direction per explicit request)
      // an AC/FAR page can show which ADs cite IT.
      supabase
        .from('document_citations_gated')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.ad,cited_id.eq.${id}),and(citing_type.eq.ad,citing_id.eq.${id})`),
    ]).then(async ([adRes, citRes]) => {
      if (!adRes.error && adRes.data) {
        const a = adRes.data as AirworthinessDirective
        setAd(a)
        addRecent({
          id: a.ad_number,
          itemType: 'ad',
          document_number: a.ad_number,
          title: a.subject_heading,
          date_issued: a.effective_date,
          subject_series: null,
        })
      } else {
        // No network (or the row is gone): fall back to the offline copy.
        // This branch was MISSING -- handleDownload below wrote an offline
        // copy that nothing ever read back, so a downloaded AD still showed
        // an empty screen with no connection. Only AC had a cache-read path.
        const cached = await findDownload(id)
        if (cached) {
          setAd({
            ad_number: cached.id,
            subject_heading: cached.title,
            body_text: cached.body_text ?? null,
          } as AirworthinessDirective)
        }
      }
      if (!citRes.error && citRes.data) {
        // Normalize to "the OTHER document" regardless of which side of the
        // row this AD is on — same fix as aim/[id].tsx and far/[id].tsx: the
        // old query only ever read cited_type/cited_id, so an inbound row
        // (an AC/FAR citing THIS AD) displayed as if it pointed at itself.
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'ad' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'ad' && r.cited_id === id))
        setCitationRelated(other)
      }
      setLoading(false)
    })

    // Slow path: semantic "related content" (embedding similarity search).
    // Decoupled from the fast path above so it never blocks the AD text --
    // it merges into the MagicLink pod whenever it happens to resolve.
    getSemanticRelated('ad', id).then(setSemanticRelated)
  }, [id])

  const body = ad?.body_text ?? ''

  // What's Changed -- found missing in the 2026-08-29 "built but inert"
  // sweep: FAR/AIM/CFR49 all have this exact wiring (whatsChanged.ts's
  // RevisionDocType has always included 'ad', and sync/ad_scraper.py has
  // always called sync/revision_log.py to write real content_revisions
  // rows for AD -- this screen just never read them back). Confirmed live
  // right up to this fix: 4 real AD revisions dated 2026-08-17 were
  // already visible in Updates -> Changed and tapping into this exact
  // screen, landing with zero banner or highlighting -- a real, currently-
  // occurring gap, not a latent one.
  const [revision, setRevision] = useState<ContentRevision | null>(null)
  useEffect(() => {
    if (!id) return
    getLatestRevision('ad', id).then(setRevision).catch(() => setRevision(null))
  }, [id])
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

  const related = mergeRelated(citationRelated, semanticRelated)
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  // AD -> AD. The pod had no bar for this at all, so the supersedes/amends
  // chain -- arguably the most important relationship an AD has, since a
  // mechanic needs to know which AD replaced which -- was invisible even
  // once the links existed. `related` is already normalized to "the other
  // document" by the fetch above, so this covers both directions: ADs this
  // one references AND ADs that reference it.
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')
  const cfr49Refs = related.filter((r) => r.cited_type === 'cfr49')

  // Each AD is its own short (2-10 page), complete government PDF — unlike
  // AC/AIM's giant multi-hundred-page combined documents, there's no "which
  // page" ambiguity to solve with server-side rendering/cropping. Reuses
  // the same gated in-app viewer AC's own pdf_url_faa fallback already
  // uses (see ac/[id].tsx's openPDF) rather than a raw external link — same
  // BB-005 reasoning: never let the app hand a bare PDF URL to a share
  // sheet where it could leak to someone who never had the app at all.
  const openPDF = () => {
    if (!ad?.pdf_url) return
    // AD full text is gated at Plus (task #139) -- the raw govinfo.gov PDF
    // contains the exact same compliance text the "Read the full AD with
    // Plus" card below is paywalling, so without this check Free tapped
    // straight past it to the real thing. Every other action on this
    // screen (bookmark, folder, print, share) already checks this; this
    // one was the one gap.
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    // Used to window.open() the raw URL on web -- found live: govinfo.gov
    // (where every AD's pdf_url points) serves its PDFs in a way that
    // triggers an OS-level file-download prompt instead of opening as a
    // page. pdf-viewer.tsx already has a correct, safe web fallback (a
    // plain "not available in the browser preview" message, no fetch
    // attempted) -- routing there unconditionally, same as LOI already does,
    // removes the download risk entirely instead of only fixing it for
    // native.
    router.push({ pathname: '/pdf-viewer', params: { url: ad.pdf_url, title: `AD ${ad.ad_number}` } })
  }

  // Simpler than AC's own handleDownload -- an AD is plain text with no
  // block-parsed structure or figure images to pre-cache, so this just
  // stores the already-loaded body text for offline reading. See
  // downloads.ts's DownloadedItemType comment for why AD/LOI don't need
  // AC's fuller pipeline.
  const handleDownload = async () => {
    if (!ad) return
    if (!isPremium && !downloaded) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(ad.ad_number)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: ad.ad_number,
        type: 'ad',
        document_number: ad.ad_number,
        title: ad.subject_heading,
        subject_series: null,
        size: (ad.body_text ?? '').length,
        body_text: ad.body_text ?? null,
      })
      setDownloaded(true)
    } catch (err) {
      confirm({ title: 'Error', message: "Couldn't save this AD for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  const openRelatedAd = (adNumber: string) => {
    router.push(`/ad/${adNumber.trim()}` as any)
  }

  const handleToggleBookmark = async () => {
    if (!ad) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: ad.ad_number,
      itemType: 'ad',
      document_number: ad.ad_number,
      title: ad.subject_heading,
      date_issued: ad.effective_date,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  // Same guard as far/[id].tsx's identical handler -- see its comment.
  const toggleInFlight = useRef(false)
  const lastToggleAt = useRef(0)
  const handleToggleHighlight = useCallback(async (paraText: string) => {
    if (!ad) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (toggleInFlight.current) return
    if (Date.now() - lastToggleAt.current < 800) return
    lastToggleAt.current = Date.now()
    toggleInFlight.current = true
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      const existing = await findHighlight(ad.ad_number, paraText, 'ad')
      if (existing) {
        await removeHighlight(existing.id)
      } else {
        await addHighlight({
          acId: ad.ad_number,
          itemType: 'ad',
          document_number: ad.ad_number,
          title: ad.subject_heading,
          date_issued: ad.effective_date,
          office: null,
          subject_series: null,
          blockKind: 'para',
          blockLabel: null,
          blockSnippet: paraText.slice(0, 100),
          blockText: paraText,
        })
      }
      const highlights = await getHighlightsForAC(ad.ad_number, 'ad')
      setHighlightedBlockTexts(new Set(highlights.map((h) => h.blockText!)))
    } finally {
      toggleInFlight.current = false
    }
  }, [ad, hasPlusAccess, authLoading])

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
    if (!ad) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setFolderPickerVisible(true)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise -- until now the app had no print at all, only the share
  // sheet (which exports a LINK, not the text).
  const handlePrint = async () => {
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (!ad) return
    try {
      await printReg({
        documentNumber: `AD ${ad.ad_number}`,
        title: ad.subject_heading ?? ad.subject,
        subtitle: ad.effective_date ? `Effective ${ad.effective_date}` : null,
        body: ad.body_text ?? '',
        kindLabel: 'AD',
        // figuresForViewer already normalizes AdFigureRow (no label/caption
        // of its own -- see its own comment) into the shared shape.
        figures: figuresForViewer.map((f) => ({ id: f.id, label: f.label, caption: f.caption, imageUrl: f.image_url })),
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
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (!ad) return
    try {
      await Share.share({
        title: `AD ${ad.ad_number}`,
        message: buildRegShareLink('ad', ad.ad_number, `AD ${ad.ad_number}`, ad.subject_heading ?? undefined),
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
      <OverlayHeader title="Airworthiness Directive" onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {/* Plus-gated, matching ac/[id].tsx's own sticky search -- AD body
          text has NO free preview at all (unlike AC's 2-block preview), so
          a free user previously saw a live, typable "IN DOC" search bar
          above a locked document: harmless (nothing renders for it to
          match against, body_text is redacted server-side), but a
          confusing dead control that undercut the screen's own "no preview
          at all" messaging right below it. Found in the 2026-08-14
          comprehensive gating re-audit. */}
      {!loading && ad && hasPlusAccess && (
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
      {!loading && ad && (
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
      ) : !ad ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>
            AD not found. Older ADs may predate FlyRegs' current AD coverage — check the FAA's Dynamic Regulatory
            System for the complete historical record.
          </Text>
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
          // far/aim/pcg's identical setup), so dragging the doc content down
          // while the in-doc search keyboard was up did nothing; the native
          // interactive-dismiss gesture only exists when this prop is set.
          // keyboardShouldPersistTaps alongside it for the same reason
          // BB-092 needed it elsewhere: without it a tap on the search bar's
          // prev/next buttons just dismisses the keyboard instead of firing.
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => Keyboard.dismiss()}
        >
          <View style={styles.headerRow}>
            <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(17) }]}>AD {ad.ad_number}</Text>
            {/* The badge now only appears when it CARRIES INFORMATION.
                ad_scraper.py hardcodes status = "Current" on every row
                (line ~345), so a green CURRENT pill rendered on all 5,023
                ADs and told the reader nothing — the app only carries
                in-force ADs, so "current" is the baseline expectation, not
                news. What genuinely matters is the opposite case: an AD that
                has been SUPERSEDED by a later one, which we do know from
                `superseded_by`. That gets a warning pill; everything else
                gets no pill at all. */}
            {ad.superseded_by ? (
              <View style={[styles.statusPill, { backgroundColor: tokens.amb + '22' }]}>
                <Text style={[styles.statusText, { color: tokens.amb, fontSize: fs(11) }]}>Superseded</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17), lineHeight: fs(17) * 1.35 }]}>{ad.subject_heading}</Text>

          {/* Unified with AC/LOI's own meta-chip row -- was a vertical
              label:value card, visually and positionally inconsistent
              with every other content type. See DetailMeta.tsx. */}
          <MetaChipRow>
            {ad.make && <MetaChip label="Make" value={ad.make} tokens={tokens} />}
            {ad.model && <MetaChip label="Model" value={ad.model} tokens={tokens} />}
            {ad.effective_date && <MetaChip label="Effective" value={ad.effective_date} tokens={tokens} />}
            {ad.docket_number && <MetaChip label="Docket" value={ad.docket_number} tokens={tokens} />}
            {ad.amendment_number && <MetaChip label="Amendment" value={ad.amendment_number} tokens={tokens} />}
          </MetaChipRow>

          {(ad.superseded_ad || ad.affected_by) && (
            <View style={[styles.infoCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 10 }]}>
              {ad.superseded_ad && (
                <Pressable onPress={() => openRelatedAd(ad.superseded_ad!)}>
                  <InfoRow tokens={tokens} fs={fs} label="Supersedes" value={`AD ${ad.superseded_ad}`} linkColor={tokens.blu} />
                </Pressable>
              )}
              {ad.affected_by && (
                <Pressable onPress={() => openRelatedAd(ad.affected_by!)}>
                  <InfoRow tokens={tokens} fs={fs} label="Superseded by" value={`AD ${ad.affected_by}`} linkColor={tokens.blu} />
                </Pressable>
              )}
            </View>
          )}

          {ad.summary && (
            <DetailSection title="Summary" tokens={tokens}>
              {/* The FAA's SUMMARY field is the full Federal Register preamble
                  (median 691 chars across the corpus, up to 2,243), so it is
                  condensed to the actionable sentence. The full text is never
                  discarded -- it is one tap away. */}
              {/* condenseAdSummary's clip is already one short sentence
                  (splitIntoDisplayParagraphs is a no-op on it); the expanded
                  full preamble is the flat, whitespace-collapsed case this
                  actually matters for. */}
              {splitIntoDisplayParagraphs(summaryExpanded ? stripAdArtifacts(ad.summary) : condenseAdSummary(ad.summary)).map((para, i, arr) => (
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
              {adSummaryWasCondensed(ad.summary) && (
                <Pressable onPress={() => setSummaryExpanded((v) => !v)} hitSlop={8}>
                  <Text style={[styles.summaryToggle, { color: tokens.blu, fontSize: fs(13) }]}>
                    {summaryExpanded ? 'Show less' : 'Show full summary'}
                  </Text>
                </Pressable>
              )}
            </DetailSection>
          )}

          {/* Unified position/style with AC/LOI: Open PDF + Download,
              same weight, same place, right before MagicLink. */}
          {ad.pdf_url && (
            <DetailActionRow
              onOpenPdf={openPDF}
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          )}

          <View style={[styles.barsWrap, { marginTop: 14 }]}>
            {/* Always shown, even at 0 -- matches FAR/AC/AIM's own bar (RC:
                found live on FAR that hiding it entirely at 0 read as
                broken/missing, not "nothing here"). No per-figure label
                here (unlike AC/AIM) -- see the AdFigureRow comment above. */}
            <Pressable
              style={[styles.tablesBar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => setFiguresExpanded((e) => !e)}
              disabled={figures.length === 0}
            >
              <Icon name="photo" size={fs(15)} color={tokens.t3} />
              <Text style={[styles.tablesBarLabel, { color: tokens.t1, fontSize: fs(13) }]}>
                {figures.length === 1 ? 'Table/Figure' : 'Tables & Figures'}
              </Text>
              <View style={{ flex: 1 }} />
              <Text style={[styles.tablesBarCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{figures.length}</Text>
              {figures.length > 0 && (
                <Icon name={figuresExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.t4} />
              )}
            </Pressable>
            {figuresExpanded && figures.length > 0 && (
              <View style={styles.figuresWrap}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.figScrollBox} contentContainerStyle={styles.figScroll}>
                  {figures.map((f, i) => (
                    <Pressable
                      key={f.id}
                      style={[styles.figCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                      onPress={() => setViewerFigure({ id: f.id, label: `Page ${i + 1} of ${figures.length}`, caption: null, page: f.page_index, image_url: f.image_url })}
                    >
                      <FigureThumb id={f.id} imageUrl={f.image_url} style={styles.figThumb} />
                      <Text style={[styles.figLabel, { color: tokens.t1, fontSize: fs(11.5) }]} numberOfLines={1}>Page {i + 1}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}
            <MagicLinkPod
              bars={[
                { icon: 'wrench.and.screwdriver.fill', label: 'Related ADs', items: adRefs },
                { icon: 'megaphone.fill', label: 'Related ACs', items: acRefs },
                { icon: 'book.closed.fill', label: 'FAR references', items: farRefs },
                { icon: 'map.fill', label: 'AIM references', items: aimRefs },
                { icon: 'headset', label: 'P/CG terms', items: pcgRefs },
                { icon: 'envelope.open.fill', label: 'Related LOIs', items: loiRefs },
                { icon: 'building.columns.fill', label: 'Related 49 CFR', items: cfr49Refs },
              ]}
              currentLabel={`AD ${ad.ad_number}`}
              hasProAccess={hasProAccess}
            />
          </View>

          {/* Branch on hasPlusAccess FIRST, not on body's truthiness --
              body_text is redacted server-side for non-Plus tiers now (see
              gotcha_tier_gate_client_side_only.md), so body is ALWAYS
              falsy for a genuine free-tier viewer post-fix. The old
              `body && hasPlusAccess` / `body && !hasPlusAccess` pair
              required body to be truthy for EITHER branch to fire, which
              made the pay-gate branch permanently unreachable (every real
              AD has body_text at the raw-table level -- confirmed 0/5023
              null -- so this isn't a rare edge case, it was the main path)
              and silently downgraded every free-tier AD view to the
              generic "No further text available" message instead of the
              intended paywall CTA. */}
          {hasPlusAccess ? (
            body ? (
              <PlainTextBody
                ref={bodyRef}
                text={body}
                hasProAccess={hasProAccess}
                // Always exactly one synthetic entry (never one per real
                // page) when any figures exist -- see crossRefLinks.ts's own
                // comment on why: it makes PlainTextBody's normal
                // figures.length===1 fallback always resolve a tap on
                // "Table N to Paragraph X" cleanly, without needing an exact
                // per-mention label match AD doesn't have.
                figures={figures.length > 0 ? [{ id: figures[0].id, label: '', caption: null, image_url: figures[0].image_url }] : undefined}
                onOpenFigure={() => figures[0] && setViewerFigure({ id: figures[0].id, label: `Page 1 of ${figures.length}`, caption: null, page: figures[0].page_index, image_url: figures[0].image_url })}
                changedIndices={changedIdx}
                highlightQuery={inDocSearch.debounced}
                activeMatch={inDocSearch.matchIdx}
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
              <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5), lineHeight: fs(14.5) * 1.52 }]}>No further text available for this AD.</Text>
            )
          ) : (
            // RC, 2026-08-03: "ADs shouldn't come alive until Plus. ADs are
            // not a Free tier, they're mainly for O&Os anyway." A firmer cut
            // than AC's (which still shows a 2-section preview): the AD
            // number, subject, make/model, effective date, and summary
            // above are enough to tell a free user an AD exists and applies
            // to them -- the compliance body text itself (what to actually
            // DO about it) is Plus-only, with no partial preview at all.
            <Pressable
              style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
              onPress={() => { if (!authLoading) router.push('/paywall?tier=plus') }}
            >
              <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
              <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Read the full AD with Plus</Text>
              <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.48 }]}>
                The summary above tells you this AD exists — unlock Plus to read the full compliance text.
              </Text>
              <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
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
      {ad && (
        <PrevNextFooter
          prevLabel={prevAd ? `AD ${prevAd.ad_number}` : null}
          nextLabel={nextAd ? `AD ${nextAd.ad_number}` : null}
          onPrev={() => prevAd && router.replace(`/ad/${prevAd.ad_number}` as any)}
          onNext={() => nextAd && router.replace(`/ad/${nextAd.ad_number}` as any)}
        />
      )}
      <FigureViewer figure={viewerFigure} figures={figuresForViewer} onNavigate={setViewerFigure} onClose={() => setViewerFigure(null)} />
      <FolderPicker
        visible={folderPickerVisible}
        itemType="ad"
        itemId={ad?.ad_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={ad ? {
          document_number: ad.ad_number,
          title: ad.subject_heading,
          date_issued: ad.effective_date,
          office: null,
          subject_series: null,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

function InfoRow({
  tokens, fs, label, value, linkColor,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: ReturnType<typeof useFS>
  label: string
  value: string
  linkColor?: string
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: tokens.t3, fontSize: fs(12.5) }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: linkColor ?? tokens.t1, fontSize: fs(13.5) }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  adNum: { fontWeight: '700' },
  statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  // lineHeight NOT set here -- always overridden inline with fs(17) * 1.35
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  title: { fontWeight: '600', marginTop: 4, marginBottom: 14 },
  infoCard: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 12, gap: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  infoLabel: { fontWeight: '500' },
  infoValue: { flex: 1, textAlign: 'right', fontWeight: '500' },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  tablesBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14,
  },
  tablesBarLabel: { fontWeight: '600' },
  tablesBarCount: { fontWeight: '500' },
  figuresWrap: { marginTop: 2 },
  // Same root cause as updates.tsx's filter chips (see that file's
  // comment): a horizontal ScrollView with no explicit `style` collapses
  // its own cross-axis height on web, clipping the row's content. Sized
  // for the fixed 90px thumbnail plus label at up to max font scale.
  figScrollBox: { flexGrow: 0, flexShrink: 0, height: 145 },
  figScroll: { gap: 10 },
  figCard: { width: 130, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  figThumb: { width: '100%', height: 90 },
  figLabel: { fontSize: 11.5, padding: 8 },
  pdfButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginBottom: 18,
  },
  pdfButtonText: { fontWeight: '600' },
  sectionLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  summaryToggle: { fontWeight: '600', marginTop: 6 },
  // lineHeight NOT set here -- always overridden inline with fs(14.5) * 1.45
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  summary: { marginBottom: 18 },
  body: { fontSize: 14.5, lineHeight: 22 },
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
