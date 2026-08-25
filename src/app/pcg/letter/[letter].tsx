import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'

interface PcgTermRow {
  term: string
  slug: string
  definition: string | null
}

// pcg_terms is public-read content (RLS: "pcg_terms public SELECT" policy,
// see sync/migrations_pcg_terms_grants.sql) -- identical for every viewer,
// no tier gate anywhere on this screen, so a bare per-letter cache key is
// correct (unlike dictionary/letter/[letter].tsx's own gated `senses`
// field). Same cache-first shape as Home's own `load` (HOME_CACHE_KEY).
const PCG_LETTER_CACHE_KEY_PREFIX = '@flyregs/pcg-letter-cache:'

export default function PcgLetterScreen() {
  const { letter } = useLocalSearchParams<{ letter: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [terms, setTerms] = useState<PcgTermRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!letter) return
    try {
      const cached = await AsyncStorage.getItem(PCG_LETTER_CACHE_KEY_PREFIX + letter)
      if (cached) {
        setTerms(JSON.parse(cached) as PcgTermRow[])
        setLoading(false)
      }
    } catch (_) {}

    try {
      const { data } = await supabase.from('pcg_terms').select('term, slug, definition').eq('letter', letter).order('term')
      if (data) {
        setTerms(data as PcgTermRow[])
        AsyncStorage.setItem(PCG_LETTER_CACHE_KEY_PREFIX + letter, JSON.stringify(data)).catch(() => {})
      }
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [letter])

  useEffect(() => { load() }, [load])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`P/CG — ${letter}`} onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
        <FlatList
          data={terms}
          keyExtractor={(item) => item.slug}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              {terms.length} TERM{terms.length !== 1 ? 'S' : ''}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push(`/pcg/${item.slug}` as any)}
            >
              <Text style={[styles.term, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.term}</Text>
              {item.definition ? (
                <Text style={[styles.def, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]} numberOfLines={2}>
                  {item.definition}
                </Text>
              ) : null}
            </Pressable>
          )}
        />
        </TabletContainer>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6, gap: 3,
  },
  term: { fontWeight: '600' },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  def: {},
})
