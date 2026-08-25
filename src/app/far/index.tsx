import { useEffect, useState, useMemo, useCallback } from 'react'
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
import { stripFarPrefix } from '@/lib/titleFormat'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// FAR's natural browse structure: by Part, matching how a pilot already
// thinks about the regs ("Part 91", "Part 61") -- same role series/[prefix]
// plays for ACs. far_parts is a small reference table (part, label,
// sort_order) built alongside the FAR scraper specifically for this.
interface FarPart {
  part: string
  label: string
  sort_order: number
}

interface Cfr49Part {
  part: string
  label: string
  family: string
  sort_order: number
}

// RC, 2026-08-14, on a screenshot of this screen: "maybe we just add them
// inside the FARs (since they're closely tied) and create top chips to see/
// sort each. FAR, HMR, NTSB, etc." -- the new 49 CFR content (NTSB 830, TSA
// 1544/1552, HMR 175; see sync/migrations_cfr49_schema.sql) folds into this
// existing screen as a family filter rather than a separate destination.
// Order matches the scraper's own TARGET_PARTS priority (accident reporting
// first, every pilot's concern; then the two TSA security parts; hazmat
// last).
type Family = 'FAR' | 'NTSB' | 'TSA' | 'HMR'
const FAMILY_ORDER: Family[] = ['FAR', 'NTSB', 'TSA', 'HMR']
const FAMILY_TITLE: Record<Family, string> = {
  FAR: 'Federal Aviation Regulations',
  NTSB: 'NTSB — Accident Reporting',
  TSA: 'TSA Security Regulations',
  HMR: 'Hazardous Materials Regulations',
}

// A bare "NN.NNN" query is almost certainly a section number someone
// already knows and wants to jump straight to, not a Part-list filter term.
const SECTION_NUM_RE = /^\d+\.\d+[a-z]?$/i

// Public, same-for-every-viewer content (part/label/section-count metadata,
// no gated body text) -- no uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention.
const FAR_INDEX_CACHE_KEY = '@flyregs/far-index-cache'

