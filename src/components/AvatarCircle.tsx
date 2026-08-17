import { View, Text, Image, StyleSheet } from 'react-native'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'

// Small reusable avatar circle -- photo, else preset icon+color, else an
// initial letter. Pulled out because it was being hand-rolled slightly
// differently in Account/Drawer/Search/profile screens, and Duels opponent
// rows + Ready Room leaderboard rows were about to become the 5th and 6th
// copies of the same three-way branch (see avatarPresets.ts's own comment:
// presets were deliberately spread across brightness, not hue, specifically
// so several players stay distinguishable "in a Duels leaderboard showing
// several players at once" -- this component is where that finally lands).
export function AvatarCircle({
  imageUri,
  presetId,
  fallbackLabel,
  size,
}: {
  imageUri: string | null
  presetId: string | null
  fallbackLabel: string
  size: number
}) {
  const { tokens, redShift } = useTheme()
  const preset = getAvatarPreset(presetId)
  const bg = imageUri ? 'transparent' : preset ? avatarColorFor(preset, redShift) : tokens.goldlt

  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg, borderColor: tokens.goldbdr }]}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
      ) : preset ? (
        <Icon name={preset.icon} size={size * 0.52} color="#fff" />
      ) : (
        <Text style={[styles.fallbackText, { color: tokens.gold, fontSize: size * 0.42 }]}>
          {fallbackLabel.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, overflow: 'hidden' },
  fallbackText: { fontWeight: '700' },
})
