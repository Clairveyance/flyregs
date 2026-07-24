import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { PlainTextBody } from '@/components/PlainTextBody'

interface FarSection {
  section_number: string
  part: string
  subpart_letter: string | null
  subpart_title: string | null
  title: string | null
  body_text: string | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

// Free tier previews a fixed opening slice of the section, same spirit as
// the AC preview cap (previewBlockCount in ac/[id].tsx) — always shows
// something real, never the whole thing.
const FREE_PREVIEW_CHARS = 500

export default function FarSectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const { isPro } = useAuth()
  const fs = useFS()
  const [section, setSection] = useState<FarSection | null>(null)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase
        .from('far_sections')
        .select('section_number, part, subpart_letter, subpart_title, title, body_text')
        .eq('section_number', id)
        .single(),
      // Both directions — a FAR section can be cited BY an AIM/PCG entry,
      // and (once FAR-side citation extraction exists) could cite outward
      // too. Association bars always show, "0" when empty — see the
      // expansion plan's locked-in empty-state decision.
      supabase
        .from('document_citations')
        .select('cited_type, cited_id, label')
        .or(`and(cited_type.eq.far,cited_id.eq.${id}),and(citing_type.eq.far,citing_id.eq.${id})`),
    ]).then(([secRes, citRes]) => {
      if (!secRes.error && secRes.data) setSection(secRes.data as FarSection)
      if (!citRes.error && citRes.data) setRelated(citRes.data as RelatedItem[])
      setLoading(false)
    })
  }, [id])

  const body = section?.body_text ?? ''
  const displayBody = isPro ? body : body.slice(0, FREE_PREVIEW_CHARS)
  const isTruncated = !isPro && body.length > FREE_PREVIEW_CHARS

  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      {/* Same fix as AIM's header — "Part 91" alone doesn't say WHICH
          regulation you're in once the app spans multiple sources. */}
      <OverlayHeader title={`FAR — Part ${section?.part ?? id?.split('.')[0] ?? ''}`} onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !section ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Section not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {section.subpart_title && (
            <Text style={[styles.subpart, { color: tokens.t3, fontSize: fs(12) }]}>{section.subpart_title}</Text>
          )}
          <Text style={[styles.secNum, { color: tokens.blu, fontSize: fs(15) }]}>§ {section.section_number}</Text>
          {section.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{section.title}</Text>
          )}

          <View style={[styles.barsWrap]}>
            <RelatedBar tokens={tokens} fs={fs} icon="doc.text" label="Related ACs" count={acRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="list.bullet" label="AIM references" count={aimRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="questionmark.circle" label="P/CG terms" count={pcgRefs.length} />
          </View>

          {displayBody ? (
            <PlainTextBody text={displayBody} />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this section.</Text>
          )}

          {isTruncated && (
            <Pressable style={[styles.unlock, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={() => router.push('/paywall')}>
              <Icon name="lock.fill" size={14} color={tokens.blu} />
              <Text style={[styles.unlockText, { color: tokens.blu, fontSize: fs(13.5) }]}>Unlock full text with Pro</Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </View>
  )
}

function RelatedBar({
  tokens, fs, icon, label, count,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: ReturnType<typeof useFS>
  icon: string
  label: string
  count: number
}) {
  return (
    <View style={[styles.bar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <View style={styles.barLeft}>
        <Icon name={icon} size={15} color={tokens.t3} />
        <Text style={[styles.barLabel, { color: tokens.t1, fontSize: fs(13) }]}>{label}</Text>
      </View>
      <Text style={[styles.barCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{count}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  subpart: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  secNum: { fontWeight: '600', fontSize: 15 },
  title: { fontWeight: '600', fontSize: 17, marginTop: 2, marginBottom: 14, lineHeight: 23 },
  barsWrap: { gap: 6, marginBottom: 16 },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  barLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { fontSize: 13 },
  barCount: { fontSize: 12.5 },
  body: { fontSize: 14.5, lineHeight: 22 },
  unlock: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 13, marginTop: 18,
  },
  unlockText: { fontSize: 13.5, fontWeight: '600' },
})
