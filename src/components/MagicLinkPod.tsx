import { useState, useEffect } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { routeForCitedItem } from '@/lib/citedItems'
import { setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { supabase } from '@/lib/supabase'

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

// The "gold spectrum" -- a narrow-hue sweep through gold/champagne/amber/
// copper, not a full ROYGBIV rainbow. Used both for the rotating border
// gradient and (sampled per-letter below) the "MagicLink" wordmark, so the
// brand mark and its own border read as one consistent visual idea.
//
// Two separate palettes, not one shared across themes -- confirmed live as
// a real bug: the dark-tuned palette's pale champagne stop (#F0D890) reads
// beautifully against the app's near-black dark bg2, but nearly disappears
// against light mode's white bg2. Light mode uses deeper, more saturated
// bronze/amber/copper/umber tones instead so the ring and wordmark still
// stand out against a light background, not just paler versions of the
// same stops.
const GOLD_SPECTRUM_DARK = ['#C6A224', '#F0D890', '#E8A860', '#D98F5C', '#C6A224'] as const
const GOLD_SPECTRUM_LIGHT = ['#A87C00', '#C9962E', '#B8601E', '#8F4A1E', '#A87C00'] as const

function goldSpectrumFor(isDark: boolean): readonly string[] {
  return isDark ? GOLD_SPECTRUM_DARK : GOLD_SPECTRUM_LIGHT
}

function borderGradientColorsFor(isDark: boolean): [string, string, ...string[]] {
  const spectrum = goldSpectrumFor(isDark)
  return ['transparent', spectrum[0], spectrum[1], spectrum[2], spectrum[3], spectrum[4], 'transparent']
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bch = Math.round(ab + (bb - ab) * t)
  return `rgb(${r},${g},${bch})`
}

// Samples a color at position `t` (0-1) along the given spectrum -- used to
// tint each letter of the "MagicLink" wordmark so it reads as a gradient
// without needing a masked-gradient-text native dependency (RN Text can't
// fill with a real CSS-style gradient on its own).
function sampleGoldSpectrum(t: number, spectrum: readonly string[]): string {
  const scaled = Math.min(t, 0.9999) * (spectrum.length - 1)
  const i = Math.floor(scaled)
  return lerpColor(spectrum[i], spectrum[i + 1], scaled - i)
}

const MAGICLINK_LETTERS = 'MagicLink'.split('')

interface BarDef {
  icon: string
  label: string
  items: RelatedItem[]
}

// MagicLink, v2: every association bar for a document now lives inside ONE
// connected pod sharing a single outer border, instead of separately spaced
// boxes -- confirmed live as a real visual confusion (the expanded dropdown
// read as a stray floating artifact, not a clearly-nested part of its own
// bar). A thin gold-leaning animated light continuously traces the pod's
// outer edge whenever anything inside it has real content, via the classic
// "gradient border" trick: an oversized rotating LinearGradient clipped
// behind a same-shaped inner panel inset by exactly the border's own width,
// so only a thin ring of the moving gradient is ever visible. Counts always
// show for every user (matches the existing "0 when empty" pattern
// app-wide) -- but the expand-and-navigate action is Plus-gated, per the
// 2026-07-26 tier decision (see flyregs_decisions.md): the cross-reference
// convenience is the paywalled thing, not the fact that connections exist.
export function MagicLinkPod({
  bars, currentLabel, hasPlusAccess,
}: {
  bars: BarDef[]
  currentLabel?: string
  hasPlusAccess: boolean
}) {
  const { tokens, resolved } = useTheme()
  const fs = useFS()
  const spectrum = goldSpectrumFor(resolved === 'dark')
  const borderGradientColors = borderGradientColorsFor(resolved === 'dark')
  const anyItems = bars.some((b) => b.items.length > 0)
  const totalCount = bars.reduce((sum, b) => sum + b.items.length, 0)
  const rotation = useSharedValue(0)
  // MagicLink v3: the pod itself now starts collapsed to just the branded
  // mark on every reg page -- confirmed live that showing every bar
  // expanded by default let this feature "take over" the page even though
  // it's the app's own standout feature. A tap reveals the category bars
  // (this level); tapping a category still reveals the actual item list
  // (PodRow's own expanded state, unchanged).
  const [podExpanded, setPodExpanded] = useState(false)
  // The rotating gradient sheet must always be a true SQUARE, oversized
  // enough that no rotation angle ever exposes an edge inside the clip
  // mask -- a fixed "250%" per-axis (the pre-v3 approach) only produces a
  // square when the outer box itself is roughly square. Once v3 made the
  // pod default to collapsed (a short, WIDE single row instead of a taller
  // box), that same 250%-per-axis sizing became a short, wide rectangle
  // instead of a square, and rotating a non-square shape inside a thin
  // clip reads as back-and-forth sliding, not a smooth sweep -- confirmed
  // as the real cause live, not a change to the animation timing itself.
  // Measuring the real box and sizing off its diagonal keeps the spin
  // layer square (and therefore the sweep visually identical) regardless
  // of the container's own aspect ratio.
  const [boxSize, setBoxSize] = useState({ width: 0, height: 0 })
  // A slow, irregular (not one-direction-constant-speed) phase drift for the
  // wordmark's per-letter color sampling -- sum of two sine waves at an
  // incommensurate frequency ratio never repeats on a short, predictable
  // cycle the way a single linear sweep does. Deliberately NOT applied to
  // the border rotation itself, only asked for on the wordmark.
  const [shimmerPhase, setShimmerPhase] = useState(0)

  useEffect(() => {
    if (anyItems) {
      rotation.value = withRepeat(withTiming(360, { duration: 6000, easing: Easing.linear }), -1, false)
    }
  }, [anyItems])

  useEffect(() => {
    if (!anyItems) return
    const start = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const t = (Date.now() - start) / 1000
      const wave = (Math.sin(t * 0.6) + Math.sin(t * 0.37 + 1.7) * 0.6) / 1.6 // ~[-1, 1], never repeats predictably
      setShimmerPhase((wave + 1) / 2) // normalize to [0, 1]
      timer = setTimeout(tick, 66) // ~15fps -- smooth enough for a slow color drift, cheap on re-renders
    }
    tick()
    return () => clearTimeout(timer)
  }, [anyItems])

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }))

  // Diagonal-based square, comfortably oversized (×1.5) so the rotated
  // sheet never exposes a transparent edge inside the clip at any angle.
  const diag = Math.sqrt(boxSize.width ** 2 + boxSize.height ** 2) * 1.5
  const spinSizeStyle = boxSize.width > 0 ? {
    width: diag,
    height: diag,
    top: (boxSize.height - diag) / 2,
    left: (boxSize.width - diag) / 2,
  } : styles.gradientSpinFallback

  return (
    <View
      style={[styles.outer, { borderColor: anyItems ? tokens.goldbdr : tokens.bdr }]}
      onLayout={(e) => setBoxSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
    >
      {anyItems && (
        <View style={styles.gradientClip} pointerEvents="none">
          <Reanimated.View style={[styles.gradientSpinBase, spinSizeStyle, spinStyle]}>
            <LinearGradient
              colors={borderGradientColors}
              locations={[0, 0.05, 0.28, 0.5, 0.72, 0.95, 1]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
          </Reanimated.View>
        </View>
      )}
      <View style={[styles.inner, { backgroundColor: tokens.bg2 }]}>
        <Pressable
          style={[styles.brandRow, podExpanded && { borderBottomColor: tokens.bdr, borderBottomWidth: StyleSheet.hairlineWidth }]}
          onPress={() => setPodExpanded((e) => !e)}
        >
          <Icon name="sparkles" size={11} color={tokens.gold} />
          <Text style={styles.brandText}>
            {MAGICLINK_LETTERS.map((ch, i) => (
              <Text
                key={i}
                // The initial capital of each word ("Magic" + "Link") pops
                // slightly larger -- checked against the raw un-transformed
                // letter, since brandText's own textTransform:'uppercase'
                // renders every character as a capital regardless. Same
                // treatment requested for every other branded name element
                // (RefPacks, etc.) -- see wherever else BRAND_LETTERS-style
                // rendering is used.
                style={{
                  color: sampleGoldSpectrum((i / (MAGICLINK_LETTERS.length - 1) + shimmerPhase) % 1, spectrum),
                  fontSize: ch === 'M' || ch === 'L' ? 13 : 11,
                }}
              >
                {ch}
              </Text>
            ))}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.brandCount, { color: anyItems ? tokens.gold : tokens.t3, fontSize: fs(11.5) }]}>
            {totalCount}
          </Text>
          <Icon name={podExpanded ? 'chevron.up' : 'chevron.down'} size={11} color={tokens.t4} />
        </Pressable>
        {podExpanded &&
          bars.map((bar, i) => (
            <PodRow
              key={bar.label}
              bar={bar}
              isLast={i === bars.length - 1}
              currentLabel={currentLabel}
              hasPlusAccess={hasPlusAccess}
              tokens={tokens}
            />
          ))}
      </View>
    </View>
  )
}

