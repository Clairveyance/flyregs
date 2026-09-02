import { View, Text, Pressable, StyleSheet, Modal, Dimensions } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// Visual half of the corpus-wide tap-and-hold-to-reveal feature -- see
// useLongPressPreview.ts's header comment for the full origin/reasoning.
// Every value below (gap, fallback height, card sizing, positioning math)
// is copied verbatim from MagicLinkPod.tsx's own preview card, including
// the exact fix RC asked for on a real device ("you need to at least
// double the fix height you built") -- not re-derived, so every new call
// site behaves identically to the original ML feature by construction.
const PREVIEW_GAP_ABOVE_TOUCH = 48
const PREVIEW_FALLBACK_HEIGHT = 180

export function LongPressPreviewCard({
  preview,
  previewHeight,
  onLayoutHeight,
  onDismiss,
}: {
  preview: { x: number; y: number; text: string; number?: string } | null
  previewHeight: number | null
  onLayoutHeight: (height: number) => void
  onDismiss: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()

  return (
    // Modal, not an absolutely-positioned sibling View -- matches
    // MagicLinkPod's own reasoning: a same-tree popup risks getting
    // silently clipped by any ancestor with overflow:hidden (a card list,
    // a rounded container, etc.) the instant it renders above that
    // ancestor's own edge.
    <Modal visible={!!preview} transparent animationType="none">
      <Pressable style={StyleSheet.absoluteFill} onPress={onDismiss}>
        {preview && (
          <View
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height
              if (h && h !== previewHeight) onLayoutHeight(h)
            }}
            style={[
              styles.previewCard,
              {
                backgroundColor: tokens.bg3,
                borderColor: tokens.bdr,
                left: Math.min(Math.max(preview.x - 120, 12), Dimensions.get('window').width - 252),
                // A fixed `y - N` only clears a card short enough to be ONE
                // line -- this feature exists specifically for text too long
                // to fit in its row, so wrapping to 2-3 lines is the common
                // case, not the exception. Measuring the card's real
                // rendered height (onLayout, above) and placing its bottom
                // edge a real gap above the touch point handles any line
                // count.
                top: Math.max(preview.y - (previewHeight ?? PREVIEW_FALLBACK_HEIGHT) - PREVIEW_GAP_ABOVE_TOUCH, 12),
                // Hidden until measured. The previous comment here claimed
                // overshooting upward for one frame was "invisible" -- it is
                // not, and RC caught it on a real device 2026-09-01: "the
                // pop-up box that shows up above your finger momentarily
                // starts much higher and then jumps down to where it is in
                // this image." The arithmetic is plain once written out: the
                // 180 fallback against a real 2-line card of roughly 90
                // paints the first frame ~228 above the touch, then onLayout
                // corrects to ~138 -- a ~90pt jump, with animationType="none"
                // so there is no fade to mask it.
                //
                // opacity does not affect layout, so the card still lays out
                // and onLayout still reports a real height; it simply is not
                // painted until that height is known, and then appears
                // already in the right place. This removes the guess
                // entirely rather than trying to tune the fallback -- no
                // constant can be right for every line count.
                opacity: previewHeight == null ? 0 : 1,
              },
            ]}
          >
            {/* RC, real device: "I DO want the press/hold... to include
                the reg number in that popup" -- reg numbers can themselves
                be too long for their column (same problem as a long
                title), so whenever a call site has a natural number
                companion to its title (AIM paragraph number, AC number,
                etc.) it's shown here too, styled like the row's own number
                column so the popup reads as "the row's real content," not
                a generic tooltip. */}
            {preview.number && (
              <Text style={[styles.previewNumber, { color: tokens.blu, fontSize: fs(13) }]}>{preview.number}</Text>
            )}
            <Text style={[styles.previewText, { color: tokens.t1, fontSize: fs(13) }]}>{preview.text}</Text>
          </View>
        )}
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
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
  previewNumber: { fontWeight: '700', marginBottom: 3 },
})
