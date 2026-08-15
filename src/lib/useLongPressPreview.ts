import { useRef, useState } from 'react'
import { GestureResponderEvent } from 'react-native'
import * as Haptics from 'expo-haptics'

// Extracted from MagicLinkPod.tsx's own long-press-to-reveal preview (RC:
// "the 'tap and hold a subject line that has been cut off, to have it
// appear in a pop up box above your finger' feature we built for ML, should
// be implemented corpus wide for all similar circumstances... make sure you
// use the same build structure as you did w/ ML, so the size, spacing, etc
// is correct"). This hook is the state/logic half; LongPressPreviewCard.tsx
// is the matching visual half -- MagicLinkPod.tsx itself is left untouched
// (already shipped, already tuned) rather than refactored onto this, so
// there's zero regression risk to it; every NEW long-press site should use
// this pair instead of re-deriving the pattern.
export function useLongPressPreview() {
  const [preview, setPreview] = useState<{ x: number; y: number; text: string } | null>(null)
  // Real measured height of the currently-open preview card -- see
  // LongPressPreviewCard's own onLayout comment for why this can't be a
  // fixed constant.
  const [previewHeight, setPreviewHeight] = useState<number | null>(null)
  // Pressable's onPress fires on release regardless of whether onLongPress
  // already fired -- without this guard, releasing a long-press to dismiss
  // the preview card would ALSO fire the row's normal onPress (e.g.
  // navigating away), immediately undoing the "just let me peek" point of
  // the feature. Call consumeLongPress() at the top of onPress and bail if
  // it returns true.
  const longPressFired = useRef(false)

  const showPreview = (text: string, e: GestureResponderEvent) => {
    longPressFired.current = true
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    // Discard the last card's measured height -- this new text can wrap to
    // a different number of lines, and reusing a stale height would
    // position against the WRONG card size for one frame.
    setPreviewHeight(null)
    setPreview({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY, text })
  }

  const hidePreview = () => setPreview(null)

  const consumeLongPress = (): boolean => {
    if (longPressFired.current) {
      longPressFired.current = false
      return true
    }
    return false
  }

  return { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress }
}
