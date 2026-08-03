import { useState, useCallback, useRef } from 'react'
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { searchParts, getAdsForPart, bestMatchingToken, PART_TYPE_LABELS, type AdPart, type PartMentionAd, type PartComponentType } from '@/lib/adParts'

// Tier boundary (revised 2026-07-28, see flyregs_decisions.md): general AD
// lookup stays free tier-wide, but a specialized parts/component search is
// more specialized than general AD lookup and gates to Plus. Saving/
// tagging a specific aircraft with a part stays Premium, handled in
// my-aircraft.tsx, not here -- this screen is pure retrieval.

const TYPE_LABELS = PART_TYPE_LABELS

// Bolds/colors the specific part number within a result's (often dense,
// comma-separated) name that actually matched the search -- RC, live, on a
// screenshot of a long multi-part-number listing: "there's so many
// condensed numbers on screen, maybe we can 'suggest' correct answer by
// highlighting them in some way to make it easier for the user?"
function HighlightedPartName({ name, words, color, style }: { name: string; words: string[]; color: string; style: object }) {
  const match = bestMatchingToken(name, words)?.trim()
  const idx = match ? name.indexOf(match) : -1
  if (!match || idx === -1) return <Text style={style}>{name}</Text>
  return (
    <Text style={style}>
      {name.slice(0, idx)}
      <Text style={{ color, fontWeight: '800' }}>{match}</Text>
      {name.slice(idx + match.length)}
    </Text>
  )
}

