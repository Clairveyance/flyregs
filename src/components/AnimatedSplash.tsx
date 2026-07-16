import { useEffect, useMemo } from 'react'
import { Image, StyleSheet, useWindowDimensions, View } from 'react-native'
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  Easing,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated'

// ─── Source-art geometry ───────────────────────────────────────────────────
// All measurements below come from connected-component analysis of the
// original wordmark PNG (1915x1428) — the wing is a large diagonal shape
// whose bounding box overlaps the letters' bounding boxes in both X and Y
// (it isn't a clean left/right split), so a simple column crop pulled in
// only some letters. Splitting by connected component gives the true wing
// ink bbox (x:[40,1160], y:[41,1286]) and the true union of the six letter
// glyphs (x:[236,1874], y:[926,1387]), both in the wordmark file's own pixel
// space — from which the wing↔text relative offset is derived below.
const WING_SOURCE_ASPECT = 971 / 1071 // flyregs-wing.png (standalone) width/height
const WING_SHAPE_WIDTH_FRAC = 891 / 971 // wing ink width within its own standalone canvas
const WING_EMBEDDED_INK_WIDTH = 1120 // wing ink width as it appears inside the wordmark file

// flyregs-wordmark-text.png: the six letters only (wing pixels masked out),
// cropped to their tight union bbox + 14px padding, in wordmark-file pixels.
const TEXT_SOURCE_WIDTH = 1666
const TEXT_SOURCE_HEIGHT = 489
// Text ink center minus wing ink center, in wordmark-file pixels.
const TEXT_REL_OFFSET_X = 455
const TEXT_REL_OFFSET_Y = 493

