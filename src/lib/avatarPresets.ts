export interface AvatarPreset {
  id: string
  icon: string
  color: string
}

// Fixed, theme-independent colors -- meant to look the same and stay vivid
// in both light and dark mode, same as the default initials avatar's own
// fixed blue background (tokens.blu) rather than reacting to theme tokens.
export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'jet', icon: 'airplane', color: '#4B8EF5' },
  { id: 'cloud', icon: 'cloud.fill', color: '#38BDF8' },
  { id: 'sun', icon: 'sun.max.fill', color: '#F59E0B' },
  { id: 'night', icon: 'moon.stars.fill', color: '#6366F1' },
  { id: 'bolt', icon: 'bolt.fill', color: '#EAB308' },
  { id: 'globe', icon: 'globe', color: '#14B8A6' },
  { id: 'star', icon: 'star.fill', color: '#F472B6' },
  { id: 'flame', icon: 'flame.fill', color: '#EF4444' },
]

export function getAvatarPreset(id: string | null | undefined): AvatarPreset | null {
  if (!id) return null
  return AVATAR_PRESETS.find((p) => p.id === id) ?? null
}
