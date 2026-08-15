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
  preview: { x: number; y: number; text: string } | null
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
                // count. Before the first onLayout fires (one frame, Modal
                // has no fade to make a reflow visible), the fallback is
                // deliberately generous -- overshooting upward for a frame
                // is invisible; undershooting reproduces the exact bug this
                // was built to fix.
                top: Math.max(preview.y - (previewHeight ?? PREVIEW_FALLBACK_HEIGHT) - PREVIEW_GAP_ABOVE_TOUCH, 12),
              },
            ]}
          >
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
})
