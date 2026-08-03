import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'

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
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<LoiHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentLoi, setRecentLoi] = useState<RecentAC[]>([])
  const [yearCounts, setYearCounts] = useState<{ year: number; count: number }[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

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
    supabase
      .from('legal_interpretations')
      .select('slug, title, addressee, year, summary, cfr_part_reference')
      .textSearch('body_text', trimmed, { type: 'websearch', config: 'english' })
      .order('year', { ascending: false })
      .limit(30)
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

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Legal Interpretations" onBack={() => router.back()} />
      <TabletContainer>
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
            placeholder="Search interpretations (e.g. 'wet lease', 'BasicMed')…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleQueryChange}
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

        {trimmedQuery ? (
          searching ? (
            <View style={styles.center}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          ) : (
            <FlatList
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
                  onPress={() => router.push(`/loi/${item.slug}` as any)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                      {item.title.replace(/-/g, ' ')}
                    </Text>
                    {item.summary && (
                      <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]} numberOfLines={2}>
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
            style={styles.flatList}
            keyboardDismissMode="interactive"
            data={yearCounts}
            keyExtractor={(item) => String(item.year)}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <>
                {recentLoi.length > 0 && (
                  <View style={styles.recentWrap}>
                    <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
                    {recentLoi.map((r) => (
                      <Pressable
                        key={r.id}
                        style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                        onPress={() => router.push(`/loi/${r.id}` as any)}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                            {r.document_number.replace(/-/g, ' ')}
                          </Text>
                          <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]} numberOfLines={1}>
                            {r.title}
                          </Text>
                        </View>
                        <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                      </Pressable>
                    ))}
                  </View>
                )}
                <View style={styles.hintBar}>
                  <Icon name="magnifyingglass" size={fs(13)} color={tokens.t4} />
                  <Text style={[styles.hintBarText, { color: tokens.t4, fontSize: fs(11.5) }]}>
                    Interpretation letters are named after the requester, not the subject —
                    full-text search above is the fastest way to find one by topic.
                  </Text>
                </View>
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>BROWSE BY YEAR</Text>
              </>
            }
            renderItem={({ item }) => (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/loi/year/${item.year}` as any)}
              >
                <Text style={[styles.yearText, { color: tokens.blu, fontSize: fs(15) }]}>{item.year}</Text>
                <View style={{ flex: 1 }} />
                <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  {item.count} interpretation{item.count === 1 ? '' : 's'}
                </Text>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )}
          />
        )}
      </TabletContainer>
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
  hintBarText: { flex: 1, lineHeight: 15 },
  yearText: { fontWeight: '700' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  recentWrap: { marginTop: 14, paddingHorizontal: 12 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  emptyText: { textAlign: 'center', marginTop: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  rowTitle: { fontWeight: '600', textTransform: 'capitalize' },
  rowSub: { marginTop: 2, lineHeight: 16 },
  rowCfr: { marginTop: 4, fontWeight: '600' },
})
