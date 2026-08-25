import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { humanizeLoiTitle } from '@/lib/titleFormat'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface LoiRow {
  slug: string
  title: string
  summary: string | null
  cfr_part_reference: string | null
  issued_date: string | null
}

// Mirrors dictionary/letter/[letter].tsx's exact pattern -- a real browse
// axis alongside loi/index.tsx's full-text search, not a replacement for
// it. RC, real device: "the entire LOI sections field is just blank, with
// only some recents and a note to search... we should be populating this."
// Year (not title) is the browse key on purpose -- loi/index.tsx's own
// comment already explains why a title-alphabetical browse would be
// useless here ("LOI titles are just the addressee/attorney's name...
// worthless as a search key"). Year sidesteps that entirely.
//
// Public, same-for-every-viewer content (title/summary/cfr-reference
// metadata only, no gated body text) -- no uid-scoping needed, matching
// Home's own HOME_CACHE_KEY convention. Keyed per-year since this screen is
// one year at a time.
const LOI_YEAR_CACHE_KEY_PREFIX = '@flyregs/loi-year-cache/'

export default function LoiYearScreen() {
  const { year } = useLocalSearchParams<{ year: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [rows, setRows] = useState<LoiRow[]>([])
  const [loading, setLoading] = useState(true)
  // LOI titles run long and get cut off the same way FAR Part titles do --
  // same hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    if (!year) return
    setLoading(true)

    // Carries the last known-good value across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx), so a failed/slow fetch never blanks out data
    // that was already showing.
    let lastGoodRows: LoiRow[] = []

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(LOI_YEAR_CACHE_KEY_PREFIX + year)
      if (cached) {
        const parsed = JSON.parse(cached) as LoiRow[]
        if (parsed?.length) { setRows(parsed); lastGoodRows = parsed }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged)
    try {
      const { data, error } = await supabase
        .from('legal_interpretations')
        .select('slug, title, summary, cfr_part_reference, issued_date')
        .eq('year', Number(year))
        .order('issued_date', { ascending: false })

      let freshRows = lastGoodRows
      if (!error && data) {
        setRows(data as LoiRow[])
        freshRows = data as LoiRow[]
      }

      setLoading(false)

      AsyncStorage.setItem(LOI_YEAR_CACHE_KEY_PREFIX + year, JSON.stringify(freshRows))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [year])

  useEffect(() => { load() }, [load])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`Legal Interpretations — ${year}`} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
          <FlatList
            data={rows}
            keyExtractor={(item) => item.slug}
            contentContainerStyle={styles.list}
            keyboardDismissMode="interactive"
            ListHeaderComponent={
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                {rows.length} INTERPRETATION{rows.length !== 1 ? 'S' : ''}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  router.push(`/loi/${item.slug}` as any)
                }}
                onLongPress={(e) => showPreview(humanizeLoiTitle(item.title), e)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.title, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>
                    {humanizeLoiTitle(item.title)}
                  </Text>
                  {item.summary && (
                    <Text style={[styles.summary, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]} numberOfLines={2}>
                      {item.summary}
                    </Text>
                  )}
                  <View style={styles.metaRow}>
                    {item.issued_date && (
                      <Text style={[styles.metaText, { color: tokens.t4, fontSize: fs(11) }]}>{item.issued_date}</Text>
                    )}
                    {item.cfr_part_reference && (
                      <Text style={[styles.metaText, styles.cfr, { color: tokens.blu, fontSize: fs(11) }]}>
                        {item.cfr_part_reference}
                      </Text>
                    )}
                  </View>
                </View>
              </Pressable>
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
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6, gap: 3,
  },
  title: { fontWeight: '600', textTransform: 'capitalize' },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  summary: { marginTop: 1 },
  metaRow: { flexDirection: 'row', gap: 10, marginTop: 4 },
  metaText: { fontWeight: '500' },
  cfr: { fontWeight: '600' },
})
