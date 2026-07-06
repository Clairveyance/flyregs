import { SymbolView } from 'expo-symbols'
import type { SymbolViewProps } from 'expo-symbols'
import type { IconProps } from './Icon.types'

export function Icon({ name, size = 22, color, weight = 'regular', style }: IconProps) {
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
