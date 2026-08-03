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
import { stripFarPrefix } from '@/lib/titleFormat'

// FAR's natural browse structure: by Part, matching how a pilot already
// thinks about the regs ("Part 91", "Part 61") -- same role series/[prefix]
// plays for ACs. far_parts is a small reference table (part, label,
// sort_order) built alongside the FAR scraper specifically for this.
interface FarPart {
  part: string
  label: string
  sort_order: number
}

// A bare "NN.NNN" query is almost certainly a section number someone
// already knows and wants to jump straight to, not a Part-list filter term.
const SECTION_NUM_RE = /^\d+\.\d+[a-z]?$/i

export default function FarIndexScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [parts, setParts] = useState<FarPart[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [recentFar, setRecentFar] = useState<RecentAC[]>([])

  useEffect(() => {
    // count_far_sections_by_part is a server-side GROUP BY RPC, not a raw
    // select() -- PostgREST's project-wide max-rows cap (1000, confirmed via
    // a direct curl test with an explicit Range header that still truncated
    // at 1000/4272) silently undercounts anything that fetches individual
    // rows to count client-side. Aggregating in SQL sidesteps the cap
    // entirely instead of trying to page around it.
    Promise.all([
      supabase.from('far_parts').select('part, label, sort_order').order('sort_order'),
      supabase.rpc('count_far_sections_by_part'),
    ]).then(([partsRes, countRes]) => {
      if (partsRes.data) setParts(partsRes.data as FarPart[])
      if (countRes.data) {
        const c: Record<string, number> = {}
        for (const row of countRes.data as { part: string; cnt: number }[]) c[row.part] = row.cnt
        setCounts(c)
      }
      setLoading(false)
    })
  }, [])

  // Device-local recently-VIEWED sections, filtered to FAR -- an honest
  // "most used" proxy without needing any new server-side tracking. Loaded
  // once on mount; this screen is a landing page a reader passes through
  // quickly, not one that needs to react to recents changing mid-visit.
  useEffect(() => {
    getRecents().then((rs) => setRecentFar(rs.filter((r) => recentItemType(r) === 'far').slice(0, 10)))
  }, [])

  const trimmedQuery = query.trim()
  const sectionJump = SECTION_NUM_RE.test(trimmedQuery) ? trimmedQuery : null

  const filteredParts = useMemo(() => {
    const q = trimmedQuery.toLowerCase()
    if (!q) return parts
    return parts.filter((p) => p.part.toLowerCase().includes(q) || p.label.toLowerCase().includes(q))
  }, [parts, trimmedQuery])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Federal Aviation Regulations" onBack={() => router.back()} />
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
            placeholder="Part number, title, or § section…"
            placeholderTextColor={tokens.t3}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => { if (sectionJump) router.push(`/far/${sectionJump}` as any) }}
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
            onPress={() => router.push(`/far/${sectionJump}` as any)}
          >
            <Icon name="arrow.up.right.square" size={fs(15)} color={tokens.blu} />
            <Text style={[styles.jumpText, { color: tokens.blu, fontSize: fs(14) }]}>Go to § {sectionJump}</Text>
          </Pressable>
        )}

        {!trimmedQuery && recentFar.length > 0 && (
          <View style={styles.recentWrap}>
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>RECENTLY VIEWED</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentRow}>
              {recentFar.map((r) => (
                <Pressable
                  key={r.id}
                  style={[styles.recentChip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/far/${r.id}` as any)}
                >
                  <Text style={[styles.recentChipNum, { color: tokens.blu, fontSize: fs(12.5) }]}>{r.document_number}</Text>
                  <Text style={[styles.recentChipTitle, { color: tokens.t2, fontSize: fs(11) }]} numberOfLines={1}>
                    {stripFarPrefix(r.title)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}

        <FlatList
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
          renderItem={({ item }) => (
            <Pressable
              style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push(`/far/part/${item.part}` as any)}
            >
              <Text style={[styles.partNum, { color: tokens.blu, fontSize: fs(15) }]}>{item.part}</Text>
              <Text style={[styles.partLabel, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                {item.label.replace(/^Part\s+\d+—/, '')}
              </Text>
              <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[item.part] ?? 0}</Text>
              </View>
              <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
            </Pressable>
          )}
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
  partNum: { fontWeight: '700', width: 30 },
  partLabel: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
