import { View, StyleSheet } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { Icon } from '@/components/Icon'
import { useFS } from '@/context/fontScale'
import { useTheme } from '@/context/theme'
import type { CoinTier } from '@/lib/coins'

// A flat single-color circle read as a plain icon badge, not a coin --
// real challenge coins (see the reference photos) have a beveled metallic
// rim and a raised/engraved face. Approximates that with two nested
// gradient rings (outer rim, inner bevel) plus a dark face disc, using
// only what's already in the app (LinearGradient, same as MagicLink's own
// gold effect) rather than needing commissioned per-coin artwork.
//
// Tiers progressively escalate in ornamentation, not just color, so a
// bronze/silver/gold set of the same coin reads as genuinely harder-won
// rather than a recolor: bronze is the plain single-ring rim; silver adds
// an inner bevel ring and a soft glow; gold adds a warmer/stronger glow
// plus a diagonal shine sweep across the rim -- the same "more is rarer"
// escalation real challenge-coin sets use.
//
// The shine replaced four small solid-circle "sparkle" dots fixed at the
// rim's N/S/E/W points -- confirmed live: "these four dots on these icons.
// they look weird, not premium. find a better way to 'accent' the gold
// coins. something that's more fluid and more distinguished." A rigid
// 4-point cardinal pattern is the opposite of fluid regardless of what
// shape sits at each point; a single soft diagonal highlight (how light
// actually catches a curved polished-metal surface) reads as an intrinsic
// property of the coin's finish rather than a decoration stuck on top.
// Bronze was '#E0A868' -- a pale warm tan that, at coin size, read as just a
// dimmer gold rather than its own distinct tone. Confirmed live: "they all
// look gold-ish. the 'lesser' ones can be diff tones." Real bronze is a
// saturated orange-brown copper (the classic "bronze" reference is
// #CD7F32), clearly cooler and darker than gold's pale yellow -- bronze is
// the tier with NO bevel/glow escalation (see showBevel below), so its rim
// gradient is the ONLY signal it gets; it needs to carry the difference on
// its own.
const TIER_GRADIENTS: Record<CoinTier, readonly [string, string, string]> = {
  bronze: ['#CD8032', '#7A4A1D', '#CD8032'],
  silver: ['#F2F2F2', '#9A9A9A', '#F2F2F2'],
  gold: ['#FFE9A8', '#C9971F', '#FFE9A8'],
}
const TIER_BEVEL: Record<CoinTier, readonly [string, string]> = {
  bronze: ['#8C5A2B', '#8C5A2B'],
  silver: ['#FFFFFF', '#C7C7C7'],
  gold: ['#FFF6D9', '#E8B923'],
}
const TIER_GLOW: Record<CoinTier, string | null> = {
  bronze: null,
  silver: 'rgba(226,226,226,0.45)',
  gold: 'rgba(255,201,64,0.6)',
}
const LOCKED_GRADIENT: readonly [string, string, string] = ['#4a4a52', '#2a2a30', '#4a4a52']

// Red Shift equivalents. Silver's near-white/grey (R=G=B) and gold's pale
// yellow (G nearly as high as R) are the two least night-vision-safe things
// in the app -- recolored using the same rust-tone language as theme.tsx's
// own `slv`/`gold` tokens so a coin matches the rest of the red-shifted UI
// instead of being the one thing that's still grey. Bronze is already a
// red-safe copper hue and only gets a minor low-green nudge.
const TIER_GRADIENTS_REDSHIFT: Record<CoinTier, readonly [string, string, string]> = {
  bronze: ['#D97A3A', '#7A3814', '#D97A3A'],
  silver: ['#C4906F', '#6B4638', '#C4906F'],
  gold: ['#FFC178', '#B8541A', '#FFC178'],
}
const TIER_BEVEL_REDSHIFT: Record<CoinTier, readonly [string, string]> = {
  bronze: ['#8C5A2B', '#8C5A2B'],
  silver: ['#E0B896', '#8F6252'],
  gold: ['#FFDCAE', '#FF9A2E'],
}
const TIER_GLOW_REDSHIFT: Record<CoinTier, string | null> = {
  bronze: null,
  silver: 'rgba(196,144,111,0.45)',
  gold: 'rgba(255,154,46,0.6)',
}
const LOCKED_GRADIENT_REDSHIFT: readonly [string, string, string] = ['#4a3530', '#2a1e1c', '#4a3530']
const SHINE_COLOR_REDSHIFT = 'rgba(255,180,140,0.55)'

