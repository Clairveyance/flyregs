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
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// AIM's natural browse structure: by Chapter, matching the printed manual's
// own table of contents. aim_chapters is a small reference table (chapter,
// title, sort_order) built alongside the AIM scraper for exactly this.
interface AimChapter {
  chapter: string
  title: string
  sort_order: number
}

// A bare "N-N-N" query is almost certainly a paragraph number someone
// already knows and wants to jump straight to, not a Chapter-list filter.
const PARA_NUM_RE = /^\d+-\d+-\d+[a-z]?$/i

// Public, same-for-every-viewer content (chapter/title/paragraph-count
// metadata, no gated body text) -- no uid-scoping needed, matching Home's
// own HOME_CACHE_KEY convention.
const AIM_INDEX_CACHE_KEY = '@flyregs/aim-index-cache'

export default function AimIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const ifs = useInputFS()
  const [chapters, setChapters] = useState<AimChapter[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  // Offline on a fresh install this rendered "0 CHAPTERS & APPENDICES" over
  // an empty list -- indistinguishable from an empty product. supabase-js
  // RESOLVES with {data: null} on a network failure rather than throwing, so
  // the catch below never fired. Same fix ac/library.tsx already had and
  // far/index.tsx just got.
  const [loadError, setLoadError] = useState(false)
  const [query, setQuery] = useState('')
  const [recentAim, setRecentAim] = useState<RecentAC[]>([])
  // AIM Chapter titles get cut off the same way FAR Part titles do -- same
  // hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    // Carries the last known-good values across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx), so a failed/slow fetch never blanks out data
    // that was already showing.
    let lastGoodChapters: AimChapter[] = []
    let lastGoodCounts: Record<string, number> = {}

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(AIM_INDEX_CACHE_KEY)
      if (cached) {
        const { chapters: cc, counts: ccc } = JSON.parse(cached)
        if (cc?.length) { setChapters(cc); lastGoodChapters = cc }
        if (ccc) { setCounts(ccc); lastGoodCounts = ccc }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged) -- server-side GROUP
    // BY RPC, not client-side counting -- see far/index.tsx's comment on why
    // (PostgREST's project-wide 1000-row max-rows cap silently undercounts
    // any query that fetches individual rows just to count them).
    try {
      const [chapRes, countRes] = await Promise.all([
        supabase.from('aim_chapters').select('chapter, title, sort_order').order('sort_order'),
        supabase.rpc('count_aim_paragraphs_by_chapter'),
      ])

      let freshChapters = lastGoodChapters
      if (chapRes.data) { setChapters(chapRes.data as AimChapter[]); freshChapters = chapRes.data as AimChapter[] }

      let freshCounts = lastGoodCounts
      if (countRes.data) {
        const c: Record<string, number> = {}
        for (const row of countRes.data as { chapter: string; cnt: number }[]) c[row.chapter] = row.cnt
        setCounts(c)
        freshCounts = c
      }

      // Only an error state when there is genuinely nothing cached to show.
      setLoadError(!!(chapRes.error || countRes.error) && freshChapters.length === 0)

      setLoading(false)

      AsyncStorage.setItem(AIM_INDEX_CACHE_KEY, JSON.stringify({ chapters: freshChapters, counts: freshCounts }))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
      setLoadError(chapters.length === 0)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Device-local recently-viewed paragraphs, filtered to AIM -- an honest
  // "most used" proxy without needing any new server-side tracking.
  useEffect(() => {
    getRecents().then((rs) => setRecentAim(rs.filter((r) => recentItemType(r) === 'aim').slice(0, 10)))
  }, [])

  const trimmedQuery = query.trim()
  const paraJump = PARA_NUM_RE.test(trimmedQuery) ? trimmedQuery : null

  const filteredChapters = useMemo(() => {
    const q = trimmedQuery.toLowerCase()
    if (!q) return chapters
    return chapters.filter((c) => c.chapter.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
  }, [chapters, trimmedQuery])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Aeronautical Information Manual" onBack={() => router.back()} />
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
            placeholder="Chapter title, or paragraph #…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => { if (paraJump) router.push(`/aim/${paraJump}` as any) }}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
            </Pressable>
          )}
        </View>

        {paraJump && (
          <Pressable
            style={[styles.jumpRow, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
            onPress={() => router.push(`/aim/${paraJump}` as any)}
          >
            <Icon name="arrow.up.right.square" size={fs(15)} color={tokens.blu} />
            <Text style={[styles.jumpText, { color: tokens.blu, fontSize: fs(14) }]}>Go to ¶ {paraJump}</Text>
          </Pressable>
        )}

        {!trimmedQuery && recentAim.length > 0 && (
          <View style={styles.recentWrap}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.recentScroll} contentContainerStyle={styles.recentRow}>
              {recentAim.map((r) => (
                <Pressable
                  key={r.id}
                  style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => { if (consumeLongPress()) return; router.push(`/aim/${r.id}` as any) }}
                  // Long-press fallback, matching this screen's list rows: the
                  // truncated tail is what identifies the item, and the chip had
                  // no other way to reveal it.
                  onLongPress={(e) => showPreview(r.title ?? '', e, r.document_number ?? r.id)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  {/* numberOfLines={1}, corpus-wide reg-number sweep: fixed,
                      unscaled width:130 chip -- some real AIM paragraph
                      numbers are long front-matter/appendix slugs (e.g.
                      "chap0_section_0", 15 chars), not just "N-N-NN". */}
                  <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>{r.document_number}</Text>
                  <Text style={[styles.recentChipTitle, { color: tokens.t2, fontSize: fs(11), lineHeight: fs(11) * 1.27 }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        {loadError ? (
          <View style={styles.center}>
            <Icon name="exclamationmark.triangle" size={fs(28)} color={tokens.red} />
            <Text style={[styles.groupLabel, { color: tokens.t2, fontSize: fs(15), marginTop: 10, textAlign: 'center' }]}>
              Couldn't load the AIM.
            </Text>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(13), marginTop: 6, textAlign: 'center' }]}>
              Check your connection and try again.
            </Text>
            <Pressable
              onPress={load}
              style={{ marginTop: 14, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 10, backgroundColor: tokens.blu }}
            >
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: fs(14) }}>Try Again</Text>
            </Pressable>
          </View>
        ) : (
        <FlatList
          keyboardDismissMode="interactive"
          style={styles.flatList}
          data={filteredChapters}
          keyExtractor={(item) => item.chapter}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {trimmedQuery
                ? `${filteredChapters.length} MATCHING CHAPTER${filteredChapters.length === 1 ? '' : 'S'}`
                : `${chapters.length} CHAPTERS & APPENDICES`}
            </Text>
          }
          renderItem={({ item }) => {
            // aim_scraper.py's front-matter/appendix rows use non-numeric
            // chapter slugs ("0" is real; appendices are handled via title
            // alone here since aim_chapters already carries a clean label).
            const isAppendix = /^a/i.test(item.chapter) && isNaN(Number(item.chapter))
            return (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  router.push(`/aim/chapter/${item.chapter}` as any)
                }}
                onLongPress={(e) => showPreview(item.title, e, isAppendix ? item.chapter.toUpperCase() : item.chapter)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                {/* numberOfLines={1}, corpus-wide reg-number sweep: chapNum
                    was a bare, unscaled `width: 30` with no fallback at all
                    -- the exact bug shape aim/chapter/[chapter].tsx's own
                    paraNum was fixed for (RC's real-device "5-4-20" report),
                    just missed on this parent chapter-list screen. Real
                    chapter labels top out at 2 chars ("A1"-"A5"), which only
                    needs a raw 30px at default scale but can exceed it at a
                    larger accessibility text size since the width itself
                    doesn't grow with fs() -- widened slightly for headroom,
                    numberOfLines is the real guarantee, backed by the
                    long-press preview now showing the full chapter label. */}
                <Text style={[styles.chapNum, { color: tokens.blu, fontSize: fs(15) }]} numberOfLines={1}>
                  {isAppendix ? item.chapter.toUpperCase() : item.chapter}
                </Text>
                <Text style={[styles.chapTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                  {item.title}
                </Text>
                <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                  <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[item.chapter] ?? 0}</Text>
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
  chapNum: { fontWeight: '700', width: 36 },
  chapTitle: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
