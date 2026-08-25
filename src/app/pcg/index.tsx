import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, FlatList, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface TermHit {
  slug: string
  term: string
}

// Public, same-for-every-viewer content (letter/term-count metadata only,
// no gated body text) -- no uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention.
const PCG_INDEX_CACHE_KEY = '@flyregs/pcg-index-cache'

// P/CG's natural browse structure: alphabetical by first letter, matching
// the source glossary's own one-page-per-letter structure
// (glossary-a.html...glossary-w.html).
export default function PcgIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [termHits, setTermHits] = useState<TermHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentPcg, setRecentPcg] = useState<RecentAC[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  // Some P/CG terms run long (equipment names with a parenthetical
  // abbreviation, etc.) and get cut off the same way FAR Part titles do --
  // same hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    // Same lastGood-preservation reason as Home's own lastGoodCount (see
    // (tabs)/index.tsx) -- a failed/slow fetch shouldn't blank out counts
    // that were already showing.
    let lastGoodCounts: Record<string, number> = {}

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(PCG_INDEX_CACHE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (parsed) { setCounts(parsed); lastGoodCounts = parsed }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged) -- server-side GROUP
    // BY RPC, not client-side counting -- confirmed live that
    // select('letter') alone silently undercounted at "1000 TERMS" against
    // the real 1,332 (PostgREST's project-wide 1000-row max-rows cap, which
    // a client Range header can't override past). See far/index.tsx's
    // comment for the full diagnosis.
    try {
      const { data } = await supabase.rpc('count_pcg_terms_by_letter')
      let freshCounts = lastGoodCounts
      if (data) {
        const c: Record<string, number> = {}
        for (const row of data as { letter: string; cnt: number }[]) c[row.letter] = row.cnt
        setCounts(c)
        freshCounts = c
      }
      setLoading(false)
      AsyncStorage.setItem(PCG_INDEX_CACHE_KEY, JSON.stringify(freshCounts))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Device-local recently-viewed terms -- an honest "most used" proxy
  // without needing any new server-side tracking.
  useEffect(() => {
    getRecents().then((rs) => setRecentPcg(rs.filter((r) => recentItemType(r) === 'pcg').slice(0, 10)))
  }, [])

  // P/CG has no natural section number to jump to (unlike FAR/AIM), so
  // search here means an actual live term lookup, not just filtering the
  // 26-letter grid.
  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { searchSeq.current++; setTermHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    supabase
      .from('pcg_terms')
      .select('slug, term')
      .ilike('term', `%${trimmed}%`)
      .order('term')
      .limit(20)
      .then(({ data }) => {
        if (seq !== searchSeq.current) return
        setTermHits((data ?? []) as TermHit[])
        setSearching(false)
      })
  }, [])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 250)
  }

  const letters = Object.keys(counts).sort()
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const trimmedQuery = query.trim()

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Pilot/Controller Glossary" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
            placeholder="Find a term…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleQueryChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => { setQuery(''); setTermHits([]) }} hitSlop={8}>
              <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {!trimmedQuery && recentPcg.length > 0 && (
          <View style={styles.recentWrap}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recentScroll} contentContainerStyle={styles.recentRow}>
              {recentPcg.map((r) => (
                <Pressable
                  key={r.id}
                  style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/pcg/${r.id}` as any)}
                >
                  <Text style={[styles.recentChipTerm, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
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
              data={termHits}
              keyExtractor={(item) => item.slug}
              contentContainerStyle={styles.list}
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                  {termHits.length} MATCHING TERM{termHits.length === 1 ? '' : 'S'}
                </Text>
              }
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>No terms found</Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    router.push(`/pcg/${item.slug}` as any)
                  }}
                  onLongPress={(e) => showPreview(item.term, e)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <Text style={[styles.termText, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                    {item.term}
                  </Text>
                  <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                </Pressable>
              )}
            />
          )
        ) : (
          <FlatList
            style={styles.flatList}
            data={letters}
            keyExtractor={(l) => l}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {total} TERMS
              </Text>
            }
            renderItem={({ item: letter }) => (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/pcg/letter/${letter}` as any)}
              >
                <Text style={[styles.letter, { color: tokens.blu, fontSize: fs(16) }]}>{letter}</Text>
                <View style={{ flex: 1 }} />
                <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                  <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[letter]}</Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )}
          />
        )}
        </TabletContainer>
      )}
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  recentWrap: { marginTop: 14, paddingLeft: 12 },
  // Same root cause as updates.tsx's filter chips (see that file's
  // comment): a horizontal ScrollView with no explicit `style` collapses
  // its own cross-axis height on web, clipping the row's content.
  recentScroll: { flexGrow: 0, flexShrink: 0, height: 52 },
  recentRow: { paddingRight: 12, gap: 8 },
  recentChip: {
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 160,
  },
  recentChipTerm: { fontWeight: '600' },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  emptyText: { textAlign: 'center', marginTop: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  letter: { fontWeight: '700', width: 24 },
  termText: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
