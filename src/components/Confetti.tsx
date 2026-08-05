import { useEffect, useMemo } from 'react'
import { View, StyleSheet, Dimensions } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, Easing } from 'react-native-reanimated'
import { useTheme } from '@/context/theme'

// Expo's managed workflow has no access to UIKit's native confetti/balloon
// emitter (that's a from-scratch native module, not something Expo exposes)
// -- this is a lightweight from-scratch equivalent using only what's
// already a dependency here (Reanimated, same primitives as the flashcard
// flip and CoinRevealModal). Purely decorative: falling/rotating pieces,
// no interaction, unmounts with the results screen.
const { width: SCREEN_W } = Dimensions.get('window')
const COLORS = ['#FFD700', '#FF6B6B', '#4ECDC4', '#95E1D3', '#F38181', '#AA96DA', '#FFA45B']
// Red Shift: the cyan/mint/lavender stops above are the opposite of
// night-vision-safe -- reused straight from the app's own redshift tokens
// (gold, red, blu, t1, blt, blu-deep, amb) so the burst still feels varied
// without leaving the red/orange band.
const COLORS_REDSHIFT = ['#FF9A2E', '#FF2D12', '#E0562E', '#FF6A4D', '#FF8F63', '#B8541A', '#F2701A']
const PIECE_COUNT = 28
const FALL_DISTANCE = 640

function ConfettiPiece({ index, colors }: { index: number; colors: readonly string[] }) {
  // Randomized once per piece on mount, not re-rolled on re-render.
  const { startX, drift, delay, duration, rotateEnd, size } = useMemo(
    () => ({
      startX: Math.random() * SCREEN_W,
      drift: (Math.random() - 0.5) * 140,
      delay: Math.random() * 250,
      duration: 1700 + Math.random() * 900,
      rotateEnd: (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 360),
      size: 5 + Math.random() * 5,
    }),
    []
  )
  const color = colors[index % colors.length]

  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = withDelay(delay, withTiming(1, { duration, easing: Easing.out(Easing.quad) }))
  }, [])

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: progress.value * FALL_DISTANCE },
      { translateX: drift * progress.value },
      { rotate: `${rotateEnd * progress.value}deg` },
    ],
    opacity: progress.value < 0.8 ? 1 : 1 - (progress.value - 0.8) * 5,
  }))

  return (
    <Reanimated.View
      style={[styles.piece, { left: startX, width: size, height: size * 0.42, backgroundColor: color }, style]}
    />
  )
}

export function ConfettiBurst() {
  const { redShift } = useTheme()
  const colors = redShift ? COLORS_REDSHIFT : COLORS
  return (
    <View style={styles.wrap} pointerEvents="none">
      {Array.from({ length: PIECE_COUNT }).map((_, i) => (
        <ConfettiPiece key={i} index={i} colors={colors} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, height: FALL_DISTANCE, zIndex: 50 },
  piece: { position: 'absolute', top: -20, borderRadius: 1 },
})
