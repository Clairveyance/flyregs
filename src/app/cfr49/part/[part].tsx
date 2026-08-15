import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { naturalCompare } from '@/lib/naturalSort'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// Mirrors far/part/[part].tsx's section-list screen. No tablet SplitPane
// variant here (see far/part/[part].tsx's isSplit branch) -- iPad is
// paused until after beta, not worth the extra surface for a brand-new
// content type; always pushes to /cfr49/[id] like FAR's own phone path.
interface Cfr49SectionRow {
  section_number: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
}

export default function Cfr49PartScreen() {
  const { part } = useLocalSearchParams<{ part: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [sections, setSections] = useState<Cfr49SectionRow[]>([])
  const [partLabel, setPartLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    if (!part) return
    Promise.all([
      supabase.from('cfr49_sections').select('section_number, subpart_letter, subpart_title, title').eq('part', part),
      supabase.from('cfr49_parts').select('label').eq('part', part).single(),
    ]).then(([secRes, partRes]) => {
      if (secRes.data) {
        setSections((secRes.data as Cfr49SectionRow[]).sort((a, b) => naturalCompare(a.section_number, b.section_number)))
      }
      if (partRes.data) setPartLabel((partRes.data as { label: string }).label)
      setLoading(false)
    })
  }, [part])

  const groups: { letter: string; title: string | null; items: Cfr49SectionRow[] }[] = []
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
                {group.items.map((s) => {
                  const cleanTitle = (s.title ?? '').replace(/^§\s*[\d.]+\s*/, '')
                  return (
                    <Pressable
                      key={s.section_number}
                      style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                      onPress={() => {
                        if (consumeLongPress()) return
                        router.push(`/cfr49/${s.section_number}` as any)
                      }}
                      onLongPress={(e) => showPreview(cleanTitle, e)}
                      onPressOut={hidePreview}
                      delayLongPress={350}
                    >
                      <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(13.5), minWidth: fs(64), flexShrink: 0 }]}>§ {s.section_number}</Text>
                      <Text style={[styles.secTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                        {cleanTitle}
                      </Text>
                      <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
                    </Pressable>
                  )
                })}
              </View>
            )}
          />
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
  list: { padding: 12, paddingBottom: 32 },
  partLabel: { fontWeight: '700', marginBottom: 14, paddingLeft: 2 },
  group: { marginBottom: 10 },
  subpartTitle: { fontWeight: '600', letterSpacing: 0.4, marginBottom: 6, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 6,
  },
  secNum: { fontWeight: '700' },
  secTitle: { flex: 1, fontWeight: '500' },
})
