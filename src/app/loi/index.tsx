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
export default function LoiIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<LoiHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentLoi, setRecentLoi] = useState<RecentAC[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  useEffect(() => {
    getRecents().then((rs) => setRecentLoi(rs.filter((r) => recentItemType(r) === 'loi').slice(0, 10)))
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
          <Icon name="magnifyingglass" size={16} color={tokens.t3} />
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
              <Icon name="xmark.circle" size={16} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {!trimmedQuery && recentLoi.length > 0 && (
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
                <Icon name="chevron.right" size={14} color={tokens.t4} />
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
                  <Icon name="chevron.right" size={14} color={tokens.t4} />
                </Pressable>
              )}
            />
          )
        ) : (
          <View style={styles.center}>
            <Icon name="magnifyingglass" size={28} color={tokens.t4} />
            <Text style={[styles.hintTitle, { color: tokens.t2, fontSize: fs(15) }]}>Search FAA Legal Interpretations</Text>
            <Text style={[styles.hintSub, { color: tokens.t3, fontSize: fs(13) }]}>
              Search by topic or keyword — interpretation letters are named after the requester,
              not the subject, so full-text search is the fastest way to find one.
            </Text>
          </View>
        )}
      </TabletContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8, marginTop: 40 },
  hintTitle: { fontWeight: '600', marginTop: 6, textAlign: 'center' },
  hintSub: { textAlign: 'center', lineHeight: 19, maxWidth: 320 },

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
