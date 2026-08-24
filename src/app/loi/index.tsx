import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, ActivityIndicator, Keyboard, Platform } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'
import { humanizeLoiTitle } from '@/lib/titleFormat'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface LoiHit {
  slug: string
  title: string
  addressee: string | null
  year: number | null
  summary: string | null
  cfr_part_reference: string | null
}

// LOI's landing page is search-FIRST, not browse-first -- per the
// expansion plan's explicit priority reframe: "LOI titles are just the
// addressee/attorney's name ('Williams 2018') -- worthless as a search
// key... topic/full-text search inside the LOI section itself... needs
// real investment, not a bare-bones browse screen." Real Postgres
// full-text search (websearch_to_tsquery, matching the
// legal_interpretations_fts_idx GIN index) against body_text, not a
// plain ILIKE title match -- title alone can't answer "what does the FAA
// say about wet leasing" the way body-text search can.
//
// Search-first doesn't mean search-ONLY, though -- RC, real device: "the
// entire LOI sections field is just blank, with only some recents and a
// note to search... we should be populating this." A year browse gives
// anyone without a specific keyword in mind something real to explore,
// without undermining the reasoning above: YEAR (not title) is the
// browse key specifically because it sidesteps the "addressee name is a
// useless label" problem entirely.
export default function LoiIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<LoiHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentLoi, setRecentLoi] = useState<RecentAC[]>([])
  const [yearCounts, setYearCounts] = useState<{ year: number; count: number }[]>([])
  const [searchFocused, setSearchFocused] = useState(false)
  const [searchWrapHeight, setSearchWrapHeight] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  // LOI titles (humanized addressee/subject names) run long and get cut off
  // the same way FAR Part titles do -- same hook/card pair as far/index.tsx's
  // own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    getRecents().then((rs) => setRecentLoi(rs.filter((r) => recentItemType(r) === 'loi').slice(0, 10)))
    // One lightweight column across all ~1,055 rows, grouped client-side --
    // not worth a dedicated RPC for a single int column at this volume.
    supabase.from('legal_interpretations').select('year').not('year', 'is', null).then(({ data }) => {
      if (!data) return
      const counts = new Map<number, number>()
      for (const row of data as { year: number }[]) {
        counts.set(row.year, (counts.get(row.year) ?? 0) + 1)
      }
      setYearCounts(
        Array.from(counts, ([year, count]) => ({ year, count })).sort((a, b) => b.year - a.year)
      )
    })
  }, [])

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 3) { searchSeq.current++; setHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    // search_legal_interpretations(), not a direct .textSearch() on the raw
    // table. `body_text` is Pro-gated content and its column-level SELECT is
    // now revoked from anon/authenticated (see
    // migrations_paid_content_column_privileges.sql) -- Postgres requires
    // SELECT on any column named in a WHERE clause, so searching it from the
    // client is no longer possible at all. Finding an LOI by its full text is
    // deliberately FREE ("find it free, read it on Pro"), so the search moved
    // server-side into a SECURITY DEFINER function that can read the body but
    // only ever returns metadata.
    supabase
      .rpc('search_legal_interpretations', { q: trimmed, lim: 30 })
      .then(({ data, error }) => {
        if (seq !== searchSeq.current) return
        if (error) {
          // websearch_to_tsquery throws on some punctuation-only input
          // (e.g. a bare "?") -- fail to an empty result set rather than
          // a crash; the user just sees "no results" for a bad query.
          setHits([])
        } else {
          setHits((data ?? []) as LoiHit[])
        }
        setSearching(false)
      })
  }, [])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 300)
  }

  const trimmedQuery = query.trim()
  const showRecentLoi = searchFocused && trimmedQuery.length === 0 && recentLoi.length > 0

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Legal Interpretations" onBack={() => router.back()} />
      <TabletContainer>
        <View
          style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}
          onLayout={(e) => setSearchWrapHeight(e.nativeEvent.layout.height)}
        >
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
            placeholder="Search LOIs (e.g. 'wet lease', 'BasicMed')…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleQueryChange}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => { setQuery(''); setHits([]) }} hitSlop={8}>
              <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {showRecentLoi && (
          <Pressable
            style={[styles.backdrop, { top: searchWrapHeight + 18 }]}
            onPress={() => { setSearchFocused(false); Keyboard.dismiss() }}
          />
        )}
        {showRecentLoi && (
          <View
            style={[
              styles.dropdown,
              { top: searchWrapHeight + 18, backgroundColor: tokens.bg2, borderColor: tokens.bdr },
            ]}
          >
            <View style={[styles.dropHeader, { borderBottomColor: tokens.bdr }]}>
              <Text style={[styles.dropHeaderText, { color: tokens.t3, fontSize: fs(11.5) }]}>RECENTLY VIEWED</Text>
            </View>
            {recentLoi.map((r) => (
              <Pressable
                key={r.id}
                style={({ pressed }) => [styles.dropRow, { borderBottomColor: tokens.bdr }, pressed && { opacity: 0.6 }]}
                onPress={() => router.push(`/loi/${r.id}` as any)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                    {humanizeLoiTitle(r.document_number)}
                  </Text>
                  <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.33 }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            ))}
          </View>
        )}

        {trimmedQuery ? (
          searching ? (
            <View style={styles.center}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          ) : (
            <FlatList
              key="search-hits"
              keyboardDismissMode="interactive"
              style={styles.flatList}
              data={hits}
              keyExtractor={(item) => item.slug}
              contentContainerStyle={styles.list}
              ListHeaderComponent={
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                  {hits.length} MATCHING INTERPRETATION{hits.length === 1 ? '' : 'S'}
                </Text>
              }
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>
                  No interpretations found for that search.
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    router.push(`/loi/${item.slug}` as any)
                  }}
                  onLongPress={(e) => showPreview(humanizeLoiTitle(item.title), e)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                      {humanizeLoiTitle(item.title)}
                    </Text>
                    {item.summary && (
                      <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12), lineHeight: fs(12) * 1.33 }]} numberOfLines={2}>
                        {item.summary}
                      </Text>
                    )}
                    {item.cfr_part_reference ? (
                      <Text style={[styles.rowCfr, { color: tokens.blu, fontSize: fs(11) }]}>{item.cfr_part_reference}</Text>
                    ) : null}
                  </View>
                  <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                </Pressable>
              )}
            />
          )
        ) : (
          <FlatList
            key="browse-years"
            style={styles.flatList}
            keyboardDismissMode="interactive"
            data={yearCounts}
            keyExtractor={(item) => String(item.year)}
            contentContainerStyle={styles.list}
            numColumns={2}
            columnWrapperStyle={styles.yearRow}
            ListHeaderComponent={
              <>
                <View style={styles.hintBar}>
                  <Icon name="magnifyingglass" size={fs(13)} color={tokens.t3} />
                  <Text style={[styles.hintBarText, { color: tokens.t3, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.3 }]}>
                    Interpretation letters are named after the requester, not the subject —
                    full-text search above is the fastest way to find one by topic.
                  </Text>
                </View>
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>BROWSE BY YEAR</Text>
              </>
            }
            renderItem={({ item }) => (
              <Pressable
                style={[styles.yearCell, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/loi/year/${item.year}` as any)}
              >
                <Text style={[styles.yearText, { color: tokens.blu, fontSize: fs(16) }]}>{item.year}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.33 }]}>{item.count}</Text>
              </Pressable>
            )}
          />
        )}
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

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8, marginTop: 40 },
  hintBar: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 6,
    marginHorizontal: 2, marginBottom: 14, paddingHorizontal: 2,
  },
  // lineHeight NOT set here -- always overridden inline with fs(11.5) * 1.3
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  hintBarText: { flex: 1 },
  yearText: { fontWeight: '700' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },

  // Focus-gated "Recently Viewed" dropdown -- same pattern as
  // semantic-search.tsx's recent-questions dropdown: hidden until the search
  // bar is focused with an empty query, dismissed on outside-tap or once the
  // user starts typing (RC: "shouldn't pop up by itself... just like it is
  // in other places in the app").
  backdrop: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1 },
  dropdown: {
    position: 'absolute', left: 12, right: 12, zIndex: 2,
    borderRadius: 12, borderWidth: 1, overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 4px 16px rgba(0,0,0,0.14)' } as object)
      : { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.13, shadowRadius: 14 }),
  },
  dropHeader: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  dropHeaderText: { fontWeight: '600', letterSpacing: 0.5 },
  dropRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth,
  },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  emptyText: { textAlign: 'center', marginTop: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  rowTitle: { fontWeight: '600', textTransform: 'capitalize' },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  rowSub: { marginTop: 2 },
  rowCfr: { marginTop: 4, fontWeight: '600' },

  // Two-column year grid (RC: tapping a year always goes to another list
  // screen, never straight to content, so a denser grid fits more years per
  // screen than the single-column list this replaced) -- each cell just
  // shows the year and its raw count, no "interpretation(s)" label (RC:
  // "we already know where we are").
  yearRow: { gap: 8 },
  yearCell: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 12, marginBottom: 8,
  },
})
