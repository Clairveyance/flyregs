import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  TextInput,
  FlatList,
  ScrollView,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import type { ACSeries } from '@/types'
import { rankSearchResults, isPhrasedQuery, extractPhrase } from '@/lib/searchRank'
import { getACIndex, searchLocal, isACQuery, ACIndexEntry } from '@/lib/acIndex'
import { collapseDictationDuplicate, normalizeSearchQuery } from '@/lib/dictation'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'

// Session-scoped result cache: same query returns instantly without a network hit.
const _resultCache = new Map<string, SearchResult[]>()
function _cacheSet(key: string, results: SearchResult[]) {
  if (_resultCache.size >= 25) _resultCache.delete(_resultCache.keys().next().value!)
  _resultCache.set(key, results)
}

// ─── Category definitions ─────────────────────────────────────────────────────
// Series not listed here fall into "General"

const EXPLICIT_CATS: Record<string, string[]> = {
  Airmen:      ['61', '63', '65', '67'],
  Aircraft:    ['20', '21', '23', '25', '27', '29', '33', '35', '36', '39'],
  Operations:  ['71', '73', '90', '91', '93', '120', '121', '125', '129', '133', '135', '137'],
  Airports:    ['141', '142', '145', '150'],
  Maintenance: ['43', '45'],
}

const CAT_ORDER = ['General', 'Airmen', 'Aircraft', 'Operations', 'Airports', 'Maintenance'] as const

interface CategoryInfo {
  name: string
  seriesList: ACSeries[]
  acCount: number
}

