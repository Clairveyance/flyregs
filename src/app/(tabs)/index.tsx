import { useEffect, useState, useCallback, useRef, useMemo, type ReactNode } from 'react'
import {
  View,
  Text,
  FlatList,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Keyboard,
  Platform,
  Animated,
  useWindowDimensions,
  Modal,
  KeyboardAvoidingView,
  RefreshControl,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import Reanimated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated'
import { router, useFocusEffect } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { REG_TYPE } from '@/lib/regTypes'
import { rankSearchResults, isPhrasedQuery, extractPhrase, relevanceTier } from '@/lib/searchRank'
import { searchOtherSources, routeForUnifiedResult, type UnifiedResult } from '@/lib/unifiedSearch'
import { expandQuery } from '@/lib/searchSynonyms'
import { collapseDictationDuplicate, normalizeSearchQuery } from '@/lib/dictation'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { getBadgeKind, getBadgeStyle, BadgeKind } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { getDailyReg, dailyRegRoute, dailyRegCitation, type DailyReg } from '@/lib/notifications'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { consumeJustConfirmed } from '@/lib/justConfirmed'
import { consumeFocusSearchRequest, registerHomeSearchFocus } from '@/lib/focusSearchSignal'
import { FigureViewer } from '@/components/FigureViewer'
import { TabletContainer } from '@/components/TabletContainer'
import { SplitPane } from '@/components/SplitPane'
import { useIsTabletLandscape, useIsTabletPortrait } from '@/context/responsive'
import { useScreenActions } from '@/context/screenActions'
import { SmartSearchLabel } from '@/components/SmartSearchLabel'
import type { AcFigure } from '@/types'
import { getRecentSearches, addRecentSearch, removeRecentSearch, clearRecentSearches } from '@/lib/recentSearches'
import { ChipFilterSheet, ChipFilterSection } from '@/components/ChipFilterSheet'
import { stripAdSubjectPrefix } from '@/lib/titleFormat'
import { getFleetSummary, type FleetAircraftSummary } from '@/lib/aircraftSharing'
import { HobbsUpdateBody } from '@/components/HobbsUpdateModal'
import {
  filterDocuments, filterResultCount, routeForFilterResult, searchCitableDocuments,
  getFarPartOptions, getAcSeriesOptions, AUDIENCE_OPTIONS,
  type FilterParams, type FilterResultRow, type FilterableType, type FilterOption, type CitableDoc,
} from '@/lib/filterSearch'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// AC search results now use the exact same two-line row shape as every
// other result type (see dropOtherPrimary/dropTitle below) — one line for
// the full designator, one for the title — instead of a side-by-side
// fixed-width number column that used to force-wrap long numbers
// ("150/5345-13B") across up to three lines. Confirmed live as a direct
// complaint: "the search dropdown looks pretty messy with those long doc
// numbers cluttered over the left side... let's make each search result
// two line high." Matches the "TYPE NUMBER" convention every other result
// type already uses (unifiedSearch.ts's `primary` strings — "FAR 91.107",
// "AIM 4-3-13") instead of leaving ACs as the one differently-laid-out
// exception.
function acResultPrimary(num: string): string {
  return `AC ${num}`
}

const HOME_CACHE_KEY = '@flyregs/home-cache'
// Separate from HOME_CACHE_KEY -- dailyReg refetches on every focus (see its
// own useFocusEffect below), not just cutoff/badgeDays changes like load()'s
// cache. Same reason for existing: show the last-known pick instantly instead
// of the card popping in a beat after the RPC resolves (RC, 2026-08-05: "the
// DR bar always takes a second to load on screen when you go to Home").
const REG_OF_DAY_CACHE_KEY = '@flyregs/home-regofday-cache'
// Same cache-first fix, same reason, applied to the Home header's speedometer
// (Hobbs/tach) icon -- RC: "sometimes the tach icon takes a second to load
// when you return to Home... on Pro/Prem it should just always be there."
const FLEET_SUMMARY_CACHE_KEY = '@flyregs/home-fleetsummary-cache'

// IA redesign (2026-07-28): search now lives entirely on Home -- there is no
// more standalone Search tab/screen to hand off to, so this dropdown IS the
// full results view, not a capped preview. Free tier sees the top
// FREE_RESULT_CAP combined results per query; Plus removes the cap. Search
// itself (instant, stemming, snippets) stays fully free, matching the
// (now-retired) Search tab's same pattern -- see flyregs_decisions.md.
const FREE_RESULT_CAP = 10

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhatsNewAC {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  cancels: string[]
  changed_block_indices: number[] | null
}

// AD/LOI use a real, genuinely-varied FAA-side date (citation_publish_date /
// issued_date), unlike far_sections/aim_paragraphs/pcg_terms's own
// updated_at -- confirmed live those three are a single uniform bulk-scrape
// timestamp shared by every row from the same sync run, not a per-item
// revision signal, so including them here would show an arbitrary slice of
// "everything we last scraped" as if it were "recently changed by the FAA."
// FAR/AIM/PCG need real incremental revision-detection (matching what AC's
// own backfill-blocks.mjs does via content_revisions) before they can join
// this feed honestly -- that's a scraper/pipeline gap, not fixable here.
interface WhatsNewOther {
  id: string
  type: 'ad' | 'loi'
  documentNumber: string
  title: string
  date: string
}

interface SearchResult {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  subject_series: string | null
  description: string | null
  rank?: number
}

// ─── Home Screen ─────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const { tokens, resolved, redShift } = useTheme()
  const { hasPlusAccess, loading: authLoading } = useAuth()
  const fs = useFS()
  const ifs = useInputFS()
  const isTabletLandscape = useIsTabletLandscape()
  const isTabletPortrait = useIsTabletPortrait()
  const [totalCount, setTotalCount] = useState<number | null>(null)
  // Regulatory-body card counts -- redesign step 5 (see
  // PROJECT_NOTES/flyregs_expansion_plan.md, "Home screen — redesigned").
  const [farCount, setFarCount] = useState<number | null>(null)
  const [aimCount, setAimCount] = useState<number | null>(null)
  const [pcgCount, setPcgCount] = useState<number | null>(null)
  const [adCount, setAdCount] = useState<number | null>(null)
  const [loiCount, setLoiCount] = useState<number | null>(null)
  const [dictCount, setDictCount] = useState<number | null>(null)
  const [whatsNew, setWhatsNew] = useState<WhatsNewAC[]>([])
  const [otherWhatsNew, setOtherWhatsNew] = useState<WhatsNewOther[]>([])
  const [dailyReg, setDailyReg] = useState<DailyReg | null>(null)
  const [loading, setLoading] = useState(true)
  const { badgeDays } = useBadgeLifespan()
  // What's New card titles and the Filter sheet's "cites this document" chip
  // can run long and get cut off the same way FAR Part titles do -- one
  // shared hook/card pair for the whole screen, same as far/index.tsx's own
  // long-press preview, threaded down into HomeHeader/WhatsNewCard below.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  // One-time "Welcome to FlyRegs" banner right after a fresh signup
  // confirmation auto-signs someone in (see src/app/confirm.tsx +
  // src/lib/justConfirmed.ts) -- consumed once so it never shows again.
  const [showWelcome, setShowWelcome] = useState(false)
  const welcomeOpacity = useRef(new Animated.Value(0)).current
  // useFocusEffect (not a plain mount-only useEffect) since Home is a tab
  // screen that stays mounted in the background -- a bare useEffect would
  // only ever check once, at initial app launch, before sign-in could have
  // set the flag. This re-checks every time Home actually comes into view.
  useFocusEffect(
    useCallback(() => {
      consumeJustConfirmed().then((justConfirmed) => {
        if (!justConfirmed) return
        setShowWelcome(true)
        Animated.sequence([
          Animated.timing(welcomeOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
          Animated.delay(2600),
          Animated.timing(welcomeOpacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        ]).start(() => setShowWelcome(false))
      })
    }, [])
  )

  // Tab bar's search icon (PersistentTabBar.tsx) needs to focus this
  // input from any screen. Registering the real focus function here lets
  // the tab bar call it directly and synchronously in its own tap
  // handler -- see focusSearchSignal.ts's header comment for why that,
  // not a navigate-then-useFocusEffect chain, is what actually gets the
  // keyboard to appear on web. Home stays mounted as a background tab for
  // the whole session, so this only ever needs to register once.
  useEffect(() => {
    registerHomeSearchFocus(() => searchInputRef.current?.focus())
    return () => registerHomeSearchFocus(null)
  }, [])

  // Defensive fallback only -- covers the split second before the effect
  // above has registered (e.g. Home's very first mount this session).
  useFocusEffect(
    useCallback(() => {
      if (consumeFocusSearchRequest()) {
        requestAnimationFrame(() => searchInputRef.current?.focus())
      }
    }, [])
  )

  // Inline search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  // FAR/AIM/P-CG/T&F results, kept in a separate list from the AC-specific
  // rankSearchResults pipeline above — see unifiedSearch.ts for why this
  // isn't folded into the same tiering logic.
  const [otherResults, setOtherResults] = useState<UnifiedResult[]>([])
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [searchLoading, setSearchLoading] = useState(false)
  // Past typed queries, shown when the search field is focused but empty —
  // distinct from the Recents tab (visited documents, not search terms).
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const [dropdownTop, setDropdownTop] = useState(0)
  // RC, real device: "when the k/b hides the rest of the search result
  // screen should take up the rest of the phone screen. Then, if the k/b is
  // brought back it recondenses." The dropdown/dropScroll styles used a flat
  // maxHeight:340 regardless of keyboard state -- close to right WITH the
  // keyboard up, but left just as much dead space below the results once the
  // keyboard was dismissed as the keyboard itself used to occupy. Tracking
  // real keyboard height here (native only -- there's no keyboard concept on
  // RN-web, so keyboardHeight just stays 0 and the dropdown always gets the
  // "expanded" height there, which is harmless) lets dropdownMaxHeight below
  // grow to fill the freed space when the keyboard hides, and shrink back the
  // moment it returns.
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const { height: windowHeight } = useWindowDimensions()
  // RC: "the swipe to hide k/b on Home when searching is really clunky in
  // front of the drop down results." Root cause: dropdownMaxHeight below
  // was a plain derived number -- correct VALUE, correct TIMING (the
  // keyboardWillShow/Hide "ahead of the animation" trick below already
  // solved when it starts), but the actual height change itself SNAPPED
  // in one React re-render while the keyboard's own dismiss (especially
  // "interactive" mode, which tracks the user's finger in real time) slides
  // smoothly over ~250-300ms -- one part of the screen animating, the other
  // popping, is exactly what reads as "clunky." Captured here so the
  // Reanimated `withTiming` driving dropdownMaxHeight (below) can match the
  // keyboard's own real animation duration instead of guessing one.
  const keyboardAnimDuration = useRef(250)

  useEffect(() => {
    // keyboardWillShow/Hide (iOS-only) fire ahead of the animation, so the
    // dropdown resizes in step with the keyboard instead of visibly lagging
    // a frame behind it; Android has no "will" variants, so it falls back
    // to the "did" events, matching every other keyboard-aware spot in this
    // app.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSub = Keyboard.addListener(showEvent, (e) => {
      keyboardAnimDuration.current = e.duration || 250
      setKeyboardHeight(e.endCoordinates?.height ?? 0)
    })
    const hideSub = Keyboard.addListener(hideEvent, (e) => {
      keyboardAnimDuration.current = e.duration || 250
      setKeyboardHeight(0)
    })
    return () => {
      showSub.remove()
      hideSub.remove()
    }
  }, [])

  // Leaves room for the persistent tab bar + safe-area inset below the
  // dropdown -- same margin the old flat 340 constant was implicitly built
  // around (dropdownTop ~110-150 + keyboard ~300-340 + this ≈ typical iPhone
  // screen height). Floored at 200 so a tiny window (or a keyboard height
  // that briefly reports oddly during its own show/hide animation) never
  // collapses the results to something unusably short.
  const dropdownMaxHeight = Math.max(200, windowHeight - dropdownTop - keyboardHeight - 90)
  // Drives the dropdown/dropScroll height with a real animation instead of
  // the instant snap a plain style value produces -- see the
  // keyboardAnimDuration comment above for why this specific value was
  // clunky. Shared across both the results dropdown and the recent-
  // searches dropdown (they're mutually exclusive, same underlying height).
  const animatedDropdownMaxHeight = useSharedValue(dropdownMaxHeight)
  useEffect(() => {
    animatedDropdownMaxHeight.value = withTiming(dropdownMaxHeight, { duration: keyboardAnimDuration.current })
  }, [dropdownMaxHeight])
  const animatedDropdownStyle = useAnimatedStyle(() => ({ maxHeight: animatedDropdownMaxHeight.value }))
  const searchInputRef = useRef<TextInput>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the most-recent search may write results (guards against a slow earlier
  // query resolving late and clobbering the latest query's ranked results).
  const searchSeq = useRef(0)

  // ── Ad hoc Filter sheet — flyregs_expansion_plan.md's "Filter button, v1
  // scope" (7 dimensions, minus certificate/rating tags -- that dimension
  // needs per-document rating tags that don't exist yet, same open gap the
  // RefPacks redesign has to solve; see PROJECT_NOTES). Separate from the
  // text-search dropdown above -- this is a browse-by-facet view, not a
  // keyword query, and can be used with zero search text typed at all.
  const [filterVisible, setFilterVisible] = useState(false)
  const [filterContentTypes, setFilterContentTypes] = useState<FilterableType[]>([])
  const [filterFarParts, setFilterFarParts] = useState<string[]>([])
  const [filterAcSeries, setFilterAcSeries] = useState<string | null>(null)
  const [filterAudience, setFilterAudience] = useState<string[]>([])
  const [filterCitesDoc, setFilterCitesDoc] = useState<CitableDoc | null>(null)
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterHasFigures, setFilterHasFigures] = useState<boolean | null>(null)
  const [farPartOptions, setFarPartOptions] = useState<FilterOption[]>([])
  const [acSeriesOptions, setAcSeriesOptions] = useState<FilterOption[]>([])
  const [citesQuery, setCitesQuery] = useState('')
  const [citesCandidates, setCitesCandidates] = useState<CitableDoc[]>([])
  const [citesLoading, setCitesLoading] = useState(false)
  const [liveCount, setLiveCount] = useState<number | null>(null)
  const [liveCountLoading, setLiveCountLoading] = useState(false)
  const [filterApplied, setFilterApplied] = useState(false)
  const [filterResults, setFilterResults] = useState<FilterResultRow[]>([])
  const [filterResultsLoading, setFilterResultsLoading] = useState(false)
  const [filterLoadingMore, setFilterLoadingMore] = useState(false)
  // Same stale-response guard as searchSeq above, for the same reason:
  // re-applying a filter (Edit -> Show results) while a loadMoreFilterResults
  // page is still in flight for the PREVIOUS filter would otherwise append
  // that stale page's rows onto the new filter's fresh result list once it
  // resolves -- there's no other signal tying a page fetch to which filter
  // it was for.
  const filterSeq = useRef(0)

  const activeFilterParams = useMemo<FilterParams>(() => ({
    contentTypes: filterContentTypes,
    farParts: filterFarParts,
    acSeries: filterAcSeries,
    audience: filterAudience,
    citesType: filterCitesDoc?.type ?? null,
    citesId: filterCitesDoc?.id ?? null,
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(filterDateFrom) ? filterDateFrom : null,
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(filterDateTo) ? filterDateTo : null,
    hasFigures: filterHasFigures,
  }), [filterContentTypes, filterFarParts, filterAcSeries, filterAudience, filterCitesDoc, filterDateFrom, filterDateTo, filterHasFigures])

  const activeFilterCount = [
    filterContentTypes.length > 0,
    filterFarParts.length > 0,
    !!filterAcSeries,
    filterAudience.length > 0,
    !!filterCitesDoc,
    !!(filterDateFrom || filterDateTo),
    filterHasFigures != null,
  ].filter(Boolean).length

  // Advanced Filter is a Plus-tier tool -- filter_documents() itself has
  // carried a `WHERE public.has_plus_access()` gate since the 2026-08-11
  // gating sweep (sync/migrations_gating_sweep_batch1.sql), whose own
  // comment says so explicitly ("The filter TOOL itself is the Plus-gated
  // capability... blocks the whole function for non-Plus regardless of
  // which content types are requested"). That migration fixed the RPC but
  // never added a matching client-side gate here -- confirmed live,
  // 2026-08-24: a real non-Plus account can still tap the Filter icon,
  // fill in any chip combination, and always gets "0" / "No documents
  // match these filters" with no explanation, because has_plus_access()
  // silently zeroes every row server-side regardless of the filter chips
  // chosen. Indistinguishable from a broken feature to that user -- same
  // entry-point-gate pattern as every other Plus/Pro toggle in this app
  // (e.g. account.tsx's handleToggleDailyWord).
  const openFilter = () => {
    if (!hasPlusAccess) { if (!authLoading) router.push('/paywall?tier=plus'); return }
    if (farPartOptions.length === 0) getFarPartOptions().then(setFarPartOptions).catch(() => {})
    if (acSeriesOptions.length === 0) getAcSeriesOptions().then(setAcSeriesOptions).catch(() => {})
    setFilterVisible(true)
  }

  const toggleFilterType = (t: FilterableType) => {
    setFilterContentTypes((prev) => {
      const next = prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
      // Has Figures section disappears only when the selection is P/CG-only
      // (see its own comment) -- clear its state too so it can't stay
      // silently active with no visible control to turn it back off.
      if (next.length > 0 && next.every((t) => t === 'pcg')) {
        setFilterHasFigures(null)
      }
      // Date Range needs a real per-document date. AC (date_issued), LOI
      // (issued_date) and -- as of 2026-08-05 -- FAR (last_amended, from
      // eCFR's own version index, 4,290 of 4,292 sections) all have one.
      //
      // AIM and P/CG still don't: their date_from/date_to filter against
      // updated_at, which every weekly scraper run stamps to now() on EVERY
      // row regardless of content change, so a historical range returns
      // either everything or nothing. FAR used to be in that same boat --
      // see memory/gotcha_far_aim_pcg_date_filter_broken.md for the whole
      // history, and sync/far_amendment_dates.py for how it got out.
      //
      // Same hide-when-wholly-inapplicable treatment as Has Figures above,
      // rather than leaving a control that can silently lie.
      if (next.length > 0 && next.every((t) => t === 'aim' || t === 'pcg')) {
        setFilterDateFrom(''); setFilterDateTo('')
      }
      return next
    })
  }
  const toggleAudience = (a: string) => {
    setFilterAudience((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]))
  }
  const toggleFarPart = (p: string) => {
    setFilterFarParts((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]))
  }

  const clearFilters = () => {
    setFilterContentTypes([]); setFilterFarParts([]); setFilterAcSeries(null); setFilterAudience([])
    setFilterCitesDoc(null); setCitesQuery(''); setCitesCandidates([])
    setFilterDateFrom(''); setFilterDateTo(''); setFilterHasFigures(null)
  }

  const applyFilters = async () => {
    setFilterVisible(false)
    setFilterApplied(true)
    setFilterResultsLoading(true)
    const seq = ++filterSeq.current
    try {
      const rows = await filterDocuments(activeFilterParams, 50, 0)
      if (seq !== filterSeq.current) return // superseded by a newer apply
      setFilterResults(rows)
    } catch (_) {
      if (seq === filterSeq.current) setFilterResults([])
    }
    if (seq === filterSeq.current) setFilterResultsLoading(false)
  }

  const dismissFilterResults = () => {
    setFilterApplied(false)
    setFilterResults([])
  }

  // Filter results are `ORDER BY item_type, item_id` server-side, and the
  // first page is only ever the first 50 of THAT ordering -- confirmed live,
  // 2026-08-24: filtering FAR+AIM together (no other narrowing) returns
  // total_count 4731, but the unpaginated single fetch below used to return
  // only the first 50 rows, which alphabetical item_type ordering ('aim' <
  // 'far') made 50 AIM rows and ZERO far rows -- FAR, 4,293 of those 4,731
  // matches, was completely unreachable even though the status bar's "50 of
  // 4731" was technically honest about there being more. Any combined-type
  // filter whose alphabetically-earlier type alone has >=50 matches hits
  // this -- not a rare edge case, the everyday 2-content-type case. Fixed
  // with real pagination instead of a one-shot fetch.
  const loadMoreFilterResults = async () => {
    if (filterLoadingMore || filterResultsLoading) return
    const total = filterResults[0]?.totalCount ?? 0
    if (filterResults.length === 0 || filterResults.length >= total) return
    const seq = filterSeq.current
    setFilterLoadingMore(true)
    try {
      const rows = await filterDocuments(activeFilterParams, 50, filterResults.length)
      // Filter re-applied (Edit -> Show results) while this page was still
      // in flight -- its own fresh fetch already replaced filterResults;
      // appending this stale page now would corrupt that new list.
      if (seq === filterSeq.current) setFilterResults((prev) => [...prev, ...rows])
    } catch (_) {
      // Leave what's already on screen as-is; a failed "load more" page
      // shouldn't wipe results the user can already see.
    }
    // Always clear the in-flight flag (not seq-guarded) -- it gates the NEXT
    // loadMoreFilterResults call ever running at all (see the entry guard
    // above), so leaving it stuck true after a superseded fetch would
    // silently disable "load more" for the new filter too.
    setFilterLoadingMore(false)
  }

  // Live "N results" readout while the sheet is open -- debounced so rapid
  // chip taps don't fire a query per tap.
  useEffect(() => {
    if (!filterVisible) return
    setLiveCountLoading(true)
    const t = setTimeout(() => {
      filterResultCount(activeFilterParams).then(setLiveCount).catch(() => setLiveCount(null)).finally(() => setLiveCountLoading(false))
    }, 300)
    return () => clearTimeout(t)
  }, [filterVisible, activeFilterParams])

  useEffect(() => {
    if (citesQuery.trim().length < 2) { setCitesCandidates([]); setCitesLoading(false); return }
    setCitesLoading(true)
    const t = setTimeout(() => {
      searchCitableDocuments(citesQuery)
        .then(setCitesCandidates)
        .catch(() => setCitesCandidates([]))
        .finally(() => setCitesLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [citesQuery])

  const load = useCallback(async () => {
    // Carries the last known-good count across both the cache-read and
    // fresh-fetch blocks below -- see this function's own cache-write
    // comment near the bottom for why this exists.
    let lastGoodCount: number | null = null

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(HOME_CACHE_KEY)
      if (cached) {
        const { totalCount: ct, whatsNew: cw, otherWhatsNew: cow } = JSON.parse(cached)
        if (ct != null) { setTotalCount(ct); lastGoodCount = ct }
        if (cw?.length) setWhatsNew(cw as WhatsNewAC[])
        if (cow?.length) setOtherWhatsNew(cow as WhatsNewOther[])
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data in the background (or blocking if no cache)
    try {
      // Same rolling clock as the NEW/UPD badges (Drawer > Badge Duration) —
      // this isn't a separately-fixed 90-day feed alongside an adjustable
      // badge display; 90 is just the long-limit default, shortened by the
      // same setting that controls badge visibility everywhere else. `load`
      // is recreated whenever `badgeDays` changes (see its dependency array
      // below), which re-triggers the `useEffect(() => { load() }, [load])`
      // effect further down — so this refetches immediately when the Drawer's
      // live badgeDays context value changes, not just on next screen focus.
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - badgeDays)
      const cutoff = cutoffDate.toISOString().split('T')[0]

      const [countRes, whatsNewRes, adNewRes, loiNewRes] = await Promise.all([
        supabase
          .from('advisory_circulars')
          // 'id' not '*' -- a head:true count request still has to touch
          // every matching row's data to compute an exact count, and this
          // table's pdf_text column is large enough that count(*) over the
          // full row shape was intermittently timing out as a genuine 500
          // (confirmed live: reproducible via plain fetch() with
          // select=*+Prefer:count=exact, gone with select=id). Same root
          // cause as this codebase's established "large pdf_text pulls
          // need small limits" pattern, just hitting count queries instead
          // of paginated selects.
          .select('id', { count: 'exact', head: true })
          .eq('status', 'active'),
        // advisory_circulars_gated, not the raw table -- `authenticated` has
        // no column-level SELECT grant on changed_block_indices, so this
        // query 403'd every time (whatsNew.ts's getWhatsNewItems has the
        // identical query and the full repro/fix writeup; this is Home's own
        // inline copy of the same shape). Found live, 2026-08-23 QA sweep.
        supabase
          .from('advisory_circulars_gated')
          .select('id, document_number, title, date_issued, cancels, changed_block_indices')
          .eq('status', 'active')
          .gte('date_issued', cutoff)
          .order('date_issued', { ascending: false })
          .limit(20),
        // AD/LOI have a real, genuinely-varied FAA-side date -- see
        // WhatsNewOther's own comment for why FAR/AIM/PCG can't join yet.
        supabase
          .from('airworthiness_directives')
          .select('id, ad_number, subject_heading, citation_publish_date')
          .gte('citation_publish_date', cutoff)
          .order('citation_publish_date', { ascending: false })
          .limit(10),
        supabase
          .from('legal_interpretations')
          .select('slug, title, issued_date')
          .gte('issued_date', cutoff)
          .order('issued_date', { ascending: false })
          .limit(10),
      ])

      const freshCount = countRes.count
      const freshWhatsNew = (whatsNewRes.data ?? []) as WhatsNewAC[]
      const freshOther: WhatsNewOther[] = [
        ...((adNewRes.data ?? []) as { id: string; ad_number: string; subject_heading: string; citation_publish_date: string }[])
          .map((r) => ({ id: r.id, type: 'ad' as const, documentNumber: r.ad_number, title: r.subject_heading, date: r.citation_publish_date })),
        ...((loiNewRes.data ?? []) as { slug: string; title: string; issued_date: string }[])
          .map((r) => ({ id: r.slug, type: 'loi' as const, documentNumber: r.title.replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' '), title: r.title.replace(/_/g, ' '), date: r.issued_date })),
      ]

      if (freshCount !== null) setTotalCount(freshCount)
      setWhatsNew(freshWhatsNew)
      setOtherWhatsNew(freshOther)

      // Cache for next launch — fire-and-forget. Was `totalCount: freshCount`
      // unconditionally -- on a transient failure (network blip, or the kind
      // of stale-JWT auth-state transition today's Face ID entitlement-race
      // fix, c052a50, targets) countRes.count comes back null, and this used
      // to overwrite a perfectly good previously-cached count with null,
      // permanently (until the next successful fetch) blanking the Home
      // card's AC count on every subsequent cold launch that read this
      // corrupted cache -- part of the same "ACs look gone" class of report
      // as series/[prefix].tsx and ac/library.tsx's own loadError fix.
      // freshCount ?? lastGoodCount preserves whatever was already known
      // good instead of clobbering it with a failed fetch's null.
      AsyncStorage.setItem(HOME_CACHE_KEY, JSON.stringify({
        totalCount: freshCount ?? lastGoodCount,
        whatsNew: freshWhatsNew,
        otherWhatsNew: freshOther,
      }))
    } catch (_) {
      // Network failed — cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [badgeDays])

  // useFocusEffect, not a plain mount-only useEffect -- found in the
  // 2026-08-29 "built but inert" sweep: Home stays mounted in the
  // background (expo-router's <Tabs> keeps every tab screen alive), so a
  // mount-only fetch left the What's New strip and the AC "active" count
  // showing whatever was true at last mount or last Badge Duration change
  // -- new content published while the app sat backgrounded never
  // appeared until a manual pull-to-refresh or a full relaunch. Every
  // sibling fetch in this exact file (the Welcome banner, DailyReg just
  // below, HobbsHeaderButton's fleet status) already got this fix; load()
  // itself never did.
  useFocusEffect(useCallback(() => { load() }, [load]))

  // Independent of `load()` above -- today's pick doesn't depend on
  // badgeDays/cutoff logic. useFocusEffect (not a plain mount-only
  // useEffect) for the same reason as the welcome banner above: Home stays
  // mounted in the background, so a mount-only fetch would show the same
  // pick forever once the app crosses midnight without a full relaunch.
  // The RPC is cheap and keyed off CURRENT_DATE server-side, so refetching
  // on every focus is safe -- same-day refocuses just get the same row back.
  useFocusEffect(
    useCallback(() => {
      AsyncStorage.getItem(REG_OF_DAY_CACHE_KEY)
        .then((cached) => { if (cached) setDailyReg(JSON.parse(cached)) })
        .catch(() => {})
      getDailyReg().then((fresh) => {
        setDailyReg(fresh)
        AsyncStorage.setItem(REG_OF_DAY_CACHE_KEY, JSON.stringify(fresh)).catch(() => {})
      }).catch(() => {})
    }, [])
  )

  // Regulatory-body card counts -- not tied to badgeDays like load() above.
  // head:true avoids PostgREST's project-wide 1000-row max-rows cap
  // entirely (no rows are actually returned, just a count) -- see
  // far/index.tsx's comment for the full diagnosis of that cap biting a
  // naive select(). useFocusEffect, not a mount-only effect -- same 2026-
  // 08-29 sweep finding as load() above: this had no refresh path at all,
  // not even the manual pull-to-refresh (its RefreshControl only re-runs
  // load()). Cheap head-count queries, safe to re-run on every focus.
  useFocusEffect(useCallback(() => {
    Promise.all([
      supabase.from('far_sections').select('id', { count: 'exact', head: true }),
      supabase.from('aim_paragraphs').select('id', { count: 'exact', head: true }),
      supabase.from('pcg_terms').select('id', { count: 'exact', head: true }),
      supabase.from('airworthiness_directives').select('id', { count: 'exact', head: true }),
      supabase.from('legal_interpretations').select('id', { count: 'exact', head: true }),
      supabase.from('dictionary_terms').select('id', { count: 'exact', head: true }),
    ]).then(([farRes, aimRes, pcgRes, adRes, loiRes, dictRes]) => {
      setFarCount(farRes.count)
      setAimCount(aimRes.count)
      setPcgCount(pcgRes.count)
      setAdCount(adRes.count)
      setLoiCount(loiRes.count)
      setDictCount(dictRes.count)
    })
  }, []))

  // ── Search logic ─────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q: string) => {
    const trimmed = normalizeSearchQuery(q.trim())
    if (trimmed.length < 2) { searchSeq.current++; setSearchResults([]); setOtherResults([]); setSearchLoading(false); return }
    const seq = ++searchSeq.current
    // Recorded as soon as a real search fires (not gated on results coming
    // back non-empty) — a query the user typed is worth re-offering later
    // even if it happened to return nothing that one time.
    addRecentSearch(trimmed).then(setRecentSearches)
    // Anonymous, fire-and-forget usage log (RC: "log all search topics...
    // stay flexible as search patterns create diff priorities") — never
    // awaited, never blocks the search critical path that was just fixed
    // for latency. See sync/migrations_search_usage_logging.sql.
    supabase.from('search_query_log').insert({ query_text: trimmed }).then(() => {})

    // Fired independently of the AC-specific branches below (phrase vs.
    // plain search) — FAR/AIM/P-CG/T&F don't need phrase-search handling
    // for v1, so this runs the same way regardless of query shape. Same
    // race guard (seq) as every other source here.
    //
    // Scoped to the Filter sheet's own content-type selection -- was
    // unconditional before, confirmed live as a real bug ("filter for AIM,
    // then start a search, it still gives you corpus wide results").
    // FilterableType includes 'ac'/'loi', neither of which searchOtherSources
    // covers, so only pass through the subset it actually understands.
    // undefined (no filter active) is NOT the same as [] (filter active but
    // resolves to none of far/aim/pcg, e.g. "AC only") -- see
    // searchOtherSources' own comment for why collapsing those two was the
    // bug in this fix's first draft.
    const otherTypes: ('far' | 'aim' | 'pcg')[] | undefined =
      filterContentTypes.length === 0
        ? undefined
        : filterContentTypes.filter((t): t is 'far' | 'aim' | 'pcg' => t === 'far' || t === 'aim' || t === 'pcg')
    const phraseForOther = isPhrasedQuery(trimmed) ? extractPhrase(trimmed) : trimmed
    // "Smart Search": expand the query into related regulatory vocabulary
    // (bridge -> corpus associations -> morphology; see searchSynonyms.ts)
    // and search every expansion alongside the literal query. One await, and
    // the result is reused by the AC branch below so expansion happens once
    // per search, not twice.
    const expansion = phraseForOther && phraseForOther.length >= 2
      ? await expandQuery(phraseForOther)
      : { terms: [] as string[], expanded: false }
    const synonymTerms = expansion.terms
    if (phraseForOther && phraseForOther.length >= 2) {
      const searchTerms = [phraseForOther, ...synonymTerms]
      Promise.all(searchTerms.map((t) => searchOtherSources(t, 20, otherTypes, hasPlusAccess, hasPlusAccess))).then((resultSets) => {
        if (seq !== searchSeq.current) return
        const seen = new Set<string>()
        const merged: UnifiedResult[] = []
        resultSets.forEach((set, i) => {
          for (const r of set) {
            const key = `${r.type}-${r.id}`
            // Remember WHICH term found this. The merge is a concatenation
            // (literal query's results, then each expansion's), so without
            // this a bridge-found answer sat behind every weak literal match
            // -- "flying drunk" put § 91.17 at #26.
            if (!seen.has(key)) { seen.add(key); merged.push({ ...r, matchedTerm: searchTerms[i] }) }
          }
        })
        setOtherResults(merged)
      })
    } else {
      setOtherResults([])
    }

    // AC-specific search below (phrase + plain branches) is skipped
    // entirely when a content-type filter is active and doesn't include
    // 'ac' -- same fix as above, just for the AC-only path.
    const skipAC = filterContentTypes.length > 0 && !filterContentTypes.includes('ac')
    if (skipAC) { setSearchResults([]); setSearchLoading(false); return }

    // ── Phrase search: user wrapped query in "double quotes" ─────────────────
    if (isPhrasedQuery(trimmed)) {
      const phrase = extractPhrase(trimmed)
      if (!phrase || phrase.length < 2) {
        setSearchResults([]); setSearchLoading(false); return
      }
      const cols = 'id, document_number, title, date_issued, subject_series, description'
      const [titleRes, descRes, rpcRes] = await Promise.all([
        supabase.from('advisory_circulars').select(cols).eq('status', 'active')
          .ilike('title', `%${phrase}%`).order('document_number').limit(30),
        supabase.from('advisory_circulars').select(cols).eq('status', 'active')
          .ilike('description', `%${phrase}%`).order('document_number').limit(20),
        supabase.rpc('search_acs', { query: phrase, result_limit: 40 }),
      ])
      if (seq !== searchSeq.current) return
      const seenIds = new Set<string>()
      const merged: SearchResult[] = []
      for (const src of [titleRes.data, descRes.data, rpcRes.data]) {
        for (const r of (src ?? []) as SearchResult[]) {
          if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r) }
        }
      }
      setSearchResults(rankSearchResults(phrase, merged))
      setSearchLoading(false)
      return
    }

    const cols = 'id, document_number, title, date_issued, subject_series, description'
    // Parallel sources: full-text RPC, a PREFIX doc-number match, a CONTAINS
    // doc-number match, and a CONTAINS title match. The prefix query is essential
    // — a plain contains ordered alphabetically truncates real matches ("20-1"
    // returns a page of "120-1xx" before any "20-1xx"). The title query guarantees
    // an exact/partial title match is fetched even when the RPC tokenises it poorly
    // (e.g. a title with a colon returns nothing). rankSearchResults orders all of
    // it so any exact match — number OR title — lands first.
    // Reuses the single expansion computed above rather than expanding again.
    const acSynonymTerms = synonymTerms
    const [rpcRes, prefixRes, numRes, titleRes, ...synonymRpcResList] = await Promise.all([
      supabase.rpc('search_acs', { query: trimmed, result_limit: 50 }),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('document_number', `${trimmed}%`).order('document_number').limit(20),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('document_number', `%${trimmed}%`).order('document_number').limit(20),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('title', `%${trimmed}%`).order('document_number').limit(20),
      ...acSynonymTerms.map((t) => supabase.rpc('search_acs', { query: t, result_limit: 20 })),
    ])

    // RPC failed + nothing from the direct queries → broad ilike fallback
    const noDirect =
      (!prefixRes.data || prefixRes.data.length === 0) &&
      (!numRes.data || numRes.data.length === 0) &&
      (!titleRes.data || titleRes.data.length === 0)
    if (rpcRes.error && noDirect) {
      const { data } = await supabase
        .from('advisory_circulars')
        .select('id, document_number, title, date_issued, subject_series, description')
        .eq('status', 'active')
        .or(`document_number.ilike.%${trimmed}%,title.ilike.%${trimmed}%,description.ilike.%${trimmed}%`)
        .order('document_number')
        .limit(50)
      if (seq !== searchSeq.current) return // superseded by a newer search
      setSearchResults(rankSearchResults(trimmed, (data ?? []) as SearchResult[]))
      setSearchLoading(false)
      return
    }

    const seenIds = new Set<string>()
    const merged: SearchResult[] = []
    // RPC first within its tier (relevance-ranked), then the direct doc/title
    // queries; rankSearchResults re-tiers so exact matches still win regardless.
    // Synonym RPC results go last -- they're a bonus expansion, not the
    // user's literal query, so an exact match on the real query always wins.
    for (const src of [prefixRes.data, numRes.data, rpcRes.data, titleRes.data, ...synonymRpcResList.map((r) => r.data)]) {
      for (const r of (src ?? []) as SearchResult[]) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r) }
      }
    }

    if (seq !== searchSeq.current) return // a newer search started while awaiting
    setSearchResults(rankSearchResults(trimmed, merged))
    setSearchLoading(false)
    // filterContentTypes: this callback reads it (skipAC/otherTypes above) --
    // an empty dep array here was a real stale-closure bug, confirmed live:
    // it froze the closure at mount (filterContentTypes = []), so selecting
    // AIM in the Filter sheet and then searching still ran the unscoped
    // AC-specific queries below, because `skipAC` always saw the ORIGINAL
    // empty selection no matter what was actually selected afterward.
  }, [filterContentTypes, hasPlusAccess])

  // Controlled input — the collapse check runs before every setState, so a
  // dictation duplicate never reaches state at all, and standard React
  // reconciliation (not an imperative ref call) is what keeps the visible
  // field in sync. No key-remounts, no `.clear()`/`setNativeProps` calls
  // anywhere in this screen — those imperative TextInput APIs turned out to
  // be unreliable for correcting displayed text and were the likely reason
  // duplication kept surviving two previous fix attempts.
  const handleQueryChange = useCallback((raw: string) => {
    const text = collapseDictationDuplicate(raw)
    setSearchQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (text.trim().length >= 2) {
      setSearchLoading(true)
      debounceRef.current = setTimeout(() => runSearch(text), 280)
    } else {
      setSearchResults([])
      setSearchLoading(false)
    }
  }, [runSearch])

  // Full reset — only for an explicit "Cancel" tap, which really means
  // "discard this search."
  const dismissSearch = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchActive(false)
    setSearchQuery('')
    setSearchResults([])
    setOtherResults([])
    setSearchLoading(false)
    Keyboard.dismiss()
  }, [])

  const selectResult = useCallback((r: SearchResult) => {
    const id = r.id
    // Fire-and-forget: which doc a search actually led to opening is the
    // real usage-popularity signal, not just the query text alone (a query
    // can surface many results -- the click says which one mattered). See
    // sync/migrations_search_usage_logging.sql.
    supabase.from('search_click_log').insert({
      doc_type: 'ac', doc_id: r.document_number, query_text: searchQuery,
    }).then(() => {})
    dismissSearch()
    router.push(`/ac/${id}`)
  }, [dismissSearch, searchQuery])

  // Tapping a past query re-populates the field and re-runs it immediately
  // — no debounce wait, since the user is choosing a value they've already
  // confirmed they want, not actively typing.
  const selectRecentSearch = useCallback((q: string) => {
    setSearchQuery(q)
    runSearch(q)
  }, [runSearch])

  const removeOneRecentSearch = useCallback((q: string) => {
    removeRecentSearch(q).then(setRecentSearches)
  }, [])

  const clearAllRecentSearches = useCallback(() => {
    clearRecentSearches().then(() => setRecentSearches([]))
  }, [])

  const selectOtherResult = useCallback((r: UnifiedResult) => {
    // Same click-through log as selectResult above, covering the FAR/AIM/
    // P-CG/CFR49/figure/dictionary results path.
    supabase.from('search_click_log').insert({
      doc_type: r.type, doc_id: r.id, query_text: searchQuery,
    }).then(() => {})
    dismissSearch()
    // Figure/table results open the image directly instead of navigating
    // to the parent AC/AIM paragraph first — confirmed live as an unwanted
    // extra tap ("it takes me to an AC and then i have to tap the T&F bar
    // and click it"). AcFigure.page has no meaning for a search-opened
    // figure (there's no viewer pagination here, just one image — see
    // FigureViewer.tsx, `page` isn't even read), so 0 is a safe placeholder,
    // same convention already used for AIM figures elsewhere.
    if (r.figure) {
      setViewerFigure({
        id: r.figure.id,
        label: r.figure.label ?? '',
        caption: r.figure.caption,
        page: 0,
        image_url: r.figure.image_url,
      })
      return
    }
    // expo-router's typed routes only accept known literal path shapes —
    // routeForUnifiedResult returns a plain dynamic string across 5 possible
    // route prefixes, which doesn't match any single literal type. `as any`
    // is the deliberate escape hatch here (see searchInput's outlineStyle
    // comment above for the same pattern/reasoning), not an accident.
    router.push(routeForUnifiedResult(r) as any)
  }, [dismissSearch, searchQuery])

  // IA redesign: there's no more standalone Search tab to hand off to, so
  // this just dismisses the keyboard — results already stay on screen
  // (showDropdown is tied to having a query, not focus).
  const submitSearch = useCallback(() => {
    Keyboard.dismiss()
  }, [])

  // One relevance-ordered list across every content type. This used to
  // concatenate ALL AC hits ahead of ALL other hits, which the user read as
  // results "segregated by reg" -- an AC matched only in its body text
  // outranked an exact FAR section-number match purely because of which
  // pipeline produced it. Both sides are now scored on the SAME tier scale
  // (see relevanceTier), then interleaved.
  //
  // Within a tier, items are ordered by their position in their own source's
  // ranking, so the best AC and the best FAR of equal tier land adjacent
  // rather than in two blocks. The free-tier cap still applies to this
  // combined total, not per-source — see flyregs_decisions.md.
  const combinedResults = useMemo(() => {
    const q = normalizeSearchQuery(searchQuery.trim())
    const eff = isPhrasedQuery(q) ? extractPhrase(q) : q
    if (!eff) return []

    type Row = { key: string; ac: SearchResult | null; other: UnifiedResult | null; tier: number; ord: number }
    const rows: Row[] = []
    const perTierCount = new Map<number, number>()
    const nextOrd = (tier: number) => {
      const n = perTierCount.get(tier) ?? 0
      perTierCount.set(tier, n + 1)
      return n
    }

    // Interleave by walking both sources together so neither monopolises a
    // tier's leading positions.
    const acScored = searchResults.map((r) => ({
      r, ...relevanceTier(eff, r.document_number, r.title),
    }))
    const otherScoredRaw = otherResults.map((r) => {
      // `id` (not `primary`) is the bare identifier -- `primary` carries a
      // type prefix ("FAR 91.107") that would never equal a user's query.
      // Score against the term that actually FOUND it as well as the raw
      // query, and keep the better (lower) tier. A hit via the expansion
      // "alcohol" is a tier-3 title match for that term even though it
      // shares no word with "flying drunk".
      const direct = relevanceTier(eff, r.id, r.secondary)
      // An expansion is a WEAKER signal than what the user actually typed,
      // so it only rescues a result the literal query couldn't place at all
      // (tier 5 = no title match). Letting it win whenever it scored better
      // measured worse: spoken questions fell from 5/6 to 2/6, because a
      // loosely-related expansion term title-matched itself into tier 3 and
      // outranked the section that actually answered the question.
      // Rescue applies from tier 4 down (a weak partial title match), not
      // just tier 5. "vfr mins" title-matches § 91.155 on one word ("vfr")
      // -> tier 4, which left it at #6; via the bridge term "vfr weather
      // minimums" it is a full tier-3 title match. Still capped at tier 3 so
      // an expansion can never manufacture an exact/number match.
      const viaTermRaw = direct.tier >= 4 && r.matchedTerm && r.matchedTerm !== eff
        ? relevanceTier(r.matchedTerm, r.id, r.secondary)
        : null
      // relevanceTier's tier 0-2 mean "the identifier itself equals/starts-
      // with/contains the query" -- built for a user PARTIAL-TYPING a real
      // document number ("91.1" -> 91.107). P/CG and A/D `id` is a
      // snake_case SLUG of the term name, not a number anyone types --
      // "visual" is trivially a substring of VISUAL_CLIMB_OVER_AIRPORT_VCOA's
      // own slug, so a one-word expansion term was hitting tier 1/2 via the
      // SLUG itself, bypassing the tier-3 flood cap below entirely (worse
      // than the case that guard was built for -- these landed ABOVE every
      // title-match tier, not at tier 3). An expansion the user never typed
      // can never legitimately claim "this IS the document you numbered" --
      // floor it at tier 3 regardless of doc type, so the flood check next
      // can see and demote it like any other over-broad rescue.
      const viaTerm = viaTermRaw && viaTermRaw.tier < 3 ? { ...viaTermRaw, tier: 3 } : viaTermRaw
      const scored = viaTerm && viaTerm.tier <= 3 && viaTerm.tier < direct.tier ? viaTerm : direct
      // A concept anchor means the DB matched the QUESTION to the document
      // that answers it, which outranks any lexical tier. Without this,
      // "VFR cloud clearance requirements" put § 91.155 second behind
      // AC 61-98E ("Currency REQUIREMENTS...") -- both landed in tier 4 on
      // one title word each, and the tie broke on array position, throwing
      // away the relevance the search RPC had just computed.
      // `viaBridge`: true when this result's tier came from an expansion
      // term rather than the user's own query -- used below both to demote
      // flooded expansion terms and to sort a direct (if weaker) match
      // ahead of expansion noise sharing the same numeric tier.
      return { r, ...scored, tier: r.anchored ? 0 : scored.tier, viaBridge: scored === viaTerm }
    })

    // A generic expansion word (bridge output like "vfr"->"visual" or
    // "night"->"lighting", or a corpus association like "vfr"->"weather")
    // title-matches EVERY document that merely CONTAINS that one word --
    // "visual" alone hits VISUAL APPROACH, VISUAL CLIMB OVER AIRPORT, VISUAL
    // LINE OF SIGHT, DEFENSE VISUAL FLIGHT RULES..., each independently
    // earning the same tier-3 "full title match" trust as a genuinely
    // specific rescue like "vfr weather minimums" -> § 91.155 (one match,
    // clearly meaningful). RC, real device: "can I fly VFR at night" buried
    // FAR 91.209/61.57(b) under a wall of unrelated glossary terms that
    // have nothing to do with night flying. The discriminator isn't word
    // count -- a precise single-word bridge that only matches one or two
    // documents is a real signal and should keep its tier -- it's whether
    // this SPECIFIC expansion term is flooding THIS SPECIFIC search with
    // many same-tier hits, which is what actually means "too generic to
    // trust." Counted per matchedTerm, not guessed at from word count alone.
    const tier3RescueCounts = new Map<string, number>()
    for (const x of otherScoredRaw) {
      if (x.viaBridge && x.tier === 3 && x.r.matchedTerm) {
        tier3RescueCounts.set(x.r.matchedTerm, (tier3RescueCounts.get(x.r.matchedTerm) ?? 0) + 1)
      }
    }
    const FLOOD_THRESHOLD = 3
    const otherScored = otherScoredRaw.map((x) => {
      if (x.viaBridge && x.tier === 3 && x.r.matchedTerm && (tier3RescueCounts.get(x.r.matchedTerm) ?? 0) > FLOOD_THRESHOLD) {
        // Pushed below every other real signal (anchor/exact/title/body),
        // not just down one tier -- a document that only surfaced because
        // it happens to contain a generic word many OTHER documents also
        // contain is genuinely the weakest kind of match here, weaker even
        // than a body-only hit on what the user actually typed.
        return { ...x, tier: 6 }
      }
      return x
    })

    for (let tier = 0; tier <= 6; tier++) {
      const a = acScored.filter((x) => x.tier === tier)
      // RC: "the majority of AFR query material will come from FAR, AIM,
      // P/CG, ACs. The ADs and LOIs do need to be included... but hardly
      // the priority result in most cases." A stable sort (guaranteed
      // order-preserving for equal keys since ES2019) pushes AD entries to
      // the back of THIS tier's other-source bucket without touching
      // relative order among everything else, or disturbing which tier any
      // result lands in -- the tier computation above (anchors, viaTerm
      // rescue, etc.) is untouched.
      // Primary key added here: a DIRECT match (found via the user's own
      // query) sorts ahead of a viaBridge one sharing the same numeric
      // tier -- without this, a handful of genuinely relevant direct
      // matches at tier 4 could still be scattered/outnumbered among a
      // dozen same-tier expansion-flood P/CG hits (see the single-word
      // rescue cap above), since a shared tier alone doesn't say which
      // result actually answers the query the user typed.
      const b = otherScored.filter((x) => x.tier === tier)
        .sort((x, y) => (x.viaBridge ? 1 : 0) - (y.viaBridge ? 1 : 0) || (x.r.type === 'ad' ? 1 : 0) - (y.r.type === 'ad' ? 1 : 0))
      const max = Math.max(a.length, b.length)
      for (let i = 0; i < max; i++) {
        if (i < a.length) rows.push({ key: `ac-${a[i].r.id}`, ac: a[i].r, other: null, tier, ord: nextOrd(tier) })
        if (i < b.length) rows.push({ key: `${b[i].r.type}-${b[i].r.id}-${i}`, ac: null, other: b[i].r, tier, ord: nextOrd(tier) })
      }
    }
    return rows
  }, [searchResults, otherResults, searchQuery])

  const onSearchZoneLayout = useCallback(
    (e: { nativeEvent: { layout: { y: number; height: number } } }) => {
      const { y, height } = e.nativeEvent.layout
      setDropdownTop(y + height + 2)
    },
    [],
  )

  // Independent of focus/keyboard state on purpose — dismissing the keyboard
  // (tapping elsewhere, or the mic button) must never hide results the user
  // already has on screen. Only picking a result or hitting Cancel clears
  // searchQuery, which is what actually closes the dropdown.
  const showDropdown = searchQuery.trim().length >= 2
  const showCancel = searchActive || searchQuery.length > 0
  // The OTHER dropdown state — focused but nothing typed yet. Mutually
  // exclusive with showDropdown by construction (that one requires 2+
  // chars), so only one of the two ever renders at a time.
  const showRecentSearches = searchActive && searchQuery.trim().length === 0 && recentSearches.length > 0

  // RC, iPad screenshot: Cancel (search-active) and the filter icon
  // circled, moved to the bottom bar. Mutually exclusive with each other,
  // same as the header buttons they replace on tablet -- see
  // screenActions.tsx.
  useScreenActions(
    showCancel
      ? [{ key: 'cancel', label: 'Cancel', onPress: dismissSearch }]
      : [{ key: 'filter', icon: 'slider.horizontal.3', onPress: openFilter }],
    [showCancel]
  )

  const regTypes = [
    { key: 'far', label: 'Federal Aviation Regulations', abbr: 'FAR', count: farCount, unit: 'sections', route: '/far' },
    { key: 'aim', label: 'Aeronautical Information Manual', abbr: 'AIM', count: aimCount, unit: 'paragraphs', route: '/aim' },
    { key: 'ac', label: 'Advisory Circulars', abbr: 'AC', count: totalCount, unit: 'active', route: '/ac/library' },
    { key: 'pcg', label: 'Pilot/Controller Glossary', abbr: 'P/CG', count: pcgCount, unit: 'terms', route: '/pcg' },
    { key: 'ad', label: 'Airworthiness Directives', abbr: 'AD', count: adCount, unit: 'directives', route: '/ad' },
    { key: 'loi', label: 'Legal Interpretations', abbr: 'LOI', count: loiCount, unit: 'interpretations', route: '/loi' },
    { key: 'dictionary', label: 'Aviation Dictionary', abbr: 'A/D', count: dictCount, unit: 'terms', route: '/dictionary' },
  ]

  // iPad (either orientation): "Browse by Regulation" becomes its own rail
  // instead of a stretched-phone single column -- RC, real device: "home
  // screen lost it's duality and reverted back to a blown up phone
  // layout." Same SplitPane/RegBodyCard pieces the list below already
  // uses, just split into two panes instead of one stacked column.
  const homeRail = (
    <FlatList
      data={regTypes}
      keyExtractor={(item) => item.key}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={
        <View style={styles.sectionLabel}>
          <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(16.5) }]}>Browse by Regulation</Text>
        </View>
      }
      renderItem={({ item }) => <RegBodyCard item={item} tokens={tokens} />}
    />
  )
  const homeDetail = (
    <ScrollView contentContainerStyle={styles.listContent} keyboardDismissMode="interactive">
      <HomeHeader
        tokens={tokens}
        whatsNew={whatsNew}
        otherWhatsNew={otherWhatsNew}
        badgeDays={badgeDays}
        hasPlusAccess={hasPlusAccess}
        dailyReg={dailyReg}
        showBrowseLabel={false}
        isTablet
        showPreview={showPreview}
        hidePreview={hidePreview}
        consumeLongPress={consumeLongPress}
      />
    </ScrollView>
  )

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader showWordmark right={<HobbsHeaderButton />} />
      <TabletContainer disabled={isTabletLandscape || isTabletPortrait}>

      {showWelcome && (
        <Animated.View
          pointerEvents="none"
          style={[styles.welcomeToast, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, opacity: welcomeOpacity }]}
        >
          <Icon name="checkmark.circle.fill" size={fs(18)} color={tokens.grn} />
          <Text style={[styles.welcomeToastText, { color: tokens.t1, fontSize: fs(14.5) }]}>Welcome to FlyRegs!</Text>
        </Animated.View>
      )}

      {/* Fixed search zone — sits above the list, never scrolls away */}
      <View style={styles.searchZone} onLayout={onSearchZoneLayout}>
        <View
          style={[
            styles.searchBar,
            {
              backgroundColor: tokens.inp,
              borderColor: searchActive ? tokens.blu : tokens.bdr,
              flex: 1,
            },
          ]}
        >
          <Icon name="magnifyingglass" size={fs(17)} color={searchActive ? tokens.blu : tokens.t3} />
          <View style={{ flex: 1 }}>
            <TextInput
              ref={searchInputRef}
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(13.5) }]}
              placeholder=""
              accessibilityLabel="Search: SmartSearch — Reg, word, or phrase"
              value={searchQuery}
              onChangeText={handleQueryChange}
              onFocus={() => {
                setSearchActive(true)
                getRecentSearches().then(setRecentSearches)
              }}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck
              returnKeyType="search"
              onSubmitEditing={submitSearch}
            />
            {/* RC: "SS needs to shimmer much slower and more subtly. It
                can go inside the search bar." A real TextInput placeholder
                can't carry per-letter styling, so this is a custom
                overlay standing in for it -- pointerEvents="none" so taps
                still reach the real input underneath, and it only shows
                while the field is genuinely empty, same as a real
                placeholder disappearing the moment you type. */}
            {searchQuery.length === 0 && (
              <View pointerEvents="none" style={styles.customPlaceholder}>
                <SmartSearchLabel fontSize={12.5} />
                <Text
                  style={[styles.placeholderRest, { color: tokens.t3, fontSize: fs(13) }]}
                  numberOfLines={1}
                >
                  · Reg, word, or phrase…
                </Text>
              </View>
            )}
          </View>
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => {
                setSearchQuery('')
                setSearchResults([])
                setSearchLoading(false)
              }}
              hitSlop={8}
            >
              <Icon name="xmark.circle" size={fs(17)} color={tokens.t4} />
            </Pressable>
          )}
        </View>
        {/* On iPad these two move to the bottom bar (useScreenActions
            above) -- RC, annotated screenshot: "all things like this need
            to find their way to the bottom of the screen." Phone keeps
            them right here, unchanged. */}
        {!showCancel && !isTabletLandscape && !isTabletPortrait && (
          <Pressable
            onPress={openFilter}
            style={[styles.filterBtn, { backgroundColor: tokens.inp, borderColor: activeFilterCount > 0 ? tokens.blu : tokens.bdr }]}
            hitSlop={4}
          >
            <Icon name="slider.horizontal.3" size={fs(16)} color={activeFilterCount > 0 ? tokens.blu : tokens.t3} />
            {activeFilterCount > 0 && (
              <View style={[styles.filterBadge, { backgroundColor: tokens.blu }]}>
                {/* Same fixed-black-text-on-tokens.blu contrast gap as
                    study.tsx's identical filter badge -- see that file's
                    comment for the measured contrast ratios per theme.
                    Black only reads well against Dark's bright blu. */}
                <Text style={[styles.filterBadgeText, { fontSize: fs(9.5), color: resolved === 'dark' && !redShift ? '#000' : '#fff' }]}>{activeFilterCount}</Text>
              </View>
            )}
          </Pressable>
        )}
        {showCancel && !isTabletLandscape && !isTabletPortrait && (
          <Pressable onPress={dismissSearch} style={styles.cancelWrap} hitSlop={4}>
            <Text style={[styles.cancelText, { color: tokens.blu, fontSize: fs(14) }]}>Cancel</Text>
          </Pressable>
        )}
      </View>

      {/* Main content — redesign step 5: regulatory-body cards replace the
          AC-series list that used to live here directly (moved to its own
          screen, ac/library.tsx, matching far/aim/pcg's new index screens).
          "Several apps under one roof" -- see flyregs_expansion_plan.md. */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : filterApplied ? (
        <FlatList
          data={filterResults}
          keyExtractor={(item) => `${item.itemType}-${item.itemId}`}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          onEndReached={loadMoreFilterResults}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            filterLoadingMore ? (
              <View style={{ paddingVertical: 16 }}>
                <ActivityIndicator color={tokens.blu} />
              </View>
            ) : null
          }
          ListHeaderComponent={
            <View style={[styles.filterStatusBar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Text style={[styles.filterStatusText, { color: tokens.t2, fontSize: fs(13) }]}>
                {filterResultsLoading ? 'Loading…' : `${filterResults.length} of ${filterResults[0]?.totalCount ?? 0} results`}
              </Text>
              <Pressable onPress={openFilter} hitSlop={6}>
                <Text style={[styles.filterStatusLink, { color: tokens.blu, fontSize: fs(13) }]}>Edit</Text>
              </Pressable>
              <Pressable onPress={dismissFilterResults} hitSlop={6}>
                <Text style={[styles.filterStatusLink, { color: tokens.t3, fontSize: fs(13) }]}>Clear</Text>
              </Pressable>
            </View>
          }
          ListEmptyComponent={
            !filterResultsLoading ? (
              <View style={styles.center}>
                <Text style={[styles.filterEmptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>No documents match these filters.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <FilterResultRowView
              item={item}
              tokens={tokens}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          )}
        />
      ) : isTabletLandscape || isTabletPortrait ? (
        <SplitPane
          storageKey={isTabletLandscape ? 'home' : 'home-portrait'}
          orientation={isTabletLandscape ? 'horizontal' : 'vertical'}
          rail={homeRail}
          detail={homeDetail}
        />
      ) : (
        <FlatList
          data={regTypes}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={tokens.t3} />}
          ListHeaderComponent={
            <HomeHeader
              tokens={tokens}
              whatsNew={whatsNew}
              otherWhatsNew={otherWhatsNew}
              badgeDays={badgeDays}
              hasPlusAccess={hasPlusAccess}
              dailyReg={dailyReg}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          }
          renderItem={({ item }) => <RegBodyCard item={item} tokens={tokens} />}
        />
      )}

      <ChipFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        title="Filter"
        subtitle="Everything searched by default — pick chips to narrow."
        resultCount={liveCount}
        countLoading={liveCountLoading}
        onClearAll={clearFilters}
        onApply={applyFilters}
      >
        <ChipFilterSection
          title="CONTENT TYPE"
          options={[
            { value: 'far', label: 'FAR' }, { value: 'aim', label: 'AIM' }, { value: 'pcg', label: 'P/CG' },
            { value: 'ac', label: 'AC' }, { value: 'loi', label: 'LOI' },
          ]}
          selected={filterContentTypes}
          onToggle={(v) => toggleFilterType(v as FilterableType)}
        />
        {filterContentTypes.includes('far') && (
          <ChipFilterSection
            title="FAR PART"
            options={farPartOptions}
            selected={filterFarParts}
            onToggle={toggleFarPart}
            selectAll
            onSetSelected={setFilterFarParts}
          />
        )}
        {filterContentTypes.includes('ac') && (
          <ChipFilterSection
            title="AC SERIES"
            options={acSeriesOptions}
            selected={filterAcSeries ? [filterAcSeries] : []}
            onToggle={(v) => setFilterAcSeries((prev) => (prev === v ? null : v))}
          />
        )}
        <ChipFilterSection
          title="AUDIENCE (NARROWS ACs ONLY)"
          options={AUDIENCE_OPTIONS}
          selected={filterAudience}
          onToggle={toggleAudience}
        />
        {/* AIM/AC check a real figures table (ac_figures/aim_figures); FAR
            and LOI have no such table but DO embed real pipe-delimited
            tables directly in body_text (confirmed: 93 FAR sections, e.g.
            $ 47.17's fee schedule -- the exact format PlainTextBody already
            renders as a real grid on the detail screen), which
            filter_documents now detects directly. P/CG genuinely has zero
            -- confirmed, not assumed -- so it's the only type this stays
            hidden for. */}
        {(filterContentTypes.length === 0 || filterContentTypes.some((t) => t !== 'pcg')) && (
          <ChipFilterSection
            title="HAS FIGURES & TABLES"
            options={[{ value: 'yes', label: 'Yes' }]}
            selected={filterHasFigures ? ['yes'] : []}
            onToggle={() => setFilterHasFigures((prev) => (prev ? null : true))}
          />
        )}
        {/* AC (date_issued), LOI (issued_date) and FAR (last_amended) have
            a real per-document date to filter on. AIM and P/CG still only
            have updated_at -- a weekly-sync stamp, not a content date --
            so filtering by it returns everything or nothing for any range.
            Hidden outright (not just disclosed) when the selection is
            wholly within those two, same treatment as Has Figures above;
            otherwise shown with an honest scope in the title, same
            convention as Audience's own "(NARROWS ACs ONLY)". */}
        {(filterContentTypes.length === 0 || filterContentTypes.some((t) => t !== 'aim' && t !== 'pcg')) && (
          <View style={{ gap: 8 }}>
            <Text style={[styles.filterSectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>DATE RANGE (NOT AIM OR P/CG)</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={[styles.filterDateInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg2, fontSize: ifs(13) }]}
                value={filterDateFrom}
                onChangeText={setFilterDateFrom}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={tokens.t4}
              />
              <TextInput
                style={[styles.filterDateInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg2, fontSize: ifs(13) }]}
                value={filterDateTo}
                onChangeText={setFilterDateTo}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={tokens.t4}
              />
            </View>
          </View>
        )}
        <View style={{ gap: 8 }}>
          <Text style={[styles.filterSectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>CITES THIS DOCUMENT</Text>
          <Text style={[styles.citesHint, { color: tokens.t4, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.25 }]}>
            Narrows results to only items that reference the FAR section, AIM paragraph, P/CG term, AC, or LOI you pick below.
          </Text>
          {filterCitesDoc ? (
            <Pressable
              style={[styles.filterCitesChip, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}
              onPress={() => {
                if (consumeLongPress()) return
                setFilterCitesDoc(null)
              }}
              onLongPress={(e) => showPreview(filterCitesDoc.label, e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Text style={[styles.filterCitesChipText, { color: tokens.gold, fontSize: fs(12.5) }]} numberOfLines={1}>
                {filterCitesDoc.label}
              </Text>
              <Icon name="xmark" size={fs(12)} color={tokens.gold} />
            </Pressable>
          ) : (
            <>
              <View style={[styles.citesInputWrap, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
                <TextInput
                  style={[styles.citesInput, { color: tokens.t1, fontSize: ifs(13) }]}
                  value={citesQuery}
                  onChangeText={setCitesQuery}
                  placeholder="Search a FAR section, AIM paragraph, P/CG term, AC, or LOI…"
                  placeholderTextColor={tokens.t4}
                />
                {citesLoading && <ActivityIndicator size="small" color={tokens.t3} style={{ marginRight: 10 }} />}
              </View>
              {!citesLoading && citesCandidates.length === 0 && citesQuery.trim().length >= 2 && (
                <Text style={[styles.citesHint, { color: tokens.t4, fontSize: fs(12), lineHeight: fs(12) * 1.25 }]}>No matches for "{citesQuery}".</Text>
              )}
              {citesCandidates.map((c) => (
                <Pressable
                  key={`${c.type}-${c.id}`}
                  style={[styles.citesCandidateRow, { borderTopColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    setFilterCitesDoc(c); setCitesQuery(''); setCitesCandidates([])
                  }}
                  onLongPress={(e) => showPreview(c.label, e)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <Text style={[styles.citesCandidateText, { color: tokens.t1, fontSize: fs(12.5) }]} numberOfLines={1}>{c.label}</Text>
                </Pressable>
              ))}
            </>
          )}
        </View>
      </ChipFilterSheet>

      {/* Search overlay — backdrop + dropdown, rendered last so they sit above content.
          Tied to showDropdown (has a query), not focus — tapping the backdrop only
          dismisses the keyboard, it never hides results that are already on screen. */}
      {showDropdown && (
        <Pressable
          style={[
            styles.backdrop,
            // starts below the search zone so the Cancel/X buttons remain tappable
            { top: dropdownTop > 0 ? dropdownTop : 110 },
          ]}
          onPress={() => Keyboard.dismiss()}
        />
      )}

      {showDropdown && (
        <Reanimated.View
          style={[
            styles.dropdown,
            {
              top: dropdownTop > 0 ? dropdownTop : 110,
              backgroundColor: tokens.bg2,
              borderColor: tokens.bdr,
              ...(Platform.OS === 'web'
                ? ({ boxShadow: '0 4px 16px rgba(0,0,0,0.14)' } as object)
                : { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.13, shadowRadius: 14 }),
            },
            animatedDropdownStyle,
          ]}
        >
          {/* Always-reachable keyboard dismiss — tapping the backdrop works too,
              but that only has empty space to tap when the dropdown doesn't
              fill it; this is a guaranteed target regardless of layout. */}
          <Pressable onPress={() => Keyboard.dismiss()} style={[styles.dropHideKb, { borderBottomColor: tokens.bdr }]}>
            <Icon name="chevron.down" size={fs(13)} color={tokens.t3} />
            <Text style={[styles.dropHideKbText, { color: tokens.t3, fontSize: fs(11.5) }]}>Hide keyboard</Text>
          </Pressable>

          {/* Once there are results, they stay on screen through subsequent
              re-searches (e.g. dictation's "final" commit re-firing onChangeText
              with unchanged text) — only the empty/first-load states get the
              spinner treatment. Previously `searchLoading` replaced the whole
              list with a spinner on every re-search, which is what made results
              flicker away and come back after releasing the mic button. */}
          {combinedResults.length > 0 ? (
            <Reanimated.ScrollView
              style={[styles.dropScroll, animatedDropdownStyle]}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              nestedScrollEnabled
            >
              {(hasPlusAccess ? combinedResults : combinedResults.slice(0, FREE_RESULT_CAP)).map((item) => {
                // RC: "verify every reg list actually HAS the tap-hold
                // feature" -- Home's own SmartSearch dropdown, the single
                // most-used results list in the app, had no long-press at
                // all despite both lines below being genuinely truncatable
                // (numberOfLines={1} on the number, ={3} on the title -- a
                // long FAR/AC title still clips past 3 lines). Computed once
                // per row here (not inline in the handlers) since both
                // onPress and onLongPress need the same primary/title pair.
                const primary = item.ac
                  ? `${acResultPrimary(item.ac.document_number)}${isOcrScanned(item.ac.document_number) ? ' *' : ''}`
                  : item.other!.primary
                const title = item.ac
                  ? item.ac.title
                  : item.other!.type === 'ad'
                    ? stripAdSubjectPrefix(item.other!.secondary)
                    : item.other!.secondary
                return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [
                    styles.dropRow,
                    { borderBottomColor: tokens.bdr },
                    pressed && { backgroundColor: tokens.bg3 },
                  ]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    item.ac ? selectResult(item.ac) : selectOtherResult(item.other!)
                  }}
                  onLongPress={(e) => showPreview(title, e, primary)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.dropOtherPrimary, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
                      {primary}
                    </Text>
                    {/* Full title, wrapped -- NOT clamped to one line. Two
                        sibling FAR sections routinely differ only past the
                        truncation point: "§ 121.649 Takeoff and landing
                        weather minimu..." and "§ 121.651 Takeoff and landing
                        weather minimu..." were indistinguishable in the
                        results, so the user couldn't tell which one they
                        needed. Uniform row height is worth less than being
                        able to read the result. */}
                    <Text style={[styles.dropTitle, { color: tokens.t1, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.33 }]} numberOfLines={3}>
                      {title}
                    </Text>
                  </View>
                </Pressable>
                )
              })}
              {!hasPlusAccess && combinedResults.length > FREE_RESULT_CAP && (
                <Pressable
                  style={[styles.dropSeeAll, { borderTopColor: tokens.bdr }]}
                  onPress={() => { dismissSearch(); router.push('/paywall?tier=plus') }}
                >
                  <Icon name="lock.fill" size={fs(13)} color={tokens.amb} />
                  <Text style={[styles.dropSeeAllText, { color: tokens.blu, fontSize: fs(13) }]}>
                    Unlock Plus for all {combinedResults.length} results
                  </Text>
                </Pressable>
              )}
            </Reanimated.ScrollView>
          ) : searchLoading ? (
            <View style={styles.dropCenter}>
              <ActivityIndicator size="small" color={tokens.blu} />
            </View>
          ) : (
            <View style={styles.dropCenter}>
              <Text style={[styles.dropEmpty, { color: tokens.t3, fontSize: fs(14) }]}>No results</Text>
            </View>
          )}
        </Reanimated.View>
      )}

      {/* Recent-searches dropdown — shown when the field is focused but
          empty, mutually exclusive with the results dropdown above (that
          one needs 2+ typed characters). Tapping a past query re-populates
          the field and re-runs it immediately, same target UX as tapping a
          live result. */}
      {showRecentSearches && (
        <Pressable
          style={[styles.backdrop, { top: dropdownTop > 0 ? dropdownTop : 110 }]}
          onPress={() => Keyboard.dismiss()}
        />
      )}

      {showRecentSearches && (
        <Reanimated.View
          style={[
            styles.dropdown,
            {
              top: dropdownTop > 0 ? dropdownTop : 110,
              backgroundColor: tokens.bg2,
              borderColor: tokens.bdr,
              ...(Platform.OS === 'web'
                ? ({ boxShadow: '0 4px 16px rgba(0,0,0,0.14)' } as object)
                : { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.13, shadowRadius: 14 }),
            },
            animatedDropdownStyle,
          ]}
        >
          <View style={[styles.dropHideKb, { borderBottomColor: tokens.bdr, justifyContent: 'space-between' }]}>
            <Text style={[styles.dropHideKbText, { color: tokens.t3, fontSize: fs(11.5) }]}>Recent searches</Text>
            <Pressable onPress={clearAllRecentSearches} hitSlop={8}>
              <Text style={[styles.dropHideKbText, { color: tokens.blu, fontSize: fs(11.5) }]}>Clear</Text>
            </Pressable>
          </View>
          <Reanimated.ScrollView
            style={[styles.dropScroll, animatedDropdownStyle]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            nestedScrollEnabled
          >
            {recentSearches.map((q) => (
              // Two SIBLING Pressables, not one nested inside the other — a
              // Pressable-in-Pressable is a known React Native trap where
              // the parent's touch responder can swallow the child's own
              // press before it ever fires, which is exactly what happened
              // here first (the row's onPress worked, but the inner ×
              // never did, live and reproducibly). A row-level View with
              // the select-Pressable and remove-Pressable side by side
              // avoids the responder conflict entirely.
              <View
                key={q}
                style={[styles.dropRow, { borderBottomColor: tokens.bdr, paddingRight: 0 }]}
              >
                <Pressable
                  style={({ pressed }) => [
                    { flex: 1, flexDirection: 'row', alignItems: 'center' },
                    pressed && { opacity: 0.6 },
                  ]}
                  onPress={() => selectRecentSearch(q)}
                >
                  <Icon name="clock" size={fs(14)} color={tokens.t3} />
                  <Text style={[styles.dropTitle, { color: tokens.t1, fontSize: fs(13.5), marginLeft: 10, lineHeight: fs(13.5) * 1.33 }]} numberOfLines={1}>
                    {q}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => removeOneRecentSearch(q)}
                  hitSlop={10}
                  style={({ pressed }) => [{ paddingHorizontal: 14, paddingVertical: 10 }, pressed && { opacity: 0.5 }]}
                >
                  <Icon name="xmark" size={fs(13)} color={tokens.t4} />
                </Pressable>
              </View>
            ))}
          </Reanimated.ScrollView>
        </Reanimated.View>
      )}

      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      </TabletContainer>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

// ─── Hobbs/tach quick update (Home header) ───────────────────────────────────
// RC: "we could find a good place for that on the Home screen so it's a
// one tap step when opening the app - a CTA box pops up, they update their
// hobbs/tach time and submit. Then, our system updates the MF/MA pages with
// that intel... NOW the h/t reminders they input actually are useful."
// Landed in the header (same row as the wordmark and drawer icon) per RC's
// own follow-up, not a scrolling-content card -- self-contained like
// DailyRegCard below (fetches its own data), invisible for Free/Plus or any
// Pro/Premium account with zero saved aircraft yet.
function HobbsHeaderButton() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasProAccess, loading: authLoading, session } = useAuth()
  const insets = useSafeAreaInsets()
  const [fleet, setFleet] = useState<FleetAircraftSummary[] | null>(null)
  const [pickerVisible, setPickerVisible] = useState(false)
  const [editing, setEditing] = useState<FleetAircraftSummary | null>(null)

  useFocusEffect(
    useCallback(() => {
      // Cache-first, same fix and same reason as DailyReg's own
      // REG_OF_DAY_CACHE_KEY (RC, 2026-08-05: "the DR bar always takes a
      // second to load... when you go to Home") -- show the last-known
      // fleet instantly instead of the icon popping in a beat after
      // getFleetSummary() resolves. Keyed by uid (same pattern as search.tsx's
      // IDENTITY_CACHE_KEY_PREFIX) -- this was a bare global key until
      // 2026-08-09, which briefly painted a PREVIOUS account's real aircraft
      // (tail numbers, compliance status) on Home the instant a different
      // Pro/Premium user signed in on the same device, before getFleetSummary()
      // resolved and overwrote it. context/auth.tsx's claimDeviceIfMismatched
      // doesn't cover this key (it's namespaced here instead, matching
      // identityStatsCache's own precedent), so the uid keying is this key's
      // only guard -- necessary on its own.
      if (!session) {
        setFleet([])
        return
      }
      const uid = session.user.id
      AsyncStorage.getItem(FLEET_SUMMARY_CACHE_KEY + uid)
        .then((cached) => { if (cached) setFleet(JSON.parse(cached)) })
        .catch(() => {})
      if (!hasProAccess) {
        // Only actually clear once auth is DONE resolving entitlements, not
        // on this transient false -- hasProAccess (isPro || isPremium)
        // starts false while auth.tsx's own `loading` is still true, so
        // blanking on that alone is exactly what made a real Pro/Premium
        // account's icon flicker away and pop back in on every return to
        // Home, instead of "just always being there."
        if (!authLoading) {
          setFleet([])
          AsyncStorage.removeItem(FLEET_SUMMARY_CACHE_KEY + uid).catch(() => {})
        }
        return
      }
      getFleetSummary().then((fresh) => {
        setFleet(fresh)
        AsyncStorage.setItem(FLEET_SUMMARY_CACHE_KEY + uid, JSON.stringify(fresh)).catch(() => {})
      }).catch(() => setFleet([]))
      // session?.user?.id, not the raw `session` object -- confirmed live
      // (2026-08-18): onAuthStateChange fires SIGNED_IN repeatedly for the
      // SAME already-signed-in user (identical token, no real change),
      // handing back a brand-new session object every time. This callback
      // is wrapped in useFocusEffect, which re-runs whenever ITS OWN
      // identity changes, not just on a real focus transition -- depending
      // on the whole object meant Home's fleet widget re-fetched
      // getFleetSummary() on a loop the entire time Home stayed mounted.
      // See AircraftDowngradeGate.tsx for the same root cause and fix.
    }, [hasProAccess, authLoading, session?.user?.id])
  )

  if (!fleet || fleet.length === 0) return null

  // RC: "most of the time, this would be how users will access MF/MA" --
  // the sheet is a real gateway into My Fleet/My Aircraft, not just a
  // quick-tach shortcut, so it always opens (even for one aircraft) instead
  // of skipping straight to the update modal. Tapping a row's hours updates
  // inline and stays on Home; tapping the rest of the row, or the "Manage"
  // bar, navigates into the app.
  const isFleet = fleet.length > 1
  const goToFleet = () => { setPickerVisible(false); router.push('/my-aircraft' as any) }
  const goToAircraft = (id: string) => { setPickerVisible(false); router.push(`/my-aircraft/${id}` as any) }

  return (
    <>
      <Pressable onPress={() => setPickerVisible(true)} style={styles.iconBtn} hitSlop={8}>
        <Icon name="speedometer" size={fs(21)} color={tokens.t2} />
      </Pressable>

      {/* RC, real device: a second stacked native <Modal> for the editor
          silently ate all touches on iOS (only worked in the web preview,
          where Modal is just a DOM overlay). One Modal, swapped content --
          the editor still appears "directly and immediately", just without
          ever mounting two native modal presentations at once. */}
      <Modal
        visible={pickerVisible || !!editing}
        animationType="slide"
        transparent
        onRequestClose={() => (editing ? setEditing(null) : setPickerVisible(false))}
      >
        {editing ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.hobbsPickerBackdrop}>
            <HobbsUpdateBody
              aircraftId={editing.aircraftId}
              initialHours={editing.currentHobbsHours}
              updatedAt={null}
              onClose={() => setEditing(null)}
              onSaved={(hours) => {
                setFleet((prev) => (prev ? prev.map((x) => (x.aircraftId === editing?.aircraftId ? { ...x, currentHobbsHours: hours } : x)) : prev))
                setEditing(null)
              }}
            />
          </KeyboardAvoidingView>
        ) : (
          <View style={styles.hobbsPickerBackdrop}>
            {/* RC, real device: "move this box up a bit, off the very
                bottom of the screen." The card's own padding (18) was flat
                on every edge, so on a device with a home-indicator inset
                the "Manage" bar sat right against it with no real
                breathing room. Same fix/pattern as ChipFilterSheet's own
                bottom-sheet footer -- Math.max keeps a sane minimum gap on
                devices with no inset (e.g. web) instead of collapsing to 0. */}
            <View style={[styles.hobbsPickerCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: Math.max(18, insets.bottom + 8) }]}>
              <View style={styles.hobbsPickerHeader}>
                <Text style={[styles.hobbsPickerTitle, { color: tokens.t1, fontSize: fs(16) }]}>{isFleet ? 'My Fleet' : 'My Aircraft'}</Text>
                <Pressable onPress={() => setPickerVisible(false)} hitSlop={10}>
                  <Icon name="xmark" size={fs(18)} color={tokens.t3} />
                </Pressable>
              </View>
              {fleet.map((a) => (
                <Pressable
                  key={a.aircraftId}
                  style={[styles.hobbsPickerRow, { borderBottomColor: tokens.bdr }]}
                  onPress={() => goToAircraft(a.aircraftId)}
                >
                  <Icon name="airplane" size={fs(14)} color={tokens.t2} />
                  <Text style={{ color: tokens.t1, fontSize: fs(14), flex: 1 }}>{a.nickname || `${a.make} ${a.model}`}</Text>
                  <Pressable
                    style={styles.hobbsPickerHours}
                    onPress={(e) => { e.stopPropagation(); setEditing(a) }}
                    hitSlop={6}
                  >
                    <Icon name="speedometer" size={fs(13)} color={tokens.blu} />
                    <Text style={{ color: tokens.blu, fontSize: fs(13), fontWeight: '600' }}>
                      {a.currentHobbsHours != null ? `${a.currentHobbsHours}` : 'Set'}
                    </Text>
                  </Pressable>
                </Pressable>
              ))}
              <Pressable style={[styles.hobbsPickerManage, { borderColor: tokens.blu }]} onPress={goToFleet}>
                <Text style={{ color: tokens.blu, fontSize: fs(14), fontWeight: '600' }}>
                  {isFleet ? 'Manage My Fleet' : 'Manage My Aircraft'}
                </Text>
                <Icon name="chevron.right" size={fs(13)} color={tokens.blu} />
              </Pressable>
            </View>
          </View>
        )}
      </Modal>
    </>
  )
}

// ─── Header (What's New + Library label) ─────────────────────────────────────

function HomeHeader({
  tokens,
  whatsNew,
  otherWhatsNew,
  badgeDays,
  hasPlusAccess,
  dailyReg,
  showBrowseLabel = true,
  isTablet = false,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  whatsNew: WhatsNewAC[]
  otherWhatsNew: WhatsNewOther[]
  badgeDays: number
  hasPlusAccess: boolean
  dailyReg: DailyReg | null
  /** iPad split view (see the main render below) shows "Browse by
   * Regulation" as its own rail instead of trailing this header -- false
   * there so it isn't shown twice. */
  showBrowseLabel?: boolean
  /** iPad, RC, annotated screenshot: "these what's new chunks were going
   * to list in a pack, and fill in down the screen... we've got all this
   * wasted space on screen." The detail pane is wide enough to show 4-5
   * cards per row with real vertical room left under them -- a single
   * horizontal-scroll strip wasted all of it. Wraps into a real grid
   * instead of scrolling sideways; phone keeps the original horizontal
   * strip untouched (isTablet defaults false, and the phone call site
   * below never passes it). */
  isTablet?: boolean
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  // hasPlusAccess arrives as a prop (the parent screen reads it), but the
  // "is that value trustworthy yet" half of the answer doesn't -- read it
  // straight from the context here rather than threading a second prop
  // through both call sites. See the locked branch below for what it fixes.
  const { loading: authLoading } = useAuth()

  // Merge AC (richer NEW/UPD/VER badge data) with AD/LOI (simpler "NEW"
  // badge, real dates) into one feed sorted by date, most recent first --
  // confirmed a real gap: this strip previously showed ACs ONLY, giving the
  // impression nothing else in the app ever changes.
  type MergedWhatsNew =
    | { kind: 'ac'; date: string | null; item: WhatsNewAC }
    | { kind: 'other'; date: string | null; item: WhatsNewOther }
  const mergedWhatsNew: MergedWhatsNew[] = [
    ...whatsNew.map((item) => ({ kind: 'ac' as const, date: item.date_issued, item })),
    ...otherWhatsNew.map((item) => ({ kind: 'other' as const, date: item.date, item })),
  ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  // What's New/Changed is Plus-tier content -- confirmed live as a real
  // gating gap: even with taps disabled, a free user seeing real AC
  // titles/badges here IS the paid info (matches AeroRegs' own free tier,
  // which shows none of this either). Free sees a locked teaser card
  // instead of the real strip, same pattern as every other Plus-gated
  // section (Ref Packets, What's Changed screen itself).
  if (!hasPlusAccess) {
    return (
      <>
        {/* RC, iPad tablet-split view, annotated: "DR can go to top on this
            view." DailyReg leads on the split-view detail pane; phone keeps
            its original trailing position below (isTablet defaults false
            there, so this is a no-op on phone). */}
        {isTablet && <DailyRegCard dailyReg={dailyReg} tokens={tokens} />}
        <View style={[styles.sectionLabel, { justifyContent: 'flex-start', gap: 8 }]}>
          <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(16.5) }]}>What's New</Text>
        </View>
        {/* Separate bug from HobbsHeaderButton's (already fixed above), same
            root cause: hasPlusAccess is false for EVERYONE until auth's own
            `loading` resolves, so a real Plus/Pro/Premium subscriber's Home
            screen showed this "Unlock Plus" card for the length of the
            entitlement fetch before the real strip replaced it. Swapping
            only the card (not the whole branch) keeps the section label and
            the DailyRegCard placements below exactly where they are, so
            nothing shifts when the real answer lands. */}
        {authLoading ? (
          <View style={[styles.wnLockedCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            <ActivityIndicator color={tokens.blu} />
          </View>
        ) : (
        <Pressable
          style={[styles.wnLockedCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={() => router.push('/paywall?tier=plus')}
        >
          <Icon name="lock.fill" size={fs(18)} color={tokens.amb} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.wnLockedTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>
              See what's new and changed
            </Text>
            <Text style={[styles.wnLockedSub, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.33 }]}>
              Unlock Plus to track new and updated ACs, with real diffs of exactly what changed.
            </Text>
          </View>
          <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
        </Pressable>
        )}
        {!isTablet && <DailyRegCard dailyReg={dailyReg} tokens={tokens} />}
      </>
    )
  }

  return (
    <>
      {/* RC, iPad tablet-split view, annotated: "DR can go to top on this
          view." Same isTablet-only lead placement as the no-Plus branch
          above; phone's trailing DailyRegCard below is untouched. */}
      {isTablet && <DailyRegCard dailyReg={dailyReg} tokens={tokens} />}

      {/* What's New strip — always shown, even with zero results, so a user
          isn't left wondering why the whole section vanished; the empty
          state tells them to widen Badge Duration if they expect to see
          something. Now spans AC + AD + LOI (each has a real, genuinely-
          varied FAA-side date) -- FAR/AIM/PCG still can't join honestly
          until they get real incremental revision-detection of their own
          issue date (see WhatsNewOther's header comment); content_revisions
          (a real, separate thing -- per-paragraph DIFFS, not new-document
          dates, see /updates's own "Changed" tab) now logs FAR/AIM/PCG/AD
          revisions too, but that's not the same signal WN needs here. */}
      <View style={[styles.sectionLabel, { justifyContent: 'flex-start', gap: 8 }]}>
        <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(16.5) }]}>What's New</Text>
        {/* RC: "you had fixed these, then they went back" -- checked git
            history directly, sectionSub's fontSize was never actually
            bumped (only sectionTitle was, this same round) -- couldn't find
            a prior committed larger version to restore, so this is a fresh
            bump now rather than a revert. */}
        <Text style={[styles.sectionSub, { color: tokens.t3, fontSize: fs(13) }]}>{badgeDays}d</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.push('/updates' as any)} hitSlop={8}>
          <Text style={[styles.sectionSub, { color: tokens.blu, fontWeight: '600', fontSize: fs(13) }]}>
            All ›
          </Text>
        </Pressable>
      </View>
      {mergedWhatsNew.length > 0 ? (
        isTablet ? (
          <View style={styles.wnGrid}>
            {mergedWhatsNew.map((entry) =>
              entry.kind === 'ac' ? (
                <WhatsNewCard
                  key={`ac-${entry.item.id}`}
                  ac={entry.item}
                  tokens={tokens}
                  badgeDays={badgeDays}
                  showPreview={showPreview}
                  hidePreview={hidePreview}
                  consumeLongPress={consumeLongPress}
                />
              ) : (
                <OtherWhatsNewCard
                  key={`${entry.item.type}-${entry.item.id}`}
                  item={entry.item}
                  tokens={tokens}
                  showPreview={showPreview}
                  hidePreview={hidePreview}
                  consumeLongPress={consumeLongPress}
                />
              )
            )}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.wnScroll}
          >
            {mergedWhatsNew.map((entry) =>
              entry.kind === 'ac' ? (
                <WhatsNewCard
                  key={`ac-${entry.item.id}`}
                  ac={entry.item}
                  tokens={tokens}
                  badgeDays={badgeDays}
                  showPreview={showPreview}
                  hidePreview={hidePreview}
                  consumeLongPress={consumeLongPress}
                />
              ) : (
                <OtherWhatsNewCard
                  key={`${entry.item.type}-${entry.item.id}`}
                  item={entry.item}
                  tokens={tokens}
                  showPreview={showPreview}
                  hidePreview={hidePreview}
                  consumeLongPress={consumeLongPress}
                />
              )
            )}
          </ScrollView>
        )
      ) : (
        <View style={[styles.wnEmpty, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Text style={[styles.wnEmptyText, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.44 }]}>
            Nothing issued or updated in the last {badgeDays} day{badgeDays === 1 ? '' : 's'}. Try a longer Badge Duration in the menu to see more.
          </Text>
        </View>
      )}

      {!isTablet && <DailyRegCard dailyReg={dailyReg} tokens={tokens} />}

      {/* Regulatory-body cards label */}
      {showBrowseLabel && (
        <View style={styles.sectionLabel}>
          <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(16.5) }]}>Browse by Regulation</Text>
        </View>
      )}
    </>
  )
}

