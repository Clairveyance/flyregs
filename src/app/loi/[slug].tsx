import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share, Alert } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { printReg } from '@/lib/printReg'
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
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'

// LOI detail screen. Per the expansion plan's explicit priority reframe:
// citation-driven discovery from a FAR page (the Related LOIs MagicLink
// bar, far/[id].tsx) is the actual payoff here, not a polished standalone
// browse experience -- this screen exists so that tapping through from
// there lands somewhere real, and so a direct search hit (loi/index.tsx)
// has somewhere to open. No Prev/Next footer (unlike far/[id].tsx) --
// LOIs have no natural ordering the way FAR sections or AIM paragraphs do.

interface LegalInterpretation {
  slug: string
  title: string
  addressee: string | null
  year: number | null
  issued_date: string | null
  source_url: string
  pdf_url_cached: string | null
  cfr_part_reference: string | null
  cfr_section_reference: string | null
  summary: string | null
  body_text: string | null
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}


// LOI titles arrive as file-style slugs ("Collins_2011_Legal_Interpretation").
// Rendering that raw reads like a bug in a premium app. Every LOI carries
// the same "_Legal_Interpretation" boilerplate, so drop it and space the
// separators: "Collins 2011".
function humanizeLoiTitle(t: string): string {
  return t
    .replace(/[_-]?legal[_-]interpretation$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}

export default function LoiDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, hasProAccess, isPremium } = useAuth()
  const [loi, setLoi] = useState<LegalInterpretation | null>(null)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [backTo, setBackTo] = useState<string | null>(null)
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [slug])

  useEffect(() => {
    if (slug) isBookmarked(slug).then(setBookmarked)
    if (slug) isDownloaded(slug).then(setDownloaded)
  }, [slug])

  useEffect(() => {
    if (!slug) return
    setLoading(true)
    Promise.all([
      supabase
        .from('legal_interpretations')
        .select('slug, title, addressee, year, issued_date, source_url, pdf_url_cached, cfr_part_reference, cfr_section_reference, summary, body_text')
        .eq('slug', slug)
        .single(),
      // Same both-directions + normalize-to-"the other document" pattern
      // as ad/[id].tsx and far/[id].tsx -- an LOI only ever CITES OUT to
      // FAR sections today (see loi_citation_extract.py), but the query
      // stays symmetric so a future inbound citation type just works.
      supabase
        .from('document_citations')
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.loi,cited_id.eq.${slug}),and(citing_type.eq.loi,citing_id.eq.${slug})`),
    ]).then(async ([loiRes, citRes]) => {
      if (!loiRes.error && loiRes.data) {
        const l = loiRes.data as LegalInterpretation
        setLoi(l)
        addRecent({
          id: l.slug,
          itemType: 'loi',
          document_number: l.title,
          title: l.summary ?? l.title,
          date_issued: l.issued_date,
          subject_series: null,
        })
      } else {
        // No network (or the row is gone): fall back to the offline copy.
        // This branch was MISSING -- handleDownload wrote an offline copy
        // that nothing ever read back, so a downloaded LOI still showed an
        // empty screen with no connection. Only AC had a cache-read path.
        const cached = await findDownload(slug)
        if (cached) {
          setLoi({
            slug: cached.id,
            title: cached.document_number,
            body_text: cached.body_text ?? null,
          } as LegalInterpretation)
        }
      }
      if (!citRes.error && citRes.data) {
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'loi' && r.citing_id === slug
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'loi' && r.cited_id === slug))
        setRelated(other)
      }
      setLoading(false)
    })
  }, [slug])

  const body = loi?.body_text ?? ''
  const currentLabel = loi ? humanizeLoiTitle(loi.title) : undefined
  const farRefs = related.filter((r) => r.cited_type === 'far')

  const handleToggleBookmark = async () => {
    if (!loi) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev)
    const next = await toggleBookmark({
      id: loi.slug,
      itemType: 'loi',
      document_number: loi.title,
      title: loi.summary ?? loi.title,
      date_issued: loi.issued_date,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const handleOpenFolderPicker = () => {
    if (!loi) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise -- until now the app had no print at all, only the share
  // sheet (which exports a LINK, not the text).
  const handlePrint = async () => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!loi) return
    try {
      await printReg({
        documentNumber: humanizeLoiTitle(loi.title),
        title: loi.summary,
        body: loi.body_text ?? '',
        kindLabel: 'LOI',
      })
    } catch {
      Alert.alert('Print failed', "Couldn't open the print dialog. Try again in a moment.")
    }
  }

  const handleShare = async () => {
    // Share/export is a PLUS feature (paywall PLUS_FEATURES), not Premium.
    // Gating it on isPremium bounced a Plus buyer to a Premium upsell for
    // something they had already paid for.
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!loi) return
    try {
      await Share.share({
        title: loi.title,
        message: buildRegShareLink('loi', loi.slug, loi.title, loi.summary ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  // Same simple text-only offline copy as AD -- see downloads.ts's
  // DownloadedItemType comment.
  const handleDownload = async () => {
    if (!loi) return
    if (!isPremium && !downloaded) { router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(loi.slug)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: loi.slug,
        type: 'loi',
        document_number: loi.slug,
        title: loi.title,
        subject_series: null,
        size: (loi.body_text ?? '').length,
        body_text: loi.body_text ?? null,
      })
      setDownloaded(true)
    } catch (err) {
      Alert.alert('Error', "Couldn't save this interpretation for offline reading. Try again in a moment.")
    }
    setDownloadBusy(false)
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })} hitSlop={12} style={{ padding: 4 }}>
          <Icon name="arrow.up.circle" size={21} color={tokens.t3} />
        </Pressable>
      )}
      <Pressable onPress={handlePrint} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="printer" size={21} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleShare} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="square.and.arrow.up" size={21} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleOpenFolderPicker} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="folder.badge.plus" size={21} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon name={bookmarked ? 'bookmark.fill' : 'bookmark'} size={21} color={bookmarked ? tokens.blu : tokens.t2} />
      </Pressable>
    </View>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Legal Interpretation" onBack={() => router.back()} right={headerRight} />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && loi && (
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
      ) : !loi ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Interpretation not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={100}
        >
          <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{humanizeLoiTitle(loi.title)}</Text>

          {/* Unified with AC/AD's own meta-chip row -- was a bare text
              line for addressee/year plus a separate CFR-ref line, visually
              inconsistent with every other content type. See DetailMeta.tsx. */}
          <MetaChipRow>
            {loi.addressee && <MetaChip label="Addressee" value={loi.addressee} tokens={tokens} />}
            {loi.year && <MetaChip label="Year" value={String(loi.year)} tokens={tokens} />}
            {loi.cfr_part_reference && (
              <MetaChip
                label="CFR"
                value={loi.cfr_section_reference ? `${loi.cfr_part_reference} — ${loi.cfr_section_reference}` : loi.cfr_part_reference}
                tokens={tokens}
              />
            )}
          </MetaChipRow>

          {loi.summary && (
            <DetailSection title="Summary" tokens={tokens}>
              <Text style={[styles.summary, { color: tokens.t2, fontSize: fs(14.5) }]}>{loi.summary}</Text>
            </DetailSection>
          )}

          {/* Unified position/style with AC/AD: Open PDF + Download,
              same weight, same place, right before MagicLink. */}
          {loi.pdf_url_cached && (
            <DetailActionRow
              onOpenPdf={() => router.push({ pathname: '/pdf-viewer', params: { url: loi.pdf_url_cached!, title: loi.title } } as any)}
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          )}

          <View style={[styles.barsWrap, { marginTop: 14 }]}>
            <MagicLinkPod
              bars={[{ icon: 'list.bullet', label: 'FAR references', items: farRefs }]}
              currentLabel={currentLabel}
              hasProAccess={hasProAccess}
            />
          </View>

          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              currentLabel={currentLabel}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
            />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this interpretation.</Text>
          )}
        </ScrollView>
        </TabletContainer>
      )}

      <FolderPicker
        visible={folderPickerVisible}
        itemType="loi"
        itemId={loi?.slug ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={loi ? {
          document_number: loi.title,
          title: loi.summary ?? loi.title,
          date_issued: loi.issued_date,
          office: null,
          subject_series: null,
        } : undefined}
      />
      <ConfirmCheck trigger={confirmTick} label={confirmLabel} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: {},
  content: { padding: 16, paddingBottom: 48 },
  meta: { marginBottom: 4, textTransform: 'capitalize' },
  title: { fontWeight: '700', lineHeight: 24, marginBottom: 4, textTransform: 'capitalize' },
  cfrRef: { marginBottom: 4 },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  pdfButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, marginBottom: 16,
  },
  pdfButtonText: { fontWeight: '600' },
  section: { marginBottom: 18 },
  sectionLabel: { fontWeight: '600', letterSpacing: 0.6, marginBottom: 8 },
  summary: { lineHeight: 21 },
  body: { lineHeight: 22 },
})
