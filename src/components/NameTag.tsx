import { useMemo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { RATING_SHORT_LABELS, type RatingCode } from '@/lib/profileRatings'
import { COIN_BY_CODE, type EarnedCoin, type CoinTier } from '@/lib/coins'
import { CoinMedal } from '@/components/CoinMedal'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// Compact "bragging rights" summary -- ratings + coin-tier tally in one
// glanceable row. This is what an opponent sees about you before a Duel (or
// anywhere else a pilot's identity shows up), so it needs to read at a
// glance without the full tap-through Profile page (ratings chips + full
// coin grid with per-coin detail) that's still the place for the complete
// picture. Renders nothing if there's simply nothing to brag about yet.
export function NameTag({ ratings, coins }: { ratings: RatingCode[]; coins: EarnedCoin[] }) {
  const { tokens } = useTheme()
  const fs = useFS()
  const tierCounts = useMemo(() => {
    const counts: Record<CoinTier, number> = { bronze: 0, silver: 0, gold: 0 }
    for (const c of coins) {
      const def = COIN_BY_CODE[c.code]
      if (def) counts[def.tier]++
    }
    return counts
  }, [coins])

  if (ratings.length === 0 && coins.length === 0) return null

  const coinTiers = (['gold', 'silver', 'bronze'] as const).filter((t) => tierCounts[t] > 0)

  // Ratings and coins are TWO separate rows, not one wrapping row. They were
  // combined, which read as "AMEL, and also a medal" -- the coin tally looked
  // like just another rating pill sitting at the end of the same line. They
  // are different kinds of thing (certificates you hold vs. achievements you
  // earned) and now stack accordingly.
  return (
    <View>
      {ratings.length > 0 && (
        <View style={styles.row}>
          {ratings.map((code) => (
            <View key={code} style={[styles.pill, { borderColor: tokens.gold, backgroundColor: tokens.goldlt }]}>
              <Text style={[styles.pillText, { color: tokens.gold, fontSize: fs(10.5) }]}>{RATING_SHORT_LABELS[code]}</Text>
            </View>
          ))}
        </View>
      )}
      {coinTiers.length > 0 && (
        <View style={styles.row}>
          {coinTiers.map((tier) => (
            <View key={tier} style={styles.tallyItem}>
              {/* 15 -> 22: at 15 the medal's own icon renders at 6px, well
                  below legible -- confirmed live, "make them a bit bigger
                  here so users can still make out which is which on their
                  nametag." 22 keeps this a compact tally chip (not the full
                  46px grid size Profile's own coin case uses) while making
                  the bronze/silver/gold rim actually readable at a glance. */}
              <CoinMedal tier={tier} icon="rosette" earned size={22} />
              <Text style={[styles.tallyText, { color: tokens.t3, fontSize: fs(12) }]}>×{tierCounts[tier]}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 5 },
  pill: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 7, paddingVertical: 2 },
  pillText: { fontWeight: '700', fontSize: 10.5 },
  tallyItem: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  tallyText: { fontWeight: '600', fontSize: 10.5 },
})
