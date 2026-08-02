import { View } from 'react-native'
import { SymbolView } from 'expo-symbols'
import type { SymbolViewProps } from 'expo-symbols'
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
