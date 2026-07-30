import { useEffect, useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getMyRatings, RATING_SHORT_LABELS, type RatingCode } from '@/lib/profileRatings'
import { getCoinsForUser, COIN_BY_CODE, type EarnedCoin } from '@/lib/coins'
import { getStatsVisible, getCurrentAircraft } from '@/lib/leaderboard'

// The Community "bragging page" -- badges, ratings, Duel record, current
// aircraft. Duel record is unconditionally public (get_duel_stats() has no
// visibility gate by original design -- match results aren't private).
// Ratings/coins/aircraft respect the existing "Show my stats" toggle
// (account.tsx / search.tsx's Community hub) -- that toggle's own copy
// promises this exact set of fields stays hidden until opted in, so this
// screen honors that even though user_coins/user_profile_ratings' RLS
// policies are technically public-readable already (a pre-existing
// permissiveness this screen doesn't rely on for anyone but the owner).
export default function ProfileScreen() {
  const { userId, label } = useLocalSearchParams<{ userId: string; label?: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { session } = useAuth()
  const isSelf = session?.user.id === userId

  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(false)
  const [duelStats, setDuelStats] = useState<DuelStats | null>(null)
  const [ratings, setRatings] = useState<RatingCode[]>([])
  const [coins, setCoins] = useState<EarnedCoin[]>([])
  const [aircraft, setAircraft] = useState('')

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    const [stats, canSeeStats] = await Promise.all([
      getDuelStats(userId).catch(() => ({ wins: 0, losses: 0, ties: 0 })),
      isSelf ? Promise.resolve(true) : getStatsVisible(userId).catch(() => false),
    ])
    setDuelStats(stats)
    setVisible(canSeeStats)
    if (canSeeStats) {
      const [r, c, a] = await Promise.all([
        getMyRatings(userId).catch(() => []),
        getCoinsForUser(userId).catch(() => []),
        getCurrentAircraft(userId).catch(() => ''),
      ])
      setRatings(r); setCoins(c); setAircraft(a)
    }
    setLoading(false)
  }, [userId, isSelf])

  useEffect(() => { load() }, [load])

  const displayLabel = isSelf ? 'You' : (label || 'Pilot')

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Profile" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      ) : (
        <TabletContainer>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.headerRow}>
              <View style={[styles.avatar, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                <Text style={[styles.avatarText, { color: tokens.gold, fontSize: fs(24) }]}>
                  {displayLabel.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.name, { color: tokens.t1, fontSize: fs(19) }]}>{displayLabel}</Text>
                {aircraft ? (
                  <Text style={[styles.aircraft, { color: tokens.t3, fontSize: fs(13) }]}>Flying: {aircraft}</Text>
                ) : null}
              </View>
            </View>

            {duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0) && (
              <View style={[styles.duelCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}>
                <Icon name="bolt.fill" size={18} color={tokens.gold} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.duelRecord, { color: tokens.t1, fontSize: fs(17) }]}>
                    {duelStats.wins}W · {duelStats.losses}L{duelStats.ties > 0 ? ` · ${duelStats.ties}T` : ''}
                  </Text>
                  <Text style={[styles.duelSub, { color: tokens.t3, fontSize: fs(11.5) }]}>Duel record</Text>
                </View>
              </View>
            )}

            {!visible ? (
              <View style={[styles.privateCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="eye.slash" size={22} color={tokens.t4} />
                <Text style={[styles.privateText, { color: tokens.t3, fontSize: fs(13) }]}>
                  {displayLabel} hasn't made ratings, badges, or aircraft visible to other pilots yet.
                </Text>
              </View>
            ) : (
              <>
                {ratings.length > 0 && (
                  <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>RATINGS</Text>
                    <View style={styles.chipWrap}>
                      {ratings.map((code) => (
                        <View key={code} style={[styles.ratingChip, { borderColor: tokens.gold, backgroundColor: tokens.goldlt }]}>
                          <Text style={[styles.ratingChipText, { color: tokens.gold, fontSize: fs(12) }]}>{RATING_SHORT_LABELS[code]}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                <View style={styles.section}>
                  <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>
                    CHALLENGE COINS{coins.length > 0 ? ` · ${coins.length}` : ''}
                  </Text>
                  {coins.length === 0 ? (
                    <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>No coins earned yet.</Text>
                  ) : (
                    <View style={styles.coinGrid}>
                      {coins.map((c) => {
                        const def = COIN_BY_CODE[c.code]
                        if (!def) return null
                        return (
                          <View key={c.code} style={[styles.coinCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}>
                            <Icon name={def.icon} size={20} color={tokens.gold} />
                            <Text style={[styles.coinName, { color: tokens.t1, fontSize: fs(12) }]} numberOfLines={2}>{def.name}</Text>
                          </View>
                        )
                      })}
                    </View>
                  )}
                </View>
              </>
            )}
          </ScrollView>
        </TabletContainer>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40, gap: 18 },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatar: { width: 58, height: 58, borderRadius: 29, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '800' },
  name: { fontWeight: '700' },
  aircraft: { marginTop: 3 },

  duelCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14,
  },
  duelRecord: { fontWeight: '800', fontVariant: ['tabular-nums'] },
  duelSub: { marginTop: 2, letterSpacing: 0.3 },

  privateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 16,
  },
  privateText: { flex: 1, lineHeight: 18 },

  section: { gap: 8 },
  sectionTitle: { fontWeight: '700', letterSpacing: 0.6 },
  emptySub: {},
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  ratingChip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 11, paddingVertical: 6 },
  ratingChipText: { fontWeight: '700' },

  coinGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  coinCard: {
    width: '31%', borderRadius: 12, borderWidth: 1, padding: 10, gap: 6, alignItems: 'center', minHeight: 74, justifyContent: 'center',
  },
  coinName: { fontWeight: '600', textAlign: 'center' },
})
