import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
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

export default function PcgLetterScreen() {
  const { letter } = useLocalSearchParams<{ letter: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [terms, setTerms] = useState<PcgTermRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!letter) return
    supabase.from('pcg_terms').select('term, slug, definition').eq('letter', letter).order('term')
      .then(({ data }) => {
        if (data) setTerms(data as PcgTermRow[])
        setLoading(false)
      })
  }, [letter])

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
                <Text style={[styles.def, { color: tokens.t3, fontSize: fs(12.5) }]} numberOfLines={2}>
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
  def: { lineHeight: 17 },
})
