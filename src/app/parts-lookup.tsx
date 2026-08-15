import { useState, useCallback, useRef } from 'react'
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { InfoPopup } from '@/components/InfoPopup'
import { TabletContainer } from '@/components/TabletContainer'
import { searchParts, getAdsForPart, bestMatchingToken, PART_TYPE_LABELS, type AdPart, type PartMentionAd, type PartComponentType } from '@/lib/adParts'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// Tier boundary (revised 2026-08-08, see flyregs_decisions.md): a specialized
// parts/component search gates to Plus, with NO free preview at all -- RC:
// "parts lookup is not avail at all for Free." Previously this screen let
// Free run real searches and see the first 5 results with an "unlock Plus"
// upsell for the rest; that undersold the gate (a free user could still use
// the feature, just capped) and didn't match AD's own "no preview at all"
// boundary on the body text right next to it (ad/[id].tsx). Now Free sees a
// single lock card, same pattern as that screen, before ever typing a query.
// Saving/tagging a specific aircraft with a part stays Premium, handled in
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
  const ifs = useInputFS()
  const { hasPlusAccess } = useAuth()
  const [query, setQuery] = useState('')
  const queryWords = query.trim().split(/\s+/).filter(Boolean)
  const [results, setResults] = useState<AdPart[]>([])
  const [relatedTo, setRelatedTo] = useState<PartComponentType | null>(null)
  const [partialMatch, setPartialMatch] = useState<{ droppedWords: string[]; usedWords: string[] } | null>(null)
  const [fuzzyMatch, setFuzzyMatch] = useState<{ originalQuery: string } | null>(null)
  const [searching, setSearching] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [adsByPart, setAdsByPart] = useState<Record<string, PartMentionAd[]>>({})
  const [loadingAds, setLoadingAds] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)
  // AD subject headings in the expanded parts list run long and get cut off
  // the same way FAR Part titles do -- same hook/card pair as far/index.tsx's
  // own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { seq.current++; setResults([]); setRelatedTo(null); setPartialMatch(null); setFuzzyMatch(null); setSearching(false); return }
    const mySeq = ++seq.current
    setSearching(true)
    searchParts(trimmed).then(({ results: hits, relatedTo: rel, partialMatch: partial, fuzzyMatch: fuzzy }) => {
      if (mySeq !== seq.current) return
      setResults(hits)
      setRelatedTo(rel)
      setPartialMatch(partial)
      setFuzzyMatch(fuzzy)
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
      <OverlayHeader
        title="Parts Lookup"
        onBack={() => router.back()}
        right={
          <InfoPopup
            id="parts-lookup-scope"
            title="What's in this catalog"
            body={[
              'This catalog only includes parts that have actually been named in an Airworthiness Directive — an engine model, a propeller, an avionics box, a specific appliance.',
              "It is not a general parts catalog. A manufacturer can make many more parts, models, and variants than what's listed here — this only covers the ones an AD has ever applied to.",
              'If you know of a part with an active AD that isn’t listed here, please send us feedback so we can get it added for everyone. Thank you!',
            ]}
          />
        }
      />
      <TabletContainer>
        {!hasPlusAccess ? (
          <Pressable
            style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
            onPress={() => router.push('/paywall?tier=plus')}
          >
            <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
            <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Parts Lookup is a Plus feature</Text>
            <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
              Search ADs by a specific part — an engine model, a muffler, an avionics box — across the entire AD catalog. Unlock Plus to use it.
            </Text>
            <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
              <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
            </View>
          </Pressable>
        ) : (
        <>
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
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
            keyboardDismissMode="interactive"
            style={styles.flatList}
            data={results}
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
              ) : fuzzyMatch ? (
                <View style={[styles.relatedNote, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                  <Icon name="info.circle" size={fs(14)} color={tokens.t3} />
                  <Text style={[styles.relatedNoteText, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    No exact match for "{fuzzyMatch.originalQuery}" — showing the closest matches instead.
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
                        <>
                          {/* Previously the count was only visible by counting
                              rows -- found during a 2026-08-12 parts-lookup
                              review as a real gap for an owner scanning many
                              parts quickly. */}
                          <Text style={[styles.adCount, { color: tokens.t3, fontSize: fs(11.5) }]}>
                            {ads.length} {ads.length === 1 ? 'AD references' : 'ADs reference'} this part
                          </Text>
                          {ads.map((ad) => (
                          <Pressable
                            key={ad.adNumber}
                            style={[styles.adRow, { borderTopColor: tokens.bdr }]}
                            onPress={() => {
                              if (consumeLongPress()) return
                              router.push(`/ad/${ad.adNumber}` as any)
                            }}
                            onLongPress={(e) => showPreview(ad.subjectHeading, e)}
                            onPressOut={hidePreview}
                            delayLongPress={350}
                          >
                            <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {ad.adNumber}</Text>
                            <Text style={[styles.adTitle, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={1}>
                              {ad.subjectHeading}
                            </Text>
                          </Pressable>
                          ))}
                        </>
                      )}
                    </View>
                  )}
                </View>
              )
            }}
          />
        )}
        </>
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 320 },
  proGate: {
    marginTop: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  proGateTitle: { fontWeight: '700', fontSize: 16, marginTop: 4 },
  proGateSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 280 },
  proGateBtn: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  proGateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
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
  adCount: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 2, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: '600' },
  adRow: { paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  adNum: { fontWeight: '700' },
  adTitle: {},
})