export default function PartsLookupScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [query, setQuery] = useState('')
  const queryWords = query.trim().split(/\s+/).filter(Boolean)
  const [results, setResults] = useState<AdPart[]>([])
  const [relatedTo, setRelatedTo] = useState<PartComponentType | null>(null)
  const [partialMatch, setPartialMatch] = useState<{ droppedWords: string[]; usedWords: string[] } | null>(null)
  // Parts Lookup is FREE, like the AD list itself -- but free results are
  // capped the same way, so the value of the full list stays behind the
  // paywall without hiding the feature's existence from anyone.
  const FREE_RESULT_CAP = 5
  const [searching, setSearching] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [adsByPart, setAdsByPart] = useState<Record<string, PartMentionAd[]>>({})
  const [loadingAds, setLoadingAds] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { seq.current++; setResults([]); setRelatedTo(null); setPartialMatch(null); setSearching(false); return }
    const mySeq = ++seq.current
    setSearching(true)
    searchParts(trimmed).then(({ results: hits, relatedTo: rel, partialMatch: partial }) => {
      if (mySeq !== seq.current) return
      setResults(hits)
      setRelatedTo(rel)
      setPartialMatch(partial)
      setSearching(false)
    }).catch(() => setSearching(false))
  }, [])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 250)
  }

  const togglePart = (part: AdPart) => {
    if (expandedId === part.id) { setExpandedId(null); return }
    setExpandedId(part.id)
    if (!adsByPart[part.id]) {
      setLoadingAds(part.id)
      getAdsForPart(part.id).then((ads) => {
        setAdsByPart((prev) => ({ ...prev, [part.id]: ads }))
        setLoadingAds(null)
      }).catch(() => setLoadingAds(null))
    }
  }


  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Parts Lookup" onBack={() => router.back()} />
      <TabletContainer>
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
            placeholder="Engine, propeller, avionics part…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={handleQueryChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => { setQuery(''); setResults([]) }} hitSlop={8}>
              <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {query.trim().length < 2 ? (
          <View style={styles.center}>
            <Icon name="wrench" size={fs(34)} color={tokens.t4} />
            <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Search by part or component</Text>
            <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
              Some ADs apply to a specific part — a muffler, an engine model, an avionics box — regardless of what
              aircraft it's installed on. Search here to find those.
            </Text>
          </View>
        ) : searching ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.blu} />
          </View>
        ) : results.length === 0 ? (
          <View style={styles.center}>
            <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No parts found</Text>
            <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
              This catalog only covers parts that have actually been named in an AD's applicability text — try a
              different term, or browse ADs directly from Home.
            </Text>
          </View>
        ) : (
          <FlatList
            style={styles.flatList}
            data={hasPlusAccess ? results : results.slice(0, FREE_RESULT_CAP)}
            keyExtractor={(p) => p.id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              partialMatch ? (
                <View style={[styles.relatedNote, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <Icon name="info.circle" size={fs(14)} color={tokens.t3} />
                  <Text style={[styles.relatedNoteText, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    No direct match for "{partialMatch.droppedWords.join(' ')}" — showing results for "{partialMatch.usedWords.join(' ')}" instead. Double-check the model number?
                  </Text>
                </View>
              ) : relatedTo ? (
                <View style={[styles.relatedNote, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <Icon name="info.circle" size={fs(14)} color={tokens.t3} />
                  <Text style={[styles.relatedNoteText, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    No exact match for "{query.trim()}" — showing {TYPE_LABELS[relatedTo]} parts, the closest category.
                  </Text>
                </View>
              ) : null
            }
            ListFooterComponent={
              !hasPlusAccess && results.length > FREE_RESULT_CAP ? (
                <Pressable
                  style={[styles.moreRow, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
                  onPress={() => router.push('/paywall?tier=plus')}
                >
                  <Icon name="lock.fill" size={fs(14)} color={tokens.gold} />
                  <Text style={[styles.moreText, { color: tokens.t2, fontSize: fs(13) }]}>
                    {results.length - FREE_RESULT_CAP} more {results.length - FREE_RESULT_CAP === 1 ? 'part' : 'parts'} match — unlock Plus to see them all
                  </Text>
                </Pressable>
              ) : null
            }
            renderItem={({ item }) => {
              const expanded = expandedId === item.id
              const ads = adsByPart[item.id] ?? []
              return (
                <View>
                  <Pressable
                    style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => togglePart(item)}
                  >
                    <View style={{ flex: 1 }}>
                      <HighlightedPartName
                        name={item.name}
                        words={queryWords}
                        color={tokens.blu}
                        style={[styles.partName, { color: tokens.t1, fontSize: fs(14.5) }]}
                      />
                      <Text style={[styles.partMeta, { color: tokens.t3, fontSize: fs(12) }]}>
                        {TYPE_LABELS[item.componentType] ?? item.componentType}
                        {item.manufacturer ? ` · ${item.manufacturer}` : ''}
                      </Text>
                    </View>
                    <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(14)} color={tokens.t4} />
                  </Pressable>
                  {expanded && (
                    <View style={[styles.adList, { borderColor: tokens.bdr }]}>
                      {loadingAds === item.id ? (
                        <ActivityIndicator color={tokens.blu} style={{ paddingVertical: 12 }} />
                      ) : ads.length === 0 ? (
                        <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(12.5), padding: 12 }]}>No ADs found.</Text>
                      ) : (
                        ads.map((ad) => (
                          <Pressable
                            key={ad.adNumber}
                            style={[styles.adRow, { borderTopColor: tokens.bdr }]}
                            onPress={() => router.push(`/ad/${ad.adNumber}` as any)}
                          >
                            <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {ad.adNumber}</Text>
                            <Text style={[styles.adTitle, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={1}>
                              {ad.subjectHeading}
                            </Text>
                          </Pressable>
                        ))
                      )}
                    </View>
                  )}
                </View>
              )
            }}
          />
        )}
      </TabletContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 320 },
  moreRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, padding: 13, marginTop: 10,
  },
  moreText: { flex: 1, fontWeight: '500', lineHeight: 18 },
  relatedNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    borderRadius: 10, borderWidth: 1, padding: 10, marginBottom: 10,
  },
  relatedNoteText: { flex: 1, lineHeight: 17 },
  upgradeBtn: { borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginTop: 12 },
  upgradeBtnText: { color: '#fff', fontWeight: '700', fontSize: 14.5 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14,
  },
  partName: { fontWeight: '600' },
  partMeta: { marginTop: 2 },
  adList: { borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderBottomLeftRadius: 12, borderBottomRightRadius: 12, marginBottom: 8, marginTop: -1 },
  adRow: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  adNum: { fontWeight: '700' },
  adTitle: {},
})
