import { View, Text, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

export type Tier = 'plus' | 'pro' | 'premium'

// Static colored tier label for inline use in copy (FAQ answers, etc.) --
// same color language as Drawer.tsx's own TierPill, which is driven by the
// CURRENT user's actual subscription state (isPro/isPremium/isUnlocked).
// This is a separate component because it's keyed by an explicit `tier`
// prop instead: it's describing which tier a FEATURE requires, not the
// reader's own plan, so it needs to render as any of the three regardless
// of who's looking at it. RC, live: "when we mention any tier in the FAQ,
// let's use the actual colored chips for those tiers to help them stand
// out."
export function TierChip({ tier }: { tier: Tier }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const color = tier === 'premium' ? tokens.gold : tier === 'pro' ? tokens.blu : tokens.amb
  const bg = tier === 'premium' ? tokens.goldlt : tier === 'pro' ? tokens.bdim : 'rgba(245,158,11,0.12)'
  const bdr = tier === 'premium' ? tokens.goldbdr : tier === 'pro' ? tokens.bbdr : 'rgba(245,158,11,0.28)'
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: bdr }]}>
      <Text style={[styles.text, { color, fontSize: fs(8.5) }]} numberOfLines={1}>{tier.toUpperCase()}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontWeight: '700', letterSpacing: 0.2 },
})