// ─── DailyReg card (collapsed by default, expand or jump to the full term) ──
// Shares the get_reg_of_the_day() rotation with the daily push notification
// (see scripts/send-reg-of-day.mjs) so the in-app pick always matches
// whatever a Pro/Premium user with the push toggle on saw today -- this is
// just an always-visible, no-push-required way to see it, since P/CG itself
// is free to browse regardless of tier.
// DailyReg is a PAID feature, not free — confirmed with RC 2026-07-31 (it
// used to render for everyone, giving away a curated reg a day to free
// users). Moved from Plus to Pro 2026-08-03 ("daily reg is Pro gated, not
// Plus") so the card and its push notification (see DailyReg daily
// notification in account.tsx) are both gated at the same tier instead of
// splitting one feature across two. Renders a locked teaser instead of
// vanishing so it's still discoverable (and sells itself).
// RC: "the D and W of DailyWord should have larger font, like ML" then,
// once that shipped: "same D and R styling for DailyReg needed." Mirrors
// DailyWordLabel in dictionary/index.tsx exactly, just for "DAILYREG" --
// kept as its own small component rather than a shared import since each
// lives beside its own StyleSheet (dailyRegLabel vs wordCardLabel) in a
// different route file. `suffix` covers the expanded-card variant, which
// appends " · <SOURCE TYPE>" after the label.
function DailyRegLabel({ color, fs, suffix }: { color: string; fs: (n: number) => number; suffix?: string }) {
  return (
    <Text style={[styles.dailyRegLabel, { color, fontSize: fs(10.5) }]}>
      <Text style={{ fontSize: fs(13.5) }}>D</Text>AILY<Text style={{ fontSize: fs(13.5) }}>R</Text>EG{suffix ? ` · ${suffix}` : ''}
    </Text>
  )
}

