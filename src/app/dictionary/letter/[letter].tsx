import { useEffect, useState } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
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
  const { hasPlusAccess } = useAuth()
  const fs = useFS()
  const [terms, setTerms] = useState<DictTermRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!letter || !hasPlusAccess) { setLoading(false); return }
    // hasPlusAccess resolves asynchronously after mount (AuthContext's
    // isPro/isPremium/isUnlocked all start false) -- without this, the guard
    // above already set loading false on the first (hasPlusAccess=false)
    // run, so the re-fire once access resolves true would skip the spinner
    // and show an empty list for the length of the real fetch below. Same
    // gap found+fixed in ref-packets/multi-engine.tsx and task/[taskId].tsx
    // this session -- ref-packets/[code].tsx's identical effect already has
    // this line.
    setLoading(true)
    supabase.from('dictionary_terms_gated').select('term, slug, category, senses').eq('letter', letter).order('term')
      .then(({ data }) => {
        if (data) setTerms(data as DictTermRow[])
        setLoading(false)
      })
  }, [letter, hasPlusAccess])

  // RC, 2026-08-10: "Plus gets the A/D, not the Mnemonics." Same
  // whole-screen lock as dictionary/index.tsx.
  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title={`Aviation Dictionary — ${letter}`} onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.lockTitle, { color: tokens.t2, fontSize: fs(16) }]}>The Aviation Dictionary is a Plus feature</Text>
          <Pressable style={[styles.lockBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus' as any)}>
            <Text style={[styles.lockBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

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
                {/* senses is null for a mnemonic entry when not Pro -- the
                    _gated view redacts it server-side. Same lock/gold
                    "unlock with Pro" treatment as dictionary/index.tsx's
                    Mnemonics card, sized for a dense list row. Everything
                    else on this (already Plus-gated) screen always has
                    senses -- only mnemonic entries can still be null here. */}
                {item.senses ? (
                  <Text style={[styles.def, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    {item.senses[0]?.definition}
                    {item.senses.length > 1 ? ` (+${item.senses.length - 1} more)` : ''}
                  </Text>
                ) : (
                  <View style={styles.lockedRow}>
                    <Icon name="lock.fill" size={fs(11)} color={tokens.gold} />
                    <Text style={[styles.def, { color: tokens.gold, fontSize: fs(12.5) }]}>Mnemonic — unlock with Pro</Text>
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
  lockTitle: { fontWeight: '600', marginTop: 6, marginBottom: 14, textAlign: 'center', maxWidth: 280 },
  lockBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11 },
  lockBtnText: { color: '#fff', fontWeight: '700' },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  row: {
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6, gap: 3,
  },
  term: { fontWeight: '600' },
  def: { lineHeight: 17 },
  lockedRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
})
