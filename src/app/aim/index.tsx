import { useEffect, useState, useMemo } from 'react'
import { View, Text, FlatList, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getRecents, recentItemType, type RecentAC } from '@/lib/recents'

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

export default function AimIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [chapters, setChapters] = useState<AimChapter[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [recentAim, setRecentAim] = useState<RecentAC[]>([])

  useEffect(() => {
    // Server-side GROUP BY RPC, not client-side counting -- see far/index.tsx's
    // comment on why (PostgREST's project-wide 1000-row max-rows cap silently
    // undercounts any query that fetches individual rows just to count them).
    Promise.all([
      supabase.from('aim_chapters').select('chapter, title, sort_order').order('sort_order'),
      supabase.rpc('count_aim_paragraphs_by_chapter'),
    ]).then(([chapRes, countRes]) => {
      if (chapRes.data) setChapters(chapRes.data as AimChapter[])
      if (countRes.data) {
        const c: Record<string, number> = {}
        for (const row of countRes.data as { chapter: string; cnt: number }[]) c[row.chapter] = row.cnt
        setCounts(c)
      }
      setLoading(false)
    })
  }, [])

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
            style={[styles.searchInput, { color: tokens.t1, fontSize: fs(14) }]}
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
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
              {recentAim.map((r) => (
                <Pressable
                  key={r.id}
                  style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/aim/${r.id}` as any)}
                >
                  <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]}>{r.document_number}</Text>
                  <Text style={[styles.recentChipTitle, { color: tokens.t2, fontSize: fs(11) }]} numberOfLines={1}>
                    {r.title}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

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
                onPress={() => router.push(`/aim/chapter/${item.chapter}` as any)}
              >
                <Text style={[styles.chapNum, { color: tokens.blu, fontSize: fs(15) }]}>
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
        </TabletContainer>
      )}
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
  recentRow: { paddingRight: 12, gap: 8 },
  recentChip: {
    width: 130, borderRadius: 12, borderWidth: 1, padding: 10, gap: 3,
  },
  recentChipNum: { fontWeight: '700' },
  recentChipTitle: { lineHeight: 14 },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  chapNum: { fontWeight: '700', width: 30 },
  chapTitle: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