function DailyRegCard({ dailyReg, tokens }: { dailyReg: DailyReg | null; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  const fs = useFS()
  // hasProAccess (isPro || isPremium), not bare isPro -- found in the
  // 2026-08-14 gating re-audit: this used bare isPro, which would show a
  // genuine Premium subscriber (isPro:false/isPremium:true, a real shape
  // for an admin/comp-granted entitlement) a permanently-locked "unlock
  // with Pro" card on the Home tab despite already owning Pro-tier access.
  // Same bug class as saved.tsx/notes.tsx/study.tsx/my-aircraft/index.tsx.
  const { hasProAccess, loading: authLoading } = useAuth()
  const [expanded, setExpanded] = useState(false)
  if (!dailyReg) return null
  // Separate bug from HobbsHeaderButton's, same root cause: dailyReg is
  // served cache-first (it lands in a millisecond or two), while
  // isPro/isPremium stay false until auth's own `loading` resolves several
  // hundred ms later -- so a real Pro/Premium subscriber's Home reliably
  // painted the "unlock with Pro" lock card first and only then swapped in
  // their actual Daily Reg. Rendering nothing for that window is what this
  // card already does before dailyReg arrives, so it costs no extra layout
  // shift and never shows a paying customer an upsell for what they own.
  if (!hasProAccess && authLoading) return null
  // Brushed-silver shimmer frame -- RC, 2026-08-05, after seeing a static
  // diagonal-gradient first pass: "the DR box silver shimmer is just the
  // edge border - it should be like the ML, but in silver instead, same
  // effect." See SilverShimmerFrame below for the actual technique (it's
  // MagicLinkPod's own rotating-ring trick, recolored). The one deliberate
  // difference from ML: "the DR box needs a slight translucency fill
  // inside, instead of nothing - to help it stand out, but this is VERY
  // subtle" -- tokens.slvlt (10% alpha) instead of ML's solid tokens.bg2.
  // The gold star/lock badge stays gold on purpose -- it's the one accent
  // inside the frame, not competing with it.
  if (!hasProAccess) {
    return (
      <Pressable onPress={() => router.push('/paywall?tier=pro')}>
        <SilverShimmerFrame tokens={tokens}>
          <View style={styles.dailyRegRow}>
            <View style={[styles.dailyRegIcon, { backgroundColor: tokens.goldlt }]}>
              <Icon name="lock.fill" size={fs(13)} color={tokens.gold} />
            </View>
            <View style={{ flex: 1 }}>
              <DailyRegLabel color={tokens.t3} fs={fs} />
              <Text style={[styles.dailyRegTerm, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
                A hand-picked reg every day — unlock with Pro
              </Text>
            </View>
            <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
          </View>
        </SilverShimmerFrame>
      </Pressable>
    )
  }
  return (
    <Pressable onPress={() => setExpanded((e) => !e)}>
      <SilverShimmerFrame tokens={tokens}>
        <View style={styles.dailyRegRow}>
          <View style={[styles.dailyRegIcon, { backgroundColor: tokens.goldlt }]}>
            <Icon name="star.fill" size={fs(14)} color={tokens.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <DailyRegLabel color={tokens.t3} fs={fs} suffix={dailyReg.sourceType.toUpperCase()} />
            <Text style={[styles.dailyRegTerm, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={expanded ? undefined : 1}>
              {dailyReg.term}
            </Text>
          </View>
          <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t4} />
        </View>
        {expanded && (
          <>
            {splitIntoDisplayParagraphs(dailyReg.definition).map((para, i, arr) => (
              <Text
                key={i}
                style={[
                  styles.dailyRegDef,
                  { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 },
                  i < arr.length - 1 && { marginBottom: 8 },
                ]}
              >
                {para}
              </Text>
            ))}
            {/* RC: "when the DailyReg is expanded or pushed to devices, it
                needs to show the reg that it came from at the bottom, so
                user can see that (just like the fix we did for study
                cards)." Same reasoning as the Study Mode citation: the
                answer text alone doesn't tell you WHERE it's from, and
                that provenance is the whole point of a regulatory
                reference app. Already in hand from the rotation RPC's own
                slug -- no backend change. */}
            <Text style={[styles.dailyRegCitation, { color: tokens.t3, fontSize: fs(12) }]}>
              {dailyRegCitation(dailyReg)}
            </Text>
            <Pressable
              style={[styles.dailyRegJump, { borderColor: tokens.bdr }]}
              onPress={() => router.push(dailyRegRoute(dailyReg) as any)}
            >
              <Text style={[styles.dailyRegJumpText, { color: tokens.blu, fontSize: fs(13) }]}>Open full entry</Text>
              <Icon name="chevron.right" size={fs(12)} color={tokens.blu} />
            </Pressable>
          </>
        )}
      </SilverShimmerFrame>
    </Pressable>
  )
}

// The exact same rotating-gradient-ring trick as MagicLinkPod's gold border
// (see that file's own long comment for the full "why": an oversized
// square clipped behind a same-shaped inner panel inset by exactly the
// border's own width, sized off the box's real diagonal so no rotation
// angle ever exposes a transparent edge, rotated continuously so it reads
// as a traveling light rather than a static ring), recolored silver via
// theme tokens instead of ML's own hardcoded gold hex spectrum -- these
// tokens are already dark/light-aware (theme.tsx) so no separate palette
// constant is needed here the way ML keeps one for its brand-fixed gold.
// Kept local to this file rather than factored out, matching the existing
// precedent that ML's own version isn't factored out either -- one caller
// each so far, both self-contained.
function SilverShimmerFrame({ tokens, children }: { tokens: ReturnType<typeof useTheme>['tokens']; children: ReactNode }) {
  const rotation = useSharedValue(0)
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 6000, easing: Easing.linear }), -1, false)
  }, [])

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }))

  // Diagonal-based square, comfortably oversized (×1.5) -- same formula as
  // MagicLinkPod, see its comment for why a fixed percentage isn't enough
  // once the box isn't roughly square (DailyReg's collapsed row is short
  // and wide, same shape that broke the old fixed-percentage approach there).
  const diag = Math.sqrt(boxSize.width ** 2 + boxSize.height ** 2) * 1.5
  const spinSizeStyle = boxSize.width > 0 ? {
    width: diag,
    height: diag,
    top: (boxSize.height - diag) / 2,
    left: (boxSize.width - diag) / 2,
  } : styles.dailyRegSpinFallback

  return (
    <View
      style={[styles.dailyRegShimmerOuter, { borderColor: tokens.slvbdr }]}
      onLayout={(e) => setBoxSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      <View style={styles.dailyRegGradientClip} pointerEvents="none">
        <Reanimated.View style={[styles.dailyRegSpinBase, spinSizeStyle, spinStyle]}>
          <LinearGradient
            colors={['transparent', tokens.slv, tokens.slvhi, tokens.slv, tokens.slvlo, tokens.slv, 'transparent']}
            locations={[0, 0.05, 0.28, 0.5, 0.72, 0.95, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
        </Reanimated.View>
      </View>
      {/* Opaque base (tokens.bg2, same as every other Home card), NOT
          tokens.slvlt directly -- the rotating gradient square underneath
          extends across the whole inset, not just the visible ring, so a
          translucent BASE fill let it bleed through the entire card face
          (confirmed live: the whole card read as a solid light-gray block,
          not "just the edge border"). The silver tint goes on top of this
          opaque layer instead, as its own absolutely-filled overlay --
          that's what makes it read as "instead of nothing, but VERY
          subtle" rather than a window into the border mechanism. */}
      <View style={[styles.dailyRegCard, { backgroundColor: tokens.bg2 }]}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: tokens.slvlt }]} pointerEvents="none" />
        {children}
      </View>
    </View>
  )
}

