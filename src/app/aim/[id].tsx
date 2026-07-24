import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Image } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { FigureViewer } from '@/components/FigureViewer'
import { PlainTextBody } from '@/components/PlainTextBody'
import type { AcFigure } from '@/types'

interface AimParagraph {
  paragraph_number: string
  chapter: string
  section_title: string | null
  title: string | null
  body_text: string | null
  reference_text: string | null
}

interface AimFigureRow {
  id: string
  label: string | null
  caption: string | null
  image_url: string
  sort_order: number
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

const FREE_PREVIEW_CHARS = 500

export default function AimParagraphScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const { isPro } = useAuth()
  const fs = useFS()
  const [para, setPara] = useState<AimParagraph | null>(null)
  const [figures, setFigures] = useState<AimFigureRow[]>([])
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase
        .from('aim_paragraphs')
        .select('paragraph_number, chapter, section_title, title, body_text, reference_text')
        .eq('paragraph_number', id)
        .single(),
      supabase
        .from('aim_figures')
        .select('id, label, caption, image_url, sort_order')
        .eq('paragraph_number', id)
        .order('sort_order'),
      supabase
        .from('document_citations')
        .select('cited_type, cited_id, label')
        .or(`and(cited_type.eq.aim,cited_id.eq.${id}),and(citing_type.eq.aim,citing_id.eq.${id})`),
    ]).then(([paraRes, figRes, citRes]) => {
      if (!paraRes.error && paraRes.data) setPara(paraRes.data as AimParagraph)
      if (!figRes.error && figRes.data) setFigures(figRes.data as AimFigureRow[])
      if (!citRes.error && citRes.data) setRelated(citRes.data as RelatedItem[])
      setLoading(false)
    })
  }, [id])

  const body = para?.body_text ?? ''
  const displayBody = isPro ? body : body.slice(0, FREE_PREVIEW_CHARS)
  const isTruncated = !isPro && body.length > FREE_PREVIEW_CHARS

  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        // Confirmed live: a bare "Chapter 4" header gives no indication
        // which document you're even in (AIM? FAR? something else?) once
        // the app spans multiple regulatory sources — every other
        // detail screen's header carries its own source prefix (P/CG's
        // says "Pilot/Controller Glossary" outright), this was the one
        // silent exception.
        title={para?.chapter?.startsWith('A') ? `AIM — Appendix ${para.chapter.slice(1)}` : `AIM — Chapter ${para?.chapter ?? ''}`}
        onBack={() => router.back()}
      />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !para ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Paragraph not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {para.section_title && (
            <Text style={[styles.section, { color: tokens.t3, fontSize: fs(12) }]}>{para.section_title}</Text>
          )}
          <Text style={[styles.paraNum, { color: tokens.blu, fontSize: fs(15) }]}>{para.paragraph_number}</Text>
          {para.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{para.title}</Text>
          )}

          <View style={styles.barsWrap}>
            <RelatedBar tokens={tokens} fs={fs} icon="photo" label="Figures & Tables" count={isPro ? figures.length : 0} />
            <RelatedBar tokens={tokens} fs={fs} icon="doc.text" label="Related ACs" count={acRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="list.bullet" label="FAR references" count={farRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="questionmark.circle" label="P/CG terms" count={pcgRefs.length} />
          </View>

          {displayBody ? (
            <PlainTextBody
              text={displayBody}
              figures={isPro ? figures : undefined}
              onOpenFigure={(f) => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
            />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this paragraph.</Text>
          )}

          {isTruncated && (
            <Pressable style={[styles.unlock, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={() => router.push('/paywall')}>
              <Icon name="lock.fill" size={14} color={tokens.blu} />
              <Text style={[styles.unlockText, { color: tokens.blu, fontSize: fs(13.5) }]}>Unlock full text with Pro</Text>
            </Pressable>
          )}

          {/* AIM's own "REFERENCE-" boxes — e.g. "REFERENCE- FAA Advisory
              Circular (AC) 90-66, Non-Towered Airport Flight Operations."
              These were being extracted into document_citations (feeding
              the bars' counts above) but never actually SHOWN anywhere —
              confirmed live as a real, significant gap: a paragraph could
              read "Related ACs: 1" with the referenced AC nowhere visible
              or tappable on the page. \n -> \n\n because reference_text
              joins its lines with a single newline (PlainTextBody splits
              paragraphs on a blank line). */}
          {isPro && para.reference_text && (
            <View style={styles.refsWrap}>
              <Text style={[styles.refsLabel, { color: tokens.t1, fontSize: fs(13) }]}>References</Text>
              <PlainTextBody text={para.reference_text.replace(/\n/g, '\n\n')} />
            </View>
          )}

          {isPro && figures.length > 0 && (
            <View style={styles.figuresWrap}>
              <Text style={[styles.figuresLabel, { color: tokens.t1, fontSize: fs(14) }]}>Figures & Tables</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.figScroll}>
                {figures.map((f) => (
                  <Pressable
                    key={f.id}
                    style={[styles.figCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    // FigureViewer/AcFigure predate multi-source figures and require a
                    // `page` field — AIM figures don't have one, so a harmless
                    // placeholder satisfies the shape without touching the AC-only
                    // type/component (see the expansion plan's migration-safety note:
                    // generalizing shared components is a deliberate later pass, not
                    // an incidental side effect of adding AIM).
                    onPress={() => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
                  >
                    <Image source={{ uri: f.image_url }} style={styles.figThumb} resizeMode="cover" />
                    <Text style={[styles.figLabel, { color: tokens.t1, fontSize: fs(11.5) }]} numberOfLines={1}>{f.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}
        </ScrollView>
      )}

      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
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
  section: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  paraNum: { fontWeight: '600', fontSize: 15 },
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
  refsWrap: { marginTop: 20 },
  refsLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  figuresWrap: { marginTop: 22 },
  figuresLabel: { fontWeight: '600', fontSize: 14, marginBottom: 10 },
  figScroll: { gap: 10 },
  figCard: { width: 130, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  figThumb: { width: '100%', height: 90 },
  figLabel: { fontSize: 11.5, padding: 8 },
})
