import { useRef } from 'react'
import { View, Pressable, Text, StyleSheet } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withSpring } from 'react-native-reanimated'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { useFS } from '@/context/fontScale'

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
  onDelete, onPress, disabled, children,
}: {
  onDelete: () => void
  onPress?: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  const fs = useFS()
  const translateX = useSharedValue(0)
  const swiped = useRef(false)

  const panGesture = Gesture.Pan()
    .activeOffsetX([-6, 6])
    .failOffsetY([-10, 10])
    .enabled(!disabled)
    .onUpdate((e) => {
      translateX.value = Math.min(0, Math.max(-84, e.translationX))
    })
    .onEnd((e) => {
      if (e.translationX < -42) {
        translateX.value = withSpring(-76, { damping: 18, stiffness: 280 })
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

  return (
    <View style={styles.wrap}>
      <View style={styles.removeBg}>
        <Pressable style={styles.removeAction} onPress={handleSwipeDelete}>
          <Text style={[styles.removeActionText, { fontSize: fs(12) }]}>Delete</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={panGesture}>
        <Reanimated.View style={cardStyle}>
          <Pressable onPress={handlePress}>{children}</Pressable>
        </Reanimated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden' },
  removeBg: {
    position: 'absolute', top: 0, bottom: 0, right: 0, width: 84,
    backgroundColor: '#ef4444', justifyContent: 'center', alignItems: 'center',
  },
  removeAction: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  removeActionText: { color: '#fff', fontWeight: '700', fontSize: 12 },
})