// ─── Regulatory-body card ───────────────────────────────────────────────────
// "Several apps under one roof" -- tapping a card enters that type's own
// section with its natural browse structure. Every document inside still
// cross-links out to the other types via the association bars already built
// on each detail screen -- see flyregs_expansion_plan.md.

interface RegBodyItem {
  key: string
  label: string
  abbr: string
  count: number | null
  unit: string
  route: string
  // AD has no dedicated browse screen of its own (unlike FAR/AIM/P-CG/AC) —
  // this overrides route navigation with an arbitrary action (focusing
  // Home's own search bar) instead of pushing a route.
  onCustomPress?: () => void
}

function RegBodyCard({
  item,
  tokens,
}: {
  item: RegBodyItem
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.regCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => (item.onCustomPress ? item.onCustomPress() : router.push(item.route as any))}
    >
      <View style={[styles.regAbbrBadge, { backgroundColor: tokens.bdim }]}>
        <Icon name={REG_TYPE[item.key as keyof typeof REG_TYPE].icon} size={fs(15)} color={tokens.blu} />
        <Text style={[styles.regAbbrText, { color: tokens.blu, fontSize: fs(11) }]}>{item.abbr}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.regLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.label}</Text>
        <Text style={[styles.regCount, { color: tokens.t3, fontSize: fs(12) }]}>
          {item.count !== null ? `${item.count.toLocaleString()} ${item.unit}` : '…'}
        </Text>
      </View>
      <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
    </Pressable>
  )
}

