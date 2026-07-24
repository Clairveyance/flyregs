import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Platform } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { PlainTextBody } from '@/components/PlainTextBody'

interface AirworthinessDirective {
  ad_number: string
  document_number: string
  subject_heading: string
  subject: string | null
  make: string | null
  model: string | null
  product_type: string | null
  product_subtype: string | null
  status: string
  effective_date: string | null
  docket_number: string | null
  amendment_number: string | null
  superseded_ad: string | null
  affected_ad: string | null
  superseded_by: string | null
  affected_by: string | null
  summary: string | null
  applicability: string | null
  unsafe_condition: string | null
  body_text: string | null
  pdf_url: string | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

// Free tier previews the summary only — same spirit as FAR/AC's fixed-
// opening-slice preview cap, always shows something real, never the whole
// thing until Pro.
const FREE_PREVIEW_CHARS = 500

export default function AdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const { isPro } = useAuth()
  const fs = useFS()
  const [ad, setAd] = useState<AirworthinessDirective | null>(null)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      supabase
        .from('airworthiness_directives')
        .select(
          'ad_number, document_number, subject_heading, subject, make, model, product_type, product_subtype, status, effective_date, docket_number, amendment_number, superseded_ad, affected_ad, superseded_by, affected_by, summary, applicability, unsafe_condition, body_text, pdf_url',
        )
        .eq('ad_number', id)
        .single(),
      // Both directions — an AD's own text can cite an AC/FAR/AIM section,
      // and (this is the actual valuable direction per explicit request)
      // an AC/FAR page can show which ADs cite IT.
      supabase
        .from('document_citations')
        .select('cited_type, cited_id, label')
        .or(`and(cited_type.eq.ad,cited_id.eq.${id}),and(citing_type.eq.ad,citing_id.eq.${id})`),
    ]).then(([adRes, citRes]) => {
      if (!adRes.error && adRes.data) setAd(adRes.data as AirworthinessDirective)
      if (!citRes.error && citRes.data) setRelated(citRes.data as RelatedItem[])
      setLoading(false)
    })
  }, [id])

  const body = ad?.body_text ?? ''
  const displayBody = isPro ? body : body.slice(0, FREE_PREVIEW_CHARS)
  const isTruncated = !isPro && body.length > FREE_PREVIEW_CHARS

  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const farRefs = related.filter((r) => r.cited_type === 'far')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')

  // Each AD is its own short (2-10 page), complete government PDF — unlike
  // AC/AIM's giant multi-hundred-page combined documents, there's no "which
  // page" ambiguity to solve with server-side rendering/cropping. Reuses
  // the same gated in-app viewer AC's own pdf_url_faa fallback already
  // uses (see ac/[id].tsx's openPDF) rather than a raw external link — same
  // BB-005 reasoning: never let the app hand a bare PDF URL to a share
  // sheet where it could leak to someone who never had the app at all.
  const openPDF = () => {
    if (!isPro) {
      router.push('/paywall')
      return
    }
    if (!ad?.pdf_url) return
    if (Platform.OS === 'web') {
      window.open(ad.pdf_url, '_blank')
      return
    }
    router.push({ pathname: '/pdf-viewer', params: { url: ad.pdf_url, title: `AD ${ad.ad_number}` } })
  }

  const openRelatedAd = (adNumber: string) => {
    router.push(`/ad/${adNumber.trim()}` as any)
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Airworthiness Directive" onBack={() => router.back()} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !ad ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>AD not found.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.headerRow}>
            <Text style={[styles.adNum, { color: tokens.blu, fontSize: fs(17) }]}>AD {ad.ad_number}</Text>
            <View
              style={[
                styles.statusPill,
                { backgroundColor: ad.status === 'Current' ? tokens.grn + '22' : tokens.t3 + '22' },
              ]}
            >
              <Text style={[styles.statusText, { color: ad.status === 'Current' ? tokens.grn : tokens.t3, fontSize: fs(11) }]}>
                {ad.status}
              </Text>
            </View>
          </View>
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{ad.subject_heading}</Text>

          <View style={[styles.infoCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            {ad.make && <InfoRow tokens={tokens} fs={fs} label="Make" value={ad.make} />}
            {ad.model && <InfoRow tokens={tokens} fs={fs} label="Model" value={ad.model} />}
            {ad.subject && <InfoRow tokens={tokens} fs={fs} label="Subject" value={ad.subject} />}
            {ad.effective_date && <InfoRow tokens={tokens} fs={fs} label="Effective" value={ad.effective_date} />}
            {ad.docket_number && <InfoRow tokens={tokens} fs={fs} label="Docket" value={ad.docket_number} />}
            {ad.amendment_number && <InfoRow tokens={tokens} fs={fs} label="Amendment" value={ad.amendment_number} />}
          </View>

          {(ad.superseded_ad || ad.affected_by) && (
            <View style={[styles.infoCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              {ad.superseded_ad && (
                <Pressable onPress={() => openRelatedAd(ad.superseded_ad!)}>
                  <InfoRow tokens={tokens} fs={fs} label="Supersedes" value={`AD ${ad.superseded_ad}`} linkColor={tokens.blu} />
                </Pressable>
              )}
              {ad.affected_by && (
                <Pressable onPress={() => openRelatedAd(ad.affected_by!)}>
                  <InfoRow tokens={tokens} fs={fs} label="Superseded by" value={`AD ${ad.affected_by}`} linkColor={tokens.blu} />
                </Pressable>
              )}
            </View>
          )}

          <View style={[styles.barsWrap]}>
            <RelatedBar tokens={tokens} fs={fs} icon="doc.text" label="Related ACs" count={acRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="doc.plaintext" label="FAR references" count={farRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="list.bullet" label="AIM references" count={aimRefs.length} />
            <RelatedBar tokens={tokens} fs={fs} icon="questionmark.circle" label="P/CG terms" count={pcgRefs.length} />
          </View>

          {ad.pdf_url && (
            <Pressable style={[styles.pdfButton, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]} onPress={openPDF}>
              <Icon name="doc.text" size={16} color={tokens.blu} />
              <Text style={[styles.pdfButtonText, { color: tokens.blu, fontSize: fs(13.5) }]}>View Original AD (PDF)</Text>
            </Pressable>
          )}

          {ad.summary && (
            <>
              <Text style={[styles.sectionLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>SUMMARY</Text>
              <Text style={[styles.summary, { color: tokens.t2, fontSize: fs(14.5) }]}>{ad.summary}</Text>
            </>
          )}

          {displayBody ? (
            <PlainTextBody text={displayBody} />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No further text available for this AD.</Text>
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

function InfoRow({
  tokens, fs, label, value, linkColor,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: ReturnType<typeof useFS>
  label: string
  value: string
  linkColor?: string
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.infoLabel, { color: tokens.t3, fontSize: fs(12.5) }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: linkColor ?? tokens.t1, fontSize: fs(13.5) }]} numberOfLines={2}>
        {value}
      </Text>
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
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  adNum: { fontWeight: '700' },
  statusPill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  title: { fontWeight: '600', marginTop: 4, marginBottom: 14, lineHeight: 23 },
  infoCard: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 12, gap: 8 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  infoLabel: { fontWeight: '500' },
  infoValue: { flex: 1, textAlign: 'right', fontWeight: '500' },
  barsWrap: { gap: 6, marginBottom: 16 },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  barLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { fontSize: 13 },
  barCount: { fontSize: 12.5 },
  pdfButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginBottom: 18,
  },
  pdfButtonText: { fontWeight: '600' },
  sectionLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  summary: { lineHeight: 21, marginBottom: 18 },
  body: { fontSize: 14.5, lineHeight: 22 },
  unlock: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 13, marginTop: 18,
  },
  unlockText: { fontSize: 13.5, fontWeight: '600' },
})
