import { View } from 'react-native'
import { SymbolView } from 'expo-symbols'
import type { SymbolViewProps } from 'expo-symbols'
import { Ionicons } from '@expo/vector-icons'
import type { IconProps } from './Icon.types'
import { AviationHeadset } from './AviationHeadset'

export function Icon({ name, size = 22, color, weight = 'regular', style }: IconProps) {
  // SF Symbols has no "headset" symbol (headphones/airpods/earbuds only), so
  // this name reached SymbolView and rendered NOTHING on device. Intercept it
  // and draw the real aviation headset instead. See AviationHeadset.tsx.
  if (name === 'headset') {
    return (
      <View style={style as object}>
        <AviationHeadset size={size} color={color ?? '#000'} />
      </View>
    )
  }
  // RC, real device: SF Symbols' real 'gauge'/'speedometer' glyphs (a plain
  // circle split by a line, or a car-style needle-in-circle) look nothing
  // like the "crescent-gap dial with 5 ticks + needle" RC saw and liked in
  // the Browser preview -- that's Ionicons' own speedometer-outline glyph,
  // rendered there via the web fallback below. Rather than hand-build that
  // exact multi-piece shape from plain Views (it has a ~300° ring with a
  // deliberate bottom gap, 5 tick marks, and an off-center needle -- not
  // reproducible at the 11-14px sizes this renders at without SVG), render
  // the SAME Ionicons glyph here too. @expo/vector-icons is already a
  // dependency and works natively via bundled font assets, so this is a
  // byte-identical render on both platforms, not an approximation.
  if (name === 'speedometer') {
    return <Ionicons name="speedometer-outline" size={size} color={color} style={style as object} />
  }
  return (
    <SymbolView
      name={name as SymbolViewProps['name']}
      size={size}
      tintColor={color}
      weight={weight as SymbolViewProps['weight']}
      style={[{ width: size, height: size }, style as object]}
    />
  )
}