// ─── Filter result row ───────────────────────────────────────────────────────

// RC: "verify every reg list actually HAS the tap-hold feature" -- this row
// (the ad hoc Filter sheet's results list) had no long-press at all despite
// primaryLabel being a real "§ 91.203 Title"/"AC 150/5320-12C: Title"-style
// combined number+title string clipped to numberOfLines={1}, same
// truncatable-content shape as every other list in the corpus-wide sweep.
// filter_documents() (filterSearch.ts) returns primaryLabel as one already-
// combined string rather than a separate number/title pair, so there's no
// natural third `number` arg to split out here -- showPreview just gets the
// whole label, matching how updates.tsx's NewRow (also a combined string)
// does it.
function FilterResultRowView({
  item,
  tokens,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  item: FilterResultRow
  tokens: ReturnType<typeof useTheme>['tokens']
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const meta = REG_TYPE[item.itemType]
  return (
    <Pressable
      style={[styles.filterRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        router.push(routeForFilterResult(item) as any)
      }}
      onLongPress={(e) => showPreview(item.primaryLabel, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={styles.filterRowTop}>
        <Icon name={meta.icon} size={fs(11)} color={tokens.blu} />
        <View style={[styles.filterTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.filterTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{meta.label}</Text>
        </View>
      </View>
      <Text style={[styles.filterRowPrimary, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>{item.primaryLabel}</Text>
      {item.secondaryLabel ? (
          <Text style={[styles.filterRowSecondary, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.33 }]} numberOfLines={4}>{item.secondaryLabel}</Text>
      ) : null}
    </Pressable>
  )
}

// ─── What's New card ─────────────────────────────────────────────────────────

function WhatsNewCard({
  ac,
  tokens,
  badgeDays,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  ac: WhatsNewAC
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const showBadge = isWithinBadgeLifespan(ac.date_issued, badgeDays)
  const dateStr = ac.date_issued
    ? new Date(ac.date_issued).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : ''

  return (
    <Pressable
      style={[styles.wnCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        router.push(`/ac/${ac.id}`)
      }}
      onLongPress={(e) => showPreview(ac.title, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={styles.wnTop}>
        {showBadge && <Badge kind={getBadgeKind(ac)} tokens={tokens} />}
        <View style={{ flex: 1 }} />
        <Text style={[styles.wnDate, { color: tokens.t3, fontSize: fs(10.5) }]}>{dateStr}</Text>
      </View>
      <View style={styles.wnIdentRow}>
        <Icon name={REG_TYPE.ac.icon} size={fs(11)} color={tokens.blu} />
        <View style={[styles.wnTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.wnTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{REG_TYPE.ac.label}</Text>
        </View>
        {/* numberOfLines={1}, corpus-wide reg-number sweep: this card is a
            FIXED, unscaled width:190 (wnCard) -- missing here even though
            OtherWhatsNewCard right below (identical card/style, AD/LOI
            variant) already has it. Real AC document numbers run up to 12
            chars ("150/5320-12C"), tight enough in this narrow card to wrap
            at a larger accessibility text size with nothing stopping it. */}
        <Text style={[styles.wnAcNum, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={1}>
          {ac.document_number}{isOcrScanned(ac.document_number) ? ' *' : ''}
        </Text>
      </View>
      <Text style={[styles.wnTitle, { color: tokens.t2, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.4 }]} numberOfLines={2}>
        {ac.title}
      </Text>
    </Pressable>
  )
}

// AD/LOI variant -- simpler than AC's (no UPD/VER distinction, since we
// don't yet detect true re-revisions for these types), just a type tag +
// plain "NEW" + the real FAA date. See WhatsNewOther's header comment for
// why FAR/AIM/PCG aren't included here.
function OtherWhatsNewCard({
  item,
  tokens,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  item: WhatsNewOther
  tokens: ReturnType<typeof useTheme>['tokens']
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const dateStr = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const route = item.type === 'ad' ? `/ad/${item.documentNumber}` : `/loi/${item.id}`
  const meta = item.type === 'ad' ? REG_TYPE.ad : REG_TYPE.loi
  const title = item.type === 'ad' ? stripAdSubjectPrefix(item.title) : item.title

  return (
    <Pressable
      style={[styles.wnCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        router.push(route as any)
      }}
      onLongPress={(e) => showPreview(title, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={styles.wnTop}>
        <Badge kind="new" tokens={tokens} />
        <View style={{ flex: 1 }} />
        <Text style={[styles.wnDate, { color: tokens.t3, fontSize: fs(10.5) }]}>{dateStr}</Text>
      </View>
      <View style={styles.wnIdentRow}>
        <Icon name={meta.icon} size={fs(11)} color={tokens.blu} />
        <View style={[styles.wnTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.wnTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{meta.label}</Text>
        </View>
        <Text style={[styles.wnAcNum, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={1}>
          {item.documentNumber}
        </Text>
      </View>
      <Text style={[styles.wnTitle, { color: tokens.t2, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.4 }]} numberOfLines={2}>
        {title}
      </Text>
    </Pressable>
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({
  kind,
  tokens,
}: {
  kind: BadgeKind
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const badge = getBadgeStyle(kind, tokens)
  return (
    <View style={[styles.badge, { backgroundColor: badge.background, borderColor: badge.border }]}>
      <Text style={[styles.badgeText, { color: badge.color, fontSize: fs(9.5) }]}>
        {badge.label}
      </Text>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { paddingBottom: 24 },
  iconBtn: { padding: 6 },
  hobbsPickerBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  hobbsPickerCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, maxHeight: '70%' },
  hobbsPickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  hobbsPickerTitle: { fontWeight: '700' },
  hobbsPickerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  hobbsPickerHours: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8 },
  hobbsPickerManage: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 1, borderRadius: 10, paddingVertical: 12, marginTop: 14 },
  welcomeToast: {
    position: 'absolute',
    top: 60,
    alignSelf: 'center',
    zIndex: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 6,
  },
  welcomeToastText: { fontWeight: '700' },

  // Regulatory-body cards (redesign step 5)
  // RC: "slightly reduce the top/bottom space for these bars so more of the
  // regs show up on the page before needing to scroll down."
  regCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginHorizontal: 16,
    marginBottom: 6,
  },
  regAbbrBadge: {
    width: 46,
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  regAbbrText: { fontWeight: '800', letterSpacing: 0.3 },
  regLabel: { fontWeight: '600' },
  regCount: { marginTop: 2 },

  // Fixed search zone above the FlatList
  searchZone: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    gap: 10,
    zIndex: 20,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    height: 40,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 13.5,
    // outlineStyle is web-only (suppresses the native focus ring) and isn't
    // part of RN's TextStyle type in any form, so `as TextStyle` would just
    // trade this error for a "conversion may be a mistake" one — `as any`
    // is the correct escape hatch here, not a stronger type.
    outlineStyle: 'none',
  } as any,
  // Custom rich placeholder -- overlays the empty TextInput exactly (same
  // box, absolutely positioned) since a real `placeholder` string can't
  // carry SmartSearchLabel's per-letter styling. pointerEvents="none" on
  // the parent lets taps fall through to the real input underneath.
  customPlaceholder: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', overflow: 'hidden',
  },
  placeholderRest: { flexShrink: 1, marginLeft: 4 },
  cancelWrap: { paddingRight: 2 },
  cancelText: { fontSize: 14, fontWeight: '500' },

  filterBtn: {
    width: 38, height: 38, borderRadius: 11, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  filterBadge: {
    position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  // RC, live: white-on-blue at this size didn't show up well -- black reads
  // clearer against tokens.blu's mid-brightness. Same fix in study.tsx's
  // own copy of this badge.
  filterBadgeText: { color: '#000', fontSize: 9.5, fontWeight: '800' },

  filterStatusBar: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, margin: 12, marginBottom: 4,
  },
  filterStatusText: { flex: 1, fontWeight: '500' },
  filterStatusLink: { fontWeight: '700' },
  filterEmptyText: { textAlign: 'center', paddingVertical: 30 },

  filterRow: { borderRadius: 12, borderWidth: 1, padding: 12, marginHorizontal: 12, marginBottom: 8, gap: 4 },
  filterRowTop: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 2 },
  filterTypeTag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  filterTypeTagText: { fontWeight: '700', letterSpacing: 0.3 },
  filterRowPrimary: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(12) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as wnTitle above.
  filterRowSecondary: {},

  filterSectionTitle: { fontWeight: '700', letterSpacing: 0.5 },
  filterDateInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.25
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  citesHint: { marginTop: -2 },
  citesInputWrap: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 10, paddingRight: 4,
  },
  citesInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 9 },
  filterCitesChip: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
  },
  filterCitesChipText: { flex: 1, fontWeight: '600' },
  citesCandidateRow: { paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
  citesCandidateText: { fontWeight: '500' },

  // Backdrop — covers content area below the search zone
  backdrop: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.22)',
    zIndex: 10,
  },

  // Autocomplete dropdown — capped height + internal scroll. Previously this
  // had no height limit and no ScrollView, so once the keyboard (or dictation's
  // toolbar) was up, any results below the fold were simply unreachable: not
  // visible, not scrollable, nothing. Capping + scrolling means every result
  // is reachable even with the keyboard still open, on top of the keyboard
  // being independently dismissible without closing the dropdown.
  dropdown: {
    position: 'absolute',
    left: 12,
    right: 12,
    maxHeight: 340,
    borderRadius: 14,
    borderWidth: 1,
    overflow: 'hidden',
    zIndex: 15,
    elevation: 10,
  },
  dropScroll: { maxHeight: 340 },
  dropHideKb: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dropHideKbText: { fontSize: 11.5, fontWeight: '600' },
  dropCenter: { padding: 18, alignItems: 'center' },
  dropEmpty: { fontSize: 14 },
  dropRow: {
    flexDirection: 'row',
    // flex-start, not center: once the title can wrap to 2-3 lines, a
    // centred row leaves the reg number floating in the middle of the block.
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as wnTitle above.
  dropTitle: { flex: 1, fontSize: 13.5 },
  dropTypeBadge: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 3, width: 44, alignItems: 'center' },
  dropTypeBadgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3 },
  dropOtherPrimary: { fontSize: 12.5, fontWeight: '700', marginBottom: 1 },
  dropSeeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dropSeeAllText: { fontSize: 13, fontWeight: '500' },

  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  // Bumped from 15/600/no-spacing -- RC, 2026-08-05: a slight size/weight
  // pull on "What's New" and "Browse by Regulation" to draw the eye without
  // adding more color to the page.
  sectionTitle: { fontWeight: '700', fontSize: 16.5, letterSpacing: 0.3 },
  sectionSub: { fontSize: 13 },

  wnScroll: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  wnGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  wnEmpty: {
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  wnLockedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginHorizontal: 16, marginBottom: 4,
    borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 14,
  },
  wnLockedTitle: { fontWeight: '600', marginBottom: 2 },
  // lineHeight NOT set here -- always overridden inline with fs(12) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  wnLockedSub: {},
  // Same fix, fs(12.5) * 1.44.
  wnEmptyText: {},
  // Same outer/clip/spin/inner shape as MagicLinkPod's own styles (see
  // SilverShimmerFrame above) -- the 1.5px padding is what reveals the
  // rotating ring underneath; dailyRegCard has no borderWidth of its own
  // for the same reason ML's inner panel doesn't (a real border on top
  // would just cover the gradient back up). Inner radius is outer radius
  // minus that same padding, so the two stay concentric.
  dailyRegShimmerOuter: {
    marginHorizontal: 16, marginTop: 10, marginBottom: 4,
    borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, padding: 1.5,
    overflow: 'hidden',
  },
  dailyRegGradientClip: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  dailyRegSpinBase: {
    position: 'absolute',
  },
  // Only used for the one frame before onLayout reports real dimensions --
  // any oversized square works here since it's replaced immediately.
  dailyRegSpinFallback: {
    top: '-75%', left: '-75%', width: '250%', height: '250%',
  },
  dailyRegCard: {
    borderRadius: 11.5, padding: 12, overflow: 'hidden',
  },
  dailyRegRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dailyRegIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dailyRegLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 1 },
  dailyRegTerm: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  dailyRegDef: { marginTop: 10 },
  dailyRegCitation: { marginTop: 10, fontWeight: '600', letterSpacing: 0.3 },
  dailyRegJump: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    marginTop: 10, paddingVertical: 9, borderRadius: 9, borderWidth: 1,
  },
  dailyRegJumpText: { fontWeight: '600' },
  wnCard: {
    width: 190,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
  },
  wnTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  wnIdentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginBottom: 3,
  },
  wnTypeTag: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2 },
  wnTypeTagText: { fontWeight: '700', letterSpacing: 0.3 },
  wnDate: { fontSize: 10.5 },
  wnAcNum: { fontWeight: '700', fontSize: 15, marginBottom: 3 },
  // lineHeight NOT set here -- StyleSheet.create is module-scope, fs() is a
  // hook only available inside the component. See this file's two
  // `styles.wnTitle` JSX call sites for the actual scaled lineHeight, same
  // fix pattern as NoteEditor.tsx's bodyInput: fs(size) * ratio, applied
  // inline where fs() is actually in scope.
  wnTitle: { fontSize: 11.5 },

  badge: {
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },

})
