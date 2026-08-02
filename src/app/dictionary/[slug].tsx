import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { TabletContainer } from '@/components/TabletContainer'
import { Icon } from '@/components/Icon'
import { FolderPicker } from '@/components/FolderPicker'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'

interface Sense {
  definition: string
  usage: string | null
}

interface DictTerm {
  term: string
  senses: Sense[]
  source: string
  category: string
  pcg_term_id: string | null
  pcg_terms: { slug: string; term: string } | null
}

// FAA's own 3-5 char category code (JO 7340.2 §1-2-3) shown as a plain-
// English chip -- the raw code alone ("NWS", "ICAO") means nothing to a
// student pilot who hasn't read the source order.
const USAGE_LABELS: Record<string, string> = {
  GEN: 'General aeronautical usage',
  NWS: 'Weather (National Weather Service)',
  ATC: 'Air Traffic Control usage',
  ICAO: 'ICAO / international usage',
  METAR: 'METAR weather-report usage',
  'METAR/TAF': 'METAR/TAF weather-report usage',
  TAF: 'TAF weather-report usage',
}

export default function DictionaryTermScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [entry, setEntry] = useState<DictTerm | null>(null)
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)

  useEffect(() => {
    if (!slug) return
    supabase.from('dictionary_terms').select('term, senses, source, category, pcg_term_id, pcg_terms(slug, term)').eq('slug', slug).single()
      .then(({ data }) => {
        // pcg_terms comes back as a plain object for this to-one relation
        // (dictionary_terms.pcg_term_id -> pcg_terms.id is a single FK), but
        // supabase-js's generic .select() typing can't infer that without
        // generated schema types -- same `any` cast already used for this
        // exact shape in adNotifications.ts's airworthiness_directives embed.
        if (data) setEntry(data as any as DictTerm)
        setLoading(false)
      })
    // Bookmark/Recents feature parity pass (2026-08-02) -- RC's audit found
    // A/D was the only content type with none of bookmarking/folders/Recents
    // wired in (FAR/AIM/P-CG/AC/AD/LOI all have it). Mirrors pcg/[id].tsx's
    // exact pattern, including keying both bookmark-check and Recents off
    // the route param slug directly (P/CG's own comment there: "an
    // un-normalized route param would check the wrong id" doesn't apply
    // here since dictionary slugs don't need normalization the way P/CG's
    // did, but keeping the same slug-as-id convention for consistency).
    isBookmarked(slug).then(setBookmarked)
  }, [slug])

  useEffect(() => {
    if (!entry || !slug) return
    addRecent({
      id: slug,
      itemType: 'dictionary',
      document_number: entry.term,
      title: entry.term,
      date_issued: null,
      subject_series: null,
    })
  }, [entry, slug])

  const handleToggleBookmark = async () => {
    if (!entry || !slug) return
    if (!hasPlusAccess) { router.push('/paywall' as any); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: slug,
      itemType: 'dictionary',
      document_number: entry.term,
      title: entry.term,
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const handleOpenFolderPicker = () => {
    if (!entry) return
    if (!hasPlusAccess) { router.push('/paywall' as any); return }
    setFolderPickerVisible(true)
  }

  const headerRight = entry ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Pressable onPress={handleOpenFolderPicker} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="folder.badge.plus" size={21} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon
          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
          size={21}
          color={bookmarked ? tokens.blu : tokens.t2}
        />
      </Pressable>
    </View>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} right={headerRight} />
      {slug && (
        <FolderPicker
          visible={folderPickerVisible}
          itemType="dictionary"
          itemId={slug}
          onClose={() => setFolderPickerVisible(false)}
          onAdded={() => setFolderPickerVisible(false)}
          acMeta={entry ? { document_number: entry.term, title: entry.term, date_issued: null, office: null, subject_series: null } : undefined}
        />
      )}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !entry ? (
        <View style={styles.center}>
          <Text style={{ color: tokens.t3, fontSize: fs(14) }}>Term not found.</Text>
        </View>
      ) : (
        <TabletContainer>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={[styles.term, { color: tokens.t1, fontSize: fs(24) }]}>{entry.term}</Text>

            {entry.senses.map((s, i) => (
              <View key={i} style={[styles.senseCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {entry.senses.length > 1 && (
                  <Text style={[styles.senseNum, { color: tokens.t4, fontSize: fs(11) }]}>SENSE {i + 1}</Text>
                )}
                <Text style={[styles.definition, { color: tokens.t1, fontSize: fs(16) }]}>{s.definition}</Text>
                {s.usage && (
                  <View style={[styles.usagePill, { backgroundColor: tokens.bdim }]}>
                    <Text style={[styles.usageText, { color: tokens.blu, fontSize: fs(11.5) }]}>
                      {USAGE_LABELS[s.usage] ?? s.usage}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            {entry.pcg_terms && (
              // Cross-link to the formal ATC-phraseology definition when this
              // same headword also exists in the Pilot/Controller Glossary --
              // the two are deliberately separate tables (see
              // migrations_dictionary_terms.sql), so this is the one place
              // they connect for a reader who wants the more authoritative
              // radio-phraseology wording alongside this entry's own source.
              <Pressable
                style={[styles.pcgLinkCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/pcg/${entry.pcg_terms!.slug}` as any)}
              >
                <Icon name="headset" size={16} color={tokens.blu} />
                <Text style={[styles.pcgLinkText, { color: tokens.blu, fontSize: fs(13.5) }]}>
                  Also in the Pilot/Controller Glossary
                </Text>
                <Icon name="chevron.right" size={14} color={tokens.t4} />
              </Pressable>
            )}

            <Text style={[styles.sourceLine, { color: tokens.t4, fontSize: fs(11.5) }]}>Source: {entry.source}</Text>
          </ScrollView>
        </TabletContainer>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  term: { fontWeight: '700', marginBottom: 16 },
  senseCard: { borderRadius: 14, borderWidth: 1, padding: 16, marginBottom: 10, gap: 8 },
  senseNum: { fontWeight: '700', letterSpacing: 0.6 },
  definition: { lineHeight: 23 },
  usagePill: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  usageText: { fontWeight: '600' },
  pcgLinkCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginTop: 4,
  },
  pcgLinkText: { flex: 1, fontWeight: '600' },
  sourceLine: { marginTop: 8, paddingHorizontal: 2 },
})
