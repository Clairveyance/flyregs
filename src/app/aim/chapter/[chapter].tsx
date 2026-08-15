import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface AimParagraphRow {
  paragraph_number: string
  section_title: string | null
  title: string | null
}

// Natural-sort AIM paragraph numbers ("4-3-2" before "4-10-1") the same
// spirit as far/part's section sort -- dotted/dashed numeric segments must
// compare as integers, not lexically.
function compareParagraphNumbers(a: string, b: string): number {
  const ap = a.split('-').map(Number)
  const bp = b.split('-').map(Number)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0
    const bv = bp[i] ?? 0
    if (!isNaN(av) && !isNaN(bv) && av !== bv) return av - bv
  }
  return a.localeCompare(b)
}

export default function AimChapterScreen() {
  const { chapter } = useLocalSearchParams<{ chapter: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [paragraphs, setParagraphs] = useState<AimParagraphRow[]>([])
  const [chapterTitle, setChapterTitle] = useState('')
  const [loading, setLoading] = useState(true)
  // AIM paragraph titles get cut off the same way FAR Part titles do -- same
  // hook/card pair as far/index.tsx's own long-press preview, see
  // useLongPressPreview.ts's header comment.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    if (!chapter) return
    Promise.all([
      supabase.from('aim_paragraphs').select('paragraph_number, section_title, title').eq('chapter', chapter),
      supabase.from('aim_chapters').select('title').eq('chapter', chapter).single(),
    ]).then(([paraRes, chapRes]) => {
      if (paraRes.data) {
        setParagraphs((paraRes.data as AimParagraphRow[]).sort((a, b) => compareParagraphNumbers(a.paragraph_number, b.paragraph_number)))
      }
      if (chapRes.data) setChapterTitle((chapRes.data as { title: string }).title)
      setLoading(false)
    })
  }, [chapter])

  // Group by section_title, preserving already-sorted order.
  const groups: { section: string | null; items: AimParagraphRow[] }[] = []
  for (const p of paragraphs) {
    let g = groups.find((g) => g.section === p.section_title)
    if (!g) { g = { section: p.section_title, items: [] }; groups.push(g) }
    g.items.push(p)
  }

  const isAppendix = /^a/i.test(chapter ?? '') && isNaN(Number(chapter))

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={isAppendix ? `AIM ${chapter?.toUpperCase()}` : `AIM Chapter ${chapter}`} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          data={groups}
          keyExtractor={(g, i) => g.section ?? `none-${i}`}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.chapTitle, { color: tokens.t1, fontSize: fs(16) }]}>{chapterTitle}</Text>
          }
          renderItem={({ item: group }) => (
            <View style={styles.group}>
              {group.section && (
                <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>
                  {group.section.toUpperCase()}
                </Text>
              )}
              {group.items.map((p) => (
                <Pressable
                  key={p.paragraph_number}
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => {
                    if (consumeLongPress()) return
                    router.push(`/aim/${p.paragraph_number}` as any)
                  }}
                  onLongPress={(e) => showPreview(p.title ?? '', e)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  <Text style={[styles.paraNum, { color: tokens.blu, fontSize: fs(13.5) }]}>{p.paragraph_number}</Text>
                  <Text style={[styles.paraTitle, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                    {p.title ?? ''}
                  </Text>
                  <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
                </Pressable>
              ))}
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
  chapTitle: { fontWeight: '700', marginBottom: 14, paddingLeft: 2 },
  group: { marginBottom: 10 },
  sectionTitle: { fontWeight: '600', letterSpacing: 0.4, marginBottom: 6, paddingLeft: 2 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 11, paddingHorizontal: 14, marginBottom: 6,
  },
  paraNum: { fontWeight: '700', width: 56 },
  paraTitle: { flex: 1, fontWeight: '500' },
})