function PodRow({
  bar, isLast, currentLabel, hasPlusAccess, tokens,
}: {
  bar: BarDef
  isLast: boolean
  currentLabel?: string
  hasPlusAccess: boolean
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const [expanded, setExpanded] = useState(false)
  const [loiTitles, setLoiTitles] = useState<Record<string, string>>({})
  const count = bar.items.length
  const hasItems = count > 0

  const handlePressBar = () => {
    if (!hasItems) return
    if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
    setExpanded((e) => !e)
  }

  // LOI item labels previously showed ONLY item.label -- confirmed a real
  // bug live: unlike every other cited_type (where cited_id alone is
  // self-explanatory, e.g. "91.107" or "120-49B"), an LOI's cited_id is an
  // opaque slug and its label is just the paragraph suffix ("(b)"), so a
  // "Related LOIs" bar showed nothing but "(b)", "(e)", "(e),(f)" with no
  // way to tell which letter was which. Fetch real titles once per
  // expand, only for the LOI items actually present in this bar.
  useEffect(() => {
    if (!expanded) return
    const loiIds = bar.items.filter((it) => it.cited_type === 'loi').map((it) => it.cited_id)
    if (loiIds.length === 0) return
    supabase.from('legal_interpretations').select('slug, title').in('slug', loiIds)
      .then(({ data }) => {
        if (!data) return
        const map: Record<string, string> = {}
        for (const row of data as { slug: string; title: string }[]) {
          map[row.slug] = row.title.replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' ')
        }
        setLoiTitles(map)
      })
  }, [expanded, bar.items])

  return (
    <View>
      <Pressable
        style={[styles.row, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
        onPress={handlePressBar}
      >
        <Icon name={bar.icon} size={15} color={hasItems ? tokens.gold : tokens.t3} />
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(13) }]}>{bar.label}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.rowCount, { color: hasItems ? tokens.gold : tokens.t3, fontSize: fs(12.5) }]}>{count}</Text>
        {hasItems && !hasPlusAccess ? (
          <Icon name="lock.fill" size={11} color={tokens.t4} />
        ) : hasItems ? (
          <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={12} color={tokens.t4} />
        ) : null}
      </Pressable>

      {expanded && hasItems && hasPlusAccess && (
        <View style={[styles.expandedList, { borderBottomColor: tokens.bdr }, isLast && styles.expandedListLast]}>
          {bar.items.map((item, i) => (
            <Pressable
              key={`${item.cited_type}-${item.cited_id}-${i}`}
              style={[styles.expandedRow, i > 0 && { borderTopColor: tokens.bdr, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => {
                if (currentLabel) setPendingBreadcrumb(currentLabel)
                router.push(routeForCitedItem(item.cited_type, item.cited_id) as any)
              }}
            >
              <Text style={[styles.expandedLabel, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={1}>
                {item.cited_type === 'loi'
                  ? (loiTitles[item.cited_id] ?? item.cited_id) + (item.label ? ` — ${item.label}` : '')
                  : item.label ?? item.cited_id}
              </Text>
              <Icon name="chevron.right" size={12} color={tokens.t4} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

const BORDER_WIDTH = 1.5

const styles = StyleSheet.create({
  outer: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: BORDER_WIDTH,
    overflow: 'hidden',
  },
  gradientClip: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
  },
  gradientSpinBase: {
    position: 'absolute',
  },
  // Only used for the one frame before onLayout reports real dimensions --
  // any oversized square works here since it's replaced immediately.
  gradientSpinFallback: {
    top: '-75%',
    left: '-75%',
    width: '250%',
    height: '250%',
  },
  inner: {
    borderRadius: 14 - BORDER_WIDTH,
    overflow: 'hidden',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brandText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  brandCount: {
    fontWeight: '700',
    marginRight: 2,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 11,
  },
  rowLabel: { fontWeight: '500' },
  rowCount: { fontWeight: '600', marginRight: 2 },
  expandedList: { paddingBottom: 4 },
  expandedListLast: {},
  expandedRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 9, marginHorizontal: 8,
  },
  expandedLabel: { flex: 1, marginRight: 8 },
})
