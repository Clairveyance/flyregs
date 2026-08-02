import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getWordOfTheDay, WordOfTheDay } from '@/lib/notifications'

interface TermHit {
  slug: string
  term: string
  definition: string | null
}

// v1 scope (2026-08-01): FAA JO 7340.2's official Contractions table
// (3,326 terms, category='contraction') -- see
// sync/migrations_dictionary_terms.sql for why this is additive to, not a
// copy of, pcg_terms (1,332 terms, its own existing screen at /pcg).
// Structure mirrors pcg/index.tsx deliberately (same A-Z browse + live
// search pattern) so the two glossary features feel like siblings, not
// unrelated screens.
export default function DictionaryIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [termHits, setTermHits] = useState<TermHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const [wordOfDay, setWordOfDay] = useState<WordOfTheDay | null>(null)

  useEffect(() => {
    getWordOfTheDay().then(setWordOfDay).catch(() => {})
  }, [])

  useEffect(() => {
    supabase.rpc('count_dictionary_terms_by_letter').then(({ data }) => {
      if (data) {
        const c: Record<string, number> = {}
        for (const row of data as { letter: string; cnt: number }[]) c[row.letter] = row.cnt
        setCounts(c)
      }
      setLoading(false)
    })
  }, [])

  // search_dictionary matches term OR definition text (senses jsonb is part
  // of its search_vector), not just the headword -- RC: "the dictionary
  // should work both ways. search a word, get a def - and search a def or
  // phrase, get the terms (ex: user types 'a smooth landing', our system
  // shows 'greaser' as one of the results)." Same RPC already powers
  // Home's SmartSearch federation; using it here too means an exact-term
  // hit (typing "fa" for the term "FA") ranks first instead of getting
  // buried alphabetically behind 20 substring matches like "ADFAP" --
  // confirmed live as a real bug in the plain .ilike().order('term') this
  // replaces.
  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { searchSeq.current++; setTermHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    supabase
      .rpc('search_dictionary', { query: trimmed, result_limit: 30 })
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

  // '#' (symbol-leading contractions like "+FC") sorts last, everything
  // else alphabetically -- matches how the source table itself orders them.
  const letters = Object.keys(counts).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const trimmedQuery = query.trim()

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
          <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
            <Icon name="magnifyingglass" size={16} color={tokens.t3} />
            <TextInput
              style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
              placeholder="Find a term or acronym…"
              placeholderTextColor={tokens.t3}
              value={query}
              onChangeText={handleQueryChange}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable onPress={() => { setQuery(''); setTermHits([]) }} hitSlop={8}>
                <Icon name="xmark.circle" size={16} color={tokens.t4} />
              </Pressable>
            )}
          </View>

          {!trimmedQuery && <DailyWordCard wordOfDay={wordOfDay} tokens={tokens} />}

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
                ListHeaderComponent={
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                    {termHits.length} MATCHING TERM{termHits.length === 1 ? '' : 'S'}
                  </Text>
                }
                ListEmptyComponent={
                  <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>
                    No terms found. Not every contraction has a plain-English match — try the raw code (e.g. "ACARS").
                  </Text>
                }
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => router.push(`/dictionary/${item.slug}` as any)}
                  >
                    <View style={{ flex: 1 }}>
                      {/* No numberOfLines cap -- a truncated row gives no way
                          to tell if it's worth tapping. Standing habit going
                          forward for any result-list row, not just this one. */}
                      <Text style={[styles.termText, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.term}</Text>
                      {item.definition && (
                        <Text style={[styles.defText, { color: tokens.t3, fontSize: fs(12.5) }]}>{item.definition}</Text>
                      )}
                    </View>
                    <Icon name="chevron.right" size={14} color={tokens.t4} />
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
              ListHeaderComponent={
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>{total} TERMS</Text>
              }
              renderItem={({ item: letter }) => (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/dictionary/letter/${encodeURIComponent(letter)}` as any)}
                >
                  <Text style={[styles.letter, { color: tokens.blu, fontSize: fs(16) }]}>{letter}</Text>
                  <View style={{ flex: 1 }} />
                  <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                    <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[letter]}</Text>
                  </View>
                  <Icon name="chevron.right" size={14} color={tokens.t4} />
                </Pressable>
              )}
            />
          )}
        </TabletContainer>
      )}
    </View>
  )
}

// Mirrors Home's DailyRegCard pattern exactly, including its Plus gate --
// RC, live (2026-08-02), after first asking for this free for everyone
// (2026-08-01) then reconsidering given the app's overall free/paid
// balance: "i think, since we're keeping the search free and open, we can
// gate the DailyWord like we do w/ DailyReg." Search/browse stays
// unlimited and free (matches AC's own pattern); this one curated daily
// pick is now Plus+, same locked-teaser-when-not-entitled treatment as
// DailyRegCard so the feature stays discoverable rather than vanishing.
function DailyWordCard({ wordOfDay, tokens }: { wordOfDay: WordOfTheDay | null; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [expanded, setExpanded] = useState(false)
  if (!wordOfDay) return null
  if (!hasPlusAccess) {
    return (
      <Pressable
        style={[styles.wordCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
        onPress={() => router.push('/paywall?tier=plus' as any)}
      >
        <View style={styles.wordCardRow}>
          <View style={[styles.wordCardIcon, { backgroundColor: tokens.goldlt }]}>
            <Icon name="lock.fill" size={13} color={tokens.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.wordCardLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>WORD OF THE DAY</Text>
            <Text style={[styles.wordCardTerm, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
              A fun new term every day — unlock with Plus
            </Text>
          </View>
          <Icon name="chevron.right" size={13} color={tokens.t4} />
        </View>
      </Pressable>
    )
  }
  return (
    <Pressable
      style={[styles.wordCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => setExpanded((e) => !e)}
    >
      <View style={styles.wordCardRow}>
        <View style={[styles.wordCardIcon, { backgroundColor: tokens.goldlt }]}>
          <Icon name="star.fill" size={14} color={tokens.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.wordCardLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>WORD OF THE DAY</Text>
          <Text style={[styles.wordCardTerm, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={expanded ? undefined : 1}>
            {wordOfDay.term}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t4} />
      </View>
      {expanded && (
        <>
          <Text style={[styles.wordCardDef, { color: tokens.t2, fontSize: fs(13.5) }]}>{wordOfDay.definition}</Text>
          <Pressable
            style={[styles.wordCardJump, { borderColor: tokens.bdr }]}
            onPress={() => router.push(`/dictionary/${wordOfDay.slug}` as any)}
          >
            <Text style={[styles.wordCardJumpText, { color: tokens.blu, fontSize: fs(13) }]}>Open full entry</Text>
            <Icon name="chevron.right" size={12} color={tokens.blu} />
          </Pressable>
        </>
      )}
    </Pressable>
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

  wordCard: {
    marginHorizontal: 12, marginTop: 10, borderRadius: 12, borderWidth: 1, padding: 12,
  },
  wordCardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wordCardIcon: {
    width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  wordCardLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 2 },
  wordCardTerm: { fontWeight: '600' },
  wordCardDef: { marginTop: 10, lineHeight: 19 },
  wordCardJump: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 10, alignSelf: 'flex-start', borderBottomWidth: 1, paddingBottom: 2,
  },
  wordCardJumpText: { fontWeight: '600' },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  emptyText: { textAlign: 'center', marginTop: 20, lineHeight: 19, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  letter: { fontWeight: '700', width: 24 },
  termText: { fontWeight: '500' },
  defText: { marginTop: 2, lineHeight: 17 },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
