export interface AvatarPreset {
  id: string
  icon: string
  color: string
  redshiftColor: string
}

// Fixed, theme-independent colors -- meant to look the same and stay vivid
// in both light and dark mode, same as the default initials avatar's own
// fixed blue background (tokens.blu) rather than reacting to theme tokens.
//
// redshiftColor: RC, after initially flagging this as a real tradeoff to
// decide (night-vision purity vs. keeping users visually distinct) and
// then seeing Red Shift live: "good, but everything on screen has to be
// included in the color shift" -- no exception, these get the same
// treatment as every app-chrome color. Spread deliberately wider across
// brightness/saturation than the 4-5-step semantic accents elsewhere in
// the app, since 8 presets need to stay mutually distinguishable (e.g. in
// a Duels leaderboard showing several players at once) within only the
// red/orange band -- pairs that were cool-vs-warm originals (jet/cloud
// blues vs. sun/bolt yellows) are now told apart by brightness instead.
export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'jet', icon: 'airplane', color: '#4B8EF5', redshiftColor: '#E0562E' },
  { id: 'cloud', icon: 'cloud.fill', color: '#38BDF8', redshiftColor: '#FF8F63' },
  { id: 'sun', icon: 'sun.max.fill', color: '#F59E0B', redshiftColor: '#F2701A' },
  { id: 'night', icon: 'moon.stars.fill', color: '#6366F1', redshiftColor: '#8A3020' },
  { id: 'bolt', icon: 'bolt.fill', color: '#EAB308', redshiftColor: '#FF9A2E' },
  { id: 'globe', icon: 'globe', color: '#14B8A6', redshiftColor: '#C4523A' },
  { id: 'star', icon: 'star.fill', color: '#F472B6', redshiftColor: '#FF5540' },
  { id: 'flame', icon: 'flame.fill', color: '#EF4444', redshiftColor: '#FF2D12' },
]

export function getAvatarPreset(id: string | null | undefined): AvatarPreset | null {
  if (!id) return null
  return AVATAR_PRESETS.find((p) => p.id === id) ?? null
}

export function avatarColorFor(preset: AvatarPreset, redShift: boolean): string {
  return redShift ? preset.redshiftColor : preset.color
}
