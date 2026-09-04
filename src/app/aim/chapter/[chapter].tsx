import { useEffect, useState, useRef } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'
import { BackToTop, makeBackToTopScrollHandler, BACK_TO_TOP_THRESHOLD } from '@/components/BackToTop'

// The last of the nine second-level browse lists to get an offline cache
// (far/part, cfr49/part, pcg/letter, loi/year and aim/index all had one).
// The real defect is the missing cache: opening a chapter with no network
// showed an empty list, even for a chapter the user had just been reading.
//
// The fetch was also a bare `.then()` with no `.catch()`. That is NOT the
// infinite spinner it looks like -- supabase-js resolves `{data, error}`
// rather than rejecting, so an ordinary network failure still reached
// setLoading(false). The catch below is defense-in-depth for a genuine
// throw (a malformed response, a rejected AsyncStorage read), not a fix for
// an observed hang. Worth having, worth not overstating.
const AIM_CHAPTER_CACHE_KEY_PREFIX = '@flyregs/aim-chapter-cache/'

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
  // "Suggest a feature", RC, 2026-09-03 -- see far/part/[part].tsx's own
  // comment for the full context; same pattern, second rollout.
  const [scrollY, setScrollY] = useState(0)
  const listRef = useRef<FlatList<{ section: string | null; items: AimParagraphRow[] }>>(null)
  // AIM paragraph titles get cut off the same way FAR Part titles do -- same
  // hook/card pair as far/index.tsx's own long-press preview, see
  // useLongPressPreview.ts's header comment.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    if (!chapter) return
    let cancelled = false
    // Mirrors far/part/[part].tsx exactly: paint from cache first so the
    // screen appears immediately, then overwrite with fresh data. A failed
    // refresh leaves whatever was already on screen rather than blanking it.
    let lastGoodParagraphs: AimParagraphRow[] = []
    let lastGoodTitle = ''

    ;(async () => {
      try {
        const cached = await AsyncStorage.getItem(AIM_CHAPTER_CACHE_KEY_PREFIX + chapter)
        if (cached && !cancelled) {
          const { paragraphs: cp, chapterTitle: ct } = JSON.parse(cached)
          if (cp?.length) { setParagraphs(cp); lastGoodParagraphs = cp }
          if (ct) { setChapterTitle(ct); lastGoodTitle = ct }
          setLoading(false)
        }
      } catch (_) {}

      try {
        const [paraRes, chapRes] = await Promise.all([
          supabase.from('aim_paragraphs').select('paragraph_number, section_title, title').eq('chapter', chapter),
          supabase.from('aim_chapters').select('title').eq('chapter', chapter).single(),
        ])
        if (cancelled) return

        let freshParagraphs = lastGoodParagraphs
        if (paraRes.data) {
          const sorted = (paraRes.data as AimParagraphRow[]).sort((a, b) => compareParagraphNumbers(a.paragraph_number, b.paragraph_number))
          setParagraphs(sorted)
          freshParagraphs = sorted
        }
        let freshTitle = lastGoodTitle
        if (chapRes.data) {
          freshTitle = (chapRes.data as { title: string }).title
          setChapterTitle(freshTitle)
        }
        setLoading(false)
        if (freshParagraphs.length) {
          AsyncStorage.setItem(
            AIM_CHAPTER_CACHE_KEY_PREFIX + chapter,
            JSON.stringify({ paragraphs: freshParagraphs, chapterTitle: freshTitle }),
          ).catch(() => {})
        }
      } catch (_) {
        // Network failed -- cached rows (if any) stay on screen. Either way
        // the spinner must stop; this is the branch that used to be missing.
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
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
      <OverlayHeader
        title={isAppendix ? `AIM ${chapter?.toUpperCase()}` : `AIM Chapter ${chapter}`}
        onBack={() => router.back()}
        right={
          <BackToTop
            visible={scrollY > BACK_TO_TOP_THRESHOLD}
            onPress={() => listRef.current?.scrollToOffset({ offset: 0, animated: true })}
          />
        }
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          ref={listRef}
          onScroll={makeBackToTopScrollHandler(setScrollY)}
          scrollEventThrottle={16}
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
                  onLongPress={(e) => showPreview(p.title ?? '', e, p.paragraph_number)}
                  onPressOut={hidePreview}
                  delayLongPress={350}
                >
                  {/* RC, real device: paragraph numbers like "5-4-20" were
                      wrapping mid-number onto a second line inside their
                      fixed-width column -- numberOfLines={1} keeps it on
                      one line; the rare case where it's still too tight
                      truncates instead (fallback below), backed by the
                      long-press preview above now showing the full number. */}
                  <Text style={[styles.paraNum, { color: tokens.blu, fontSize: fs(13.5) }]} numberOfLines={1}>{p.paragraph_number}</Text>
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
  // 62, not the old 56 -- the longest real paragraph number in this
  // chapter-list shape is "N-N-NN" (6 chars); 56 was already tight enough
  // to wrap at default font scale (RC's real-device "5-4-20" report), 62
  // gives it real room so numberOfLines={1} below rarely needs its
  // ellipsis fallback at all.
  paraNum: { fontWeight: '700', width: 62 },
  paraTitle: { flex: 1, fontWeight: '500' },
})
