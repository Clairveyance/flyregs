import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// Thin strip directly under a reg detail screen's OverlayHeader, shown only
// when the user arrived here via a cross-reference jump (MagicLink tap or
// in-doc hyperlink) -- see navBreadcrumb.ts. Confirmed live as a real gap:
// jumping FAR -> AIM -> P/CG a few taps deep left no way back to where you
// started except repeated native back-taps, easy to lose track of. Tapping
// this just calls the same onBack the header's own chevron uses -- the
// native navigation stack already goes to the right place, this is purely
// a visible label for what that native "back" actually returns to.
export function BackToBreadcrumb({ label, onPress }: { label: string; onPress: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  return (
    <Pressable
      style={[styles.wrap, { backgroundColor: tokens.bg2, borderBottomColor: tokens.bdr }]}
      onPress={onPress}
    >
      <Icon name="arrow.uturn.left" size={12} color={tokens.blu} />
      <Text style={[styles.text, { color: tokens.blu, fontSize: fs(12.5) }]} numberOfLines={1}>
        Back to {label}
      </Text>
    </Pressable>
  )
}

// Prev/Next footer for browsing sequentially through a document's own
// natural order (FAR section within a Part, AIM paragraph within a
// chapter) -- independent of the breadcrumb above, which is only about
// cross-reference jumps.
export function PrevNextFooter({
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
}: {
  prevLabel: string | null
  nextLabel: string | null
  onPrev: () => void
  onNext: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  if (!prevLabel && !nextLabel) return null
  return (
    <View style={[styles.footerWrap, { borderTopColor: tokens.bdr, backgroundColor: tokens.bg }]}>
      <Pressable
        style={[styles.footerBtn, !prevLabel && styles.footerBtnDisabled]}
        onPress={onPrev}
        disabled={!prevLabel}
      >
        <Icon name="chevron.left" size={14} color={prevLabel ? tokens.blu : tokens.t4} />
        <Text style={[styles.footerText, { color: prevLabel ? tokens.t1 : tokens.t4, fontSize: fs(12.5) }]} numberOfLines={1}>
          {prevLabel ?? 'Start'}
        </Text>
      </Pressable>
      <View style={[styles.footerDivider, { backgroundColor: tokens.bdr }]} />
      <Pressable
        style={[styles.footerBtn, styles.footerBtnRight, !nextLabel && styles.footerBtnDisabled]}
        onPress={onNext}
        disabled={!nextLabel}
      >
        <Text style={[styles.footerText, { color: nextLabel ? tokens.t1 : tokens.t4, fontSize: fs(12.5) }]} numberOfLines={1}>
          {nextLabel ?? 'End'}
        </Text>
        <Icon name="chevron.right" size={14} color={nextLabel ? tokens.blu : tokens.t4} />
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontWeight: '600', flex: 1 },

  footerWrap: {
    flexDirection: 'row', alignItems: 'stretch', borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, justifyContent: 'flex-start',
    paddingHorizontal: 14, paddingVertical: 12,
  },
  footerBtnRight: { justifyContent: 'flex-end' },
  footerBtnDisabled: { opacity: 0.5 },
  footerText: { fontWeight: '600', flexShrink: 1 },
  footerDivider: { width: StyleSheet.hairlineWidth },
})
