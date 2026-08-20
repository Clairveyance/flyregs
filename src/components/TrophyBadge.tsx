import { View, StyleSheet } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing, useReducedMotion } from 'react-native-reanimated'
import { useEffect } from 'react'
import { LinearGradient } from 'expo-linear-gradient'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { useTheme } from '@/context/theme'

// "The Ace" and "The Master" (src/lib/coins.ts's TROPHY_CATALOG) -- RC's own
// spec: "a big, bright, glowing, spinning (yes, with a slow animation)
// diamond... put the two big ticket items below the rest, side by side,
// both slowly spinning, like trophies in a case." Deliberately its own
// component rather than CoinMedal + a size bump -- these two are meant to
// read as a different REGISTER of achievement, not a 4th tier on top of
// bronze/silver/gold, so nothing here shares CoinMedal's rim/bevel/face
// layering or tier-color language.
//
// Real rotateY (with a `perspective` transform ahead of it), not a 2D
// `rotate` -- this is what makes it read as a medallion turning in a
// display case rather than a flat icon spinning like a wheel. One full
// turn every 7s: slower reads as inert, faster reads like a loading
// spinner -- 7s is the "trophy on a slow turntable" zone.
const SPIN_MS = 7000
// Locked-state spin speed, RC: "make the two large coins spin slowly (same
// speed as the diamond/globe inside)" -- naming the ACTUAL 3D scene shown
// once earned (AceGem3D.tsx/MasterGlobe3D.tsx, one full turn every
// 2*pi/rate) as the reference speed, not this badge's own earned-state
// SPIN_MS above (a separately tuned "trophy on a slow turntable" speed for
// this small-badge context, per this file's own header comment -- left
// as-is here, only the previously-static locked preview gets a speed).
// Split into two constants B34: the gem's own rotation rate was halved
// (0.25 -> 0.125 rad/s, see AceGem3D.tsx's own comment -- RC, real device:
// "spinning too fast," traced to that scene's 12-fold facet symmetry
// making the true ~25s/revolution read as a much faster ~2s facet-cycle)
// while the globe's stayed at its original 0.25 (a smooth sphere has no
// equivalent facet-aliasing, and RC didn't flag the globe's speed) -- the
// two locked previews now genuinely need different durations to keep
// matching their own real 3D scene, where a single shared constant used
// to correctly match both because they were the same rate.
const LOCKED_SPIN_MS_ACE = 50265
const LOCKED_SPIN_MS_MASTER = 25133
const PULSE_MS = 4200
// Same painted-rings glow approach as CoinMedal.tsx -- duplicated rather
// than imported since these two components deliberately share no other
// styling language (see the header comment above).
const GLOW_RING_SCALES = [1.0, 0.72, 0.48] as const
const GLOW_RING_OPACITIES = [0.22, 0.35, 0.5] as const

const PALETTES = {
  ace: {
    // Icy diamond blue/cyan -- RC named the diamond himself; kept
    // deliberately COOL against Master's warm gold so the two trophies
    // read as different registers even sitting side by side.
    gradient: ['#EAFBFF', '#2FB4D9', '#EAFBFF'] as const,
    glow: 'rgba(79,209,255,0.65)',
    shine: 'rgba(255,255,255,0.75)',
    face: '#06222b',
  },
  ace_redshift: {
    // Red Shift bans blue/green outright -- can't keep "icy blue" under
    // this theme at all, only the brightness/saturation-led differentiation
    // theme.tsx's own redshiftTokens comment documents. A near-white,
    // higher-key rust (brighter + less saturated than Master's warm gold
    // below) keeps Ace reading as the "cooler/sharper" of the two trophies
    // within the red-safe band, same rule redshiftTokens.blu now follows.
    gradient: ['#FFE3D2', '#E0714A', '#FFE3D2'] as const,
    glow: 'rgba(255,154,110,0.6)',
    shine: 'rgba(255,225,210,0.75)',
    face: '#1a0d08',
  },
  master: {
    // Warm gold-white, laurel-medal register -- see coins.ts's own comment
    // on MASTERY_FULL for the Wright Brothers Master Pilot Award reference
    // this is deliberately evoking.
    gradient: ['#FFF6D9', '#E8B923', '#FFF6D9'] as const,
    glow: 'rgba(255,201,64,0.65)',
    shine: 'rgba(255,255,255,0.75)',
    face: '#241a06',
  },
  master_redshift: {
    gradient: ['#FFE9C6', '#C97A1A', '#FFE9C6'] as const,
    glow: 'rgba(255,154,46,0.6)',
    shine: 'rgba(255,225,180,0.75)',
    face: '#1e1206',
  },
} as const

