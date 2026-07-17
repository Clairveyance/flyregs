import { useEffect, useState } from 'react'
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { isWithinBadgeLifespan } from '@/lib/badgeLifespan'
import { useBadgeLifespan } from '@/context/badgeLifespan'
import { isOcrScanned } from '@/lib/ocrScannedACs'

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

export default function SeriesScreen() {
  const { prefix } = useLocalSearchParams<{ prefix: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [acs, setACs] = useState<SeriesAC[]>([])
  const [figureCounts, setFigureCounts] = useState<Record<string, number>>({})
  const [seriesName, setSeriesName] = useState('')
  const [loading, setLoading] = useState(true)
  const { badgeDays } = useBadgeLifespan()

  useEffect(() => {
    Promise.all([
      supabase
        .from('advisory_circulars')
        .select('id, document_number, title, date_issued, office, cancels, change_number, changed_block_indices')
        .eq('subject_series', prefix)
        .eq('status', 'active'),
      supabase
        .from('series_summary')
        .select('display_name')
        .eq('series_prefix', prefix)
        .single(),
    ]).then(async ([acsRes, seriesRes]) => {
      if (!acsRes.error && acsRes.data) {
        const sorted = (acsRes.data as SeriesAC[]).sort(compareDocumentNumbers)
        setACs(sorted)
        // One batched query for every AC's Figures & Tables count instead of
        // one request per row -- counted client-side since this is a small
        // (a few hundred rows at most) per-series slice, not the whole table.
        const ids = sorted.map((a) => a.id)
        if (ids.length) {
          const { data: figs } = await supabase.from('ac_figures').select('ac_id').in('ac_id', ids)
          const counts: Record<string, number> = {}
          for (const f of figs ?? []) counts[f.ac_id] = (counts[f.ac_id] ?? 0) + 1
          setFigureCounts(counts)
        }
      }
      if (!seriesRes.error && seriesRes.data) setSeriesName(seriesRes.data.display_name)
      setLoading(false)
    })
  }, [prefix])

  const headerTitle = seriesName ? `${prefix} — ${seriesName}` : `Series ${prefix}`

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={headerTitle} onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <FlatList
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
            <ACRow item={item} tokens={tokens} badgeDays={badgeDays} figureCount={figureCounts[item.id]} />
          )}
        />
      )}
    </View>
  )
}

// ─── AC Row ──────────────────────────────────────────────────────────────────

function ACRow({
  item,
  tokens,
  badgeDays,
  figureCount,
}: {
  item: SeriesAC
  tokens: ReturnType<typeof useTheme>['tokens']
  badgeDays: number
  figureCount?: number
}) {
  const fs = useFS()
  // See the matching comment on Home's WhatsNewCard -- "UPD" is gated on
  // real diff data existing (changed_block_indices), not on `cancels`
  // (a different concept: replacing a different, older document number).
  const isUpd = !!(item.changed_block_indices && item.changed_block_indices.length > 0)
  const showBadge = isWithinBadgeLifespan(item.date_issued, badgeDays)
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
      onPress={() => router.push(`/ac/${item.id}`)}
    >
      <View style={styles.cardTop}>
        {showBadge && (
          <View
            style={[
              styles.badge,
              isUpd
                ? { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }
                : { backgroundColor: tokens.gdim, borderColor: tokens.gbdr },
            ]}
          >
            <Text style={[styles.badgeText, { color: isUpd ? tokens.blu : tokens.grn, fontSize: fs(9.5) }]}>
              {isUpd ? 'UPD' : 'NEW'}
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
      <Text style={[styles.title, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={2}>
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
              <Icon name="photo" size={13} color={tokens.t3} />
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
  title: { fontWeight: '500', fontSize: 14.5, lineHeight: 20 },
  office: { fontSize: 11.5, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  tidbit: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  tidbitText: { fontSize: 11, fontWeight: '600' },
})
