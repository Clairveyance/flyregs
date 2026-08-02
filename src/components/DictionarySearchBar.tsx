import { useState, useRef, useCallback } from 'react'
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

interface TermHit {
  slug: string
  term: string
  definition: string | null
}

// Pinned quick-search, reused across every Aviation Dictionary screen -- RC:
// "we should keep the search bar pinned and available at the top even when
// inside the A/D pages." dictionary/index.tsx already has its own inline
// search (replaces the letter list with results, fine for that screen's own
// browse-vs-search mode switch) -- this is for the two screens that had NO
// search at all: letter/[letter].tsx and [slug].tsx. Same search_dictionary
// RPC and debounce pattern as the index screen's search, but renders results
// as a floating dropdown instead of replacing the screen's own content,
// since here the user is mid-browse or mid-read and shouldn't lose their
// place just by tapping into the search field.
export function DictionarySearchBar() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TermHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { searchSeq.current++; setHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    supabase
      .rpc('search_dictionary', { query: trimmed, result_limit: 20 })
      .then(({ data }) => {
        if (seq !== searchSeq.current) return
        setHits((data ?? []) as TermHit[])
        setSearching(false)
      })
  }, [])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 250)
  }

  const handleClear = () => {
    setQuery('')
    setHits([])
    searchSeq.current++
  }

  const trimmedQuery = query.trim()

  return (
    <View style={styles.wrap}>
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
          <Pressable onPress={handleClear} hitSlop={8}>
            <Icon name="xmark.circle" size={16} color={tokens.t4} />
          </Pressable>
        )}
      </View>
      {trimmedQuery.length > 0 && (
        <View style={[styles.dropdown, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          {searching ? (
            <View style={styles.center}>
              <ActivityIndicator color={tokens.blu} />
            </View>
          ) : (
            <FlatList
              data={hits}
              keyExtractor={(item) => item.slug}
              keyboardShouldPersistTaps="handled"
              style={styles.dropdownList}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13) }]}>
                  No terms found.
                </Text>
              }
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.row, { borderColor: tokens.bdr }]}
                  onPress={() => { handleClear(); router.push(`/dictionary/${item.slug}` as any) }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.termText, { color: tokens.t1, fontSize: fs(14) }]}>{item.term}</Text>
                    {item.definition && (
                      <Text style={[styles.defText, { color: tokens.t3, fontSize: fs(12) }]} numberOfLines={2}>
                        {item.definition}
                      </Text>
                    )}
                  </View>
                  <Icon name="chevron.right" size={13} color={tokens.t4} />
                </Pressable>
              )}
            />
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 10, position: 'relative', zIndex: 20 },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    height: 40, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },
  dropdown: {
    position: 'absolute', top: 50, left: 12, right: 12, maxHeight: 360,
    borderRadius: 12, borderWidth: 1, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 8,
  },
  dropdownList: { flexGrow: 0 },
  center: { padding: 20, alignItems: 'center' },
  emptyText: { textAlign: 'center', padding: 16 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  termText: { fontWeight: '600' },
  defText: { marginTop: 2, lineHeight: 15 },
})
