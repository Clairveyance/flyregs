import { View } from 'react-native'

/**
 * Aviation headset glyph — headband + two ear cups + boom mic.
 *
 * WHY THIS EXISTS AT ALL, twice over:
 *
 * 1. CORRECTNESS. The P/CG icon was the bare name 'headset', and
 *    Icon.native.tsx passes names straight through to expo-symbols. SF
 *    Symbols has NO symbol called "headset" (it has headphones, airpods,
 *    earbuds — not headset), so on a real device this icon rendered as
 *    nothing at all. A comment in regTypes.ts claimed both Icon files
 *    special-cased the name; they did not. Only the web build ever showed
 *    anything, via the Ionicons fallback.
 *
 * 2. MEANING. Plain headphones read as "music". A pilot's headset has an
 *    ear cup AND a boom mic — that combination is what makes it read as
 *    aviation, and the P/CG is specifically the shared PILOT/CONTROLLER
 *    radio vocabulary, so the mic is the whole point of the metaphor.
 *
 * Built from plain Views rather than SVG deliberately: this project has no
 * react-native-svg dependency, and the same primitives render identically on
 * web and native, so there is no second implementation to keep in sync.
 * Every dimension is a fraction of `size`, so it stays proportional wherever
 * it is drawn (15px in a NameTag tally, 22px in a header).
 */
export function AviationHeadset({ size = 22, color = '#000' }: { size?: number; color?: string }) {
  const s = size
  // RC, real device: "headset looks good, try to make it a bit bigger or
  // 'thicker' so it matches better the other icons" -- the other reg-type
  // icons are all SF Symbol ".fill" (solid) glyphs, which read heavier at a
  // given point size than this component's own thin outline stroke did.
  // Thickened the stroke rather than the overall size, since the shape/
  // silhouette was already confirmed good -- this is a weight match, not a
  // redesign.
  const stroke = Math.max(1.6, s * 0.13)
  const cupW = s * 0.22
  const cupH = s * 0.34
  const bandW = s * 0.72
  const bandH = s * 0.4
  // Confirmed live as a real complaint (RC, annotated screenshot): at the
  // old 0.34 length the boom+mic visually reached almost all the way to
  // the RIGHT ear cup, reading as a bar spanning ear-to-ear rather than a
  // mic boom hanging off the left one. Halved, with the mic capsule's own
  // position (below) pulled in proportionally to match -- it's a
  // hand-positioned absolute coordinate, not derived from boomLen, so it
  // has to move with it or the mic ends up floating past the boom's own
  // (now shorter) end.
  const boomLen = s * 0.17

  return (
    <View style={{ width: s, height: s }}>
      {/* Headband: a top-only arc — borders on three sides with a large top
          radius gives a clean semicircle without needing a path. */}
      <View
        style={{
          position: 'absolute',
          left: (s - bandW) / 2,
          top: s * 0.12,
          width: bandW,
          height: bandH,
          borderColor: color,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderTopLeftRadius: bandW / 2,
          borderTopRightRadius: bandW / 2,
        }}
      />
      {/* Ear cups, outlined to sit alongside the app's other outline icons */}
      <View
        style={{
          position: 'absolute',
          left: s * 0.1,
          top: s * 0.44,
          width: cupW,
          height: cupH,
          borderColor: color,
          borderWidth: stroke,
          borderRadius: s * 0.07,
        }}
      />
      <View
        style={{
          position: 'absolute',
          right: s * 0.1,
          top: s * 0.44,
          width: cupW,
          height: cupH,
          borderColor: color,
          borderWidth: stroke,
          borderRadius: s * 0.07,
        }}
      />
      {/* Boom arm, angled down and inward from the left cup */}
      <View
        style={{
          position: 'absolute',
          left: s * 0.28,
          top: s * 0.74,
          width: boomLen,
          height: stroke,
          backgroundColor: color,
          borderRadius: stroke,
          transform: [{ rotate: '22deg' }],
        }}
      />
      {/* Mic capsule at the end of the boom — filled, so it reads as the
          mic head rather than more tubing at 15px. */}
      <View
        style={{
          position: 'absolute',
          left: s * 0.4,
          top: s * 0.735,
          width: s * 0.16,
          height: s * 0.16,
          borderRadius: s * 0.08,
          backgroundColor: color,
        }}
      />
    </View>
  )
}
