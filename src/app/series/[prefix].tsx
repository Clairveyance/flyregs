import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { BackToTop, makeBackToTopScrollHandler, BACK_TO_TOP_THRESHOLD } from '@/components/BackToTop'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { getBadgeKind, getBadgeStyle } from '@/lib/acBadge'
import { isOcrScanned } from '@/lib/ocrScannedACs'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface SeriesAC {
  id: string
  document_number: string
  title: string
  date_issued: string | null
  office: string | null
  cancels: string[]
  change_number: number
  changed_block_indices: number[] | null
}

// Natural-sort two FAA document numbers so numeric segments compare as integers.
// "20-24D" < "20-197" because 24 < 197, even though "197" < "24" lexically.
function compareDocumentNumbers(a: SeriesAC, b: SeriesAC): number {
  const RE = /(\d+)/g
  const seg = (s: string) => s.split(RE)
  const ap = seg(a.document_number)
  const bp = seg(b.document_number)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? ''
    const bv = bp[i] ?? ''
    const an = parseInt(av, 10)
    const bn = parseInt(bv, 10)
    if (!isNaN(an) && !isNaN(bn)) {
      if (an !== bn) return an - bn
    } else if (av !== bv) {
      return av.localeCompare(bv)
    }
  }
  return 0
}

// Public, same-for-every-viewer content -- this screen already reads
// through advisory_circulars_gated (see the load() comment below on why),
// which means the columns selected here are already exactly what this
// viewer legitimately received back from the server; caching that same
// already-redacted response for instant reopen isn't caching anything MORE
// than they already saw. No uid-scoping needed, matching Home's own
// HOME_CACHE_KEY convention. Keyed per-prefix since this screen is one
// series at a time.
const SERIES_CACHE_KEY_PREFIX = '@flyregs/series-cache/'