function buildCategories(allSeries: ACSeries[]): CategoryInfo[] {
  const mappedPrefixes = new Set(Object.values(EXPLICIT_CATS).flat())
  return CAT_ORDER.map((catName) => {
    const seriesList =
      catName === 'General'
        ? allSeries.filter((s) => !mappedPrefixes.has(s.series_prefix))
        : allSeries.filter((s) => (EXPLICIT_CATS[catName] ?? []).includes(s.series_prefix))
    const acCount = seriesList.reduce((sum, s) => sum + s.ac_count, 0)
    return { name: catName, seriesList, acCount }
  })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface SearchResult {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  subject_series: string | null
  description: string | null
  rank: number
  // Only populated for results sourced from a direct .select() query below --
  // the search_acs RPC's own return columns aren't guaranteed to include
  // these, so RPC-sourced rows just won't show a badge (getBadgeKind treats
  // missing cancels/changed_block_indices as "new", a safe fallback).
  cancels?: string[]
  changed_block_indices?: number[] | null
}

// Result ranking lives in @/lib/searchRank (rankSearchResults), shared with the
// Home quick-search dropdown so both surface the right AC number first.

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function SearchScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { badgeDays } = useBadgeLifespan()
  const { q: navQuery } = useLocalSearchParams<{ q?: string }>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [series, setSeries] = useState<ACSeries[]>([])
  const [searching, setSearching] = useState(false)
  const [isPhraseSearch, setIsPhraseSearch] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Monotonic token: only the most-recently-started search may write results.
  const searchSeq = useRef(0)
  // Local index ref — populated by the preload effect below.
  const localIndexRef = useRef<ACIndexEntry[]>([])

  // Pre-fill query when navigated from home's "See all results"
  useEffect(() => {
    if (typeof navQuery === 'string' && navQuery.trim().length >= 2) {
      setQuery(navQuery.trim())
    }
  }, [navQuery])

  // Warm the local index in the background so it's ready for the first search.
  useEffect(() => {
    getACIndex().then((idx) => { localIndexRef.current = idx })
  }, [])

  const handleQueryChange = useCallback((raw: string) => {
    setQuery(collapseDictationDuplicate(raw))
  }, [])

  useEffect(() => {
    supabase
      .from('series_summary')
      .select('*')
      .order('sort_order')
      .then(({ data }) => {
        if (data) setSeries(data as ACSeries[])
      })
  }, [])

  const runSearch = useCallback(async (q: string) => {
    const trimmed = normalizeSearchQuery(q.trim())
    if (trimmed.length < 2) {
      searchSeq.current++
      setResults([])
      setSearching(false)
      setIsPhraseSearch(false)
      return
    }
    const seq = ++searchSeq.current
    setSearching(true)

    // ── Result cache: return instantly for repeated queries ───────────────────
    if (_resultCache.has(trimmed)) {
      if (seq === searchSeq.current) {
        setResults(_resultCache.get(trimmed)!)
        setSearching(false)
        setIsPhraseSearch(isPhrasedQuery(trimmed))
      }
      return
    }

    // ── Show local results immediately while network queries run ─────────────
    const localHits = searchLocal(trimmed, localIndexRef.current)
    if (localHits.length > 0 && seq === searchSeq.current) {
      setResults(localHits as unknown as SearchResult[])
      setSearching(false)
    }

    // ── Phrase search: user wrapped query in "double quotes" ─────────────────
    if (isPhrasedQuery(trimmed)) {
      const phrase = extractPhrase(trimmed)
      if (!phrase || phrase.length < 2) {
        setResults([]); setSearching(false); setIsPhraseSearch(false); return
      }
      setIsPhraseSearch(true)
      const cols = 'id, document_number, title, date_issued, subject_series, description, cancels, changed_block_indices'
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
      const ranked = rankSearchResults(phrase, merged)
      _cacheSet(trimmed, ranked)
      if (seq === searchSeq.current) { setResults(ranked); setSearching(false) }
      return
    }

    setIsPhraseSearch(false)

    const cols = 'id, document_number, title, date_issued, subject_series, description, cancels, changed_block_indices'
    const acNum = isACQuery(trimmed)

    // AC-number queries: prefix + contains are sufficient — skip the full-text RPC.
    // Keyword queries: fire RPC + title ilike (drop the redundant doc-number queries
    // since local index already covered those instantly above).
    const networkResults = acNum
      ? await Promise.all([
          supabase.from('advisory_circulars').select(cols).eq('status', 'active')
            .ilike('document_number', `${trimmed}%`).order('document_number').limit(20),
          supabase.from('advisory_circulars').select(cols).eq('status', 'active')
            .ilike('document_number', `%${trimmed}%`).order('document_number').limit(20),
        ])
      : await Promise.all([
          supabase.rpc('search_acs', { query: trimmed, result_limit: 50 }),
          supabase.from('advisory_circulars').select(cols).eq('status', 'active')
            .ilike('title', `%${trimmed}%`).order('document_number').limit(20),
        ])

    if (seq !== searchSeq.current) return

    // Merge network results, deduped by id, local hits first for stable ordering.
    const seenIds = new Set<string>()
    const merged: SearchResult[] = []

    // Seed with local hits (already shown to user)
    for (const e of localHits) {
      seenIds.add(e.id)
      merged.push({ ...e, rank: 0 } as SearchResult)
    }

    if (acNum) {
      const [prefixRes, numRes] = networkResults
      for (const r of [...((prefixRes.data ?? []) as SearchResult[]), ...((numRes.data ?? []) as SearchResult[])]) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push({ ...r, rank: 0 }) }
      }
    } else {
      const [rpcRes, titleRes] = networkResults

      // RPC failed + no local hits → broad ilike fallback
      if (rpcRes.error && localHits.length === 0) {
        const { data } = await supabase
          .from('advisory_circulars')
          .select(cols)
          .eq('status', 'active')
          .or(`document_number.ilike.%${trimmed}%,title.ilike.%${trimmed}%,description.ilike.%${trimmed}%`)
          .order('document_number')
          .limit(50)
        if (seq !== searchSeq.current) return
        const ranked = rankSearchResults(trimmed, (data ?? []) as SearchResult[])
        _cacheSet(trimmed, ranked)
        setResults(ranked); setSearching(false)
        return
      }

      for (const r of [...((rpcRes.data ?? []) as SearchResult[]), ...((titleRes.data ?? []) as SearchResult[])]) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r) }
      }
    }

    if (seq !== searchSeq.current) return
    const ranked = rankSearchResults(trimmed, merged)
    _cacheSet(trimmed, ranked)
    setResults(ranked)
    setSearching(false)
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length >= 2) {
      setSearching(true)
      debounceRef.current = setTimeout(() => runSearch(query), 300)
    } else {
      setResults([])
      setSearching(false)
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, runSearch])

  const showBrowse = query.trim().length < 2

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader title="Search" />

      {/* Live search bar */}
      <View style={[styles.barWrap, { backgroundColor: tokens.bg, borderBottomColor: tokens.bdr }]}>
        <View style={[styles.bar, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={17} color={tokens.t3} />
          <TextInput
            style={[styles.input, { color: tokens.t1, fontSize: fs(14.5) }]}
            placeholder='AC number, keyword, or "phrase"…'
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleQueryChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon name="xmark.circle" size={17} color={tokens.t4} />
            </Pressable>
          )}
        </View>
      </View>

      {showBrowse ? (
        <BrowseView series={series} tokens={tokens} />
      ) : searching ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : results.length === 0 ? (
        <View style={styles.center}>
          <Icon name="magnifyingglass" size={34} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>
            {isPhraseSearch ? 'No exact matches' : 'No results'}
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            {isPhraseSearch
              ? 'No ACs found containing that exact phrase.\nRemove the quotes for a broader keyword search.'
              : 'Try a different term or browse by category below.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          ListHeaderComponent={
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {results.length} RESULT{results.length !== 1 ? 'S' : ''}
            </Text>
          }
          renderItem={({ item }) => <ResultRow item={item} tokens={tokens} badgeDays={badgeDays} />}
        />
      )}
    </View>
  )
}

