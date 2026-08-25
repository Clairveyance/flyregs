import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import type { ACSeries } from '@/types'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// AC's natural browse structure: by series -- this used to live directly on
// Home (the FlatList's primary content, pre-redesign). Redesign step 5 moved
// it to its own dedicated screen, matching the new far/aim/pcg index screens,
// so Home can show the regulatory-body cards as its primary content instead.
// series/[prefix].tsx (unchanged) is still where tapping a row lands.
// Public, same-for-every-viewer content (series names/counts only, never
// gated full text) -- no uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention.
const AC_LIBRARY_CACHE_KEY = '@flyregs/ac-library-cache'

export default function AcLibraryScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const [series, setSeries] = useState<ACSeries[]>([])
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  // Same real bug, same fix, as series/[prefix].tsx's own loadError comment
  // -- RC real-device report 2026-08-21/22: "ALL of the ACs are GONE!!."
  // This screen had no error state at all; a failed fetch (supabase-js
  // resolves {data, error} rather than throwing) used to silently render
  // an empty list with no indication anything went wrong.
  const [loadError, setLoadError] = useState(false)
  // AC series display names get cut off the same way FAR Part titles do --
  // same hook/card pair as far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = async () => {
    setLoading(true)
    setLoadError(false)

    // Carries the last known-good values across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx), so a failed fetch never blanks out (or
    // errors-out) something that was already correctly showing. Also what
    // lets a failed refresh distinguish "nothing to show, surface the real
    // error" from "cache/previous data still stands, stay quiet" -- see this
    // file's own loadError comment above for why that distinction exists.
    let lastGoodSeries: ACSeries[] = []
    let lastGoodCount: number | null = null

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(AC_LIBRARY_CACHE_KEY)
      if (cached) {
        const { series: cs, totalCount: ct } = JSON.parse(cached)
        if (cs?.length) { setSeries(cs); lastGoodSeries = cs }
        if (ct != null) { setTotalCount(ct); lastGoodCount = ct }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged)
    try {
      const [seriesRes, countRes] = await Promise.all([
        supabase.from('series_summary').select('*').order('sort_order'),
        // 'id' not '*' -- see (tabs)/index.tsx's identical fix for why: a
        // count(*)-only request still touches every matching row's data, and
        // this table's pdf_text column is large enough to make that
        // intermittently fail as a genuine 500 under select=*.
        supabase.from('advisory_circulars').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      ])

      let freshSeries = lastGoodSeries
      if (seriesRes.data) { setSeries(seriesRes.data as ACSeries[]); freshSeries = seriesRes.data as ACSeries[] }
      else if (seriesRes.error && !lastGoodSeries.length) setLoadError(true)

      const freshCount = countRes.count ?? lastGoodCount
      if (countRes.count !== null) setTotalCount(countRes.count)

      setLoading(false)

      AsyncStorage.setItem(AC_LIBRARY_CACHE_KEY, JSON.stringify({ series: freshSeries, totalCount: freshCount }))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible; only surface
      // the real error state when there's genuinely nothing cached to show.
      if (!lastGoodSeries.length) setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Advisory Circulars" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Icon name="exclamationmark.triangle" size={fs(28)} color={tokens.red} />
          <Text style={[styles.groupLabel, { color: tokens.t2, fontSize: fs(15), marginTop: 10, textAlign: 'center' }]}>
            Couldn't load Advisory Circulars.
          </Text>
          <Pressable
            onPress={load}
            style={{ marginTop: 14, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 10, backgroundColor: tokens.blu }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: fs(14) }}>Try Again</Text>
          </Pressable>
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          data={series}
          keyExtractor={(item) => item.series_prefix}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {series.length} SERIES{totalCount !== null ? ` · ${totalCount} CURRENT ACS` : ''}
            </Text>
          }
          renderItem={({ item }) => {
            const numSize = item.series_prefix.length >= 4 ? 11.5 : 15
            return (
              <Pressable
                style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => {
                  if (consumeLongPress()) return
                  router.push(`/series/${item.series_prefix}`)
                }}
                onLongPress={(e) => showPreview(item.display_name, e, item.series_prefix)}
                onPressOut={hidePreview}
                delayLongPress={350}
              >
                <Text style={[styles.seriesNum, { color: tokens.blu, fontSize: fs(numSize) }]} numberOfLines={1}>{item.series_prefix}</Text>
                <Text style={[styles.seriesName, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={2}>
                  {item.display_name}
                </Text>
                <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                  <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{item.ac_count}</Text>
                </View>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )
          }}
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
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  // RC, real device: "1…"/"4…"/"82…" -- 3-digit series numbers (194, 437,
  // 440...) were getting cut down to a single digit in this column. 34 was
  // sized for the shortest real prefixes and just isn't enough room for
  // the ordinary 3-digit case at this font size, let alone "8260" (the
  // longest real one) -- 46 gives real 3-digit numbers room to render in
  // full; the numSize step-down above still helps the 4-digit outlier.
  // numberOfLines={1} at the call site is the truncation fallback for
  // anything still too tight (e.g. a larger accessibility text-size
  // setting), backed by the long-press preview now showing the full number.
  seriesNum: { fontWeight: '700', width: 46, textAlign: 'center' },
  seriesName: { flex: 1, fontWeight: '500' },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
