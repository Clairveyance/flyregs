import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, TextInput, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { buildAdSearchPlan } from '@/lib/aircraftSearch'
import { stripAdSubjectPrefix } from '@/lib/titleFormat'
import { BackToTop, makeBackToTopScrollHandler, BACK_TO_TOP_THRESHOLD } from '@/components/BackToTop'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

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

// Public, same-for-every-viewer content (AD number/subject metadata only,
// not gated body text) -- no uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention. Only the "New" feed is cached here -- this
// screen is search-first with no other pre-loaded browse list, and it
// already renders instantly with no full-screen loading gate.
const AD_NEWADS_CACHE_KEY = '@flyregs/ad-newads-cache'

export default function AdIndexScreen() {
  const { tokens } = useTheme()
  const { hasPlusAccess, hasProAccess, loading: authLoading } = useAuth()
  const fs = useFS()
  const ifs = useInputFS()
  // `q` -- deep-link from My Aircraft's "widen your search" prompt
  // (my-aircraft/[id].tsx) when the precision-tightened AD matcher can't
  // confirm a model-specific match; pre-fills and runs a real search here
  // instead of dumping the user on a blank screen they'd have to
  // re-type the make into.
  const { q: qParam } = useLocalSearchParams<{ q?: string }>()
  const [query, setQuery] = useState(qParam ?? '')
  // "Suggest a feature", RC, 2026-09-03 -- see far/part/[part].tsx's own comment.
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef<ScrollView>(null)
  const [hits, setHits] = useState<AdHit[]>([])
  const [similarHits, setSimilarHits] = useState<AdHit[]>([])
  const [searching, setSearching] = useState(false)
  const [recentAd, setRecentAd] = useState<RecentAC[]>([])
  const [newAds, setNewAds] = useState<NewAd[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const { badgeDays } = useBadgeLifespan()
  // AD subject headings run long and get cut off the same way FAR Part
  // titles do -- same hook/card pair as far/index.tsx's own long-press
  // preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  // BB-081, RC real-device beta report: "we need pull-down-to-refresh for
  // all updatable screens." Shared by the mount effect below and the
  // ScrollView's own refreshControl so pulling down re-runs the exact same
  // fetches instead of duplicating them.
  const loadRecentAd = useCallback(() => {
    getRecents().then((rs) => setRecentAd(rs.filter((r) => recentItemType(r) === 'ad').slice(0, 10)))
  }, [])

  useEffect(() => {
    loadRecentAd()
  }, [loadRecentAd])

  // A general, non-specific "new ADs" feed -- unlike AC's What's New (which
  // distinguishes genuinely-new vs. revised via changed_block_indices, a
  // parsed-block concept AD doesn't have), this is just "published within
  // the same rolling window the Badge Duration setting already controls
  // everywhere else" -- same cutoff, no NEW/UPD badge distinction needed.
  // RC, 2026-08-08: "in Free, the AD page should not display the 'New' list
  // at all. That's a paid tier feature" -- matches this screen's own AD
  // body-text boundary (Plus, see ad/[id].tsx), which this list was
  // missing entirely; skip the fetch too, not just the render, for a
  // free-tier viewer.
  const loadNewAds = useCallback(async () => {
    if (!hasPlusAccess) {
      // Only actually clear once auth is DONE resolving -- hasPlusAccess
      // starts false for everyone (see context/auth.tsx), and this callback
      // is also the pull-to-refresh handler, so a real Plus subscriber who
      // pulled to refresh inside the launch window would have watched their
      // already-loaded "New ADs" list blank out. Same shape and same fix as
      // (tabs)/index.tsx's HobbsHeaderButton. No cache read/write in this
      // branch either -- this component only reaches the Plus-gated code
      // path below when hasPlusAccess is actually true, so a non-Plus
      // viewer on this device never sees a Plus viewer's earlier cache.
      if (!authLoading) setNewAds([])
      return
    }

    // Show cached data immediately so the "New" section doesn't pop in a
    // beat after the query resolves -- same reasoning as Home's own
    // REG_OF_DAY_CACHE_KEY comment.
    let lastGood: NewAd[] = []
    try {
      const cached = await AsyncStorage.getItem(AD_NEWADS_CACHE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached) as NewAd[]
        if (parsed?.length) { setNewAds(parsed); lastGood = parsed }
      }
    } catch (_) {}

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - badgeDays)
    const cutoff = cutoffDate.toISOString().split('T')[0]
    try {
      // citation_publish_date (Federal Register publication date, from the
      // API's own structured metadata) not effective_date -- confirmed
      // live that effective_date is null on all 5,013 rows (never parsed
      // by ad_scraper.py at all), while citation_publish_date is fully
      // populated and genuinely current (today's date shows up on a real
      // row). Same field ad_citations.py/sync_ad.sh already treat as this
      // corpus's authoritative "when was this touched" signal.
      const { data, error } = await supabase
        .from('airworthiness_directives')
        .select('ad_number, subject_heading, citation_publish_date')
        .gte('citation_publish_date', cutoff)
        .order('citation_publish_date', { ascending: false })
        .limit(20)
      if (!error) {
        const fresh = (data ?? []) as NewAd[]
        setNewAds(fresh)
        AsyncStorage.setItem(AD_NEWADS_CACHE_KEY, JSON.stringify(fresh)).catch(() => {})
      }
      // else: query failed -- cached data (if any) stays visible, don't clear it
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    }
  }, [badgeDays, hasPlusAccess, authLoading])

  useEffect(() => {
    loadNewAds()
  }, [loadNewAds])

  const onRefresh = useCallback(() => {
    loadRecentAd()
    loadNewAds()
  }, [loadRecentAd, loadNewAds])

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
      <OverlayHeader
        title="Airworthiness Directives"
        onBack={() => router.back()}
        right={
          <BackToTop
            visible={scrollY > BACK_TO_TOP_THRESHOLD}
            onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          />
        }
      />
      <TabletContainer>
        <ScrollView
          ref={scrollRef}
          onScroll={makeBackToTopScrollHandler(setScrollY)}
          scrollEventThrottle={16}
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          refreshControl={<RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={tokens.t3} />}
        >
          <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
            <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
            <TextInput
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
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
                <Text style={[styles.coverageNoteText, { color: tokens.t3, fontSize: fs(11.5), lineHeight: fs(11.5) * 1.39 }]}>
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
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
                    Find ADs by named engine, propeller, or avionics part — not just aircraft model
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 8 }]}
                onPress={() => {
                  // Live audit, 2026-08-13: this was the one entry point into
                  // /my-aircraft with no pre-tap tier check -- account.tsx's
                  // own "My Aircraft" row already redirects straight to
                  // /paywall for non-Pro instead of pushing the real screen
                  // (RC: "Free/Plus go straight to the paywall instead of
                  // into a screen that would only block them once they try
                  // to add an aircraft"). Matches that same pattern here;
                  // my-aircraft/index.tsx also now self-guards regardless.
                  // hasProAccess, not bare isPro -- found in the 2026-08-14
                  // gating re-audit: this entry point was still gating on
                  // bare isPro, which would wrongly bounce a genuine Premium
                  // subscriber (isPro:false/isPremium:true) to the paywall
                  // before ever reaching the screen, even after
                  // my-aircraft/index.tsx's own self-guard was fixed.
                  // !authLoading: hasProAccess is false for everyone until
                  // auth resolves, and my-aircraft/index.tsx's own self-guard
                  // now waits for that too -- so this pre-tap check has to
                  // as well, or it becomes the one thing still bouncing a
                  // real Pro/Premium owner to a paywall on a fast tap.
                  if (!hasProAccess) { if (!authLoading) router.push('/paywall?tier=pro'); return }
                  router.push('/my-aircraft' as any)
                }}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.bdim }]}>
                  <Icon name="doc.plaintext" size={fs(19)} color={tokens.blu} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>My Aircraft</Text>
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
                    Save an aircraft to get alerted when a new or updated AD applies to it
                  </Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>

              {recentAd.length > 0 && (
                <View style={styles.recentWrap}>
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recentScroll} contentContainerStyle={styles.recentRow}>
                    {recentAd.map((r) => (
                      <Pressable
                        key={r.id}
                        style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, maxWidth: fs(160) }]}
                        onPress={() => { if (consumeLongPress()) return; router.push(`/ad/${r.id}` as any) }}
                        // Long-press fallback: at larger text sizes the maxWidth:160
                        // box truncates "AD 2018-02-04" mid-number, and the
                        // within-year sequence is what identifies which AD it is.
                        onLongPress={(e) => showPreview(r.title ?? '', e, r.document_number ?? r.id)}
                        onPressOut={hidePreview}
                        delayLongPress={350}
                      >
                        {/* numberOfLines={1}, corpus-wide reg-number sweep:
                            this chip's box only caps width via maxWidth:160,
                            no floor of its own -- added for the same
                            defensive reason as the other index screens'
                            recentChipNum, even though real AD numbers
                            ("2018-02-04", fixed 10-char format) are shorter
                            and lower-risk than FAR's range spans. */}
                        <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>AD {r.document_number}</Text>
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
                      onPress={() => {
                        if (consumeLongPress()) return
                        router.push(`/ad/${item.ad_number}` as any)
                      }}
                      onLongPress={(e) => showPreview(stripAdSubjectPrefix(item.subject_heading), e, `AD ${item.ad_number}`)}
                      onPressOut={hidePreview}
                      delayLongPress={350}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                        <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14), lineHeight: fs(14) * 1.29 }]} numberOfLines={2}>
                          {stripAdSubjectPrefix(item.subject_heading)}
                        </Text>
                      </View>
                      <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}

          {trimmedQuery.length > 0 && (
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
                            onPress={() => {
                              if (consumeLongPress()) return
                              router.push(`/ad/${item.ad_number}` as any)
                            }}
                            onLongPress={(e) => showPreview(stripAdSubjectPrefix(item.subject_heading), e, `AD ${item.ad_number}`)}
                            onPressOut={hidePreview}
                            delayLongPress={350}
                          >
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                              <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14), lineHeight: fs(14) * 1.29 }]} numberOfLines={2}>
                                {stripAdSubjectPrefix(item.subject_heading)}
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
                      onPress={() => {
                        if (consumeLongPress()) return
                        router.push(`/ad/${item.ad_number}` as any)
                      }}
                      onLongPress={(e) => showPreview(stripAdSubjectPrefix(item.subject_heading), e, `AD ${item.ad_number}`)}
                      onPressOut={hidePreview}
                      delayLongPress={350}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(13) }]}>AD {item.ad_number}</Text>
                        <Text style={[styles.adTitle, { color: tokens.t1, fontSize: fs(14), lineHeight: fs(14) * 1.29 }]} numberOfLines={2}>
                          {stripAdSubjectPrefix(item.subject_heading)}
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
  // lineHeight NOT set here -- always overridden inline with fs(11.5) * 1.39
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  coverageNoteText: { flex: 1 },

  hubCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginTop: 14,
  },
  hubIconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  hubTitle: { fontWeight: '600' },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  hubSub: { marginTop: 2 },

  recentWrap: { marginTop: 18 },
  // Same root cause as updates.tsx's filter chips (see that file's
  // comment): a horizontal ScrollView with no explicit `style` collapses
  // its own cross-axis height on web, clipping the row's content. Sized
  // generously for a 2-line chip up to max font scale (1.75x).
  recentScroll: { flexGrow: 0, flexShrink: 0, height: 84 },
  recentRow: { gap: 8 },
  // maxWidth passed inline via fs() at the call site so the cap grows with
  // the text-size slider instead of truncating harder at every step up.
  recentChip: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10 },
  recentChipNum: { fontWeight: '700' },
  recentChipTitle: { marginTop: 2 },

  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  emptyText: { textAlign: 'center', marginTop: 12 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  adNum: { fontWeight: '700', marginBottom: 2 },
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.29
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  adTitle: { fontWeight: '500' },
})