// ─── Browse view ─────────────────────────────────────────────────────────────

// ─── Search tips ─────────────────────────────────────────────────────────────

const TIPS = [
  { before: 'Case-insensitive — "IFR" and "ifr" return the same results.' },
  { before: 'Wrap a phrase in quotes for exact matching: ', example: '"instrument currency"' },
  { before: 'Multiple keywords find ACs that contain all of them.' },
  { before: 'Word forms are matched — "fly" also finds "flying" and "flies".' },
]

function SearchTips({ tokens }: { tokens: ReturnType<typeof useTheme>['tokens'] }) {
  const fs = useFS()
  return (
    <View style={[tipStyles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Text style={[tipStyles.header, { color: tokens.t3, fontSize: fs(11) }]}>SEARCH TIPS</Text>
      {TIPS.map((tip, i) => (
        <View key={i} style={tipStyles.row}>
          <Text style={[tipStyles.chevron, { color: tokens.blu, fontSize: fs(16) }]}>›</Text>
          <Text style={[tipStyles.text, { color: tokens.t2, fontSize: fs(13) }]}>
            {tip.before}
            {tip.example
              ? <Text style={{ color: tokens.blu, fontWeight: '600', fontSize: fs(13) }}>{tip.example}</Text>
              : null}
          </Text>
        </View>
      ))}
    </View>
  )
}

const tipStyles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 14 },
  header: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7, marginBottom: 10 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 7 },
  chevron: { fontSize: 16, lineHeight: 20, fontWeight: '700' },
  text: { flex: 1, fontSize: 13, lineHeight: 19 },
})

// ─── Browse view ─────────────────────────────────────────────────────────────

