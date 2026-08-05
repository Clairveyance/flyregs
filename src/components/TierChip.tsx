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
  const bg = tier === 'premium' ? tokens.goldlt : tier === 'pro' ? tokens.bdim : tokens.adim
  const bdr = tier === 'premium' ? tokens.goldbdr : tier === 'pro' ? tokens.bbdr : tokens.abdr
  return (
    <View style={[styles.pill, { backgroundColor: bg, borderColor: bdr }]}>
      <Text style={[styles.text, { color, fontSize: fs(8.5) }]} numberOfLines={1}>{tier.toUpperCase()}</Text>
    </View>
  )
}

// Inline version, for tier names that appear MID-SENTENCE in prose rather
// than as a leading badge. RC: "if faq, make sure any mention of a tier,
// comes w/ the colored chip" -- the block TierChip above only covers
// answers whose whole point is one tier, but plenty of copy names a tier
// inside a sentence ("Pro includes one, Premium is unlimited"), and those
// were rendering as flat body text.
//
// Deliberately a nested <Text>, not the <View> pill above: a View can't sit
// inline inside a Text run in React Native, so a pill would break the line
// box. Same colour language, just carried by weight + colour instead of a
// border.
export function inlineTierText(
  text: string,
  tokens: ReturnType<typeof useTheme>['tokens'],
): (string | React.ReactElement)[] {
  const colorFor = (word: string) => {
    const w = word.toLowerCase()
    return w === 'premium' ? tokens.gold : w === 'pro' ? tokens.blu : tokens.amb
  }
  // Word-boundary matched so "Provide"/"Plusses" can never be recoloured,
  // and possessives/punctuation still work.
  const parts = text.split(/\b(Premium|Pro|Plus)\b/g)
  return parts.map((part, i) =>
    i % 2 === 1
      ? <Text key={i} style={{ color: colorFor(part), fontWeight: '700' }}>{part}</Text>
      : part,
  )
}

const styles = StyleSheet.create({
  pill: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 2, alignSelf: 'flex-start' },
  text: { fontWeight: '700', letterSpacing: 0.2 },
})