export default function FarIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [parts, setParts] = useState<FarPart[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [cfr49Parts, setCfr49Parts] = useState<Cfr49Part[]>([])
  const [cfr49Counts, setCfr49Counts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [recentFar, setRecentFar] = useState<RecentAC[]>([])
  const [family, setFamily] = useState<Family>('FAR')
  // RC: "the FAR list has many Part titles that are long and get cut off by
  // the phone screen. tap/hold to have the entire title readable." Same
  // hook/card pair MagicLink's own long-press preview uses -- see
  // useLongPressPreview.ts's header comment.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    // Carries the last known-good values across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx), so a failed/slow fetch never blanks out data
    // that was already showing.
    let lastGoodParts: FarPart[] = []
    let lastGoodCounts: Record<string, number> = {}
    let lastGoodCfr49Parts: Cfr49Part[] = []
    let lastGoodCfr49Counts: Record<string, number> = {}

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(FAR_INDEX_CACHE_KEY)
      if (cached) {
        const { parts: cp, counts: cc, cfr49Parts: ccp, cfr49Counts: ccc } = JSON.parse(cached)
        if (cp?.length) { setParts(cp); lastGoodParts = cp }
        if (cc) { setCounts(cc); lastGoodCounts = cc }
        if (ccp?.length) { setCfr49Parts(ccp); lastGoodCfr49Parts = ccp }
        if (ccc) { setCfr49Counts(ccc); lastGoodCfr49Counts = ccc }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged) -- count_far_sections_by_part
    // is a server-side GROUP BY RPC, not a raw select() -- PostgREST's
    // project-wide max-rows cap (1000, confirmed via a direct curl test with
    // an explicit Range header that still truncated at 1000/4272) silently
    // undercounts anything that fetches individual rows to count
    // client-side. Aggregating in SQL sidesteps the cap entirely instead of
    // trying to page around it. cfr49_sections is a small first pass (86
    // rows total) so a plain select+client reduce is fine there, well under
    // the cap.
    try {
      const [partsRes, countRes, cfr49PartsRes, cfr49SecRes] = await Promise.all([
        supabase.from('far_parts').select('part, label, sort_order').order('sort_order'),
        supabase.rpc('count_far_sections_by_part'),
        supabase.from('cfr49_parts').select('part, label, family, sort_order').order('sort_order'),
        supabase.from('cfr49_sections').select('part'),
      ])

      let freshParts = lastGoodParts
      if (partsRes.data) { setParts(partsRes.data as FarPart[]); freshParts = partsRes.data as FarPart[] }

      let freshCounts = lastGoodCounts
      if (countRes.data) {
        const c: Record<string, number> = {}
        for (const row of countRes.data as { part: string; cnt: number }[]) c[row.part] = row.cnt
        setCounts(c)
        freshCounts = c
      }

      let freshCfr49Parts = lastGoodCfr49Parts
      if (cfr49PartsRes.data) { setCfr49Parts(cfr49PartsRes.data as Cfr49Part[]); freshCfr49Parts = cfr49PartsRes.data as Cfr49Part[] }

      let freshCfr49Counts = lastGoodCfr49Counts
      if (cfr49SecRes.data) {
        const c: Record<string, number> = {}
        for (const row of cfr49SecRes.data as { part: string }[]) c[row.part] = (c[row.part] ?? 0) + 1
        setCfr49Counts(c)
        freshCfr49Counts = c
      }

      setLoading(false)

      AsyncStorage.setItem(FAR_INDEX_CACHE_KEY, JSON.stringify({
        parts: freshParts,
        counts: freshCounts,
        cfr49Parts: freshCfr49Parts,
        cfr49Counts: freshCfr49Counts,
      }))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Device-local recently-VIEWED sections, filtered to FAR -- an honest
  // "most used" proxy without needing any new server-side tracking. Loaded
  // once on mount; this screen is a landing page a reader passes through
  // quickly, not one that needs to react to recents changing mid-visit.
  // FAR-only: cfr49's recents would need a per-family cross-reference this
  // first pass doesn't build (see far/index.tsx's own build notes).
  useEffect(() => {
    getRecents().then((rs) => setRecentFar(rs.filter((r) => recentItemType(r) === 'far').slice(0, 10)))
  }, [])

  const trimmedQuery = query.trim()
  const sectionJump = SECTION_NUM_RE.test(trimmedQuery) ? trimmedQuery : null
  const jumpRoute = family === 'FAR' ? `/far/${sectionJump}` : `/cfr49/${sectionJump}`

  const familiesPresent = useMemo(
    () => FAMILY_ORDER.filter((f) => f === 'FAR' || cfr49Parts.some((p) => p.family === f)),
    [cfr49Parts],
  )

  const filteredParts = useMemo(() => {
    const q = trimmedQuery.toLowerCase()
    if (!q) return parts
    return parts.filter((p) => p.part.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
  }, [parts, trimmedQuery])

  const filteredCfr49Parts = useMemo(() => {
    const inFamily = cfr49Parts.filter((p) => p.family === family)
    const q = trimmedQuery.toLowerCase()
    if (!q) return inFamily
    return inFamily.filter((p) => p.part.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
  }, [cfr49Parts, family, trimmedQuery])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={FAMILY_TITLE[family]} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        {familiesPresent.length > 1 && (
          <View style={styles.familyChipRow}>
            {familiesPresent.map((f) => {
              const active = family === f
              return (
                <Pressable
                  key={f}
                  style={[
                    styles.familyChip,
                    { backgroundColor: tokens.bdim, borderColor: tokens.bbdr },
                    active && { backgroundColor: tokens.blu, borderColor: tokens.blu },
                  ]}
                  onPress={() => setFamily(f)}
                >
                  <Text style={[styles.familyChipText, { color: active ? '#fff' : tokens.blu, fontSize: fs(12.5) }]}>{f}</Text>
                </Pressable>
              )
            })}
          </View>
        )}

        <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
          <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
          <TextInput
            style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
            placeholder="Part number, title, or § section…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => { if (sectionJump) router.push(jumpRoute as any) }}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {sectionJump && (
          <Pressable
            style={[styles.jumpRow, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
            onPress={() => router.push(jumpRoute as any)}
          >
            <Icon name="arrow.up.right.square" size={fs(15)} color={tokens.blu} />
            <Text style={[styles.jumpText, { color: tokens.blu, fontSize: fs(14) }]}>Go to § {sectionJump}</Text>
          </Pressable>
        )}

        {family === 'FAR' && !trimmedQuery && recentFar.length > 0 && (
          <View style={styles.recentWrap}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recentScroll} contentContainerStyle={styles.recentRow}>
              {recentFar.map((r) => (
                <Pressable
                  key={r.id}
                  style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/far/${r.id}` as any)}
                >
                  {/* numberOfLines={1}, corpus-wide reg-number sweep: this
                      chip is a fixed, unscaled width:130 -- real FAR section
                      numbers can be range spans up to 17 chars
                      ("121.1400-121.1499"), which wrapped mid-number with no
                      fallback here (same bug shape as AIM's original paraNum
                      report). */}
                  <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>{r.document_number}</Text>
                  <Text style={[styles.recentChipTitle, { color: tokens.t2, fontSize: fs(11), lineHeight: fs(11) * 1.27 }]} numberOfLines={1}>
                    {stripFarPrefix(r.title)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {family === 'FAR' ? (
          <FlatList
            keyboardDismissMode="interactive"
            style={styles.flatList}
            data={filteredParts}
            keyExtractor={(item) => item.part}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {trimmedQuery
                  ? `${filteredParts.length} MATCHING PART${filteredParts.length === 1 ? '' : 'S'}`
                  : `${parts.length} PARTS · ${Object.values(counts).reduce((a, b) => a + b, 0)} SECTIONS`}
              </Text>
            }
            renderItem={({ item }) => {
              const cleanLabel = item.label.replace(/^Part\s+\d+—/, '')
              return (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    router.push(`/far/part/${item.part}` as any)
                  }}
                  onLongPress={(e) => showPreview(cleanLabel, e, item.part)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <Text style={[styles.partNum, { color: tokens.blu, fontSize: fs(15), minWidth: fs(30) }]} numberOfLines={1}>{item.part}</Text>
                  <Text style={[styles.partLabel, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                    {cleanLabel}
                  </Text>
                  <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                    <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[item.part] ?? 0}</Text>
                  </View>
                  <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                </Pressable>
              )
            }}
          />
        ) : (
          <FlatList
            keyboardDismissMode="interactive"
            style={styles.flatList}
            data={filteredCfr49Parts}
            keyExtractor={(item) => item.part}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {trimmedQuery
                  ? `${filteredCfr49Parts.length} MATCHING PART${filteredCfr49Parts.length === 1 ? '' : 'S'}`
                  : `${filteredCfr49Parts.length} PART${filteredCfr49Parts.length === 1 ? '' : 'S'} · ${filteredCfr49Parts.reduce((a, p) => a + (cfr49Counts[p.part] ?? 0), 0)} SECTIONS`}
              </Text>
            }
            renderItem={({ item }) => {
              const cleanLabel = item.label.replace(/^PART\s+[\d.]+—/i, '')
              return (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    router.push(`/cfr49/part/${item.part}` as any)
                  }}
                  onLongPress={(e) => showPreview(cleanLabel, e, item.part)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <Text style={[styles.partNum, { color: tokens.blu, fontSize: fs(15), minWidth: fs(30) }]} numberOfLines={1}>{item.part}</Text>
                  <Text style={[styles.partLabel, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                    {cleanLabel}
                  </Text>
                  <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                    <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{cfr49Counts[item.part] ?? 0}</Text>
                  </View>
                  <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                </Pressable>
              )
            }}
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

  // flexWrap, not a horizontal ScrollView -- the RefPack category chips in
  // search.tsx had the exact "chip runs off screen on a 13 mini" bug this
  // was built to avoid corpus-wide; only 4 short chips here so wrap never
  // costs more than one extra row even at max font scale.
  familyChipRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center',
    marginHorizontal: 12, marginTop: 10,
  },
  familyChip: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7 },
  familyChipText: { fontWeight: '700', letterSpacing: 0.3 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  jumpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 8,
    borderRadius: 10, borderWidth: 1, paddingVertical: 9, paddingHorizontal: 12,
  },
  jumpText: { fontWeight: '600' },

  recentWrap: { marginTop: 14, paddingLeft: 12 },
  // Same root cause as updates.tsx's filter chips (see that file's
  // comment): a horizontal ScrollView with no explicit `style` collapses
  // its own cross-axis height on web, clipping the row's content. Sized
  // generously for a 2-line chip up to max font scale (1.75x).
  recentScroll: { flexGrow: 0, flexShrink: 0, height: 84 },
  recentRow: { paddingRight: 12, gap: 8 },
  recentChip: {
    width: 130, borderRadius: 12, borderWidth: 1, padding: 10, gap: 3,
  },
  recentChipNum: { fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(11) * 1.27
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  recentChipTitle: {},

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  // minWidth (not a fixed width) + flexShrink: 0 -- same fix as far/part/
  // [part].tsx's own secNum column (BB-072): a hardcoded width fit FAR's own
  // 1-3 digit part numbers but wrapped cfr49's 4-digit ones ("1544", "1552")
  // onto two lines. Scales with the text-size slider via fs() like the
  // original fix; numberOfLines={1} on the Text itself is the second layer
  // (BB-072 needed both -- a width alone isn't a hard guarantee against wrap).
  partNum: { fontWeight: '700', minWidth: 30, flexShrink: 0 },
  partLabel: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
