import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, TextInput, Pressable, StyleSheet, ActivityIndicator, Platform, Share, Keyboard } from 'react-native'
import * as Haptics from 'expo-haptics'
import * as Clipboard from 'expo-clipboard'
import * as Sentry from '@sentry/react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { BackToBreadcrumb, ChangedBanner, OfflineCopyBanner } from '@/components/DocNavBar'
import { Icon } from '@/components/Icon'
import { printReg } from '@/lib/printReg'
import { ACBody, ACBodyHandle } from '@/components/ACBody'
import { addRecent } from '@/lib/recents'
import { isBookmarked, toggleBookmark, getHighlightsForAC, findHighlight, addHighlight, removeHighlight } from '@/lib/bookmarks'
import { getDownloads, isDownloaded, addDownload, removeDownload, isDownloadStale, type DownloadedAC } from '@/lib/downloads'
import { downloadGatedImageToCache, downloadAllToCache } from '@/lib/imageCache'
import { resolveGatedStorageUrl } from '@/lib/gatedStorage'
import { collapseDictationDuplicate, normalizeSearchQuery } from '@/lib/dictation'
import { blockText, previewBlockCount, ACBlock } from '@/lib/acFormat'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { FigureViewer } from '@/components/FigureViewer'
import { FormulaRefViewer } from '@/components/FormulaRefViewer'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { isOcrScanned, ocrScannedSeq, OCR_SCANNED_TOTAL } from '@/lib/ocrScannedACs'
import { buildACShareLink, highlightSnippet } from '@/lib/acShare'
import { FolderPicker } from '@/components/FolderPicker'
import { useIsTabletLandscape, useIsTabletPortrait } from '@/context/responsive'
import { useScreenActions } from '@/context/screenActions'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { useConfirm } from '@/components/ConfirmDialog'
import { consumePendingBreadcrumb, setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { getSemanticRelated, mergeRelated } from '@/lib/relatedContent'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { TabletContainer } from '@/components/TabletContainer'
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

export default function ACDetailScreen() {
  const { id, hlId, hlText } = useLocalSearchParams<{ id: string; hlId?: string; hlText?: string }>()
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()

  // Inline cross-reference links (LinkedBody, see crossRefLinks.ts) only
  // have the AC's document_number to build a route from — a "AC 90-67B"
  // mention in running prose has no UUID anywhere nearby. Rather than
  // teach the main fetch effect below (already handling offline/cache
  // fallback, highlighting, figures, formulas) to accept either shape,
  // resolve document_number -> real id here and bounce to the canonical
  // URL. A no-op for every normal navigation, which always already passes
  // the real UUID.
  useEffect(() => {
    if (!id || UUID_RE.test(id)) return
    supabase.from('advisory_circulars').select('id').eq('document_number', id).eq('status', 'active').maybeSingle()
      .then(({ data, error }) => {
        if (data) { router.replace(`/ac/${data.id}` as any); return }
        // maybeSingle() (unlike single()) returns error:null on a genuine
        // 0-row miss -- exactly the routine "cited without its revision
        // letter" case the ilike fallback below exists for -- so only a
        // REAL unexpected error (not "no rows") should skip it. Confirmed
        // live: single() fired a console 406 on every one of these misses
        // even though the fallback already recovered silently underneath
        // it -- corpus-wide noise (this route is hit from the "Related
        // ACs" bar on every FAR/AIM/PCG/AD/LOI/AC detail screen), not a
        // functional bug, but still worth a clean console.
        // setLoading(false) on EVERY exit, not just the happy one. These
        // three bare returns left `loading` true forever: the main content
        // effect below starts with `if (!UUID_RE.test(id)) return`, so it
        // never reaches its own setLoading(false), and the render is
        // `loading ? <Spinner/> : !ac ? "AC not found."` -- so an
        // unresolvable AC number spun forever instead of saying so. Reachable
        // today: 31 document_citations point at 5 AC numbers that exist only
        // as status='cancelled', which both queries here filter out.
        if (error) { setLoading(false); return }
        // Regulatory text routinely cites an AC by its base number without
        // the revision letter ("AC 90-66" in running prose, real document
        // is "90-66C") — confirmed live, not a one-off: an exact match
        // failing here doesn't mean the link is bad, it means the source
        // text used the unversioned form. Prefix-match and take the
        // longest (most specific / most likely current-revision) hit
        // rather than leaving the link dead.
        supabase.from('advisory_circulars').select('id,document_number').ilike('document_number', `${id}%`).eq('status', 'active')
          .then(({ data: matches }) => {
            if (!matches || matches.length === 0) { setLoading(false); return }
            // A revision suffix is always non-numeric ("120-12" -> "120-12A")
            // -- confirmed live as a real, wrong-AC bug: unfiltered, this
            // prefix match also caught "120-126A" for a query of "120-12"
            // (120-12 IS a literal string-prefix of 120-126A), and being
            // longer, it won the "take the longest match" sort over the
            // actual correct target "120-12A". A candidate whose next
            // character after the matched prefix is a DIGIT is a different
            // AC's number that happens to share a numeric prefix, not a
            // missing-revision-letter case of this one -- exclude those.
            const revisionMatches = matches.filter((m) => !/^\d/.test(m.document_number.slice(id.length)))
            if (revisionMatches.length === 0) { setLoading(false); return }
            const best = revisionMatches.sort((a, b) => b.document_number.length - a.document_number.length)[0]
            router.replace(`/ac/${best.id}` as any)
          })
      })
  }, [id])

  // Consumed once per screen instance, not on every render -- see
  // navBreadcrumb.ts's single-slot design. Confirmed a real gap: unlike
  // far/aim/pcg/loi, this screen never read the pending breadcrumb at all,
  // so arriving here via a MagicLink (e.g. from FAR 119.39) showed a plain
  // back arrow instead of "Back to § 119.39" — inconsistent with every
  // other content type's detail screen.
  //
  // AC is unique among content types in redirecting internally: a
  // MagicLink to an AC lands on its document_number ("120-49B"), which the
  // effect above resolves and router.replace()s to the canonical UUID
  // route. That replace() mounts a genuinely NEW component instance with
  // its own fresh state -- a same-instance guard (a ref, a bool) can't
  // help, because the FIRST (document_number) instance already emptied
  // the single slot before the SECOND (UUID) instance -- the one that
  // actually renders -- ever mounts. Confirmed live: even with a
  // mount-once ref guard, the breadcrumb still silently vanished.
  //
  // Fix: while `id` is still the non-canonical document_number (i.e. this
  // instance is about to redirect and die), read the pending breadcrumb
  // and immediately put it right back -- a no-op pass-through that keeps
  // it alive for the instance that's about to replace this one. Only
  // consume it for real once `id` is already the canonical UUID, which is
  // the stable instance that actually renders.
  useEffect(() => {
    if (id && !UUID_RE.test(id)) {
      const label = consumePendingBreadcrumb()
      if (label) setPendingBreadcrumb(label)
      return
    }
    setBackTo(consumePendingBreadcrumb())
  }, [id])
  // FlyRegs pricing pivot (2026-07-24). RC, 2026-08-14, direct correction to
  // the 2026-08-11 pass (which had moved highlights/notes/bookmarks/folders
  // to Pro on a misreading of "back up sync is Pro" -- see
  // gotcha_gating_sweep_2026_08_11.md): AC full text, figures, Print/Export,
  // AND highlights/notes/bookmarks/folders are all Plus (hasPlusAccess).
  // Only the separate "Back up & sync" toggle (cross-device sync, in
  // saved.tsx/notes.tsx) requires Pro. Offline downloads and sharing stay
  // Premium-only, unchanged from before.
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
  const { isPremium, hasPlusAccess, hasProAccess, loading: authLoading } = useAuth()
  const fs = useFS()
  const ifs = useInputFS()
  const isTabletLandscape = useIsTabletLandscape()
  const isTabletPortrait = useIsTabletPortrait()
  const scrollRef = useRef<ScrollView>(null)
  const acBodyRef = useRef<ACBodyHandle>(null)
  const [ac, setAC] = useState<AdvisoryCircular | null>(null)
  // Set only when `ac` above is being served from the offline cache, not a
  // live fetch -- see far/[id].tsx's identical comment.
  const [offlineCopy, setOfflineCopy] = useState<DownloadedAC | null>(null)
  const [offlineStale, setOfflineStale] = useState(false)
  const [backTo, setBackTo] = useState<string | null>(null)
  // Split so citation-derived related links can show up as soon as the fast
  // document_citations_gated query resolves, without waiting on the slower
  // semantic "related content" RPC -- see the effect below for why.
  // mergeRelated() is pure and safe to call with whichever of these two has
  // filled in so far. Note: unlike far/aim/ad/loi/cfr49, this screen's main
  // content-loading effect (below, ~line 281) already sets `loading` false
  // entirely on its own, independent of this citations+semantic effect --
  // so the AC text itself was never gated on the semantic RPC to begin
  // with. This split only speeds up how soon the MagicLink pod's bars fill in.
  const [citationRelated, setCitationRelated] = useState<RelatedItem[]>([])
  const [semanticRelated, setSemanticRelated] = useState<RelatedItem[]>([])
  const [bookmarked, setBookmarked] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmTick, setConfirmTick] = useState(0)
  const [confirmLabel, setConfirmLabel] = useState('')
  const [highlightedBlockTexts, setHighlightedBlockTexts] = useState<Set<string>>(new Set())
  const [figures, setFigures] = useState<AcFigure[] | null>(null)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [formulaRefs, setFormulaRefs] = useState<FormulaRef[] | null>(null)
  const [viewerFormulaRef, setViewerFormulaRef] = useState<FormulaRef | null>(null)
  const [changedIdx, setChangedIdx] = useState(0)
  const [loading, setLoading] = useState(true)
  const [scrollY, setScrollY] = useState(0)
  // How far down the "FULL TEXT" section (which wraps ACBody) sits within
  // this ScrollView's content -- i.e. the combined height of everything
  // rendered above it (badge row, title, description, action buttons,
  // etc). Passed to ACBody as outerOffsetYRef so its jump-to search-match/
  // changed-block scroll can compute each block's true absolute position
  // via pure onLayout arithmetic, with no dependency on live scroll
  // position or keyboard state -- see that prop's own comment in
  // ACBody.tsx for why that matters (interactive keyboard dismiss from the
  // search bar ties into the same native scrolling machinery).
  const fullTextSectionYRef = useRef(0)
  // The ScrollView's own rendered height -- passed to ACBody so a jump-to
  // search-match/changed-block scroll can center against what's ACTUALLY
  // visible (header + this screen's own chrome above it, tab bar below it),
  // not the full device window, which is taller and made prior centering
  // attempts land the target too low/off the bottom of the real viewport.
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
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
    const t = normalizeSearchQuery(collapseDictationDuplicate(raw))
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
    // Dismiss the keyboard before jumping -- otherwise a "centered" result
    // can still land visually behind the keyboard, which still covers the
    // bottom of the screen while the search TextInput has focus. The 50ms
    // delay before scrolling gives that dismiss animation a moment to
    // start -- keyboardDismissMode="interactive" ties keyboard retraction
    // into the same native scroll machinery as our own scrollTo, so firing
    // both in the same tick risked the two fighting over the ScrollView's
    // contentInset/offset mid-animation on a real device.
    Keyboard.dismiss()
    const next = (matchIdx - 1 + matchCount) % matchCount
    setMatchIdx(next)
    setTimeout(() => acBodyRef.current?.scrollToMatch(next), 50)
  }, [matchIdx, matchCount])

  const goToNext = useCallback(() => {
    if (matchCount === 0) return
    Keyboard.dismiss()
    const next = (matchIdx + 1) % matchCount
    setMatchIdx(next)
    setTimeout(() => acBodyRef.current?.scrollToMatch(next), 50)
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
    // A MagicLink/direct URL to an AC's document_number ("61-65K") lands
    // here BEFORE the resolver effect above has replaced it with the real
    // UUID -- both effects depend on the same `[id]` and run in the same
    // initial pass. Tracked down a real, reproducible bug from this exact
    // race: `id` (a document_number string) sent straight into `.eq('id',
    // id)` below, a UUID column, so Postgres/PostgREST rejects the whole
    // query with a 400 ("invalid input syntax for type uuid"). The
    // resolver's router.replace() remounts a fresh, correct instance
    // moments later, so the final render was always right -- this was a
    // real, silent, wasted request on every single MagicLink/document-
    // number arrival, not a one-off. Same guard the resolver effect
    // already uses: skip entirely until `id` is the canonical UUID.
    if (!id || !UUID_RE.test(id)) return
    setFigures(null)
    setFormulaRefs(null)
    // _gated view returns only the free-preview slice of pdf_blocks for
    // non-Plus tiers server-side -- see gotcha_tier_gate_client_side_only.md.
    // pdf_blocks_total_count is the TRUE count (unaffected by the preview
    // truncation) -- needed below so the "Continue reading with Plus" gate
    // can still tell "there's more" from "that's everything".
    supabase
      .from('advisory_circulars_gated')
      .select('id,document_number,title,date_issued,office,subject_series,description,pdf_blocks,pdf_blocks_total_count,pdf_url_cached,pdf_url_faa,change_number,status,cancels,document_id,updated_at,changed_block_indices')
      .eq('id', id)
      // maybeSingle(), not single() -- a stale UUID (e.g. a bookmark
      // pointing to a removed AC) is a real, if rare, 0-row case, and
      // single() logged a console 406 for it even though the branch below
      // already only acts when both `!error && data`, degrading cleanly
      // to the offline-copy fallback either way.
      .maybeSingle()
      .then(async ({ data, error }) => {
        if (!error && data) {
          const loaded = data as AdvisoryCircular
          setAC(loaded)
          setOfflineCopy(null)
          addRecent({
            id: loaded.id,
            document_number: loaded.document_number,
            title: loaded.title,
            date_issued: loaded.date_issued,
            subject_series: loaded.subject_series,
          })
          // Only fetched live when the main AC fetch itself succeeded --
          // when it didn't (see the offline branch below), these would
          // otherwise fire their own doomed network calls and, depending on
          // exactly how they fail, could either leave Figures & Tables stuck
          // on "loading forever" or silently overwrite the offline copy's
          // cached figures/formulas with empty arrays.
          supabase
            .from('ac_figures')
            .select('id,label,caption,page,image_url')
            .eq('ac_id', id)
            .order('sort_order', { ascending: true })
            // `?? []` here contradicted the comment four lines above, which
            // says this must never "silently overwrite the offline copy's
            // cached figures/formulas with empty arrays". supabase-js
            // RESOLVES with {data: null, error} on a network failure rather
            // than rejecting, so a failed secondary fetch produced exactly
            // that empty array -- indistinguishable from "this AC genuinely
            // has no figures", and then persisted as such by handleDownload.
            .then(({ data, error }) => { if (!error && data) setFigures(data as AcFigure[]) })
          // Separate query, separate table -- deliberately not combined with
          // the ac_figures fetch above so this can never interfere with the
          // Figures & Tables pipeline (see FormulaRef type comment in
          // src/types/index.ts).
          supabase
            .from('ac_formula_refs')
            .select('id,label,note,page,image_url')
            .eq('ac_id', id)
            .order('sort_order', { ascending: true })
            .then(({ data, error }) => { if (!error && data) setFormulaRefs(data as FormulaRef[]) })
        } else {
          // Live fetch failed (most likely: no network). Fall back to a
          // downloaded offline copy if this AC was saved for offline reading —
          // otherwise the Download feature stores content it can never show.
          // Figures/formula-refs come from the SAME cached record (their
          // images were pre-downloaded to local storage in handleDownload,
          // see imageCache.ts) instead of the live queries above, which would
          // just fail with no network anyway.
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
            setFigures(cached.figures ?? [])
            setFormulaRefs(cached.formulaRefs ?? [])
            setOfflineCopy(cached)
          }
        }
        setLoading(false)
      })
    isBookmarked(id).then(setBookmarked)
    isDownloaded(id).then(setDownloaded)
    getHighlightsForAC(id).then((hs) => setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!))))
  }, [id])

  // Opportunistic staleness check -- see downloads.ts's isDownloadStale.
  useEffect(() => {
    if (!offlineCopy) { setOfflineStale(false); return }
    let cancelled = false
    isDownloadStale(offlineCopy).then((s) => { if (!cancelled) setOfflineStale(s) })
    return () => { cancelled = true }
  }, [offlineCopy])

  // MagicLink cross-references -- confirmed a total, real gap: document_citations
  // had zero rows with citing_type='ac' anywhere in the corpus (no extraction
  // script for AC's own outbound citations had ever been built), so this screen
  // never had ANY related-content UI at all despite far/aim/ad all having it.
  // document_citations keys ACs by document_number (what ac_citations.py writes),
  // not the internal UUID `id` param this screen otherwise uses -- so this waits
  // for ac.document_number to be loaded rather than running off the raw param.
  useEffect(() => {
    const docNum = ac?.document_number
    if (!docNum) return
    // Reset both -- otherwise navigating between two ACs can briefly show
    // the PREVIOUS AC's related content under the new one's header while
    // the new fetches are in flight.
    setCitationRelated([])
    setSemanticRelated([])
    supabase
      .from('document_citations_gated')
      .select('citing_type, citing_id, cited_type, cited_id, label')
      .or(`and(cited_type.eq.ac,cited_id.eq.${docNum}),and(citing_type.eq.ac,citing_id.eq.${docNum})`)
      .then(({ data, error }) => {
        if (error || !data) return
        // Normalize to "the OTHER document" regardless of which side of the
        // row this AC is on -- same pattern as far/aim/ad's fixed queries.
        const rows = data as { citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null }[]
        const other = rows
          .map((r) => (r.citing_type === 'ac' && r.citing_id === docNum
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'ac' && r.cited_id === docNum))
        setCitationRelated(other)
      })
    // Decoupled from the citations fetch above -- the semantic RPC is
    // noticeably slower (embedding centroid + HNSW search), and there's no
    // reason the citation-derived bars should wait on it before showing
    // anything.
    getSemanticRelated('ac', docNum).then(setSemanticRelated)
  }, [ac?.document_number])

  const related = mergeRelated(citationRelated, semanticRelated)
  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const otherAcRefs = related.filter((r) => r.cited_type === 'ac')
  const cfr49Refs = related.filter((r) => r.cited_type === 'cfr49')
  // Confirmed a real gap live: far/[id].tsx already builds a "Related LOIs"
  // bar off this same bidirectional citation fetch, but AC/P-CG/AIM/AD never
  // did -- an LOI interpreting an AC or P/CG term (33 + 24 real citation
  // rows respectively) was fetched by the query above but silently dropped
  // on the floor since nothing filtered cited_type==='loi' into its own bar.
  const loiRefs = related.filter((r) => r.cited_type === 'loi')

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

  // Opened from someone else's shared passage (?hlText=<snippet>) -- the
  // recipient has no local highlight of their own to look up by id, so this
  // jumps by matching the snippet directly against this AC's own blocks.
  // Also creates a real highlight for the recipient at that same block --
  // sharing a highlighted passage previously only ever scrolled the
  // recipient to it without marking it yellow on their end, even though
  // that's the whole point of sharing a *highlight* specifically (as
  // opposed to the AC generally). Gated on hasPlusAccess, same as creating any
  // other highlight -- this only ever adds one the recipient doesn't
  // already have; it never removes/toggles anything of theirs.
  const jumpedToHlText = useRef<string | null>(null)
  useEffect(() => {
    if (!hlText || !ac?.pdf_blocks) return
    if (jumpedToHlText.current === hlText) return
    const snippet = decodeURIComponent(hlText)
    const idx = ac.pdf_blocks.findIndex((b) => blockText(b).trim().startsWith(snippet))
    if (idx === -1) return
    jumpedToHlText.current = hlText
    setTimeout(() => acBodyRef.current?.scrollToBlockIndex(idx), 250)

    if (hasPlusAccess) {
      const block = ac.pdf_blocks[idx]
      const meta = highlightMeta(block)
      const contentKey = blockText(block)
      if (meta) {
        findHighlight(ac.id, contentKey).then((existing) => {
          if (existing) return
          addHighlight({
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
          }).then(() => getHighlightsForAC(ac.id)).then((hs) => {
            setHighlightedBlockTexts(new Set(hs.map((h) => h.blockText!)))
          })
        })
      }
    }
  }, [hlText, ac?.id, ac?.pdf_blocks, hasPlusAccess])

  const handleDownload = async () => {
    if (!ac) return
    if (!isPremium && !downloaded) {
      if (!authLoading) router.push('/paywall?tier=premium')
      return
    }
    if (hasNoSourceAtAll) {
      confirm({
        title: 'Not available from the FAA',
        message: 'The FAA has not published public content for this document, so there is nothing to save offline.',
        cancelLabel: null,
      })
      return
    }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(ac.id)
      return
    }
    // Not optimistic this time, unlike the plain-text case below -- pulling
    // every Figure/Table and Formula-to-Verify image over the network can
    // take a real, visible amount of time (several images, not just a JSON
    // blob), and flipping to "Saved offline" before those bytes actually
    // exist on disk would be a lie the moment the device loses signal.
    setDownloadBusy(true)
    // Pre-cache every image now, while there's still a network connection to
    // fetch them with -- downloadImageToCache persists to local disk (see
    // imageCache.ts) keyed by each figure/formula's own id, which is exactly
    // what FigureViewer/FormulaRefViewer now read from at render time. This
    // is what actually makes T&Fs viewable (and thus rotatable, once the
    // image loads at all) with no network -- storing just the label/caption
    // metadata below would leave the section listed but every image broken.
    // Uses downloadImageToCache, NOT getCachedImageUri -- confirmed live,
    // post-build-31 sweep: getCachedImageUri fires its real download in a
    // detached background task and returns almost instantly regardless of
    // image size, which meant this whole Promise.allSettled resolved in
    // single-digit milliseconds while every image was still mid-download,
    // directly contradicting the "not optimistic" comment right above --
    // "Saved offline" could fire before the bytes existed. downloadImageToCache
    // is the awaitable counterpart, added specifically for this call site;
    // it doesn't resolve until the download actually finishes or fails.
    // allSettled, not all -- one image failing to cache (bad connection mid-
    // transfer, expo-file-system genuinely unsupported on this platform)
    // must never take down the whole download and lose the reliable text
    // part too. Confirmed live: an uncaught rejection here (the original
    // Promise.all version) silently aborted before addDownload ever ran,
    // leaving the button stuck on "Saving…" forever with nothing saved.
    // Bounded pool, not an unbounded allSettled: this AC can have 378 figures
    // (43.13-1B, measured) averaging 326 KB, so firing them all in one tick
    // meant ~123 MB in flight and a tail that outlived its own 300-second
    // signed URLs -- failing silently, since allSettled swallows it, and
    // telling the user "Saved offline" with figures missing.
    const imgResult = await downloadAllToCache([
      ...(figures ?? []).map((f) => ({ key: f.id, url: f.image_url })),
      ...(formulaRefs ?? []).map((f) => ({ key: f.id, url: f.image_url })),
    ])
    // pdf_blocks is already loaded in `ac` (it's part of the main fetch above) —
    // that's also exactly what ACBody renders, so caching it here is what
    // actually makes the offline copy readable with no network connection.
    try {
      await addDownload({
        id: ac.id,
        document_number: ac.document_number,
        title: ac.title,
        subject_series: ac.subject_series,
        size: ac.pdf_blocks ? JSON.stringify(ac.pdf_blocks).length : 24_000,
        pdf_blocks: ac.pdf_blocks ?? null,
        figures: figures ?? null,
        formulaRefs: formulaRefs ?? null,
      })
      setDownloaded(true)
      // Tell the user when the offline copy is incomplete. The text is saved
      // either way (the reliable part, worth keeping), but claiming "Saved
      // offline" while images are missing is exactly the bug this closes.
      if (imgResult.failed > 0) {
        confirm({
          title: 'Saved, but some images are missing',
          message: `${imgResult.failed} image${imgResult.failed === 1 ? '' : 's'} couldn't be downloaded. The text is saved offline; the missing images will need a connection.`,
          cancelLabel: null,
        })
      }
    } catch (err) {
      Sentry.captureException(err)
      confirm({ title: 'Error', message: "Couldn't save this AC for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise. An AC's text lives in pdf_blocks rather than one body column,
  // so flatten it with the same blockText() the reader renders from.
  const handlePrint = async () => {
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (!ac) return
    const body = (ac.pdf_blocks ?? []).map((b) => blockText(b)).filter(Boolean).join('\n\n')
    try {
      await printReg({
        documentNumber: `AC ${ac.document_number}`,
        title: ac.title,
        body: body || ac.description || '',
        kindLabel: 'Advisory Circular',
        figures: (figures ?? []).map((f) => ({ id: f.id, label: f.label, caption: f.caption, imageUrl: f.image_url })),
      })
    } catch (err) {
      // RC, real device: "when you tap print it opens the phone's print
      // dialog box, but when you close it, the app puts a CTA on screen
      // about it not closing." expo-print's iOS path can reject AFTER the
      // system print sheet already opened and was used (e.g. no printer
      // configured, so there's nowhere to actually send the finished job)
      // -- by the time this catch fires, the user has already seen and
      // interacted with a dialog that visibly worked, so an alert
      // insisting it "couldn't open" is actively wrong, not just unhelpful.
      // A genuine failure to open at all is self-evident (nothing
      // appears) and needs no alert to announce it either. Log for our
      // own visibility, don't tell the user something that isn't true.
      Sentry.captureException(err)
    }
  }

  const handleShare = async () => {
    // Share/export is a PLUS feature (paywall PLUS_FEATURES), not Premium.
    // Gating it on isPremium bounced a Plus buyer to a Premium upsell for
    // something they had already paid for.
    if (!hasPlusAccess) {
      if (!authLoading) router.push('/paywall?tier=plus')
      return
    }
    if (!ac) return
    try {
      // Just the link -- no title/doc-number prefix repeating what the
      // link's own destination page already shows.
      await Share.share({
        title: `AC ${ac.document_number}`,
        message: buildACShareLink(ac),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const handleToggleBookmark = async () => {
    if (!ac) return
    if (!hasPlusAccess) {
      if (!authLoading) router.push('/paywall?tier=plus')
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

  // Gated synchronously here (not just relying on FolderPicker's own
  // internal backstop) -- same "always show an action" rule as everywhere
  // else a paid feature is gated, so a free-tier tap always at least shows
  // the paywall rather than risking a silent no-op.
  const handleOpenFolderPicker = () => {
    if (!ac) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    setFolderPickerVisible(true)
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
    if (!hasPlusAccess) {
      if (!authLoading) router.push('/paywall?tier=plus')
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
  }, [ac, hasPlusAccess, authLoading])

  // Copy is deliberately NOT gated, unlike highlighting — it only ever
  // copies a block that's already rendered on screen for this reader (Free
  // preview blocks included). Copy/Highlight is a Plus feature as a whole —
  // gated at the long-press entry point below, not per-action, so Copy can't
  // be used as a back door around the Highlight paywall.
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
  // adding new on-screen buttons to every block. The entry point
  // (handleBlockLongPress) is Plus-gated (RC, 2026-08-14: reverted the
  // 2026-08-11 Pro gate -- see gotcha_gating_sweep_2026_08_11.md and
  // migrations_fix_folders_are_plus_not_pro.sql), matching what this comment
  // already argued Copy/Highlight conceptually was; handleSharePassage
  // itself still requires Premium, one tier higher than what got the user
  // into the menu -- confirmed via audit as a real advertised-but-bounced
  // mismatch -- the menu label itself says "(Premium)" for anyone below that
  // tier instead of silently bouncing with no warning.
  const handleSharePassage = useCallback(async (block: ACBlock) => {
    if (!isPremium) { if (!authLoading) router.push('/paywall?tier=premium'); return }
    if (!ac) return
    const text = blockText(block)
    if (!text) return
    try {
      // Just the link, same as every other share entry point -- the
      // recipient jumps straight to (and sees highlighted, per BB-026) the
      // passage once they open it, so quoting it again here was redundant.
      await Share.share({
        title: `AC ${ac.document_number}`,
        message: buildACShareLink(ac, highlightSnippet(text)),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }, [ac, isPremium, authLoading])

  const handleBlockLongPress = useCallback((block: ACBlock, index: number) => {
    const meta = highlightMeta(block)
    if (!meta) return
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    const isHighlighted = highlightedBlockTexts.has(blockText(block))
    confirm({
      title: 'Passage',
      // A picker, not a confirm -- and one that was completely inert on
      // web, which meant Copy/Highlight/Share were untestable there.
      choices: [
        { label: 'Copy Text', onPress: () => handleCopyBlock(block) },
        {
          label: isHighlighted ? 'Remove Highlight' : 'Highlight',
          onPress: () => handleToggleHighlight(block),
        },
        // Reachable by any Plus+ user (the long-press entry point above only
        // checks hasPlusAccess), but handleSharePassage itself requires
        // Premium -- confirmed as a real advertised-but-bounced mismatch: a
        // Plus/Pro user could tap this and land on the paywall with zero
        // warning. Labeling it up front costs nothing and matches how the
        // rest of the app discloses a higher-tier gate before the tap, not
        // after.
        { label: isPremium ? 'Share Passage' : 'Share Passage (Premium)', onPress: () => handleSharePassage(block) },
      ],
    })
  }, [hasPlusAccess, isPremium, highlightedBlockTexts, handleCopyBlock, handleToggleHighlight, handleSharePassage, authLoading])

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

  // Opens in-app via pdf-viewer.tsx's WebView, not an external/system browser
  // sheet -- see that file's header comment for why (BB-005: a Safari View
  // Controller's own native share/copy-link button let the raw, un-gated PDF
  // URL leak to someone who never had the app at all).
  // RC's QA framework (2026-08-06) found AC 8260-32F: status=active, but
  // pdf_url_cached, pdf_url_faa, AND pdf_blocks are all null/empty --
  // confirmed directly on faa.gov: "This document's content is unavailable."
  // Not a scraper miss to re-run; the FAA itself doesn't publish this one
  // (an FAA/USAF interagency order, not a normal public AC). Previously
  // openPDF() fell through to a GUESSED url pattern in this exact case,
  // which 404s (our own scraper tries that same pattern first and already
  // failed to resolve it) -- silently routing to a broken pdf-viewer with no
  // explanation. Detect the truly-no-source state up front instead.
  const hasNoSourceAtAll = !ac?.pdf_url_cached && !ac?.pdf_url_faa && !(ac?.pdf_blocks && ac.pdf_blocks.length > 0)

  const openPDF = async () => {
    if (!hasPlusAccess) {
      if (!authLoading) router.push('/paywall?tier=plus')
      return
    }
    if (hasNoSourceAtAll) {
      confirm({
        title: 'Not available from the FAA',
        message: 'The FAA has not published public content for this document. This is a gap in the source material, not something we can fix by re-checking.',
        cancelLabel: null,
      })
      return
    }
    // pdf_url_cached lives in the private advisory-circulars bucket now --
    // needs a freshly-signed URL to actually be fetchable. pdf_url_faa (and
    // the guessed faa.gov fallback) are the FAA's own public URLs, already
    // directly fetchable, no signing needed or possible.
    const url =
      (await resolveGatedStorageUrl(ac?.pdf_url_cached)) ??
      ac?.pdf_url_faa ??
      `https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_${ac?.document_number}.pdf`
    // Used to window.open() the raw URL on web -- found live: several real
    // source PDFs (govinfo.gov, confirmed via direct fetch) get served in a
    // way that triggers an OS-level file-download prompt instead of opening
    // as a page, not the clean preview-sandbox limitation this branch's old
    // comment assumed. pdf-viewer.tsx already has a correct, safe web
    // fallback (a plain "not available in the browser preview" message, no
    // fetch attempted) -- routing there unconditionally, same as LOI already
    // does, removes the download risk entirely instead of only fixing it for
    // native.
    router.push({ pathname: '/pdf-viewer', params: { url, title: ac ? `AC ${ac.document_number}` : undefined } })
  }

  // RC, annotated iPad screenshot: the overflow menu and bookmark icon
  // circled, both moved to the bottom bar. The overflow menu's own dropdown
  // still lives here (lifted to controlled open/onOpenChange so the bottom
  // bar's action can drive it) -- only its trigger icon and the header
  // bookmark icon actually move.
  const isTabletSplit = isTabletLandscape || isTabletPortrait
  useScreenActions(
    [
      { key: 'overflow', icon: 'ellipsis', onPress: () => setOverflowOpen(true) },
      {
        key: 'bookmark',
        icon: bookmarked ? 'bookmark.fill' : 'bookmark',
        onPress: handleToggleBookmark,
        variant: bookmarked ? 'primary' : 'default',
      },
    ],
    [bookmarked]
  )

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
        hideTrigger={isTabletSplit}
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        position={isTabletSplit ? 'bottom' : 'top'}
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasPlusAccess },
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasPlusAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasPlusAccess },
        ]}
      />
      {!isTabletSplit && (
        <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
          <Icon
            name={bookmarked ? 'bookmark.fill' : 'bookmark'}
            size={fs(21)}
            color={bookmarked ? tokens.blu : tokens.t2}
          />
        </Pressable>
      )}
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={ac?.document_number ?? 'Advisory Circular'}
        onBack={() => router.back()}
        right={headerRight}
      />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}

      {/* Sticky in-AC search — Plus only, only shown when AC has searchable content */}
      {!loading && hasPlusAccess && ac?.pdf_blocks && ac.pdf_blocks.length > 0 && (
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
              <Icon name="magnifyingglass" size={fs(15)} color={tokens.t3} />
              <View style={[styles.acSearchScope, { backgroundColor: tokens.bdim }]}>
                <Text style={[styles.acSearchScopeText, { color: tokens.blu, fontSize: fs(9) }]}>IN DOC</Text>
              </View>
              <TextInput
                style={[
                  styles.acSearchInput,
                  { color: tokens.t1, fontSize: ifs(15) },
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
                  <Icon name="xmark" size={fs(14)} color={tokens.t3} />
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
                        <Icon name="chevron.up" size={fs(18)} color={tokens.t2} />
                      </Pressable>
                      <Pressable hitSlop={14} onPress={goToNext} style={{ padding: 8 }}>
                        <Icon name="chevron.down" size={fs(18)} color={tokens.t2} />
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
      {!loading && offlineCopy && (
        <OfflineCopyBanner downloadedAt={offlineCopy.downloadedAt} stale={offlineStale} />
      )}
      {!loading && ac && changedList.length > 0 && (
        <ChangedBanner
          count={changedList.length}
          currentIdx={changedIdx}
          onPrev={goToPrevChanged}
          onNext={goToNextChanged}
          label={`This AC was updated — ${changedList.length} section${changedList.length === 1 ? '' : 's'} changed${changedLabels.length > 0 ? ` (${changedLabels.join(', ')})` : ''}.`}
        />
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
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={e => setScrollY(e.nativeEvent.contentOffset.y)}
          onLayout={e => setScrollViewportHeight(e.nativeEvent.layout.height)}
          scrollEventThrottle={100}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={() => Keyboard.dismiss()}
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

          {/* Scanned-original disclaimer -- sets expectations for old ACs
              whose source is a scanned paper original with an OCR text layer,
              so garbled words read as an explained limitation of the source
              document rather than a FlyRegs bug. The formula-refs and
              figures sentences are separate conditions (an AC could have
              flagged formulas without being OCR-scanned, in principle) so
              the banner still renders if only some of the three are true --
              but the figures sentence is additionally gated on the AC
              actually being OCR-scanned, since "view the real page instead
              of the extracted text" is only a relevant pointer when that
              extracted text is the unreliable kind. Every OCR-scanned AC
              that also has Figures & Tables entries gets this same second
              sentence, not just the ones that happen to have formula refs
              too -- previously only formula refs got a pointer sentence,
              which is why AC 20-30B's banner looked different/incomplete
              from ACs that had formula refs. */}
          {(isOcrScanned(ac.document_number) || (formulaRefs && formulaRefs.length > 0)) && (
            <View style={[styles.scanBanner, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Icon name="doc.text" size={fs(14)} color={tokens.t3} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                {isOcrScanned(ac.document_number) && (
                  <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
                    * This AC's source is a scanned original — some words in the extracted text may be
                    misread from the scan. The original PDF is the authoritative source.
                  </Text>
                )}
                {isOcrScanned(ac.document_number) && figures && figures.length > 0 && (
                  <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
                    Figures and tables are best viewed as page images in the "Figures & Tables" section
                    below rather than the extracted text.
                  </Text>
                )}
                {formulaRefs && formulaRefs.length > 0 && (
                  <Text style={[styles.scanBannerText, { color: tokens.t2, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
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
              {/* Scraped with whitespace fully flattened (faa_scraper.py's
                  _extract_description, get_text(separator=" ")) -- can run
                  to ~3000 chars with an inline enumerated list and zero
                  paragraph structure. splitIntoDisplayParagraphs decides
                  WHERE to break (real breaks/enum markers) AND soft-wraps
                  any remaining long run of plain sentences, without
                  changing the source text itself. */}
              {splitIntoDisplayParagraphs(ac.description).map((para, i, arr) => (
                <Text
                  key={i}
                  style={[
                    styles.body,
                    { color: tokens.t2, fontSize: fs(16), lineHeight: fs(16) * 1.44 },
                    i < arr.length - 1 && { marginBottom: 12 },
                  ]}
                >
                  {para}
                </Text>
              ))}
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
              <Icon name="doc.text" size={fs(17)} color="#fff" />
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
              disabled={downloadBusy}
            >
              {downloadBusy ? (
                <ActivityIndicator size="small" color={tokens.t2} />
              ) : (
                <Icon
                  name={downloaded ? 'checkmark.circle' : 'arrow.down.circle'}
                  size={fs(17)}
                  color={downloaded ? tokens.grn : tokens.t2}
                />
              )}
              <Text
                style={[
                  styles.downloadBtnText,
                  { color: downloaded ? tokens.grn : tokens.t1, fontSize: fs(14) },
                ]}
              >
                {downloadBusy ? 'Saving…' : downloaded ? 'Saved offline' : 'Download'}
              </Text>
            </Pressable>
          </View>

          <View style={styles.barsWrap}>
            <MagicLinkPod
              bars={[
                { icon: 'megaphone.fill', label: 'Related ACs', items: otherAcRefs },
                { icon: 'book.closed.fill', label: 'FAR references', items: farRefs },
                { icon: 'map.fill', label: 'AIM references', items: aimRefs },
                { icon: 'headset', label: 'P/CG terms', items: pcgRefs },
                { icon: 'wrench.and.screwdriver.fill', label: 'Related ADs', items: adRefs },
                { icon: 'envelope.open.fill', label: 'Related LOIs', items: loiRefs },
                { icon: 'building.columns.fill', label: 'Related 49 CFR', items: cfr49Refs },
              ]}
              currentLabel={`AC ${ac.document_number}`}
              hasProAccess={hasProAccess}
            />
          </View>

          {/* Full text — free readers get the Contents + a proportional preview
              of the beginning, then a gate; Plus gets the complete document. */}
          {ac.pdf_blocks && ac.pdf_blocks.length > 0 ? (
            <View
              style={styles.fullTextSection}
              onLayout={(e) => { fullTextSectionYRef.current = e.nativeEvent.layout.y }}
            >
              <View style={[styles.fullTextDivider, { backgroundColor: tokens.bdr }]} />
              <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>FULL TEXT</Text>
              <ACBody
                ref={acBodyRef}
                blocks={ac.pdf_blocks}
                bodyLimit={hasPlusAccess ? undefined : previewBlockCount(ac.pdf_blocks_total_count ?? ac.pdf_blocks.length)}
                hasProAccess={hasProAccess}
                scrollRef={scrollRef}
                viewportHeight={scrollViewportHeight}
                outerOffsetYRef={fullTextSectionYRef}
                highlightQuery={hasPlusAccess && acSearchDebounced.length >= 2 ? acSearchDebounced : undefined}
                onMatchCount={handleMatchCount}
                activeMatch={matchCount > 0 ? matchIdx : -1}
                changedIndices={ac.changed_block_indices}
                highlightedBlockTexts={hasPlusAccess ? highlightedBlockTexts : undefined}
                onToggleHighlight={handleBlockLongPress}
                figures={hasPlusAccess ? (figures ?? undefined) : undefined}
                onOpenFigure={hasPlusAccess ? setViewerFigure : undefined}
                formulaRefs={hasPlusAccess ? (formulaRefs ?? undefined) : undefined}
                onOpenFormulaRef={hasPlusAccess ? setViewerFormulaRef : undefined}
                currentLabel={`AC ${ac.document_number}`}
              />
              {!hasPlusAccess && (ac.pdf_blocks_total_count ?? ac.pdf_blocks.length) > previewBlockCount(ac.pdf_blocks_total_count ?? ac.pdf_blocks.length) && (
                <Pressable
                  style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                  onPress={() => { if (!authLoading) router.push('/paywall?tier=plus') }}
                >
                  <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
                  <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Continue reading with Plus</Text>
                  <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.48 }]}>
                    You're reading a preview. Unlock Plus for the complete text, with full search and navigation.
                  </Text>
                  <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                    <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
                  </View>
                </Pressable>
              )}
            </View>
          ) : (
            <Text style={[styles.body, { color: tokens.t4, marginTop: 8, textAlign: 'center', fontSize: fs(13), lineHeight: fs(13) * 1.44 }]}>
              {hasNoSourceAtAll
                ? 'The FAA has not published public content for this document.'
                : 'Full text is not available for this AC — use Open PDF above.'}
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
        </TabletContainer>
      )}
      <FigureViewer figure={viewerFigure} figures={figures ?? undefined} onNavigate={setViewerFigure} onClose={() => setViewerFigure(null)} />
      <FormulaRefViewer formulaRef={viewerFormulaRef} onClose={() => setViewerFormulaRef(null)} />
      <FolderPicker
        visible={folderPickerVisible}
        itemType="ac"
        itemId={ac?.id ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={ac ? {
          document_number: ac.document_number,
          title: ac.title,
          date_issued: ac.date_issued,
          office: ac.office,
          subject_series: ac.subject_series,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
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
  const badge = getBadgeStyle(getBadgeKind(ac), tokens)

  if (!isWithinBadgeLifespan(ac.date_issued, badgeDays)) return null

  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: badge.background, borderColor: badge.border },
      ]}
    >
      <Text style={[styles.badgeText, { color: badge.color, fontSize: fs(9.5) }]}>
        {badge.label}
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

  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },

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
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  scanBannerText: { flex: 1 },
  scanBannerSeq: { marginTop: 4, fontWeight: '600' },

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
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.44
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  body: { fontSize: 16 },
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
