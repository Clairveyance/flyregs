import { View, StyleSheet } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Icon } from '@/components/Icon'
import type { CoinTier } from '@/lib/coins'

// A flat single-color circle read as a plain icon badge, not a coin --
// real challenge coins (see the reference photos) have a beveled metallic
// rim and a raised/engraved face. Approximates that with two nested
// gradient rings (outer rim, inner bevel) plus a dark face disc, using
// only what's already in the app (LinearGradient, same as MagicLink's own
// gold effect) rather than needing commissioned per-coin artwork.
const TIER_GRADIENTS: Record<CoinTier, readonly [string, string, string]> = {
  bronze: ['#E0A868', '#8C5A2B', '#E0A868'],
  silver: ['#F2F2F2', '#9A9A9A', '#F2F2F2'],
  gold: ['#FFE9A8', '#C9971F', '#FFE9A8'],
}
const LOCKED_GRADIENT: readonly [string, string, string] = ['#4a4a52', '#2a2a30', '#4a4a52']

export function CoinMedal({
  tier,
  icon,
  earned,
  size = 46,
}: {
  tier: CoinTier
  icon: string
  earned: boolean
  size?: number
}) {
  const colors = earned ? TIER_GRADIENTS[tier] : LOCKED_GRADIENT
  const faceSize = size * 0.78

  return (
    <LinearGradient
      colors={colors}
      start={{ x: 0.15, y: 0.15 }}
      end={{ x: 0.9, y: 0.9 }}
      style={[styles.rim, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <View
        style={[
          styles.face,
          {
            width: faceSize,
            height: faceSize,
            borderRadius: faceSize / 2,
            backgroundColor: earned ? '#1c1c1f' : '#242429',
            borderColor: colors[1],
          },
        ]}
      >
        <Icon name={earned ? icon : 'lock.fill'} size={size * 0.4} color={earned ? colors[0] : '#7a7a82'} />
      </View>
    </LinearGradient>
  )
}

const styles = StyleSheet.create({
  rim: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  face: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
})