function BrowseView({
  series,
  tokens,
}: {
  series: ACSeries[]
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const [selectedCat, setSelectedCat] = useState<string | null>(null)
  const categories = useMemo(() => buildCategories(series), [series])
  const expanded = selectedCat ? categories.find((c) => c.name === selectedCat) : null
  const scrollRef = useRef<ScrollView>(null)
  // Position of the expanded category's own header ("OPERATIONS" etc.) within
  // the ScrollView's content, from its own onLayout -- it's a direct child of
  // the ScrollView here (no extra nested wrapper to sum through, unlike
  // ACBody's jump math), so this one value is already usable as-is.
  const expandedHeaderYRef = useRef(0)

  const toggleCat = (name: string) => {
    const opening = selectedCat !== name
    setSelectedCat((prev) => (prev === name ? null : name))
    if (opening) {
      // Tapping a category reveals its series list below the 6-box grid, but
      // the ScrollView itself never moves -- on a normal-height screen the
      // newly-revealed list renders entirely below the fold, so a reader sees
      // no visible change at all and assumes the tap did nothing. The 80ms
      // delay lets the just-opened header's onLayout land before we read its
      // position, matching the same "let a just-triggered layout settle
      // before reading it" pattern already used for the TOC-collapse jump in
      // ACBody.tsx.
      setTimeout(() => {
        scrollRef.current?.scrollTo({ y: Math.max(0, expandedHeaderYRef.current - 12), animated: true })
      }, 80)
    }
  }

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={styles.browseContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
    >
      <SearchTips tokens={tokens} />
      <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>BROWSE BY CATEGORY</Text>

      {/* 2-column category grid */}
      <View style={styles.catGrid}>
        {categories.map((cat) => {
          const active = selectedCat === cat.name
          return (
            <Pressable
              key={cat.name}
              style={[
                styles.catCard,
                {
                  backgroundColor: tokens.bg2,
                  borderColor: active ? tokens.blu : tokens.bdr,
                },
              ]}
              onPress={() => toggleCat(cat.name)}
            >
              <Text style={[styles.catName, { color: active ? tokens.blu : tokens.t1, fontSize: fs(15.5) }]}>
                {cat.name}
              </Text>
              {series.length > 0 ? (
                <Text style={[styles.catMeta, { color: tokens.t3, fontSize: fs(11.5) }]}>
                  {cat.seriesList.length} series · {cat.acCount} ACs
                </Text>
              ) : (
                <Text style={[styles.catMeta, { color: tokens.t4, fontSize: fs(11.5) }]}>Loading…</Text>
              )}
            </Pressable>
          )
        })}
      </View>

      {/* Expanded series for selected category */}
      {expanded && expanded.seriesList.length > 0 && (
        <>
          <Text
            onLayout={(e) => { expandedHeaderYRef.current = e.nativeEvent.layout.y }}
            style={[styles.groupLabel, { color: tokens.t3, marginTop: 16, fontSize: fs(11) }]}
          >
            {expanded.name.toUpperCase()}
          </Text>
          {expanded.seriesList.map((item) => (
            <Pressable
              key={item.series_prefix}
              style={[styles.seriesRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push(`/series/${item.series_prefix}`)}
            >
              <Text style={[styles.seriesPrefix, { color: tokens.t3, fontSize: fs(14) }]}>
                {item.series_prefix}
              </Text>
              <Text style={[styles.seriesName, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                {item.display_name}
              </Text>
              <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{item.ac_count}</Text>
              </View>
              <Icon name="chevron.right" size={14} color={tokens.t4} />
            </Pressable>
          ))}
        </>
      )}
    </ScrollView>
  )
}

// ─── Result row ───────────────────────────────────────────────────────────────

function ResultRow({
  item,
  tokens,
  badgeDays,
}: {
  item: SearchResult
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.resultRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => router.push(`/ac/${item.id}`)}
    >
      <View style={styles.resultNumBadgeWrap}>
        <Text style={[styles.resultNum, { color: tokens.blu, fontSize: fs(12.5) }]}>
          {item.document_number}{isOcrScanned(item.document_number) ? ' *' : ''}
        </Text>
        {isWithinBadgeLifespan(item.date_issued, badgeDays) && (() => {
          const badge = getBadgeStyle(getBadgeKind(item), tokens)
          return (
            <View style={[styles.resultNumBadge, { backgroundColor: badge.background, borderColor: badge.border }]}>
              <Text style={[styles.resultNumBadgeText, { color: badge.color, fontSize: fs(8) }]}>{badge.label}</Text>
            </View>
          )
        })()}
      </View>
      <Text style={[styles.resultTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
        {item.title}
      </Text>
      {item.description ? (
        <Text style={[styles.resultDesc, { color: tokens.t3, fontSize: fs(12.5) }]} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}
      <View style={styles.resultMeta}>
        {item.subject_series ? (
          <Text style={[styles.metaChip, { color: tokens.t4, fontSize: fs(11) }]}>Series {item.subject_series}</Text>
        ) : null}
        {item.date_issued ? (
          <Text style={[styles.metaChip, { color: tokens.t4, fontSize: fs(11) }]}>
            {new Date(item.date_issued).getFullYear()}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontWeight: '600', fontSize: 16, marginTop: 8 },
  emptySub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20 },

  barWrap: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    height: 42,
    borderRadius: 13,
    borderWidth: 1,
    paddingHorizontal: 12,
  },
  input: { flex: 1, fontSize: 14.5 },

  browseContent: { padding: 12, paddingBottom: 40 },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingLeft: 2,
  },

  // Category grid — 2-column wrap
  catGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 4,
  },
  catCard: {
    width: '48%',
    borderRadius: 14,
    borderWidth: 1,
    padding: 15,
  },
  catName: {
    fontWeight: '700',
    fontSize: 15.5,
  },
  catMeta: {
    fontSize: 11.5,
    marginTop: 4,
  },

  // Series rows inside expanded category
  seriesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 6,
    gap: 10,
  },
  seriesPrefix: { fontWeight: '700', fontSize: 14, width: 34, textAlign: 'center' },
  seriesName: { flex: 1, fontWeight: '500', fontSize: 14 },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontSize: 11.5, fontWeight: '600' },

  // Search result rows
  list: { padding: 12, paddingBottom: 32 },
  resultRow: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
    gap: 4,
  },
  resultNum: { fontWeight: '700', fontSize: 12.5 },
  resultNumBadgeWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resultNumBadge: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 1.5 },
  resultNumBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  resultTitle: { fontWeight: '500', fontSize: 14.5, lineHeight: 20 },
  resultDesc: { fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  resultMeta: { flexDirection: 'row', gap: 12, marginTop: 4 },
  metaChip: { fontSize: 11 },
})
