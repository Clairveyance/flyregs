import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Platform, Share, Alert } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { MetaChip, MetaChipRow, DetailSection, DetailActionRow } from '@/components/DetailMeta'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { buildRegShareLink } from '@/lib/regShare'
import { isDownloaded, addDownload, removeDownload } from '@/lib/downloads'

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

export default function AdScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, isPremium } = useAuth()
  const [ad, setAd] = useState<AirworthinessDirective | null>(null)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)
  const [backTo, setBackTo] = useState<string | null>(null)

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
    if (id) isDownloaded(id).then(setDownloaded)
  }, [id])

  // Confirmed a real gap: AD never read the pending breadcrumb at all,
  // unlike far/aim/pcg/ac/loi. Unlike AC, this route param IS already the
  // canonical id (no internal redirect step), so a plain [id]-keyed effect
  // is safe here -- no double-consume race to guard against.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

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
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.ad,cited_id.eq.${id}),and(citing_type.eq.ad,citing_id.eq.${id})`),
    ]).then(([adRes, citRes]) => {
      if (!adRes.error && adRes.data) {
        const a = adRes.data as AirworthinessDirective
        setAd(a)
        addRecent({
          id: a.ad_number,
          itemType: 'ad',
          document_number: a.ad_number,
          title: a.subject_heading,
          date_issued: a.effective_date,
          subject_series: null,
        })
      }
      if (!citRes.error && citRes.data) {
        // Normalize to "the OTHER document" regardless of which side of the
        // row this AD is on — same fix as aim/[id].tsx and far/[id].tsx: the
        // old query only ever read cited_type/cited_id, so an inbound row
        // (an AC/FAR citing THIS AD) displayed as if it pointed at itself.
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'ad' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'ad' && r.cited_id === id))
        setRelated(other)
      }
      setLoading(false)
    })
  }, [id])

  const body = ad?.body_text ?? ''

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
    if (!ad?.pdf_url) return
    if (Platform.OS === 'web') {
      window.open(ad.pdf_url, '_blank')
      return
    }
    router.push({ pathname: '/pdf-viewer', params: { url: ad.pdf_url, title: `AD ${ad.ad_number}` } })
  }

  // Simpler than AC's own handleDownload -- an AD is plain text with no
  // block-parsed structure or figure images to pre-cache, so this just
  // stores the already-loaded body text for offline reading. See
  // downloads.ts's DownloadedItemType comment for why AD/LOI don't need
  // AC's fuller pipeline.
  const handleDownload = async () => {
    if (!ad) return
    if (!isPremium && !downloaded) { router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(ad.ad_number)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: ad.ad_number,
        type: 'ad',
        document_number: ad.ad_number,
        title: ad.subject_heading,
        subject_series: null,
        size: (ad.body_text ?? '').length,
        body_text: ad.body_text ?? null,
      })
      setDownloaded(true)
    } catch (err) {
      Alert.alert('Error', "Couldn't save this AD for offline reading. Try again in a moment.")
    }
    setDownloadBusy(false)
  }

  const openRelatedAd = (adNumber: string) => {
    router.push(`/ad/${adNumber.trim()}` as any)
  }

  const handleToggleBookmark = async () => {
    if (!ad) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: ad.ad_number,
      itemType: 'ad',
      document_number: ad.ad_number,
      title: ad.subject_heading,
      date_issued: ad.effective_date,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const handleOpenFolderPicker = () => {
    if (!ad) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  const handleShare = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    if (!ad) return
    try {
      await Share.share({
        title: `AD ${ad.ad_number}`,
        message: buildRegShareLink('ad', ad.ad_number, `AD ${ad.ad_number}`, ad.subject_heading ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          hitSlop={12}
          style={{ padding: 4 }}
        >
          <Icon name="arrow.up.circle" size={21} color={tokens.t3} />
        </Pressable>
      )}
      <Pressable onPress={handleShare} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="square.and.arrow.up" size={21} color={isPremium ? tokens.t2 : tokens.t4} />
      </Pressable>
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
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Airworthiness Directive" onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && ad && (
        <InDocSearchBar
          query={inDocSearch.query}
          onQueryChange={inDocSearch.onQueryChange}
          onClear={inDocSearch.onClear}
          matchCount={inDocSearch.matchCount}
          matchIdx={inDocSearch.matchIdx}
          onPrev={inDocSearch.goToPrev}
          onNext={inDocSearch.goToNext}
        />
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !ad ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>
            AD not found. Older ADs may predate FlyRegs' current AD coverage — check the FAA's Dynamic Regulatory
            System for the complete historical record.
          </Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={100}
        >
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

          {/* Unified with AC/LOI's own meta-chip row -- was a vertical
              label:value card, visually and positionally inconsistent
              with every other content type. See DetailMeta.tsx. */}
          <MetaChipRow>
            {ad.make && <MetaChip label="Make" value={ad.make} tokens={tokens} />}
            {ad.model && <MetaChip label="Model" value={ad.model} tokens={tokens} />}
            {ad.effective_date && <MetaChip label="Effective" value={ad.effective_date} tokens={tokens} />}
            {ad.docket_number && <MetaChip label="Docket" value={ad.docket_number} tokens={tokens} />}
            {ad.amendment_number && <MetaChip label="Amendment" value={ad.amendment_number} tokens={tokens} />}
          </MetaChipRow>

          {(ad.superseded_ad || ad.affected_by) && (
            <View style={[styles.infoCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr, marginTop: 10 }]}>
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

          {ad.summary && (
            <DetailSection title="Summary" tokens={tokens}>
              <Text style={[styles.summary, { color: tokens.t2, fontSize: fs(14.5) }]}>{ad.summary}</Text>
            </DetailSection>
          )}

          {/* Unified position/style with AC/LOI: Open PDF + Download,
              same weight, same place, right before MagicLink. */}
          {ad.pdf_url && (
            <DetailActionRow
              onOpenPdf={openPDF}
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          )}

          <View style={[styles.barsWrap, { marginTop: 14 }]}>
            <MagicLinkPod
              bars={[
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'doc.plaintext', label: 'FAR references', items: farRefs },
                { icon: 'list.bullet', label: 'AIM references', items: aimRefs },
                { icon: 'questionmark.circle', label: 'P/CG terms', items: pcgRefs },
              ]}
              currentLabel={`AD ${ad.ad_number}`}
              hasPlusAccess={hasPlusAccess}
            />
          </View>

          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
            />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No further text available for this AD.</Text>
          )}
        </ScrollView>
        </TabletContainer>
      )}
      <FolderPicker
        visible={folderPickerVisible}
        itemType="ad"
        itemId={ad?.ad_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={ad ? {
          document_number: ad.ad_number,
          title: ad.subject_heading,
          date_issued: ad.effective_date,
          office: null,
          subject_series: null,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
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
  pdfButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginBottom: 18,
  },
  pdfButtonText: { fontWeight: '600' },
  sectionLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 },
  summary: { lineHeight: 21, marginBottom: 18 },
  body: { fontSize: 14.5, lineHeight: 22 },
})