export function CoinMedal({
  tier,
  icon,
  earned,
  size: baseSize = 46,
}: {
  tier: CoinTier
  icon: string
  earned: boolean
  size?: number
}) {
  // Every caller passes a design-time base size (e.g. 22 in a name tag, 96
  // in the earned-coin reveal) -- scaling it here once, rather than at each
  // call site, means the text-size setting reaches every coin automatically
  // as new call sites get added, instead of relying on each one to remember.
  const fs = useFS()
  const { redShift } = useTheme()
  const size = fs(baseSize)
  const gradients = redShift ? TIER_GRADIENTS_REDSHIFT : TIER_GRADIENTS
  const bevels = redShift ? TIER_BEVEL_REDSHIFT : TIER_BEVEL
  const glows = redShift ? TIER_GLOW_REDSHIFT : TIER_GLOW
  const locked = redShift ? LOCKED_GRADIENT_REDSHIFT : LOCKED_GRADIENT
  const faceBg = redShift ? '#1a0e0a' : '#1c1c1f'
  const lockedFaceBg = redShift ? '#241a16' : '#242429'
  const lockedIconColor = redShift ? '#8a6858' : '#7a7a82'
  const shineColor = redShift ? SHINE_COLOR_REDSHIFT : 'rgba(255,255,255,0.55)'
  const colors = earned ? gradients[tier] : locked
  const faceSize = size * 0.78
  const bevelSize = size * 0.9
  const showBevel = earned && tier !== 'bronze'
  const showShine = earned && tier === 'gold'
  const glow = earned ? glows[tier] : null

  return (
    <View
      style={[
        styles.wrap,
        // Silver/gold's glow -- shadowColor/shadowRadius with no offset --
        // casts its soft halo in the exact shape of THIS view's own box.
        // `wrap` had no borderRadius, so the glow rendered as a square
        // around the circular coin instead of a matching circular glow --
        // confirmed live via DOM inspection (not assumed): the coin itself
        // is circular border-radius at every layer, only this outer
        // shadow-casting box wasn't. RC: "can we get rid of the square b/g
        // box behind all these coins? just have the round coin."
        { width: size * 1.3, height: size * 1.3, borderRadius: size * 0.65 },
        glow ? { shadowColor: glow, shadowOpacity: 1, shadowRadius: size * 0.22, shadowOffset: { width: 0, height: 0 } } : null,
      ]}
    >
      <LinearGradient
        colors={colors}
        start={{ x: 0.15, y: 0.15 }}
        end={{ x: 0.9, y: 0.9 }}
        style={[styles.rim, { width: size, height: size, borderRadius: size / 2, overflow: 'hidden' }]}
      >
        {showBevel ? (
          <LinearGradient
            colors={bevels[tier]}
            start={{ x: 0.2, y: 0.2 }}
            end={{ x: 0.85, y: 0.85 }}
            style={[styles.bevel, { width: bevelSize, height: bevelSize, borderRadius: bevelSize / 2 }]}
          >
            <View
              style={[
                styles.face,
                { width: faceSize, height: faceSize, borderRadius: faceSize / 2, backgroundColor: faceBg, borderColor: colors[1] },
              ]}
            >
              <Icon name={icon} size={size * 0.4} color={colors[0]} />
            </View>
          </LinearGradient>
        ) : (
          <View
            style={[
              styles.face,
              {
                width: faceSize,
                height: faceSize,
                borderRadius: faceSize / 2,
                backgroundColor: earned ? faceBg : lockedFaceBg,
                borderColor: colors[1],
              },
            ]}
          >
            <Icon name={earned ? icon : 'lock.fill'} size={size * 0.4} color={earned ? colors[0] : lockedIconColor} />
          </View>
        )}
        {/* Diagonal glint, not a decoration bolted onto the coin -- rim has
            overflow:hidden (its borderRadius makes it a circle) so this
            oversized rotated bar gets clipped to exactly the coin's curve,
            same way real light only catches a thin arc of a curved
            polished surface. pointerEvents="none" so it never intercepts
            the coin's own press target. */}
        {showShine && (
          <LinearGradient
            pointerEvents="none"
            colors={['transparent', shineColor, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={{
              position: 'absolute',
              width: size * 1.6,
              height: size * 0.3,
              top: size * 0.12,
              left: -size * 0.3,
              transform: [{ rotate: '-35deg' }],
            }}
          />
        )}
      </LinearGradient>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rim: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  bevel: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  face: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
})
