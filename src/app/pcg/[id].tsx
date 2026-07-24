import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { slugifyPcgTerm } from '@/lib/pcg'

interface PcgTerm {
  slug: string
  term: string
  definition: string | null
  frequently_used: boolean
  see_refs: string[]
  external_refs: { label: string; url: string }[]
}

// P/CG entries are free to read in full, same as browsing/searching any
// content type — the gating boundary is on ACs/FARs/AIM's full body text,
// not the glossary itself, which is short by nature and part of what makes
// search results useful even for a free-tier user deciding whether to
// subscribe.
export default function PcgTermScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [term, setTerm] = useState<PcgTerm | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    supabase
      .from('pcg_terms')
      .select('slug, term, definition, frequently_used, see_refs, external_refs')
      .eq('slug', id)
      .single()
      .then(async ({ data, error }) => {
        if (!error && data) { setTerm(data as PcgTerm); setLoading(false); return }
        // Inline cross-reference links (LinkedBody, see crossRefLinks.ts)
        // only have the raw term TEXT from body prose to work with — e.g.
        // "Pilot/Controller Glossary Term- Light Gun" — not the real slug
        // ("LIGHT_GUN"). Normalize with the same convention see_refs links
        // below already use and retry once before giving up.
        const normalized = slugifyPcgTerm(id)
        if (normalized !== id) {
          const retry = await supabase
            .from('pcg_terms')
            .select('slug, term, definition, frequently_used, see_refs, external_refs')
            .eq('slug', normalized)
            .single()
          if (!retry.error && retry.data) { setTerm(retry.data as PcgTerm); setLoading(false); return }
        }
        setLoading(false)
      })
  }, [id])

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Pilot/Controller Glossary" onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !term ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Term not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={[styles.term, { color: tokens.t1, fontSize: fs(19) }]}>{term.term}</Text>
          {term.frequently_used && (
            <View style={[styles.freqPill, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Text style={[styles.freqText, { color: tokens.t3, fontSize: fs(11) }]}>Frequently used</Text>
            </View>
          )}

          <Text style={[styles.def, { color: tokens.t2, fontSize: fs(15) }]}>
            {term.definition || 'See related term below — no standalone definition.'}
          </Text>

          {term.see_refs.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: tokens.t1, fontSize: fs(13) }]}>See also</Text>
              {term.see_refs.map((ref) => (
                <Pressable
                  key={ref}
                  style={[styles.seeRow, { borderBottomColor: tokens.bdr }]}
                  onPress={() => router.push(`/pcg/${slugifyPcgTerm(ref)}`)}
                >
                  <Text style={[styles.seeText, { color: tokens.blu, fontSize: fs(13.5) }]}>{ref}</Text>
                  <Icon name="chevron.right" size={13} color={tokens.t4} />
                </Pressable>
              ))}
            </View>
          )}

          {term.external_refs.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionLabel, { color: tokens.t1, fontSize: fs(13) }]}>Referenced in</Text>
              {term.external_refs.map((ref, i) => (
                <View key={i} style={[styles.refRow, { borderBottomColor: tokens.bdr }]}>
                  <Text style={[styles.refText, { color: tokens.t2, fontSize: fs(13.5) }]}>{ref.label}</Text>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  term: { fontWeight: '700', fontSize: 19, marginBottom: 8 },
  freqPill: { alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 14 },
  freqText: { fontSize: 11, fontWeight: '600' },
  def: { fontSize: 15, lineHeight: 22 },
  section: { marginTop: 22 },
  sectionLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  seeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  seeText: { fontSize: 13.5, fontWeight: '500' },
  refRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  refText: { fontSize: 13.5 },
})
