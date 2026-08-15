import { useRef } from 'react'
import { View, Pressable, Text, StyleSheet, GestureResponderEvent } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useFS } from '@/context/fontScale'
import { useTheme } from '@/context/theme'

// RC: "get rid of all trash cans (on all pages, as able), in favor of
// swipe to delete (with two step CTA popup verification explaining what
// will be deleted)." Extracted from FolderListView.tsx's own row, which
// already had this exact gesture proven on a real device (see that
// file's own comment on why activeOffsetX/failOffsetY are gated the way
// they are -- an ungated Pan loses arbitration to the parent list's
// scroll responder on native and silently never fires). onDelete is
// expected to be the actual mutation OR a function that itself opens a
// confirm Alert -- this component only handles the gesture and the red
// reveal, not the confirmation copy, since that's specific to what's
// being deleted on each screen.
export function SwipeToDelete({
  onDelete, onPress, disabled, children, leftAction,
  onLongPress, onPressOut, delayLongPress,
}: {
  onDelete: () => void
  onPress?: () => void
  disabled?: boolean
  children: React.ReactNode
  /**
   * Optional second reveal on the OPPOSITE (rightward) swipe -- e.g. "Mark
   * Complied" on the AD list. RC: ADs could only be marked complied via
   * the small status-icon tap; a swipe should reach the same action.
   * Same reveal-then-tap two-step as the delete side (never fires on the
   * swipe alone), just a different color/label/callback. Only rendered
   * when passed, so every other existing call site (Equipment, Reminders)
   * is byte-identical to before.
   */
  leftAction?: { label: string; color: string; onPress: () => void }
  /**
   * Corpus-wide reg-number sweep: my-aircraft/[id].tsx's Applicable ADs list
   * had no tap-hold preview at all (its own "Link an AD" picker modal, one
   * screen over, already had it) -- this row's onPress is internal to
   * SwipeToDelete's own Pressable (see handlePress below), so there was no
   * way for a caller to attach a long-press gesture alongside it without
   * this. All three are optional and simply unused (byte-identical
   * behavior) at every other existing call site that doesn't pass them.
   */
  onLongPress?: (e: GestureResponderEvent) => void
  onPressOut?: () => void
  delayLongPress?: number
}) {
  const fs = useFS()
  const { tokens } = useTheme()
  const translateX = useSharedValue(0)
  const swiped = useRef(false)

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .enabled(!disabled)
    .onUpdate((e) => {
      translateX.value = Math.min(leftAction ? 84 : 0, Math.max(-84, e.translationX))
    })
    .onEnd((e) => {
      // RC, real device (leftAction/Mark case): swipe right to reveal
      // Mark, then move the finger back left to cancel -- the old check
      // only looked at the FINAL translationX from the start of the whole
      // gesture, so a normal "give up" motion that overshoots back past
      // center got read as a fresh leftward swipe and "forced" the row
      // into Delete instead of just closing. A reversal -- position still
      // on one side but velocity now carrying the opposite way -- means
      // the user changed their mind mid-swipe, and always closes instead
      // of letting the raw endpoint decide.
      const reversing = (e.translationX > 0 && e.velocityX < -300) || (e.translationX < 0 && e.velocityX > 300)
      if (!reversing && e.translationX < -48) {
        translateX.value = withSpring(-76, { damping: 18, stiffness: 280 })
        swiped.current = true
      } else if (!reversing && leftAction && e.translationX > 48) {
        translateX.value = withSpring(76, { damping: 18, stiffness: 280 })
        swiped.current = true
      } else {
        translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
        swiped.current = false
      }
    })

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }))

  // A tap on an already-swiped-open row closes it instead of firing
  // onPress -- same "first tap dismisses, doesn't act" convention as
  // FolderListView's own handlePress.
  const handlePress = () => {
    if (swiped.current) {
      translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
      swiped.current = false
      return
    }
    onPress?.()
  }

  const handleSwipeDelete = () => {
    translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    swiped.current = false
    onDelete()
  }

  const handleLeftAction = () => {
    translateX.value = withSpring(0, { damping: 18, stiffness: 280 })
    swiped.current = false
    leftAction?.onPress()
  }

  return (
    <View style={styles.wrap}>
      {leftAction && (
        <View style={[styles.leftBg, { backgroundColor: leftAction.color }]}>
          <Pressable style={styles.removeAction} onPress={handleLeftAction}>
            <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>{leftAction.label}</Text>
          </Pressable>
        </View>
      )}
      <View style={[styles.removeBg, { backgroundColor: tokens.red }]}>
        <Pressable style={styles.removeAction} onPress={handleSwipeDelete}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Delete</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable
            onPress={handlePress}
            onLongPress={onLongPress}
            onPressOut={onPressOut}
            delayLongPress={delayLongPress}
          >
            {children}
          </Pressable>
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  removeBg: {
    position: 'absolute', top: 0, bottom: 0, right: 0, width: 84,
    justifyContent: 'center', alignItems: 'center',
  },
  leftBg: {
    position: 'absolute', top: 0, bottom: 0, left: 0, width: 84,
    justifyContent: 'center', alignItems: 'center',
  },
  removeAction: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 12 },
})
