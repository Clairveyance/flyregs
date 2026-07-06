import { useEffect } from 'react'
import { View, StyleSheet } from 'react-native'
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withTiming,
  withDelay,
  Easing,
} from 'react-native-reanimated'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'

// Brief centered checkmark confirmation — pops in, holds, fades out. Used
// after a bulk action (e.g. "Add N items to Folder") completes, so there's a
// visible cue the move actually happened instead of items just silently
// disappearing from a select list.
export function ConfirmCheck({ trigger }: { trigger: number }) {
  const { tokens } = useTheme()
  const scale = useSharedValue(0)
  const opacity = useSharedValue(0)

  useEffect(() => {
    if (trigger === 0) return
    opacity.value = withSequence(
      withTiming(1, { duration: 120 }),
      withDelay(550, withTiming(0, { duration: 220 }))
    )
    scale.value = withSequence(
      withTiming(1.15, { duration: 200, easing: Easing.out(Easing.back(2)) }),
      withTiming(1, { duration: 120 }),
      withDelay(550, withTiming(0.85, { duration: 220 }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger])

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }))

  return (
    <View style={styles.wrap} pointerEvents="none">
      <Reanimated.View style={[styles.badge, { backgroundColor: tokens.blu }, animStyle]}>
        <Icon name="checkmark" size={32} color="#fff" />
      </Reanimated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
  },
  badge: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
})
