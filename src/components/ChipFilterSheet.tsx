import { ReactNode, useRef } from 'react'
import { View, Text, Pressable, ScrollView, Modal, StyleSheet, ActivityIndicator, PanResponder, Platform } from 'react-native'
import * as Haptics from 'expo-haptics'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// Generic ad hoc filter sheet -- the chrome (modal, header, sticky
// clear-all/show-results footer, live result count) is shared; each screen
// composes its own dimension sections as children using <ChipFilterSection>
// (or custom content, e.g. a date-range row or a type-ahead doc picker,
// for dimensions that aren't a flat option list). Built for Home's 7-
// dimension catalog filter, but generic enough for any other filtering
// surface -- same idea as Study Mode/Duels' content-type chip rows, just
// with the bottom-sheet chrome factored out so those don't have to
// hand-roll it again.
export function ChipFilterSheet({
  visible,
  onClose,
  title,
  subtitle,
  resultCount,
  countLoading,
  onClearAll,
  onApply,
  applyLabel = 'Show results',
  children,
}: {
  visible: boolean
  onClose: () => void
  title: string
  /** One-line semantics hint under the title (e.g. "Everything is included until you narrow it"). */
  subtitle?: string
  resultCount: number | null
  countLoading?: boolean
  onClearAll: () => void
  onApply: () => void
  applyLabel?: string
  children: ReactNode
}) {
  const { tokens } = useTheme()
  const fs = useFS()

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <View style={[styles.card, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="xmark" size={18} color={tokens.t3} />
            </Pressable>
          </View>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: tokens.t3, fontSize: fs(12) }]}>{subtitle}</Text>
          ) : null}

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: tokens.bdr }]}>
            <Pressable style={[styles.clearBtn, { borderColor: tokens.bdr }]} onPress={onClearAll}>
              <Text style={[styles.clearBtnText, { color: tokens.t2, fontSize: fs(13.5) }]}>Clear all</Text>
            </Pressable>
            <Pressable style={[styles.applyBtn, { backgroundColor: tokens.blu }]} onPress={onApply}>
              {countLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[styles.applyBtnText, { fontSize: fs(14) }]}>
                  {applyLabel}{resultCount != null ? ` · ${resultCount}` : ''}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// One labeled section of tappable chips. `multiSelect` (default true) lets
