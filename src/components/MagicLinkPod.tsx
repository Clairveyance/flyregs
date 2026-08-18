import { useState, useEffect, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, Modal, Dimensions, GestureResponderEvent } from 'react-native'
import { router } from 'expo-router'
import Reanimated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import * as Haptics from 'expo-haptics'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { routeForCitedItem } from '@/lib/citedItems'
import { setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { supabase } from '@/lib/supabase'
import { stripAdSubjectPrefix } from '@/lib/titleFormat'

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
// Red Shift: same 5-stop sweep shape (hero -> highlight -> mid -> deep ->
// back to hero) as the dark/light spectrums above, but every stop kept
// low-blue/low-green so the shimmer stays night-vision-safe instead of
// just being a paler gold.
const GOLD_SPECTRUM_REDSHIFT = ['#FF9A2E', '#FFB864', '#FF7A1E', '#D9481A', '#FF9A2E'] as const

function goldSpectrumFor(isDark: boolean, redShift: boolean): readonly string[] {
  if (redShift) return GOLD_SPECTRUM_REDSHIFT
  return isDark ? GOLD_SPECTRUM_DARK : GOLD_SPECTRUM_LIGHT
}

function borderGradientColorsFor(isDark: boolean, redShift: boolean): [string, string, ...string[]] {
  const spectrum = goldSpectrumFor(isDark, redShift)
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
// app-wide) -- but the expand-and-navigate action is Pro-gated (RC,
// 2026-07-31: "ML has to at least be Pro tier" -- the earlier Plus gate,
// from the 2026-07-26 tier decision in flyregs_decisions.md, was corrected
// up a tier): the cross-reference convenience is the paywalled thing, not
// the fact that connections exist.
export function MagicLinkPod({
  bars, currentLabel, hasProAccess,
}: {
  bars: BarDef[]
  currentLabel?: string
  hasProAccess: boolean
}) {
  const { tokens, resolved, redShift } = useTheme()
  const fs = useFS()
  const spectrum = goldSpectrumFor(resolved === 'dark', redShift)
  const borderGradientColors = borderGradientColorsFor(resolved === 'dark', redShift)
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
          <Icon name="sparkles" size={fs(16)} color={tokens.gold} />
          <Text style={[styles.brandText, { fontSize: fs(13) }]}>
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
                  fontSize: ch === 'M' || ch === 'L' ? fs(15) : fs(13),
                }}
              >
                {ch}
              </Text>
            ))}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.brandCount, { color: anyItems ? tokens.gold : tokens.t3, fontSize: fs(13) }]}>
            {totalCount}
          </Text>
          <Icon name={podExpanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t4} />
        </Pressable>
        {podExpanded &&
          bars.map((bar, i) => (
            <PodRow
              key={bar.label}
              bar={bar}
              isLast={i === bars.length - 1}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
              tokens={tokens}
            />
          ))}
      </View>
    </View>
  )
}

// Long-press preview card vertical positioning -- see the card's own
// `top:` comment where these are used for the full reasoning. Gap is
// clearance between the card's bottom edge and the touch point itself,
// on top of the card's own (measured) height; fallback is only used for
// the single frame before the real height is known, so it's fine to be
// generously oversized.
// RC, real device, second pass: "the ML tap to reveal fix is better, but
// still not high enough. you need to at least double the fix height you
// built." Doubled both -- the gap is the one that matters in steady state
// (previewHeight is measured for real via onLayout after the first
// frame); the fallback only covers that one frame but doubled it too for
// consistency.
const PREVIEW_GAP_ABOVE_TOUCH = 48
const PREVIEW_FALLBACK_HEIGHT = 180

