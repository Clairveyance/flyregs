import { useState, useCallback, useRef } from 'react'
import { View, Text, TextInput, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { searchParts, getAdsForPart, type AdPart, type PartMentionAd } from '@/lib/adParts'

// Tier boundary (revised 2026-07-28, see flyregs_decisions.md): general AD
// lookup stays free tier-wide, but a specialized parts/component search is
// more specialized than general AD lookup and gates to Plus. Saving/
// tagging a specific aircraft with a part stays Premium, handled in
// my-aircraft.tsx, not here -- this screen is pure retrieval.

const TYPE_LABELS: Record<string, string> = {
  engine: 'Engine', propeller: 'Propeller', avionics: 'Avionics',
  airframe: 'Airframe', appliance: 'Appliance', other: 'Other',
}

export default function PartsLookupScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdPart[]>([])
  const [searching, setSearching] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [adsByPart, setAdsByPart] = useState<Record<string, PartMentionAd[]>>({})
  const [loadingAds, setLoadingAds] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seq = useRef(0)

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { seq.current++; setResults([]); setSearching(false); return }
    const mySeq = ++seq.current
    setSearching(true)
    searchParts(trimmed).then((hits) => {
      if (mySeq !== seq.current) return
      setResults(hits)
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

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Parts Lookup" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={36} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Parts Lookup is a Plus feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Search Airworthiness Directives by named part or component — engines, propellers, avionics, and more —
            not just aircraft model or AD number.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus')}>
            <Text style={styles.upgradeBtnText}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Parts Lookup" onBack={() => router.back()} />
      <TabletContainer>
        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={16} color={tokens.t3} />
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
              <Icon name="xmark.circle" size={16} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {query.trim().length < 2 ? (
          <View style={styles.center}>
            <Icon name="wrench" size={34} color={tokens.t4} />
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
            data={results}
            keyExtractor={(p) => p.id}
            contentContainerStyle={styles.list}
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
                      <Text style={[styles.partName, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.name}</Text>
                      <Text style={[styles.partMeta, { color: tokens.t3, fontSize: fs(12) }]}>
                        {TYPE_LABELS[item.componentType] ?? item.componentType}
                        {item.manufacturer ? ` · ${item.manufacturer}` : ''}
                      </Text>
                    </View>
                    <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={14} color={tokens.t4} />
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