export function TrophyBadge({
  variant,
  icon,
  earned,
  size: baseSize = 108,
}: {
  variant: 'ace' | 'master'
  icon: string
  earned: boolean
  size?: number
}) {
  const fs = useFS()
  const { redShift } = useTheme()
  const reduceMotion = useReducedMotion()
  const size = fs(baseSize)
  const spin = useSharedValue(0)
  const pulse = useSharedValue(0)

  useEffect(() => {
    if (reduceMotion) return
    const lockedMs = variant === 'ace' ? LOCKED_SPIN_MS_ACE : LOCKED_SPIN_MS_MASTER
    spin.value = withRepeat(withTiming(360, { duration: earned ? SPIN_MS : lockedMs, easing: Easing.linear }), -1, false)
    if (earned) {
      pulse.value = withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.inOut(Easing.sin) }), -1, true)
    }
  }, [earned, reduceMotion, spin, pulse])

  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 900 }, { rotateY: `${spin.value}deg` }],
  }))
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + pulse.value * 0.45,
    transform: [{ scale: 1 + pulse.value * 0.08 }],
  }))

  const palKey = (redShift ? `${variant}_redshift` : variant) as keyof typeof PALETTES
  const pal = PALETTES[palKey]
  const lockedGradient = redShift ? (['#4a3530', '#2a1e1c', '#4a3530'] as const) : (['#4a4a52', '#2a2a30', '#4a4a52'] as const)
  const lockedFace = redShift ? '#241a16' : '#242429'
  const lockedIcon = redShift ? '#8a6858' : '#7a7a82'
  const colors = earned ? pal.gradient : lockedGradient
  const faceSize = size * 0.76

  return (
    <View style={[styles.wrap, { width: size * 1.5, height: size * 1.5 }]}>
      {/* Painted concentric circles, not a shadow -- see CoinMedal.tsx's
          identical fix for why a shadowColor/shadowRadius "glow" on a
          transparent view renders as a square on iOS (no real alpha shape
          for the OS to derive a shadow path from) even though it looks
          fine on web. */}
      {earned && (
        <Reanimated.View pointerEvents="none" style={[styles.glow, { width: size * 1.5, height: size * 1.5 }, glowStyle]}>
          {GLOW_RING_SCALES.map((scale, i) => (
            <View
              key={i}
              style={{
                position: 'absolute',
                width: size * 1.5 * scale, height: size * 1.5 * scale,
                borderRadius: size * 0.75 * scale,
                top: size * 0.75 * (1 - scale), left: size * 0.75 * (1 - scale),
                backgroundColor: pal.glow,
                opacity: GLOW_RING_OPACITIES[i],
              }}
            />
          ))}
        </Reanimated.View>
      )}
      <Reanimated.View style={[{ width: size, height: size, borderRadius: size / 2 }, spinStyle]}>
        <LinearGradient
          colors={colors}
          start={{ x: 0.15, y: 0.15 }}
          end={{ x: 0.9, y: 0.9 }}
          style={[styles.rim, { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }]}
        >
          <View
            style={[
              styles.face,
              {
                width: faceSize,
                height: faceSize,
                borderRadius: faceSize / 2,
                backgroundColor: earned ? pal.face : lockedFace,
                borderColor: colors[1],
              },
            ]}
          >
            <Icon name={earned ? icon : 'lock.fill'} size={size * 0.42} color={earned ? colors[0] : lockedIcon} />
          </View>
          {earned && (
            <LinearGradient
              pointerEvents="none"
              colors={['transparent', pal.shine, 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={{
                position: 'absolute',
                width: size * 1.7,
                height: size * 0.32,
                top: size * 0.1,
                left: -size * 0.35,
                transform: [{ rotate: '-35deg' }],
              }}
            />
          )}
        </LinearGradient>
      </Reanimated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute' },
  rim: { alignItems: 'center', justifyContent: 'center' },
  face: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
})
