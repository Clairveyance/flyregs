import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { SplitPane } from '@/components/SplitPane'
import { RegPreviewInline } from '@/components/RegPreviewPane'
import { useIsTabletLandscape, useIsTabletPortrait } from '@/context/responsive'
import { naturalCompare } from '@/lib/naturalSort'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface FarSectionRow {
  section_number: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
}

// Public, same-for-every-viewer content (section number/title metadata
// only, no gated body text) -- no uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention. Keyed per-part since this screen is one Part
// at a time.
const FAR_PART_CACHE_KEY_PREFIX = '@flyregs/far-part-cache/'

export default function FarPartScreen() {
  const { part } = useLocalSearchParams<{ part: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [sections, setSections] = useState<FarSectionRow[]>([])
  const [partLabel, setPartLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const isTabletLandscape = useIsTabletLandscape()
  const isTabletPortrait = useIsTabletPortrait()
  // Either tablet split variant swaps the reading pane in place instead of
  // navigating -- only phone still pushes to /far/[id] as before.
  const isSplit = isTabletLandscape || isTabletPortrait
  // Reset whenever the part itself changes (navigating Part 91 -> Part 61
  // shouldn't leave 91's last-read section showing in a pane now labeled
  // Part 61).
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null)
  useEffect(() => { setSelectedRoute(null) }, [part])
  // Section titles here can run just as long as FAR Part titles do (same
  // corpus-wide ask that produced far/index.tsx's own long-press preview) --
  // same hook/card pair, see useLongPressPreview.ts's header comment.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    if (!part) return
    setLoading(true)

    // Carries the last known-good values across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx), so a failed/slow fetch never blanks out data
    // that was already showing.
    let lastGoodSections: FarSectionRow[] = []
    let lastGoodLabel = ''

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(FAR_PART_CACHE_KEY_PREFIX + part)
      if (cached) {
        const { sections: cs, partLabel: cl } = JSON.parse(cached)
        if (cs?.length) { setSections(cs); lastGoodSections = cs }
        if (cl) { setPartLabel(cl); lastGoodLabel = cl }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged)
    try {
      const [secRes, partRes] = await Promise.all([
        supabase.from('far_sections').select('section_number, subpart_letter, subpart_title, title').eq('part', part),
        supabase.from('far_parts').select('label').eq('part', part).single(),
      ])

      let freshSections = lastGoodSections
      if (secRes.data) {
        const sorted = (secRes.data as FarSectionRow[]).sort((a, b) => naturalCompare(a.section_number, b.section_number))
        setSections(sorted)
        freshSections = sorted
      }

      let freshLabel = lastGoodLabel
      if (partRes.data) {
        const label = (partRes.data as { label: string }).label
        setPartLabel(label)
        freshLabel = label
      }

      setLoading(false)

      AsyncStorage.setItem(FAR_PART_CACHE_KEY_PREFIX + part, JSON.stringify({ sections: freshSections, partLabel: freshLabel }))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [part])

  useEffect(() => { load() }, [load])

  // Group by subpart, preserving first-seen order (already numerically sorted above).
  const groups: { letter: string; title: string | null; items: FarSectionRow[] }[] = []
  for (const s of sections) {
    const letter = s.subpart_letter ?? ''
    let g = groups.find((g) => g.letter === letter)
    if (!g) { g = { letter, title: s.subpart_title, items: [] }; groups.push(g) }
    g.items.push(s)
  }

  const sectionList = (
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
            const route = `/far/${s.section_number}`
            const isSelected = isSplit && selectedRoute === route
            const cleanTitle = (s.title ?? '').replace(/^§\s*[\d.]+\s*/, '')
            return (
              <Pressable
                key={s.section_number}
                style={[
                  styles.row,
                  { backgroundColor: isSelected ? tokens.bdim : tokens.bg2, borderColor: isSelected ? tokens.bbdr : tokens.bdr },
                ]}
                onPress={() => {
                  if (consumeLongPress()) return
                  if (isSplit) setSelectedRoute(route)
                  else router.push(route as any)
                }}
                onLongPress={(e) => showPreview(cleanTitle, e, `§ ${s.section_number}`)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                {/* minWidth (not the old fixed width: 62) scales with the
                    text-size slider via fs() -- BB-072, real device beta
                    report: "the #s themselves don't have enough room on the
                    left and are being forced to wrap." A raw pixel width
                    never grew even though the digits inside it did at
                    larger text sizes. flexShrink: 0 keeps secTitle's own
                    flex:1 from squeezing this column back down.
                    numberOfLines={1}, added in the corpus-wide reg-number
                    sweep: real section numbers can be range spans up to 17
                    chars ("121.1400-121.1499"), long enough that minWidth's
                    floor alone isn't a hard guarantee against wrap under a
                    tight combination of a narrow device and a large
                    accessibility text size -- same second-layer defense as
                    aim/chapter/[chapter].tsx's paraNum, backed by the
                    long-press preview now showing the full number below. */}
                <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(13.5), minWidth: fs(64), flexShrink: 0 }]} numberOfLines={1}>§ {s.section_number}</Text>
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
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`Part ${part}`} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : isTabletLandscape ? (
        <SplitPane
          storageKey="far"
          rail={sectionList}
          detail={<RegPreviewInline route={selectedRoute} onClose={() => setSelectedRoute(null)} />}
        />
      ) : isTabletPortrait ? (
        <SplitPane
          storageKey="far-portrait"
          orientation="vertical"
          rail={sectionList}
          detail={<RegPreviewInline route={selectedRoute} onClose={() => setSelectedRoute(null)} />}
        />
      ) : (
        <TabletContainer>{sectionList}</TabletContainer>
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