// (table, key column, title column) for every cited_type that has one --
// pcg deliberately excluded, its cited_id is already the human-readable
// term (see the fetch effect below).
// Found 2026-08-12 during the post-create_challenge-fix QA re-sweep: ac/ad/
// loi were pointed at their RAW tables, but (per the Storage Buckets Gated
// security fix) those raw tables have zero SELECT grant for anon/
// authenticated -- only their _gated views do. Not a leak (access was
// correctly blocked both directions), but every AC/AD/LOI citation's
// title-enrichment 403'd silently for every tier, including paying Pro/
// Premium users, and fell back to displaying the raw document_number/
// ad_number/slug instead of a human title. far/far_part/aim were never
// affected -- those raw tables ARE publicly grant-accessible (no gated
// view exists or is needed for them). Confirmed live: the _gated views
// below expose the same id+title columns and leave title/subject_heading
// un-redacted at every tier (only body_text is redacted), so this is a
// pure fix with no gating behavior change.
const TITLE_SOURCE: Partial<Record<string, [string, string, string]>> = {
  far: ['far_sections', 'section_number', 'title'],
  far_part: ['far_parts', 'part', 'label'],
  aim: ['aim_paragraphs', 'paragraph_number', 'title'],
  ac: ['advisory_circulars_gated', 'document_number', 'title'],
  ad: ['airworthiness_directives_gated', 'ad_number', 'subject_heading'],
  loi: ['legal_interpretations_gated', 'slug', 'title'],
  // Free tier, same as far/aim above -- no _gated view needed (see
  // migrations_cfr49_schema.sql's own tier-decision comment).
  cfr49: ['cfr49_sections', 'section_number', 'title'],
}

// Extraction coverage genuinely improving (see the 2026-08-17 MagicLink
// audit) means a single bar's item list can now legitimately run long --
// with no relevance/frequency signal in document_citations to rank by
// (occurrence counts are computed transiently during extraction and never
// persisted -- adding that is its own separate schema change, not bundled
// here), the safest cap is a plain "first N in the already-natural-sorted
// order, expand for the rest" -- never HIDES a citation permanently, just
// keeps the common case (most bars, most documents) from growing a wall of
// rows while a genuinely citation-dense document (e.g. a Part 91-heavy AC)
// still surfaces everything on request.
const BAR_ITEM_CAP = 8

