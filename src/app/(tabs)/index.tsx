import { useEffect, useState, useCallback, useRef } from 'react'
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
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import type { ACSeries } from '@/types'
import { rankSearchResults, isPhrasedQuery, extractPhrase } from '@/lib/searchRank'
import { collapseDictationDuplicate } from '@/lib/dictation'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'

const HOME_CACHE_KEY = '@flyregs/home-cache'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WhatsNewAC {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  cancels: string[]
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
  const fs = useFS()
  const [series, setSeries] = useState<ACSeries[]>([])
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [whatsNew, setWhatsNew] = useState<WhatsNewAC[]>([])
  const [loading, setLoading] = useState(true)
  const { badgeDays } = useBadgeLifespan()

  // Inline search state
  const [searchQuery, setSearchQuery] = useState('')
  const [searchActive, setSearchActive] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [dropdownTop, setDropdownTop] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the most-recent search may write results (guards against a slow earlier
  // query resolving late and clobbering the latest query's ranked results).
  const searchSeq = useRef(0)

  const load = useCallback(async () => {
    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(HOME_CACHE_KEY)
      if (cached) {
        const { series: cs, totalCount: ct, whatsNew: cw } = JSON.parse(cached)
        if (cs?.length) setSeries(cs as ACSeries[])
        if (ct != null) setTotalCount(ct)
        if (cw?.length) setWhatsNew(cw as WhatsNewAC[])
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data in the background (or blocking if no cache)
    try {
      // Same rolling clock as the NEW/UPD badges (Drawer > Badge Lifespan) —
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

      const [seriesRes, countRes, whatsNewRes] = await Promise.all([
        supabase.from('series_summary').select('*').order('sort_order'),
        supabase
          .from('advisory_circulars')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'active'),
        supabase
          .from('advisory_circulars')
          .select('id, document_number, title, date_issued, cancels')
          .eq('status', 'active')
          .gte('date_issued', cutoff)
          .order('date_issued', { ascending: false })
          .limit(20),
      ])

      const freshSeries = (seriesRes.data ?? []) as ACSeries[]
      const freshCount = countRes.count
      const freshWhatsNew = (whatsNewRes.data ?? []) as WhatsNewAC[]

      if (freshSeries.length) setSeries(freshSeries)
      if (freshCount !== null) setTotalCount(freshCount)
      setWhatsNew(freshWhatsNew)

      // Cache for next launch — fire-and-forget
      AsyncStorage.setItem(HOME_CACHE_KEY, JSON.stringify({
        series: freshSeries,
        totalCount: freshCount,
        whatsNew: freshWhatsNew,
      }))
    } catch (_) {
      // Network failed — cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [badgeDays])

  useEffect(() => { load() }, [load])

  // ── Search logic ─────────────────────────────────────────────────────────────

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { searchSeq.current++; setSearchResults([]); setSearchLoading(false); return }
    const seq = ++searchSeq.current

    // ── Phrase search: user wrapped query in "double quotes" ─────────────────
    if (isPhrasedQuery(trimmed)) {
      const phrase = extractPhrase(trimmed)
      if (!phrase || phrase.length < 2) {
        setSearchResults([]); setSearchLoading(false); return
      }
      const cols = 'id, document_number, title, date_issued, subject_series, description'
      const [titleRes, descRes, rpcRes] = await Promise.all([
        supabase.from('advisory_circulars').select(cols).eq('status', 'active')
          .ilike('title', `%${phrase}%`).order('document_number').limit(12),
        supabase.from('advisory_circulars').select(cols).eq('status', 'active')
          .ilike('description', `%${phrase}%`).order('document_number').limit(10),
        supabase.rpc('search_acs', { query: phrase, result_limit: 15 }),
      ])
      if (seq !== searchSeq.current) return
      const seenIds = new Set<string>()
      const merged: SearchResult[] = []
      for (const src of [titleRes.data, descRes.data, rpcRes.data]) {
        for (const r of (src ?? []) as SearchResult[]) {
          if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r) }
        }
      }
      setSearchResults(rankSearchResults(phrase, merged).slice(0, 8))
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
    const [rpcRes, prefixRes, numRes, titleRes] = await Promise.all([
      supabase.rpc('search_acs', { query: trimmed, result_limit: 10 }),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('document_number', `${trimmed}%`).order('document_number').limit(12),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('document_number', `%${trimmed}%`).order('document_number').limit(12),
      supabase
        .from('advisory_circulars')
        .select(cols).eq('status', 'active')
        .ilike('title', `%${trimmed}%`).order('document_number').limit(12),
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
        .limit(10)
      if (seq !== searchSeq.current) return // superseded by a newer search
      setSearchResults(rankSearchResults(trimmed, (data ?? []) as SearchResult[]).slice(0, 8))
      setSearchLoading(false)
      return
    }

    const seenIds = new Set<string>()
    const merged: SearchResult[] = []
    // RPC first within its tier (relevance-ranked), then the direct doc/title
    // queries; rankSearchResults re-tiers so exact matches still win regardless.
    for (const src of [prefixRes.data, numRes.data, rpcRes.data, titleRes.data]) {
      for (const r of (src ?? []) as SearchResult[]) {
        if (!seenIds.has(r.id)) { seenIds.add(r.id); merged.push(r) }
      }
    }

    if (seq !== searchSeq.current) return // a newer search started while awaiting
    setSearchResults(rankSearchResults(trimmed, merged).slice(0, 8))
    setSearchLoading(false)
  }, [])

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
    setSearchLoading(false)
    Keyboard.dismiss()
  }, [])

  const selectResult = useCallback((r: SearchResult) => {
    const id = r.id
    dismissSearch()
    router.push(`/ac/${id}`)
  }, [dismissSearch])

  const goToFullSearch = useCallback(() => {
    const q = searchQuery.trim()
    dismissSearch()
    if (q.length >= 2) {
      router.push({ pathname: '/(tabs)/search', params: { q } })
    } else {
      router.push('/(tabs)/search')
    }
  }, [searchQuery, dismissSearch])

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

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader showWordmark />

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
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(13.5) }]}
            placeholder='AC number, keyword, or "phrase"…'
            placeholderTextColor={tokens.t3}
            value={searchQuery}
            onChangeText={handleQueryChange}
            onFocus={() => setSearchActive(true)}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={goToFullSearch}
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
        {showCancel && (
          <Pressable onPress={dismissSearch} style={styles.cancelWrap} hitSlop={4}>
            <Text style={[styles.cancelText, { color: tokens.blu, fontSize: fs(14) }]}>Cancel</Text>
          </Pressable>
        )}
      </View>

      {/* Main content */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <FlatList
          data={series}
          keyExtractor={(item) => item.series_prefix}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <HomeHeader
              tokens={tokens}
              totalCount={totalCount}
              whatsNew={whatsNew}
              badgeDays={badgeDays}
            />
          }
          renderItem={({ item }) => <SeriesRow item={item} tokens={tokens} />}
        />
      )}

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
          {searchResults.length > 0 ? (
            <ScrollView
              style={styles.dropScroll}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {searchResults.map((r) => (
                <Pressable
                  key={r.id}
                  style={({ pressed }) => [
                    styles.dropRow,
                    { borderBottomColor: tokens.bdr },
                    pressed && { backgroundColor: tokens.bg3 },
                  ]}
                  onPress={() => selectResult(r)}
                >
                  <Text style={[styles.dropNum, { color: tokens.blu, fontSize: fs(12.5) }]}>{r.document_number}</Text>
                  <Text style={[styles.dropTitle, { color: tokens.t1, fontSize: fs(13.5) }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={[styles.dropSeeAll, { borderTopColor: tokens.bdr }]}
                onPress={goToFullSearch}
              >
                <Text style={[styles.dropSeeAllText, { color: tokens.blu, fontSize: fs(13) }]}>
                  See all results
                </Text>
                <Icon name="chevron.right" size={12} color={tokens.blu} />
              </Pressable>
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
    </View>
  )
}

// ─── Header (What's New + Library label) ─────────────────────────────────────

function HomeHeader({
  tokens,
  totalCount,
  whatsNew,
  badgeDays,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  totalCount: number | null
  whatsNew: WhatsNewAC[]
  badgeDays: number
}) {
  const fs = useFS()
  return (
    <>
      {/* What's New strip — always shown, even with zero results, so a user
          isn't left wondering why the whole section vanished; the empty
          state tells them to widen Badge Lifespan if they expect to see
          something. */}
      <View style={styles.sectionLabel}>
        <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(15) }]}>What's New</Text>
        <Text style={[styles.sectionSub, { color: tokens.t3, fontSize: fs(11.5) }]}>Last {badgeDays} days</Text>
      </View>
      {whatsNew.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.wnScroll}
        >
          {whatsNew.map((ac) => (
            <WhatsNewCard key={ac.id} ac={ac} tokens={tokens} badgeDays={badgeDays} />
          ))}
        </ScrollView>
      ) : (
        <View style={[styles.wnEmpty, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Text style={[styles.wnEmptyText, { color: tokens.t3, fontSize: fs(12.5) }]}>
            No ACs issued or updated in the last {badgeDays} day{badgeDays === 1 ? '' : 's'}. Try a longer Badge Lifespan in the menu to see more.
          </Text>
        </View>
      )}

      {/* AC Library label */}
      <View style={styles.sectionLabel}>
        <Text style={[styles.sectionTitle, { color: tokens.t1, fontSize: fs(15) }]}>AC Library</Text>
        {totalCount !== null && (
          <Text style={[styles.sectionCount, { color: tokens.blu, fontSize: fs(12) }]}>
            {totalCount} current ACs
          </Text>
        )}
      </View>
    </>
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
  const isUpd = ac.cancels && ac.cancels.length > 0
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
        {showBadge && <Badge isUpd={isUpd} tokens={tokens} />}
        <Text style={[styles.wnDate, { color: tokens.t3, fontSize: fs(10.5) }]}>{dateStr}</Text>
      </View>
      <Text style={[styles.wnAcNum, { color: tokens.t1, fontSize: fs(15) }]}>{ac.document_number}</Text>
      <Text style={[styles.wnTitle, { color: tokens.t2, fontSize: fs(11.5) }]} numberOfLines={2}>
        {ac.title}
      </Text>
    </Pressable>
  )
}

// ─── Series row ──────────────────────────────────────────────────────────────

function SeriesRow({
  item,
  tokens,
}: {
  item: ACSeries
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <Pressable
      style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => router.push(`/series/${item.series_prefix}`)}
    >
      <Text style={[styles.seriesNum, { color: tokens.t3, fontSize: fs(15) }]}>{item.series_prefix}</Text>
      <View style={styles.cardBody}>
        <Text style={[styles.cardTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
          {item.display_name}
        </Text>
      </View>
      <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
        <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{item.ac_count}</Text>
      </View>
      <Icon name="chevron.right" size={14} color={tokens.t4} />
    </Pressable>
  )
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function Badge({
  isUpd,
  tokens,
}: {
  isUpd: boolean
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <View
      style={[
        styles.badge,
        isUpd
          ? { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }
          : { backgroundColor: tokens.gdim, borderColor: tokens.gbdr },
      ]}
    >
      <Text
        style={[
          styles.badgeText,
          { color: isUpd ? tokens.blu : tokens.grn, fontSize: fs(9.5) },
        ]}
      >
        {isUpd ? 'UPD' : 'NEW'}
      </Text>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  listContent: { paddingBottom: 24 },

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
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dropNum: { fontSize: 12.5, fontWeight: '700', width: 72 },
  dropTitle: { flex: 1, fontSize: 13.5 },
  dropSeeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  sectionCount: { fontSize: 12, fontWeight: '500' },

  wnScroll: { paddingHorizontal: 16, gap: 10, paddingBottom: 4 },
  wnEmpty: {
    marginHorizontal: 16,
    marginBottom: 4,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 16,
  },
  wnEmptyText: { lineHeight: 18 },
  wnCard: {
    width: 190,
    borderRadius: 14,
    borderWidth: 1,
    padding: 12,
  },
  wnTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  wnDate: { fontSize: 10.5 },
  wnAcNum: { fontWeight: '700', fontSize: 15, marginBottom: 3 },
  wnTitle: { fontSize: 11.5, lineHeight: 16 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 16,
    marginBottom: 8,
    gap: 12,
  },
  seriesNum: {
    fontWeight: '700',
    fontSize: 15,
    width: 38,
    textAlign: 'center',
  },
  cardBody: { flex: 1, minWidth: 0 },
  cardTitle: { fontWeight: '500', fontSize: 14 },
  countPill: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: { fontSize: 11.5, fontWeight: '600' },

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
