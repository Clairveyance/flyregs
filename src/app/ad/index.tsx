import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { buildAdSearchPlan } from '@/lib/aircraftSearch'

interface AdHit {
  ad_number: string
  subject_heading: string
}

interface NewAd {
  ad_number: string
  subject_heading: string
  citation_publish_date: string | null
}

// AD's landing page -- unlike FAR/AIM/P-CG/AC, there's no natural way to
// group 5,000+ ADs into a browsable grid (no Part/letter/chapter structure
// to hang a list off), so this is search-first: a bare AD-number jump
// ("2018-02-04") plus a live subject-heading search, alongside the two
// real entry points into the rest of the AD feature set (Parts Lookup, My
// Aircraft) that previously had no home of their own inside "the AD
// section" -- Home's own AD card used to just focus Home's search bar
// instead of routing anywhere, which is the exact inconsistency this
// screen fixes (see (tabs)/index.tsx's RegBodyItem for the routing change).
const AD_NUM_RE = /^\d{4}-\d{2}-\d{2}$/

export default function AdIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  // `q` -- deep-link from My Aircraft's "widen your search" prompt
  // (my-aircraft/[id].tsx) when the precision-tightened AD matcher can't
  // confirm a model-specific match; pre-fills and runs a real search here
  // instead of dumping the user on a blank screen they'd have to
  // re-type the make into.
  const { q: qParam } = useLocalSearchParams<{ q?: string }>()
  const [query, setQuery] = useState(qParam ?? '')
  const [hits, setHits] = useState<AdHit[]>([])
  const [similarHits, setSimilarHits] = useState<AdHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentAd, setRecentAd] = useState<RecentAC[]>([])
  const [newAds, setNewAds] = useState<NewAd[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const { badgeDays } = useBadgeLifespan()

  useEffect(() => {
    getRecents().then((rs) => setRecentAd(rs.filter((r) => recentItemType(r) === 'ad').slice(0, 10)))
  }, [])

  // A general, non-specific "new ADs" feed -- unlike AC's What's New (which
  // distinguishes genuinely-new vs. revised via changed_block_indices, a
  // parsed-block concept AD doesn't have), this is just "published within
  // the same rolling window the Badge Duration setting already controls
  // everywhere else" -- same cutoff, no NEW/UPD badge distinction needed.
  useEffect(() => {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - badgeDays)
    const cutoff = cutoffDate.toISOString().split('T')[0]
    supabase
      .from('airworthiness_directives')
      // citation_publish_date (Federal Register publication date, from the
      // API's own structured metadata) not effective_date -- confirmed
      // live that effective_date is null on all 5,013 rows (never parsed
      // by ad_scraper.py at all), while citation_publish_date is fully
      // populated and genuinely current (today's date shows up on a real
      // row). Same field ad_citations.py/sync_ad.sh already treat as this
      // corpus's authoritative "when was this touched" signal.
      .select('ad_number, subject_heading, citation_publish_date')
      .gte('citation_publish_date', cutoff)
      .order('citation_publish_date', { ascending: false })
      .limit(20)
      .then(({ data }) => setNewAds((data ?? []) as NewAd[]))
  }, [badgeDays])

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 3) { searchSeq.current++; setHits([]); setSimilarHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)

    // Search make + model + subject_heading (previously subject_heading
    // ONLY -- confirmed live as why "Cessna 172" and "c172s" both returned
    // zero results despite hundreds of real Cessna 172 ADs, since the
    // model number almost never appears inside subject_heading's prose).
    // Each required term group is ANDed via a separate .or() call --
    // postgrest ANDs successive filter calls together -- so a multi-word
    // query like "Cessna 172" requires BOTH tokens to appear somewhere
    // across the three columns, not one literal contiguous substring.
    const { requiredTermGroups, fallbackTerm } = buildAdSearchPlan(trimmed)
    let builder = supabase.from('airworthiness_directives').select('ad_number, subject_heading')
    for (const group of requiredTermGroups) {
      const orExpr = group
        .flatMap((term) => [`make.ilike.%${term}%`, `model.ilike.%${term}%`, `subject_heading.ilike.%${term}%`])
        .join(',')
      builder = builder.or(orExpr)
    }
    builder
      .order('citation_publish_date', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (seq !== searchSeq.current) return
        const results = (data ?? []) as AdHit[]
        setHits(results)
        setSearching(false)

        // Nothing matched even the tokenized/expanded search -- fall back
        // to a broader single-term "similar aircraft" lookup (just the
        // model-number part, e.g. "172s" out of "c172s") so a near-miss
        // query still surfaces something to tap instead of a dead end.
        if (results.length === 0 && fallbackTerm && fallbackTerm !== trimmed.toLowerCase()) {
          supabase
            .from('airworthiness_directives')
            .select('ad_number, subject_heading')
            .or(`model.ilike.%${fallbackTerm}%,make.ilike.%${fallbackTerm}%`)
            .order('citation_publish_date', { ascending: false })
            .limit(10)
            .then(({ data: similar }) => {
              if (seq !== searchSeq.current) return
              setSimilarHits((similar ?? []) as AdHit[])
            })
        } else {
          setSimilarHits([])
        }
      })
  }, [])

  useEffect(() => {
    if (qParam) runSearch(qParam)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 250)
  }

  const trimmedQuery = query.trim()
  const adJump = AD_NUM_RE.test(trimmedQuery) ? trimmedQuery : null

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Airworthiness Directives" onBack={() => router.back()} />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive">
          <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
            <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
            <TextInput
              style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
              placeholder="AD number or subject…"
              placeholderTextColor={tokens.t3}
              value={query}
              onChangeText={handleQueryChange}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => { if (adJump) router.push(`/ad/${adJump}` as any) }}
            />
            {query.length > 0 && (
              <Pressable onPress={() => { setQuery(''); setHits([]) }} hitSlop={8}>
                <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
              </Pressable>
            )}
          </View>

          {adJump && (
            <Pressable
              style={[styles.jumpRow, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
              onPress={() => router.push(`/ad/${adJump}` as any)}
            >
              <Icon name="arrow.up.right.square" size={fs(15)} color={tokens.blu} />
              <Text style={[styles.jumpText, { color: tokens.blu, fontSize: fs(14) }]}>Go to AD {adJump}</Text>
            </Pressable>
          )}

          {!trimmedQuery && (
            <>
              {/* RC, live (2026-08-02): "maybe we should have a disclaimer
                  inside ADs somewhere letting users know that our current
                  list of ADs extends back to the year 2000. and maybe that
                  over time, we may expand the DB further back." Verified
                  the exact cutoff against the live table before writing
                  this (earliest citation_publish_date = 2000-01-12, zero
                  rows before 2000) rather than assume a round number. */}
              <View style={[styles.coverageNote, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="info.circle" size={fs(13)} color={tokens.t3} />
                <Text style={[styles.coverageNoteText, { color: tokens.t3, fontSize: fs(11.5) }]}>
                  FlyRegs' Airworthiness Directives cover from the year 2000 to the present. We may extend coverage further back over time.
                </Text>
              </View>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push('/parts-lookup' as any)}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.bdim }]}>
                  <Icon name="wrench" size={fs(19)} color={tokens.blu} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Search by Part</Text>
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    Find ADs by named engine, propeller, or avionics part — not just aircraft model
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 8 }]}
                onPress={() => router.push('/my-aircraft' as any)}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.bdim }]}>
                  <Icon name="doc.plaintext" size={fs(19)} color={tokens.blu} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>My Aircraft</Text>
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    Save an aircraft to get alerted when a new or updated AD applies to it
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>

              {recentAd.length > 0 && (
                <View style={styles.recentWrap}>
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
                    {recentAd.map((r) => (
                      <Pressable
                        key={r.id}
                        style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                        onPress={() => router.push(`/ad/${r.id}` as any)}
                      >
                        <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]}>AD {r.document_number}</Text>
                        <Text style={[styles.recentChipTitle, { color: tokens.t2, fontSize: fs(11) }]} numberOfLines={1}>
                          {r.title}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              )}

              {newAds.length > 0 && (
                <View style={{ marginTop: 18 }}>
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                    NEW — LAST {badgeDays}d
                  </Text>
                  {newAds.map((item) => (
                    <Pressable
                      key={item.ad_number}
                      style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                      onPress={() => router.push(`/ad/${item.ad_number}` as any)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                        <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                          {item.subject_heading}
                        </Text>
                      </View>
                      <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}

          {trimmedQuery && (
            searching ? (
              <View style={styles.center}>
                <ActivityIndicator color={tokens.blu} />
              </View>
            ) : (
              <View style={{ marginTop: 14 }}>
                <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                  {hits.length} MATCHING AD{hits.length === 1 ? '' : 'S'}
                </Text>
                {hits.length === 0 ? (
                  <>
                    <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5) }]}>
                      No exact matches. Try a subject keyword, or search by part above.
                    </Text>
                    {similarHits.length > 0 && (
                      <View style={{ marginTop: 16 }}>
                        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                          SIMILAR AIRCRAFT
                        </Text>
                        {similarHits.map((item) => (
                          <Pressable
                            key={item.ad_number}
                            style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                            onPress={() => router.push(`/ad/${item.ad_number}` as any)}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                              <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                                {item.subject_heading}
                              </Text>
                            </View>
                            <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </>
                ) : (
                  hits.map((item) => (
                    <Pressable
                      key={item.ad_number}
                      style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                      onPress={() => router.push(`/ad/${item.ad_number}` as any)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                        <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                          {item.subject_heading}
                        </Text>
                      </View>
                      <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                    </Pressable>
                  ))
                )}
              </View>
            )
          )}
        </ScrollView>
      </TabletContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 20 },
  content: { padding: 12, paddingBottom: 32 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    height: 40, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  jumpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10,
  },
  jumpText: { fontWeight: '600' },

  coverageNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginTop: 10,
  },
  coverageNoteText: { flex: 1, lineHeight: 16 },

  hubCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginTop: 14,
  },
  hubIconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hubTitle: { fontWeight: '600' },
  hubSub: { marginTop: 2, lineHeight: 17 },

  recentWrap: { marginTop: 18 },
  recentRow: { gap: 8 },
  recentChip: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, maxWidth: 160 },
  recentChipNum: { fontWeight: '700' },
  recentChipTitle: { marginTop: 2 },

  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  emptyText: { textAlign: 'center', marginTop: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  adNum: { fontWeight: '700', marginBottom: 2 },
  adTitle: { fontWeight: '500', lineHeight: 18 },
})