function PodRow({
  bar, isLast, currentLabel, hasProAccess, tokens,
}: {
  bar: BarDef
  isLast: boolean
  currentLabel?: string
  hasProAccess: boolean
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  const [expanded, setExpanded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<{ x: number; y: number; text: string } | null>(null)
  // Real measured height of the currently-open preview card -- see showPreview
  // and the card's own onLayout below for why this can't be a fixed constant.
  const [previewHeight, setPreviewHeight] = useState<number | null>(null)
  // Pressable's onPress fires on release regardless of whether onLongPress
  // already fired -- without this guard, releasing a long-press to dismiss
  // the preview card would ALSO navigate away, immediately undoing the
  // "just let me peek" point of the feature.
  const longPressFired = useRef(false)
  const count = bar.items.length
  const hasItems = count > 0

  const handlePressBar = () => {
    if (!hasItems) return
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    setExpanded((e) => !e)
  }

  // Item rows previously showed only the bare number (item.label is always
  // null -- every citation writer sets it that way, see e.g.
  // aim_far_citations.py) -- confirmed live, RC: "offer some textual
  // elaboration on the regs, so users have a sense of what info is linked,
  // other than just the numbers." LOI already had its own one-off version
  // of this (its cited_id is an opaque slug, unreadable on its own);
  // generalized to every type that has a real title field. Fetched once
  // per expand, scoped to only the items actually present in this bar.
  useEffect(() => {
    if (!expanded) return
    const byType = new Map<string, string[]>()
    for (const it of bar.items) {
      if (!TITLE_SOURCE[it.cited_type]) continue
      const list = byType.get(it.cited_type) ?? []
      list.push(it.cited_id)
      byType.set(it.cited_type, list)
    }
    if (byType.size === 0) return
    Promise.all(
      Array.from(byType.entries()).map(async ([citedType, ids]) => {
        const [table, keyCol, titleCol] = TITLE_SOURCE[citedType]!
        // Supabase's typed .select() tries to statically parse the column
        // list at the type level -- a dynamic template literal can't be
        // parsed that way, hence the `as any` escape hatch (same pattern
        // as other genuinely-dynamic-column selects elsewhere in the app).
        const { data } = await supabase.from(table).select(`${keyCol}, ${titleCol}` as any).in(keyCol, ids)
        return { citedType, data: (data ?? []) as unknown as Record<string, string>[], keyCol, titleCol }
      })
    ).then((results) => {
      const map: Record<string, string> = {}
      for (const { citedType, data, keyCol, titleCol } of results) {
        for (const row of data) {
          let title = row[titleCol] ?? ''
          if (citedType === 'loi') title = title.replace(/_Legal_Interpretation$/i, '').replace(/_/g, ' ')
          map[`${citedType}-${row[keyCol]}`] = title
        }
      }
      setTitles(map)
    })
  }, [expanded, bar.items])

  const titleFor = (item: RelatedItem): string | null => {
    if (item.cited_type === 'pcg') return item.cited_id.replace(/_/g, ' ')
    const title = titles[`${item.cited_type}-${item.cited_id}`] ?? null
    return title && item.cited_type === 'ad' ? stripAdSubjectPrefix(title) : title
  }

  const primaryFor = (item: RelatedItem): string =>
    item.cited_type === 'loi' ? (titleFor(item) ?? item.cited_id) : item.label ?? item.cited_id

  // RC, real device: "these don't have the 'press/hold...' working like
  // the others" (Related LOIs specifically). Every OTHER type's primary
  // line is a short label (item.label ?? cited_id) with the real title as
  // a secondary elaboration line below it -- long-press reveals that
  // secondary line. LOI has no secondary line at all: primaryFor() above
  // already renders its title AS the (numberOfLines=1) primary line, so
  // it's the one that actually gets cut off. The old code hardcoded LOI's
  // preview text to null ("nothing extra to elaborate on" -- true for the
  // OTHER types' shape, false for LOI's), silently no-opping the gesture
  // for every LOI row regardless of whether its title was cut off.
  const showPreview = (item: RelatedItem, e: GestureResponderEvent) => {
    const title = item.cited_type === 'loi' ? primaryFor(item) : titleFor(item)
    if (!title) return // nothing extra to elaborate on, or not loaded yet -- don't show an empty card
    longPressFired.current = true
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    // Discard the last card's measured height -- this new text can wrap to a
    // different number of lines, and reusing a stale height would position
    // against the WRONG card size for one frame.
    setPreviewHeight(null)
    setPreview({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, text: title })
  }

  return (
    <View>
      <Pressable
        style={[styles.row, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
        onPress={handlePressBar}
      >
        <Icon name={bar.icon} size={fs(15)} color={hasItems ? tokens.gold : tokens.t3} />
        <Text style={[styles.rowLabel, { color: tokens.t1, fontSize: fs(13) }]}>{bar.label}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.rowCount, { color: hasItems ? tokens.gold : tokens.t3, fontSize: fs(12.5) }]}>{count}</Text>
        {hasItems && !hasProAccess ? (
          <Icon name="lock.fill" size={fs(11)} color={tokens.t4} />
        ) : hasItems ? (
          <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(12)} color={tokens.t4} />
        ) : null}
      </Pressable>

      {expanded && hasItems && hasProAccess && (
        <View style={[styles.expandedList, { borderBottomColor: tokens.bdr }, isLast && styles.expandedListLast]}>
          {(showAll ? bar.items : bar.items.slice(0, BAR_ITEM_CAP)).map((item, i) => (
            <Pressable
              key={`${item.cited_type}-${item.cited_id}-${i}`}
              style={[styles.expandedRow, i > 0 && { borderTopColor: tokens.bdr, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => {
                if (longPressFired.current) { longPressFired.current = false; return }
                if (currentLabel) setPendingBreadcrumb(currentLabel)
                router.push(routeForCitedItem(item.cited_type, item.cited_id) as any)
              }}
              onLongPress={(e) => showPreview(item, e)}
              onPressOut={() => setPreview(null)}
              delayLongPress={350}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.expandedLabel, { color: tokens.t2, fontSize: fs(12.5) }]} numberOfLines={1}>
                  {primaryFor(item)}
                </Text>
                {item.cited_type !== 'loi' && !!titleFor(item) && (
                  <Text style={[styles.expandedTitle, { color: tokens.t4, fontSize: fs(11) }]} numberOfLines={1}>
                    {titleFor(item)}
                  </Text>
                )}
              </View>
              <Icon name="chevron.right" size={fs(12)} color={tokens.t4} />
            </Pressable>
          ))}
          {!showAll && count > BAR_ITEM_CAP && (
            <Pressable
              style={[styles.expandedRow, styles.showAllRow, { borderTopColor: tokens.bdr, borderTopWidth: StyleSheet.hairlineWidth }]}
              onPress={() => setShowAll(true)}
            >
              <Text style={[styles.showAllText, { color: tokens.gold, fontSize: fs(12.5) }]}>
                Show all {count}
              </Text>
              <Icon name="chevron.down" size={fs(12)} color={tokens.gold} />
            </Pressable>
          )}
        </View>
      )}

      {/* Modal, not an absolutely-positioned sibling View -- MagicLinkPod's
          own outer container clips with overflow:hidden (needed for the
          rotating border), which would silently clip a same-tree popup
          the instant it tried to render above the pod's own top edge, the
          most common case for a row near the top of the expanded list. */}
      <Modal visible={!!preview} transparent animationType="none">
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setPreview(null)}>
          {preview && (
            <View
              onLayout={(e) => {
                const h = e.nativeEvent.layout.height
                if (h && h !== previewHeight) setPreviewHeight(h)
              }}
              style={[
                styles.previewCard,
                {
                  backgroundColor: tokens.bg3,
                  borderColor: tokens.bdr,
                  left: Math.min(Math.max(preview.x - 120, 12), Dimensions.get('window').width - 252),
                  // RC, on a real device: "it pops up right under the finger so
                  // you can't read it." A fixed `y - 64` only clears a card
                  // short enough to be ONE line -- but this feature exists
                  // specifically for text too long to fit in the row, so
                  // wrapping to 2-3 lines is the common case, not the
                  // exception, and a taller card's bottom edge lands AT or
                  // BELOW the touch point instead of above it (confirmed by
                  // computing it: a realistic 3-line card's bottom edge sits
                  // ~5px past the finger, not clear of it). Fixed by
                  // measuring the card's real rendered height (onLayout,
                  // above) and placing its bottom edge a real gap above the
                  // touch point, whatever the text's actual line count turns
                  // out to be -- PREVIEW_GAP_ABOVE_TOUCH on top of that gives
                  // clearance for the finger pad's real on-screen footprint,
                  // not just the exact reported coordinate. Before the first
                  // onLayout fires (one frame, Modal has no fade to make a
                  // reflow visible), PREVIEW_FALLBACK_HEIGHT is deliberately
                  // generous -- overshooting upward for a frame is invisible;
                  // undershooting reproduces this exact bug.
                  top: Math.max(preview.y - (previewHeight ?? PREVIEW_FALLBACK_HEIGHT) - PREVIEW_GAP_ABOVE_TOUCH, 12),
                },
              ]}
            >
              <Text style={[styles.previewText, { color: tokens.t1, fontSize: fs(13) }]}>{preview.text}</Text>
            </View>
          )}
        </Pressable>
      </Modal>
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
    gap: 6,
    paddingHorizontal: 13,
    paddingTop: 12,
    paddingBottom: 10,
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
  expandedTitle: { marginTop: 1 },
  showAllRow: { justifyContent: 'center', gap: 6 },
  showAllText: { fontWeight: '600' },
  previewCard: {
    position: 'absolute',
    maxWidth: 240,
    minWidth: 100,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  previewText: { fontWeight: '600' },
})