// several options be active at once (e.g. content type); set it false for
// dependent single-pick dimensions like FAR Part or AC series.
//
// For long multi-select grids (FAR Part lists ~40 chips), two extras:
//   selectAll     an "All" chip that selects every option in one tap; when
//                 everything is already selected it clears instead, so the
//                 flow "All -> untick the few you don't want" works the way
//                 RC asked for.
//   drag-select   iOS-Photos-style sweep: touch a chip and drag ACROSS the
//                 row to keep applying that chip's new state to everything
//                 under the finger, with a selection haptic per chip.
//                 Horizontal-dominant drags only, so the sheet still
//                 scrolls vertically.
export function ChipFilterSection({
  title,
  options,
  selected,
  onToggle,
  selectAll,
  onSetSelected,
}: {
  title: string
  options: { value: string; label: string }[]
  selected: string[]
  onToggle: (value: string) => void
  /** Show the "All" chip + enable drag-select. */
  selectAll?: boolean
  /** Required when selectAll is set: replaces the whole selection at once. */
  onSetSelected?: (values: string[]) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()

  // Per-chip hit rects, relative to the chip grid. Refreshed on every
  // layout pass, so wrap/reflow (font scale, rotation) can't go stale.
  const rects = useRef<Record<string, { x: number; y: number; w: number; h: number }>>({})
  // Which state the sweep is painting (the first chip touched decides), and
  // which chips this sweep already visited so a wiggle can't re-toggle them.
  const dragMode = useRef<boolean>(true)
  const visited = useRef<Set<string>>(new Set())
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const chipAt = (x: number, y: number): string | null => {
    for (const [v, r] of Object.entries(rects.current)) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return v
    }
    return null
  }

  const paint = (value: string | null) => {
    if (!value || visited.current.has(value)) return
    visited.current.add(value)
    const isSel = selectedRef.current.includes(value)
    if (isSel !== dragMode.current) {
      onToggle(value)
      if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {})
    }
  }

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Claim only clearly-horizontal drags; vertical stays with the
      // ScrollView so the sheet remains scrollable.
      onMoveShouldSetPanResponder: (_e, g) =>
        !!selectAll && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onPanResponderGrant: (e) => {
        visited.current = new Set()
        const start = chipAt(e.nativeEvent.locationX, e.nativeEvent.locationY)
        dragMode.current = start ? !selectedRef.current.includes(start) : true
        paint(start)
      },
      onPanResponderMove: (e) => paint(chipAt(e.nativeEvent.locationX, e.nativeEvent.locationY)),
      onPanResponderTerminationRequest: () => false,
    })
  ).current

  if (options.length === 0) return null
  const allSelected = options.length > 0 && options.every((o) => selected.includes(o.value))

  // Search covers everything by default: an empty selection means "no
  // narrowing", not "nothing". Say so in-line — RC's call (2026-07-31) was
  // to keep the assume-all-ON model but make the assumption visible instead
  // of flipping the chips to literal all-lit (which would make isolating one
  // value a many-tap chore and break the empty->null query convention).
  const nothingSelected = selected.length === 0

  return (
    <View style={styles.section}>
      <View style={styles.sectionTitleRow}>
        <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>{title}</Text>
        {nothingSelected && (
          <Text style={[styles.allIncluded, { color: tokens.t3, fontSize: fs(10.5) }]}>All included</Text>
        )}
      </View>
      <View style={styles.chipWrap} {...(selectAll ? pan.panHandlers : {})}>
        {selectAll && onSetSelected && (
          <Pressable
            style={[
              styles.chip,
              { backgroundColor: allSelected ? tokens.goldlt : tokens.bg2, borderColor: allSelected ? tokens.goldbdr : tokens.bdr },
            ]}
            onPress={() => onSetSelected(allSelected ? [] : options.map((o) => o.value))}
          >
            <Text style={[styles.chipText, { color: allSelected ? tokens.gold : tokens.t2, fontSize: fs(12.5) }]}>
              {allSelected ? 'Clear all' : 'Select all'}
            </Text>
          </Pressable>
        )}
        {options.map((o) => {
          const active = selected.includes(o.value)
          return (
            <Pressable
              key={o.value}
              onLayout={(e) => {
                const { x, y, width, height } = e.nativeEvent.layout
                rects.current[o.value] = { x, y, w: width, h: height }
              }}
              style={[
                styles.chip,
                { backgroundColor: active ? tokens.goldlt : tokens.bg2, borderColor: active ? tokens.goldbdr : tokens.bdr },
              ]}
              onPress={() => onToggle(o.value)}
            >
              <Text style={[styles.chipText, { color: active ? tokens.gold : tokens.t2, fontSize: fs(12.5) }]}>{o.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  card: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, maxHeight: '85%' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 18, paddingBottom: 12,
  },
  title: { fontWeight: '700' },
  subtitle: { paddingHorizontal: 18, marginTop: -6, paddingBottom: 10 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 18, paddingBottom: 12, gap: 16 },

  section: { gap: 8 },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontWeight: '700', letterSpacing: 0.5 },
  allIncluded: { fontStyle: 'italic', opacity: 0.8 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 7 },
  chipText: { fontWeight: '600' },

  footer: {
    flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: StyleSheet.hairlineWidth,
  },
  clearBtn: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  clearBtnText: { fontWeight: '700' },
  applyBtn: { flex: 1, borderRadius: 20, alignItems: 'center', paddingVertical: 12 },
  applyBtnText: { color: '#fff', fontWeight: '700' },
})