// Splash choreography:
// 1. Wing mark alone, centered — holds.
// 2. It shrinks to 70% and shifts left while "lyRegs" trains out from behind
//    it, left-to-right (l first, s last), landing with the whole wing+text
//    lockup centered on screen.
// 3. Lockup holds.
// 4. Whole lockup + backdrop fade together, revealing the app underneath.
export function AnimatedSplash({ onDone }: { onDone: () => void }) {
  const { width: screenW, height: screenH } = useWindowDimensions()

  const wingBigWidth = Math.min(screenW * 0.34, 138)
  const wingBigHeight = wingBigWidth / WING_SOURCE_ASPECT
  const WING_SCALE_TARGET = 0.7 // deliberate 100% -> 70% shrink, not geometrically derived

  const wingSettledWidth = wingBigWidth * WING_SCALE_TARGET
  const wingSettledHeight = wingBigHeight * WING_SCALE_TARGET

  // "Zoom level" of the whole lockup, derived from how big the wing ends up
  // on screen vs. its true ink width inside the source wordmark file — this
  // lets the text scale and position proportionally no matter what wing size
  // is chosen above.
  const compositeScale = (wingSettledWidth * WING_SHAPE_WIDTH_FRAC) / WING_EMBEDDED_INK_WIDTH
  const textWidth = TEXT_SOURCE_WIDTH * compositeScale
  const textHeight = TEXT_SOURCE_HEIGHT * compositeScale
  const textOffsetFromWingX = TEXT_REL_OFFSET_X * compositeScale
  const textOffsetFromWingY = TEXT_REL_OFFSET_Y * compositeScale

  // Lay out wing (at origin) + text (offset from wing), then re-center the
  // whole union on screen so the finished lockup never drifts off-center.
  const { wingTranslateXTarget, wingTranslateYTarget, textTranslateX, textTranslateY } = useMemo(() => {
    const wingLeft = -wingSettledWidth / 2
    const wingRight = wingSettledWidth / 2
    const wingTop = -wingSettledHeight / 2
    const wingBottom = wingSettledHeight / 2

    const textCenterX = textOffsetFromWingX
    const textCenterY = textOffsetFromWingY
    const textLeft = textCenterX - textWidth / 2
    const textRight = textCenterX + textWidth / 2
    const textTop = textCenterY - textHeight / 2
    const textBottom = textCenterY + textHeight / 2

    const unionCenterX = (Math.min(wingLeft, textLeft) + Math.max(wingRight, textRight)) / 2
    const unionCenterY = (Math.min(wingTop, textTop) + Math.max(wingBottom, textBottom)) / 2

    return {
      wingTranslateXTarget: -unionCenterX,
      wingTranslateYTarget: -unionCenterY,
      textTranslateX: textCenterX - unionCenterX,
      textTranslateY: textCenterY - unionCenterY,
    }
  }, [wingSettledWidth, wingSettledHeight, textOffsetFromWingX, textOffsetFromWingY, textWidth, textHeight])

  const wingOpacity = useSharedValue(0)
  const wingScale = useSharedValue(0.5)
  const wingTranslateX = useSharedValue(0)
  const wingTranslateY = useSharedValue(0)

  const revealProgress = useSharedValue(0)
  const rootOpacity = useSharedValue(1)

  useEffect(() => {
    const WING_HOLD = 1650
    const MORPH_DURATION = 650
    const WORDMARK_HOLD = 900
    const FADE_DURATION = 500

    const morphStart = WING_HOLD
    const fadeStart = morphStart + MORPH_DURATION + WORDMARK_HOLD

    // Each shared value gets exactly one `.value =` assignment for its whole
    // life — assigning twice in the same tick (e.g. once to fade in, again
    // later to fade out) makes the second assignment cancel the first before
    // it ever animates, since both run synchronously at mount.
    wingOpacity.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic) })
    wingScale.value = withSequence(
      withTiming(1, { duration: 520, easing: Easing.out(Easing.back(1.3)) }),
      withDelay(morphStart - 520, withTiming(WING_SCALE_TARGET, { duration: MORPH_DURATION, easing: Easing.inOut(Easing.cubic) }))
    )
    wingTranslateX.value = withDelay(morphStart, withTiming(wingTranslateXTarget, { duration: MORPH_DURATION, easing: Easing.inOut(Easing.cubic) }))
    wingTranslateY.value = withDelay(morphStart, withTiming(wingTranslateYTarget, { duration: MORPH_DURATION, easing: Easing.inOut(Easing.cubic) }))

    // The text trains out in the same window the wing shrinks in.
    revealProgress.value = withDelay(morphStart, withTiming(1, { duration: MORPH_DURATION, easing: Easing.inOut(Easing.cubic) }))

    rootOpacity.value = withDelay(
      fadeStart,
      withTiming(0, { duration: FADE_DURATION, easing: Easing.in(Easing.cubic) }, (finished) => {
        if (finished) runOnJS(onDone)()
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wingStyle = useAnimatedStyle(() => ({
    opacity: wingOpacity.value,
    transform: [
      { translateX: wingTranslateX.value },
      { translateY: wingTranslateY.value },
      { scale: wingScale.value },
    ],
  }))
  const clipStyle = useAnimatedStyle(() => ({
    width: interpolate(revealProgress.value, [0, 1], [0, textWidth], Extrapolation.CLAMP),
  }))
  const rootStyle = useAnimatedStyle(() => ({ opacity: rootOpacity.value }))

  return (
    <Reanimated.View style={[styles.root, rootStyle]} pointerEvents="none">
      <Image
        source={require('@/assets/images/flyregs-splash-bg.png')}
        style={[StyleSheet.absoluteFill, { width: screenW, height: screenH }]}
        resizeMode="cover"
      />

      <Reanimated.View style={[styles.absoluteCenter, wingStyle]}>
        <Image
          source={require('@/assets/images/flyregs-wing.png')}
          style={{ width: wingBigWidth, height: wingBigHeight }}
          resizeMode="contain"
        />
      </Reanimated.View>

      <View
        style={[
          styles.textOuter,
          { width: textWidth, height: textHeight, transform: [{ translateX: textTranslateX }, { translateY: textTranslateY }] },
        ]}
      >
        <Reanimated.View style={[styles.textClip, { height: textHeight }, clipStyle]}>
          <Image
            source={require('@/assets/images/flyregs-wordmark-text.png')}
            style={{ width: textWidth, height: textHeight }}
            resizeMode="stretch"
          />
        </Reanimated.View>
      </View>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#07111E',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 999,
    overflow: 'hidden',
  },
  absoluteCenter: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Text reveals left-to-right, away from the wing (l first, s last), so
  // both the outer box and the clip anchor to the LEFT edge — the clip
  // grows rightward, and the image inside stays pinned to the clip's left
  // edge so already-revealed letters never shift once shown.
  textOuter: {
    position: 'absolute',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  textClip: {
    overflow: 'hidden',
    alignItems: 'flex-start',
  },
})
