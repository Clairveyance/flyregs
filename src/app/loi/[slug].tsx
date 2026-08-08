import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
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
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
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
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'
import { useConfirm } from '@/components/ConfirmDialog'

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
  const { slug, hl } = useLocalSearchParams<{ slug: string; hl?: string }>()
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { hasProAccess, isPremium } = useAuth()
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
  const [scrollViewportHeight, setScrollViewportHeight] = useState<number | undefined>(undefined)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Same Study-bookmark passage seeding FAR/AIM/P-CG/AD do. LOI was missing
  // this on BOTH ends -- routeForBookmark's own loi branch returned a bare
  // `/loi/<slug>` with no hl at all, unlike every other non-AC type -- so both
  // halves are wired here and there. Latent like AD's (LOI isn't a study type
  // today), fixed together so all five PlainTextBody screens behave the same.
  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])

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
      // _gated view redacts body_text server-side for non-Pro tiers -- see
      // gotcha_tier_gate_client_side_only.md.
      supabase
        .from('legal_interpretations_gated')
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

  // LOI's own actions gate on hasProAccess, not the app-wide hasPlusAccess
  // every other content type's print/share/bookmark/folder uses -- since
  // the body text itself now requires Pro (see the body-render block
  // below), letting a Plus-only user bookmark/print/share/folder an
  // interpretation they can't even read would be incoherent.
  const handleToggleBookmark = async () => {
    if (!loi) return
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
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
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    setFolderPickerVisible(true)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise app-wide -- but see the hasProAccess comment above for why
  // LOI specifically is the one exception, gated at Pro instead.
  const handlePrint = async () => {
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    if (!loi) return
    try {
      await printReg({
        documentNumber: humanizeLoiTitle(loi.title),
        title: loi.summary,
        body: loi.body_text ?? '',
        kindLabel: 'LOI',
      })
    } catch (err) {
      // See ac/[id].tsx's handlePrint for the full reasoning -- expo-print
      // on iOS can reject AFTER the system print sheet already opened and
      // was used, so alerting the user that it "couldn't open" is often
      // just wrong by the time this fires. Log only, don't tell them
      // something untrue.
      Sentry.captureException(err)
    }
  }

  const handleShare = async () => {
    // Share/export is a PLUS feature app-wide (paywall PLUS_FEATURES), but
    // LOI is gated at Pro instead -- see the hasProAccess comment above.
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
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
      confirm({ title: 'Error', message: "Couldn't save this interpretation for offline reading. Try again in a moment.", cancelLabel: null })
    }
    setDownloadBusy(false)
  }

  const headerRight = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })} hitSlop={12} style={{ padding: 4 }}>
          <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
        </Pressable>
      )}
      <HeaderOverflowMenu
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasProAccess },
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasProAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasProAccess },
        ]}
      />
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon name={bookmarked ? 'bookmark.fill' : 'bookmark'} size={fs(21)} color={bookmarked ? tokens.blu : tokens.t2} />
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
          onLayout={(e) => setScrollViewportHeight(e.nativeEvent.layout.height)}
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
              {splitIntoDisplayParagraphs(loi.summary).map((para, i, arr) => (
                <Text
                  key={i}
                  style={[
                    styles.summary,
                    { color: tokens.t2, fontSize: fs(14.5) },
                    i < arr.length - 1 && { marginBottom: 10 },
                  ]}
                >
                  {para}
                </Text>
              ))}
            </DetailSection>
          )}

          {/* Unified position/style with AC/AD: Open PDF + Download,
              same weight, same place, right before MagicLink. */}
          {loi.pdf_url_cached && (
            <DetailActionRow
              // LOI full text is gated at Pro (task #138) -- same leak and
              // same fix as ad/[id].tsx's openPDF: the raw cached PDF has
              // the same legal text the Pro paywall below is guarding, and
              // every other action on this screen already checks
              // hasProAccess before this one did.
              onOpenPdf={() => {
                if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
                router.push({ pathname: '/pdf-viewer', params: { url: loi.pdf_url_cached!, title: loi.title } } as any)
              }}
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

          {/* Branch on hasProAccess FIRST, not on body's truthiness -- same
              reasoning and same fix as ad/[id].tsx's identical bug: body_text
              is redacted server-side for non-Pro tiers now (see
              gotcha_tier_gate_client_side_only.md), so body is ALWAYS falsy
              for a genuine non-Pro viewer post-fix. The old
              `body && hasProAccess` / `body && !hasProAccess` pair required
              body to be truthy for EITHER branch to fire, permanently
              hiding the pay-gate (every real LOI has body_text at the
              raw-table level -- confirmed 0/1055 null) behind the generic
              "No text available" fallback instead. */}
          {hasProAccess ? (
            body ? (
              <PlainTextBody
                ref={bodyRef}
                text={body}
                currentLabel={currentLabel}
                highlightQuery={inDocSearch.debounced}
                activeMatch={inDocSearch.matchIdx}
                onMatchCount={inDocSearch.setMatchCount}
                scrollRef={scrollRef}
                viewportHeight={scrollViewportHeight}
              />
            ) : (
              <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this interpretation.</Text>
            )
          ) : (
            // No partial preview -- same call as AD's, and for the same
            // reason: RC's "LOIs are a Pro feature" is the same flat,
            // no-preview-length-specified framing as AD's "not a Free
            // tier," not AC's explicit "preview 2 sections." (Also:
            // paragraph-count-based truncation was tried first and found
            // to not actually limit anything on 719 of 1,054 real LOIs --
            // most of this corpus has 0-2 blank-line breaks in the WHOLE
            // document, so "first 2 paragraphs" was often the entire
            // document. The Summary section above already tells a free
            // reader what this interpretation is about.)
            <Pressable
              style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
              onPress={() => router.push('/paywall?tier=pro')}
            >
              <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
              <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Read the full interpretation with Pro</Text>
              <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                The summary above tells you what this interpretation covers — unlock Pro to read the full text.
              </Text>
              <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Pro</Text>
              </View>
            </Pressable>
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
  proGate: {
    marginTop: 16,
    borderRadius: 16,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  proGateTitle: { fontWeight: '700', fontSize: 16, marginTop: 4 },
  proGateSub: { fontSize: 13.5, textAlign: 'center', lineHeight: 20, maxWidth: 260 },
  proGateBtn: {
    marginTop: 8,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  proGateBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
})
