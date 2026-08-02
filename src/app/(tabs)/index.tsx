import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
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
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router, useFocusEffect } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
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
import { getRegOfTheDay, regOfTheDayRoute, type RegOfTheDay } from '@/lib/notifications'
import { consumeJustConfirmed } from '@/lib/justConfirmed'
import { FigureViewer } from '@/components/FigureViewer'
import { TabletContainer } from '@/components/TabletContainer'
import type { AcFigure } from '@/types'
import { getRecentSearches, addRecentSearch, removeRecentSearch, clearRecentSearches } from '@/lib/recentSearches'
import { ChipFilterSheet, ChipFilterSection } from '@/components/ChipFilterSheet'
import {
  filterDocuments, filterResultCount, routeForFilterResult, searchCitableDocuments,
  getFarPartOptions, getAcSeriesOptions, AUDIENCE_OPTIONS,
  type FilterParams, type FilterResultRow, type FilterableType, type FilterOption, type CitableDoc,
} from '@/lib/filterSearch'

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
  const { tokens } = useTheme()
  const { hasPlusAccess } = useAuth()
  const fs = useFS()
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
  const [regOfDay, setRegOfDay] = useState<RegOfTheDay | null>(null)
  const [loading, setLoading] = useState(true)
  const { badgeDays } = useBadgeLifespan()

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

  const openFilter = () => {
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
    try {
      const rows = await filterDocuments(activeFilterParams, 50, 0)
      setFilterResults(rows)
    } catch (_) {
      setFilterResults([])
    }
    setFilterResultsLoading(false)
  }

  const dismissFilterResults = () => {
    setFilterApplied(false)
    setFilterResults([])
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
    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(HOME_CACHE_KEY)
      if (cached) {
        const { totalCount: ct, whatsNew: cw, otherWhatsNew: cow } = JSON.parse(cached)
        if (ct != null) setTotalCount(ct)
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
        supabase
          .from('advisory_circulars')
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

      // Cache for next launch — fire-and-forget
      AsyncStorage.setItem(HOME_CACHE_KEY, JSON.stringify({
        totalCount: freshCount,
        whatsNew: freshWhatsNew,
        otherWhatsNew: freshOther,
      }))
    } catch (_) {
      // Network failed — cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [badgeDays])

  useEffect(() => { load() }, [load])

  // Independent of `load()` above -- today's pick doesn't depend on
  // badgeDays/cutoff logic. useFocusEffect (not a plain mount-only
  // useEffect) for the same reason as the welcome banner above: Home stays
  // mounted in the background, so a mount-only fetch would show the same
  // pick forever once the app crosses midnight without a full relaunch.
  // The RPC is cheap and keyed off CURRENT_DATE server-side, so refetching
  // on every focus is safe -- same-day refocuses just get the same row back.
  useFocusEffect(
    useCallback(() => {
      getRegOfTheDay().then(setRegOfDay).catch(() => {})
    }, [])
  )

  // Regulatory-body card counts -- fetched once, not tied to badgeDays like
  // load() above. head:true avoids PostgREST's project-wide 1000-row
  // max-rows cap entirely (no rows are actually returned, just a count) --
  // see far/index.tsx's comment for the full diagnosis of that cap biting a
  // naive select().
  useEffect(() => {
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
  }, [])

  // ── Search logic ─────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q: string) => {
    const trimmed = normalizeSearchQuery(q.trim())
    if (trimmed.length < 2) { searchSeq.current++; setSearchResults([]); setOtherResults([]); setSearchLoading(false); return }
    const seq = ++searchSeq.current
    // Recorded as soon as a real search fires (not gated on results coming
    // back non-empty) — a query the user typed is worth re-offering later
    // even if it happened to return nothing that one time.
    addRecentSearch(trimmed).then(setRecentSearches)

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
      Promise.all(searchTerms.map((t) => searchOtherSources(t, 20, otherTypes))).then((resultSets) => {
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
  }, [filterContentTypes])

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
    dismissSearch()
    router.push(`/ac/${id}`)
  }, [dismissSearch])

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
  }, [dismissSearch])

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
    const otherScored = otherResults.map((r) => {
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
      const viaTerm = direct.tier >= 4 && r.matchedTerm && r.matchedTerm !== eff
        ? relevanceTier(r.matchedTerm, r.id, r.secondary)
        : null
      const scored = viaTerm && viaTerm.tier <= 3 && viaTerm.tier < direct.tier ? viaTerm : direct
      // A concept anchor means the DB matched the QUESTION to the document
      // that answers it, which outranks any lexical tier. Without this,
      // "VFR cloud clearance requirements" put § 91.155 second behind
      // AC 61-98E ("Currency REQUIREMENTS...") -- both landed in tier 4 on
      // one title word each, and the tie broke on array position, throwing
      // away the relevance the search RPC had just computed.
      return { r, ...scored, tier: r.anchored ? 0 : scored.tier }
    })

    for (let tier = 0; tier <= 5; tier++) {
      const a = acScored.filter((x) => x.tier === tier)
      // RC: "the majority of AFR query material will come from FAR, AIM,
      // P/CG, ACs. The ADs and LOIs do need to be included... but hardly
      // the priority result in most cases." A stable sort (guaranteed
      // order-preserving for equal keys since ES2019) pushes AD entries to
      // the back of THIS tier's other-source bucket without touching
      // relative order among everything else, or disturbing which tier any
      // result lands in -- the tier computation above (anchors, viaTerm
      // rescue, etc.) is untouched.
      const b = otherScored.filter((x) => x.tier === tier).sort((x, y) => (x.r.type === 'ad' ? 1 : 0) - (y.r.type === 'ad' ? 1 : 0))
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

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader showWordmark />
      <TabletContainer>

      {showWelcome && (
        <Animated.View
          pointerEvents="none"
          style={[styles.welcomeToast, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, opacity: welcomeOpacity }]}
        >
          <Icon name="checkmark.circle.fill" size={18} color={tokens.grn} />
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
          <Icon name="magnifyingglass" size={17} color={searchActive ? tokens.blu : tokens.t3} />
          <TextInput
            ref={searchInputRef}
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(13.5) }]}
            placeholder='Reg number, keyword, or "phrase"…'
            placeholderTextColor={tokens.t3}
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
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => {
                setSearchQuery('')
                setSearchResults([])
                setSearchLoading(false)
              }}
              hitSlop={8}
            >
              <Icon name="xmark.circle" size={17} color={tokens.t4} />
            </Pressable>
          )}
        </View>
        {!showCancel && (
          <Pressable
            onPress={openFilter}
            style={[styles.filterBtn, { backgroundColor: tokens.inp, borderColor: activeFilterCount > 0 ? tokens.blu : tokens.bdr }]}
            hitSlop={4}
          >
            <Icon name="slider.horizontal.3" size={16} color={activeFilterCount > 0 ? tokens.blu : tokens.t3} />
            {activeFilterCount > 0 && (
              <View style={[styles.filterBadge, { backgroundColor: tokens.blu }]}>
                <Text style={styles.filterBadgeText}>{activeFilterCount}</Text>
              </View>
            )}
          </Pressable>
        )}
        {showCancel && (
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
          renderItem={({ item }) => <FilterResultRowView item={item} tokens={tokens} />}
        />
      ) : (
        <FlatList
          data={[
            { key: 'far', label: 'Federal Aviation Regulations', abbr: 'FAR', count: farCount, unit: 'sections', route: '/far' },
            { key: 'aim', label: 'Aeronautical Information Manual', abbr: 'AIM', count: aimCount, unit: 'paragraphs', route: '/aim' },
            { key: 'pcg', label: 'Pilot/Controller Glossary', abbr: 'P/CG', count: pcgCount, unit: 'terms', route: '/pcg' },
            { key: 'ad', label: 'Airworthiness Directives', abbr: 'AD', count: adCount, unit: 'directives', route: '/ad' },
            { key: 'loi', label: 'Legal Interpretations', abbr: 'LOI', count: loiCount, unit: 'interpretations', route: '/loi' },
            { key: 'ac', label: 'Advisory Circulars', abbr: 'AC', count: totalCount, unit: 'active', route: '/ac/library' },
            { key: 'dictionary', label: 'Aviation Dictionary', abbr: 'A/D', count: dictCount, unit: 'terms', route: '/dictionary' },
          ]}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.listContent}
          keyboardDismissMode="interactive"
          ListHeaderComponent={
            <HomeHeader
              tokens={tokens}
              whatsNew={whatsNew}
              otherWhatsNew={otherWhatsNew}
              badgeDays={badgeDays}
              hasPlusAccess={hasPlusAccess}
              regOfDay={regOfDay}
            />
          }
          renderItem={({ item }) => <RegBodyCard item={item} tokens={tokens} />}
        />
      )}

      <ChipFilterSheet
        visible={filterVisible}
        onClose={() => setFilterVisible(false)}
        title="Filter"
        subtitle="Everything is searched by default — pick chips only to narrow."
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
        <View style={{ gap: 8 }}>
          <Text style={[styles.filterSectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>DATE RANGE (ISSUED/UPDATED)</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              style={[styles.filterDateInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg2, fontSize: fs(13) }]}
              value={filterDateFrom}
              onChangeText={setFilterDateFrom}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={tokens.t4}
            />
            <TextInput
              style={[styles.filterDateInput, { color: tokens.t1, borderColor: tokens.bdr, backgroundColor: tokens.bg2, fontSize: fs(13) }]}
              value={filterDateTo}
              onChangeText={setFilterDateTo}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={tokens.t4}
            />
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <Text style={[styles.filterSectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>CITES THIS DOCUMENT</Text>
          <Text style={[styles.citesHint, { color: tokens.t4, fontSize: fs(11.5) }]}>
            Narrows results to only items that reference the FAR section, AIM paragraph, P/CG term, AC, or LOI you pick below.
          </Text>
          {filterCitesDoc ? (
            <Pressable
              style={[styles.filterCitesChip, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}
              onPress={() => setFilterCitesDoc(null)}
            >
              <Text style={[styles.filterCitesChipText, { color: tokens.gold, fontSize: fs(12.5) }]} numberOfLines={1}>
                {filterCitesDoc.label}
              </Text>
              <Icon name="xmark" size={12} color={tokens.gold} />
            </Pressable>
          ) : (
            <>
              <View style={[styles.citesInputWrap, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
                <TextInput
                  style={[styles.citesInput, { color: tokens.t1, fontSize: fs(13) }]}
                  value={citesQuery}
                  onChangeText={setCitesQuery}
                  placeholder="Search a FAR section, AIM paragraph, P/CG term, AC, or LOI…"
                  placeholderTextColor={tokens.t4}
                />
                {citesLoading && <ActivityIndicator size="small" color={tokens.t3} style={{ marginRight: 10 }} />}
              </View>
              {!citesLoading && citesCandidates.length === 0 && citesQuery.trim().length >= 2 && (
                <Text style={[styles.citesHint, { color: tokens.t4, fontSize: fs(12) }]}>No matches for "{citesQuery}".</Text>
              )}
              {citesCandidates.map((c) => (
                <Pressable
                  key={`${c.type}-${c.id}`}
                  style={[styles.citesCandidateRow, { borderTopColor: tokens.bdr }]}
                  onPress={() => { setFilterCitesDoc(c); setCitesQuery(''); setCitesCandidates([]) }}
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
        <View
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
          ]}
        >
          {/* Always-reachable keyboard dismiss — tapping the backdrop works too,
              but that only has empty space to tap when the dropdown doesn't
              fill it; this is a guaranteed target regardless of layout. */}
          <Pressable onPress={() => Keyboard.dismiss()} style={[styles.dropHideKb, { borderBottomColor: tokens.bdr }]}>
            <Icon name="chevron.down" size={13} color={tokens.t3} />
            <Text style={[styles.dropHideKbText, { color: tokens.t3, fontSize: fs(11.5) }]}>Hide keyboard</Text>
          </Pressable>

          {/* Once there are results, they stay on screen through subsequent
              re-searches (e.g. dictation's "final" commit re-firing onChangeText
              with unchanged text) — only the empty/first-load states get the
              spinner treatment. Previously `searchLoading` replaced the whole
              list with a spinner on every re-search, which is what made results
              flicker away and come back after releasing the mic button. */}
          {combinedResults.length > 0 ? (
            <ScrollView
              style={styles.dropScroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
              nestedScrollEnabled
            >
              {(hasPlusAccess ? combinedResults : combinedResults.slice(0, FREE_RESULT_CAP)).map((item) => (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [
                    styles.dropRow,
                    { borderBottomColor: tokens.bdr },
                    pressed && { backgroundColor: tokens.bg3 },
                  ]}
                  onPress={() => (item.ac ? selectResult(item.ac) : selectOtherResult(item.other!))}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.dropOtherPrimary, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
                      {item.ac
                        ? `${acResultPrimary(item.ac.document_number)}${isOcrScanned(item.ac.document_number) ? ' *' : ''}`
                        : item.other!.primary}
                    </Text>
                    {/* Full title, wrapped -- NOT clamped to one line. Two
                        sibling FAR sections routinely differ only past the
                        truncation point: "§ 121.649 Takeoff and landing
                        weather minimu..." and "§ 121.651 Takeoff and landing
                        weather minimu..." were indistinguishable in the
                        results, so the user couldn't tell which one they
                        needed. Uniform row height is worth less than being
                        able to read the result. */}
                    <Text style={[styles.dropTitle, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={3}>
                      {item.ac ? item.ac.title : item.other!.secondary}
                    </Text>
                  </View>
                </Pressable>
              ))}
              {!hasPlusAccess && combinedResults.length > FREE_RESULT_CAP && (
                <Pressable
                  style={[styles.dropSeeAll, { borderTopColor: tokens.bdr }]}
                  onPress={() => { dismissSearch(); router.push('/paywall?tier=plus') }}
                >
                  <Icon name="lock.fill" size={13} color={tokens.amb} />
                  <Text style={[styles.dropSeeAllText, { color: tokens.blu, fontSize: fs(13) }]}>
                    Unlock Plus for all {combinedResults.length} results
                  </Text>
                </Pressable>
              )}
            </ScrollView>
          ) : searchLoading ? (
            <View style={styles.dropCenter}>
              <ActivityIndicator size="small" color={tokens.blu} />
            </View>
          ) : (
            <View style={styles.dropCenter}>
              <Text style={[styles.dropEmpty, { color: tokens.t3, fontSize: fs(14) }]}>No results</Text>
            </View>
          )}
        </View>
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
        <View
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
          ]}
        >
          <View style={[styles.dropHideKb, { borderBottomColor: tokens.bdr, justifyContent: 'space-between' }]}>
            <Text style={[styles.dropHideKbText, { color: tokens.t3, fontSize: fs(11.5) }]}>Recent searches</Text>
            <Pressable onPress={clearAllRecentSearches} hitSlop={8}>
              <Text style={[styles.dropHideKbText, { color: tokens.blu, fontSize: fs(11.5) }]}>Clear</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.dropScroll}
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
                  <Icon name="clock" size={14} color={tokens.t3} />
                  <Text style={[styles.dropTitle, { color: tokens.t1, fontSize: fs(13.5), marginLeft: 10 }]} numberOfLines={1}>
                    {q}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => removeOneRecentSearch(q)}
                  hitSlop={10}
                  style={({ pressed }) => [{ paddingHorizontal: 14, paddingVertical: 10 }, pressed && { opacity: 0.5 }]}
                >
                  <Icon name="xmark" size={13} color={tokens.t4} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      </TabletContainer>
    </View>
  )
}

// ─── Header (What's New + Library label) ─────────────────────────────────────

function HomeHeader({
  tokens,
  whatsNew,
  otherWhatsNew,
  badgeDays,
  hasPlusAccess,
  regOfDay,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  whatsNew: WhatsNewAC[]
  otherWhatsNew: WhatsNewOther[]
  badgeDays: number
  hasPlusAccess: boolean
  regOfDay: RegOfTheDay | null
}) {
  const fs = useFS()

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
        <View style={[styles.sectionLabel, { justifyContent: 'flex-start', gap: 8 }]}>
          <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(15) }]}>What's New</Text>
        </View>
        <Pressable
          style={[styles.wnLockedCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={() => router.push('/paywall?tier=plus')}
        >
          <Icon name="lock.fill" size={18} color={tokens.amb} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.wnLockedTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>
              See what's new and changed
            </Text>
            <Text style={[styles.wnLockedSub, { color: tokens.t3, fontSize: fs(12) }]}>
              Unlock Plus to track new and updated ACs, with real diffs of exactly what changed.
            </Text>
          </View>
          <Icon name="chevron.right" size={14} color={tokens.t4} />
        </Pressable>
        <DailyRegCard regOfDay={regOfDay} tokens={tokens} />
      </>
    )
  }

  return (
    <>
      {/* What's New strip — always shown, even with zero results, so a user
          isn't left wondering why the whole section vanished; the empty
          state tells them to widen Badge Duration if they expect to see
          something. Now spans AC + AD + LOI (each has a real, genuinely-
          varied FAA-side date) -- FAR/AIM/PCG still can't join honestly
          until they get real incremental revision-detection of their own
          (see WhatsNewOther's header comment); content_revisions exists in
          schema but is confirmed empty for every doc type right now, so
          it isn't a usable source yet either. */}
      <View style={[styles.sectionLabel, { justifyContent: 'flex-start', gap: 8 }]}>
        <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(15) }]}>What's New</Text>
        <Text style={[styles.sectionSub, { color: tokens.t3, fontSize: fs(11.5) }]}>Last {badgeDays} days</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => router.push('/whats-changed' as any)} hitSlop={8}>
          <Text style={[styles.sectionSub, { color: tokens.blu, fontWeight: '600', fontSize: fs(11.5) }]}>
            See changes ›
          </Text>
        </Pressable>
      </View>
      {mergedWhatsNew.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.wnScroll}
        >
          {mergedWhatsNew.map((entry) =>
            entry.kind === 'ac' ? (
              <WhatsNewCard key={`ac-${entry.item.id}`} ac={entry.item} tokens={tokens} badgeDays={badgeDays} />
            ) : (
              <OtherWhatsNewCard key={`${entry.item.type}-${entry.item.id}`} item={entry.item} tokens={tokens} />
            )
          )}
        </ScrollView>
      ) : (
        <View style={[styles.wnEmpty, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Text style={[styles.wnEmptyText, { color: tokens.t3, fontSize: fs(12.5) }]}>
            Nothing issued or updated in the last {badgeDays} day{badgeDays === 1 ? '' : 's'}. Try a longer Badge Duration in the menu to see more.
          </Text>
        </View>
      )}

      <DailyRegCard regOfDay={regOfDay} tokens={tokens} />

      {/* Regulatory-body cards label */}
      <View style={styles.sectionLabel}>
        <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(15) }]}>Browse by Regulation</Text>
      </View>
    </>
  )
}

