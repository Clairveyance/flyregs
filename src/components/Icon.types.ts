import type { StyleProp, ViewStyle } from 'react-native'

export interface IconProps {
  /** SF Symbol name — mapped to Ionicons on web */
  name: string
  size?: number
  /** Icon tint/fill color */
  color?: string
  weight?: 'ultraLight' | 'thin' | 'light' | 'regular' | 'medium' | 'semibold' | 'bold' | 'heavy' | 'black'
  style?: StyleProp<ViewStyle>
}