export default function SeriesScreen() {
  const { prefix } = useLocalSearchParams<{ prefix: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [acs, setACs] = useState<SeriesAC[]>([])
  const [figureCounts, setFigureCounts] = useState<Record<string, number>>({})
  const [seriesName, setSeriesName] = useState('')
  const [loading, setLoading] = useState(true)
  // Back-to-top, same rollout -- an AC series list can run long.
  const [scrollY, setScrollY] = useState(0)
  const listRef = useRef<FlatList<SeriesAC>>(null)
  // Real bug, RC real-device report 2026-08-21/22: "ALL of the ACs are
  // GONE!!" -- this screen used to have no error state at all. supabase-js
  // query builders resolve to {data, error} rather than throwing on a
  // failed request (network blip, an in-flight/stale JWT during an
  // auth-state transition -- see today's Face ID entitlement-race fix,
  // c052a50, for exactly the kind of transitional window that could
  // trigger this), so a transient failure used to silently fall through
  // the `if (!acsRes.error && acsRes.data)` guard, leave `acs` empty, and
  // still flip `loading` false -- rendering the exact same "No active ACs
  // in this series" empty state a genuinely-empty series shows, with zero
  // indication anything went wrong. Indistinguishable from real data loss.
  const [loadError, setLoadError] = useState(false)
  const { badgeDays } = useBadgeLifespan()
  // AC titles in this series list get cut off the same way FAR Part titles
  // do -- same hook/card pair as far/index.tsx's own long-press preview.
  // Lives at the screen level (one hook/card per screen, not per row) and
  // is passed down to ACRow below.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)

    const cacheKey = SERIES_CACHE_KEY_PREFIX + prefix
    // Carries the last known-good values across both the cache-read and
    // fresh-fetch blocks below -- same reason as Home's own lastGoodCount
    // (see (tabs)/index.tsx). Also what lets a failed refresh distinguish
    // "nothing to show, surface the real loadError" from "cache/previous
    // data still stands, stay quiet" -- see this file's own loadError
    // comment above for why that distinction exists; a network failure
    // shouldn't downgrade a good cached list to the error screen.
    let lastGoodAcs: SeriesAC[] = []
    let lastGoodFigureCounts: Record<string, number> = {}
    let lastGoodSeriesName = ''

    // Show cached data immediately so the screen appears in under 100 ms
    try {
      const cached = await AsyncStorage.getItem(cacheKey)
      if (cached) {
        const { acs: ca, figureCounts: cf, seriesName: cn } = JSON.parse(cached)
        if (ca?.length) { setACs(ca); lastGoodAcs = ca }
        if (cf) { setFigureCounts(cf); lastGoodFigureCounts = cf }
        if (cn) { setSeriesName(cn); lastGoodSeriesName = cn }
        setLoading(false)
      }
    } catch (_) {}

    // Then fetch fresh data (existing query, unchanged)
    try {
      const [acsRes, seriesRes] = await Promise.all([
        // advisory_circulars_gated, not the raw advisory_circulars table --
        // found live 2026-08-23 QA sweep: `authenticated` has no column-level
        // SELECT grant on advisory_circulars.changed_block_indices (verified
        // via a direct PostgREST call: selecting `id,changed_block_indices`
        // 403s with "permission denied for table advisory_circulars" while
        // every OTHER column in this same select list -- id/document_number/
        // title/date_issued/office/cancels/change_number -- individually
        // succeeds). Since this query selects changed_block_indices (needed
        // for the UPD/VER/NEW badge -- see acBadge.ts's getBadgeKind), the
        // one ungranted column poisons the WHOLE select and this screen 403s
        // on every single load, for every series, for every user, always --
        // which is exactly the failure shape e8302a5's new loadError/"Couldn't
        // load this series" state was built to surface distinctly from a
        // genuinely-empty series, but that fix never addressed why the load
        // itself was failing. ac/[id].tsx already reads this exact column via
        // advisory_circulars_gated (see its own load effect's comment) --
        // that view already works for this exact filter shape (verified live:
        // same subject_series/status filter, 200 with real changed_block_
        // indices data), so this switches to the same sanctioned gated read
        // path instead of the raw table other AC screens correctly avoid.
        supabase
          .from('advisory_circulars_gated')
          .select('id, document_number, title, date_issued, office, cancels, change_number, changed_block_indices')
          .eq('subject_series', prefix)
          .eq('status', 'active'),
        supabase
          .from('series_summary')
          .select('display_name')
          .eq('series_prefix', prefix)
          .single(),
      ])

      let freshAcs = lastGoodAcs
      let freshFigureCounts = lastGoodFigureCounts
      if (!acsRes.error && acsRes.data) {
        const sorted = (acsRes.data as SeriesAC[]).sort(compareDocumentNumbers)
        setACs(sorted)
        freshAcs = sorted
        // One batched query for every AC's Figures & Tables count instead of
        // one request per row -- counted client-side since this is a small
        // (a few hundred rows at most) per-series slice, not the whole table.
        const ids = sorted.map((a) => a.id)
        if (ids.length) {
          const { data: figs } = await supabase.from('ac_figures').select('ac_id').in('ac_id', ids)
          const counts: Record<string, number> = {}
          for (const f of figs ?? []) counts[f.ac_id] = (counts[f.ac_id] ?? 0) + 1
          setFigureCounts(counts)
          freshFigureCounts = counts
        } else {
          setFigureCounts({})
          freshFigureCounts = {}
        }
      } else if (acsRes.error) {
        // Distinguishes "the fetch failed" from "this series genuinely has
        // zero active ACs" -- see this file's loadError comment above. Only
        // surfaced when there's genuinely nothing cached to show -- a
        // network blip shouldn't replace an already-visible cached list
        // with the error screen.
        if (!lastGoodAcs.length) setLoadError(true)
      }

      let freshSeriesName = lastGoodSeriesName
      if (!seriesRes.error && seriesRes.data) {
        setSeriesName(seriesRes.data.display_name)
        freshSeriesName = seriesRes.data.display_name
      }

      setLoading(false)

      AsyncStorage.setItem(cacheKey, JSON.stringify({ acs: freshAcs, figureCounts: freshFigureCounts, seriesName: freshSeriesName }))
    } catch (_) {
      // Network failed -- cached data (if any) stays visible; only surface
      // the real error state when there's genuinely nothing cached to show.
      if (!lastGoodAcs.length) setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [prefix])

  useEffect(() => { load() }, [load])

  const headerTitle = seriesName ? `${prefix} — ${seriesName}` : `Series ${prefix}`

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title={headerTitle}
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
      ) : loadError ? (
        <View style={styles.center}>
          <Icon name="exclamationmark.triangle" size={fs(28)} color={tokens.red} />
          <Text style={[styles.empty, { color: tokens.t2, fontSize: fs(15), marginTop: 10 }]}>
            Couldn't load this series.
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
          ref={listRef}
          onScroll={makeBackToTopScrollHandler(setScrollY)}
          scrollEventThrottle={16}
          data={acs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>
                No active ACs in this series.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <ACRow
              item={item}
              tokens={tokens}
              badgeDays={badgeDays}
              figureCount={figureCounts[item.id]}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
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

// ─── AC Row ──────────────────────────────────────────────────────────────────

function ACRow({
  item,
  tokens,
  badgeDays,
  figureCount,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  item: SeriesAC
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
  figureCount?: number
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const showBadge = isWithinBadgeLifespan(item.date_issued, badgeDays)
  const badge = getBadgeStyle(getBadgeKind(item), tokens)
  const dateStr = item.date_issued
    ? new Date(item.date_issued).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

  return (
    <Pressable
      style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        router.push(`/ac/${item.id}`)
      }}
      onLongPress={(e) => showPreview(item.title, e, item.document_number)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={styles.cardTop}>
        {showBadge && (
          <View style={[styles.badge, { backgroundColor: badge.background, borderColor: badge.border }]}>
            <Text style={[styles.badgeText, { color: badge.color, fontSize: fs(9.5) }]}>
              {badge.label}
            </Text>
          </View>
        )}
        {dateStr && (
          <Text style={[styles.date, { color: tokens.t3, fontSize: fs(11) }]}>{dateStr}</Text>
        )}
        {item.change_number > 0 && (
          <Text style={[styles.change, { color: tokens.t4, fontSize: fs(11) }]}>
            Chg {item.change_number}
          </Text>
        )}
      </View>

      <Text style={[styles.acNum, { color: tokens.blu, fontSize: fs(13) }]}>
        {item.document_number}
        {isOcrScanned(item.document_number) && (
          <Text style={{ color: tokens.t4 }}> *</Text>
        )}
      </Text>
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(14.5), lineHeight: fs(14.5) * 1.38 }]} numberOfLines={2}>
        {item.title}
      </Text>
      {(item.office || !!figureCount) && (
        <View style={styles.metaRow}>
          {item.office && (
            <Text style={[styles.office, { color: tokens.t3, fontSize: fs(11.5) }]}>{item.office}</Text>
          )}
          <View style={{ flex: 1 }} />
          {!!figureCount && (
            <View style={styles.tidbit}>
              <Icon name="photo" size={fs(13)} color={tokens.t3} />
              <Text style={[styles.tidbitText, { color: tokens.t3, fontSize: fs(12.5) }]}>{figureCount}</Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  list: { padding: 12, paddingBottom: 32 },

  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 8,
    gap: 5,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },

  badge: {
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  date: { fontSize: 11, flex: 1 },
  change: { fontSize: 11 },

  acNum: { fontWeight: '700', fontSize: 13 },
  // lineHeight NOT set here -- always overridden inline with fs(14.5) * 1.38
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  title: { fontWeight: '500', fontSize: 14.5 },
  office: { fontSize: 11.5, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  tidbit: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tidbitText: { fontSize: 11, fontWeight: '600' },
})