// ─── DailyReg card (collapsed by default, expand or jump to the full term) ──
// Shares the get_reg_of_the_day() rotation with the daily push notification
// (see scripts/send-reg-of-day.mjs) so the in-app pick always matches
// whatever a Pro/Premium user with the push toggle on saw today -- this is
// just an always-visible, no-push-required way to see it, since P/CG itself
// is free to browse regardless of tier.
// DailyReg is a PAID feature (Plus and above), not free — confirmed with RC
// 2026-07-31. It used to render for everyone, giving away a curated reg a day
// to free users. Renders a locked teaser instead so the feature is still
// discoverable (and sells itself) rather than vanishing.
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

function DailyRegCard({ regOfDay, tokens }: { regOfDay: RegOfTheDay | null; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [expanded, setExpanded] = useState(false)
  if (!regOfDay) return null
  if (!hasPlusAccess) {
    return (
      <Pressable
        style={[styles.dailyRegCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
        onPress={() => router.push('/paywall?tier=plus')}
      >
        <View style={styles.dailyRegRow}>
          <View style={[styles.dailyRegIcon, { backgroundColor: tokens.goldlt }]}>
            <Icon name="lock.fill" size={13} color={tokens.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <DailyRegLabel color={tokens.t3} fs={fs} />
            <Text style={[styles.dailyRegTerm, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
              A hand-picked reg every day — unlock with Plus
            </Text>
          </View>
          <Icon name="chevron.right" size={13} color={tokens.t4} />
        </View>
      </Pressable>
    )
  }
  return (
    <Pressable
      style={[styles.dailyRegCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => setExpanded((e) => !e)}
    >
      <View style={styles.dailyRegRow}>
        <View style={[styles.dailyRegIcon, { backgroundColor: tokens.goldlt }]}>
          <Icon name="star.fill" size={14} color={tokens.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <DailyRegLabel color={tokens.t3} fs={fs} suffix={regOfDay.sourceType.toUpperCase()} />
          <Text style={[styles.dailyRegTerm, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={expanded ? undefined : 1}>
            {regOfDay.term}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t4} />
      </View>
      {expanded && (
        <>
          <Text style={[styles.dailyRegDef, { color: tokens.t2, fontSize: fs(13.5) }]}>{regOfDay.definition}</Text>
          <Pressable
            style={[styles.dailyRegJump, { borderColor: tokens.bdr }]}
            onPress={() => router.push(regOfTheDayRoute(regOfDay) as any)}
          >
            <Text style={[styles.dailyRegJumpText, { color: tokens.blu, fontSize: fs(13) }]}>Open full entry</Text>
            <Icon name="chevron.right" size={12} color={tokens.blu} />
          </Pressable>
        </>
      )}
    </Pressable>
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
        <Icon name={REG_TYPE[item.key as keyof typeof REG_TYPE].icon} size={15} color={tokens.blu} />
        <Text style={[styles.regAbbrText, { color: tokens.blu, fontSize: fs(11) }]}>{item.abbr}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.regLabel, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.label}</Text>
        <Text style={[styles.regCount, { color: tokens.t3, fontSize: fs(12) }]}>
          {item.count !== null ? `${item.count.toLocaleString()} ${item.unit}` : '…'}
        </Text>
      </View>
      <Icon name="chevron.right" size={14} color={tokens.t4} />
    </Pressable>
  )
}

// ─── Filter result row ───────────────────────────────────────────────────────

function FilterResultRowView({
  item,
  tokens,
}: {
  item: FilterResultRow
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const meta = REG_TYPE[item.itemType]
  return (
    <Pressable
      style={[styles.filterRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => router.push(routeForFilterResult(item) as any)}
    >
      <View style={styles.filterRowTop}>
        <Icon name={meta.icon} size={11} color={tokens.blu} />
        <View style={[styles.filterTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.filterTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{meta.label}</Text>
        </View>
      </View>
      <Text style={[styles.filterRowPrimary, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>{item.primaryLabel}</Text>
      {item.secondaryLabel ? (
          <Text style={[styles.filterRowSecondary, { color: tokens.t3, fontSize: fs(12) }]} numberOfLines={4}>{item.secondaryLabel}</Text>
      ) : null}
    </Pressable>
  )
}

// ─── What's New card ─────────────────────────────────────────────────────────

function WhatsNewCard({
  ac,
  tokens,
  badgeDays,
}: {
  ac: WhatsNewAC
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
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
      onPress={() => router.push(`/ac/${ac.id}`)}
    >
      <View style={styles.wnTop}>
        {showBadge && <Badge kind={getBadgeKind(ac)} tokens={tokens} />}
        <View style={{ flex: 1 }} />
        <Text style={[styles.wnDate, { color: tokens.t3, fontSize: fs(10.5) }]}>{dateStr}</Text>
      </View>
      <View style={styles.wnIdentRow}>
        <Icon name={REG_TYPE.ac.icon} size={11} color={tokens.blu} />
        <View style={[styles.wnTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.wnTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{REG_TYPE.ac.label}</Text>
        </View>
        <Text style={[styles.wnAcNum, { color: tokens.t1, fontSize: fs(15) }]}>
          {ac.document_number}{isOcrScanned(ac.document_number) ? ' *' : ''}
        </Text>
      </View>
      <Text style={[styles.wnTitle, { color: tokens.t2, fontSize: fs(11.5) }]} numberOfLines={2}>
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
}: {
  item: WhatsNewOther
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const dateStr = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const route = item.type === 'ad' ? `/ad/${item.documentNumber}` : `/loi/${item.id}`
  const meta = item.type === 'ad' ? REG_TYPE.ad : REG_TYPE.loi

  return (
    <Pressable
      style={[styles.wnCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => router.push(route as any)}
    >
      <View style={styles.wnTop}>
        <Badge kind="new" tokens={tokens} />
        <View style={{ flex: 1 }} />
        <Text style={[styles.wnDate, { color: tokens.t3, fontSize: fs(10.5) }]}>{dateStr}</Text>
      </View>
      <View style={styles.wnIdentRow}>
        <Icon name={meta.icon} size={11} color={tokens.blu} />
        <View style={[styles.wnTypeTag, { backgroundColor: tokens.bdim }]}>
          <Text style={[styles.wnTypeTagText, { color: tokens.blu, fontSize: fs(9) }]}>{meta.label}</Text>
        </View>
        <Text style={[styles.wnAcNum, { color: tokens.t1, fontSize: fs(15) }]} numberOfLines={1}>
          {item.documentNumber}
        </Text>
      </View>
      <Text style={[styles.wnTitle, { color: tokens.t2, fontSize: fs(11.5) }]} numberOfLines={2}>
        {item.title}
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
  filterBadgeText: { color: '#fff', fontSize: 9.5, fontWeight: '800' },

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
  filterRowSecondary: { lineHeight: 16 },

  filterSectionTitle: { fontWeight: '700', letterSpacing: 0.5 },
  filterDateInput: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  citesHint: { lineHeight: 15, marginTop: -2 },
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
  dropTitle: { flex: 1, fontSize: 13.5, lineHeight: 18 },
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
  sectionTitle: { fontWeight: '600', fontSize: 15 },
  sectionSub: { fontSize: 11.5 },

  wnScroll: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
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
  wnLockedSub: { lineHeight: 16 },
  wnEmptyText: { lineHeight: 18 },
  dailyRegCard: {
    marginHorizontal: 16, marginTop: 10, marginBottom: 4,
    borderRadius: 12, borderWidth: 1, padding: 12,
  },
  dailyRegRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dailyRegIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dailyRegLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 1 },
  dailyRegTerm: { fontWeight: '700' },
  dailyRegDef: { lineHeight: 19, marginTop: 10 },
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
  wnTitle: { fontSize: 11.5, lineHeight: 16 },

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
