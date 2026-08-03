import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'

interface FarSectionRow {
  section_number: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
}

// Natural-sort section numbers ("91.3" before "91.107") the same way
// series/[prefix].tsx sorts AC document numbers.
function compareSectionNumbers(a: string, b: string): number {
  const an = parseFloat(a)
  const bn = parseFloat(b)
  if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn
  return a.localeCompare(b)
}

export default function FarPartScreen() {
  const { part } = useLocalSearchParams<{ part: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [sections, setSections] = useState<FarSectionRow[]>([])
  const [partLabel, setPartLabel] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!part) return
    Promise.all([
      supabase.from('far_sections').select('section_number, subpart_letter, subpart_title, title').eq('part', part),
      supabase.from('far_parts').select('label').eq('part', part).single(),
    ]).then(([secRes, partRes]) => {
      if (secRes.data) {
        setSections((secRes.data as FarSectionRow[]).sort((a, b) => compareSectionNumbers(a.section_number, b.section_number)))
      }
      if (partRes.data) setPartLabel((partRes.data as { label: string }).label)
      setLoading(false)
    })
  }, [part])

  // Group by subpart, preserving first-seen order (already numerically sorted above).
  const groups: { letter: string; title: string | null; items: FarSectionRow[] }[] = []
  for (const s of sections) {
    const letter = s.subpart_letter ?? ''
    let g = groups.find((g) => g.letter === letter)
    if (!g) { g = { letter, title: s.subpart_title, items: [] }; groups.push(g) }
    g.items.push(s)
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`Part ${part}`} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          data={groups}
          keyExtractor={(g) => g.letter || 'none'}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.partLabel, { color: tokens.t1, fontSize: fs(16) }]}>{partLabel}</Text>
          }
          renderItem={({ item: group }) => (
            <View style={styles.group}>
              {group.title && (
                <Text style={[styles.subpartTitle, { color: tokens.t3, fontSize: fs(11) }]}>
                  {group.title.toUpperCase()}
                </Text>
              )}
              {group.items.map((s) => (
                <Pressable
                  key={s.section_number}
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/far/${s.section_number}` as any)}
                >
                  <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(13.5) }]}>§ {s.section_number}</Text>
                  <Text style={[styles.secTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                    {(s.title ?? '').replace(/^§\s*[\d.]+\s*/, '')}
                  </Text>
                  <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
                </Pressable>
              ))}
            </View>
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
  list: { padding: 12, paddingBottom: 32 },
  partLabel: { fontWeight: '700', marginBottom: 14, paddingLeft: 2 },
  group: { marginBottom: 10 },
  subpartTitle: { fontWeight: '600', letterSpacing: 0.4, marginBottom: 6, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 6,
  },
  secNum: { fontWeight: '700', width: 62 },
  secTitle: { flex: 1, fontWeight: '500' },
})
