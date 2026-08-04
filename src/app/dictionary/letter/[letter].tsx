import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { DictionarySearchBar } from '@/components/DictionarySearchBar'
import { Icon } from '@/components/Icon'

interface DictTermRow {
  term: string
  slug: string
  category: string
  // null for a mnemonic entry when the viewer isn't Plus -- the _gated view
  // redacts senses server-side (see gotcha_tier_gate_client_side_only.md).
  // This unfiltered browse-by-letter list mixes every category, unlike
  // dictionary/index.tsx's dedicated (already-safe) mnemonic list.
  senses: { definition: string; usage: string | null }[] | null
}

export default function DictionaryLetterScreen() {
  const { letter } = useLocalSearchParams<{ letter: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [terms, setTerms] = useState<DictTermRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!letter) return
    supabase.from('dictionary_terms_gated').select('term, slug, category, senses').eq('letter', letter).order('term')
      .then(({ data }) => {
        if (data) setTerms(data as DictTermRow[])
        setLoading(false)
      })
  }, [letter])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={`Aviation Dictionary — ${letter}`} onBack={() => router.back()} />
      <DictionarySearchBar />
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
                onPress={() => router.push(`/dictionary/${item.slug}` as any)}
              >
                <Text style={[styles.term, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.term}</Text>
                {/* senses is null for a mnemonic entry when not Plus -- the
                    _gated view redacts it server-side. Same lock/gold
                    "unlock with Plus" treatment as dictionary/index.tsx's
                    Mnemonics card, sized for a dense list row. */}
                {item.senses ? (
                  <Text style={[styles.def, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    {item.senses[0]?.definition}
                    {item.senses.length > 1 ? ` (+${item.senses.length - 1} more)` : ''}
                  </Text>
                ) : (
                  <View style={styles.lockedRow}>
                    <Icon name="lock.fill" size={fs(11)} color={tokens.gold} />
                    <Text style={[styles.def, { color: tokens.gold, fontSize: fs(12.5) }]}>Mnemonic — unlock with Plus</Text>
                  </View>
                )}
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
  lockedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
})
