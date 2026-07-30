import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Image, Share } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { FigureViewer } from '@/components/FigureViewer'
import { PlainTextBody, PlainTextBodyHandle } from '@/components/PlainTextBody'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { BackToBreadcrumb, PrevNextFooter } from '@/components/DocNavBar'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch } from '@/lib/useInDocSearch'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'
import { consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { buildRegShareLink } from '@/lib/regShare'
import type { AcFigure } from '@/types'

// Natural-sort AIM paragraph numbers ("4-3-2" before "4-10-1") for
// Prev/Next -- same comparator aim/chapter/[chapter].tsx already uses.
function compareParagraphNumbers(a: string, b: string): number {
  const ap = a.split('-').map(Number)
  const bp = b.split('-').map(Number)
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const av = ap[i] ?? 0
    const bv = bp[i] ?? 0
    if (!isNaN(av) && !isNaN(bv) && av !== bv) return av - bv
  }
  return a.localeCompare(b)
}

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

export default function AimParagraphScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, isPremium } = useAuth()
  const [para, setPara] = useState<AimParagraph | null>(null)
  const [figures, setFigures] = useState<AimFigureRow[]>([])
  const [figuresExpanded, setFiguresExpanded] = useState(false)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [loading, setLoading] = useState(true)
  const [viewerFigure, setViewerFigure] = useState<AcFigure | null>(null)
  const [bookmarked, setBookmarked] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [backTo, setBackTo] = useState<string | null>(null)
  const [siblingParagraphs, setSiblingParagraphs] = useState<string[]>([])
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef<ScrollView>(null)
  const bodyRef = useRef<PlainTextBodyHandle>(null)
  const inDocSearch = useInDocSearch(bodyRef)

  // Consumed once per screen instance (on mount / id change), not on every
  // render -- see navBreadcrumb.ts's single-slot design.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

  useEffect(() => {
    if (id) isBookmarked(id).then(setBookmarked)
  }, [id])

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
        .select('citing_type, citing_id, cited_type, cited_id, label')
        .or(`and(cited_type.eq.aim,cited_id.eq.${id}),and(citing_type.eq.aim,citing_id.eq.${id})`),
    ]).then(([paraRes, figRes, citRes]) => {
      if (!paraRes.error && paraRes.data) {
        const p = paraRes.data as AimParagraph
        setPara(p)
        addRecent({
          id: p.paragraph_number,
          itemType: 'aim',
          document_number: p.paragraph_number,
          title: p.title ?? '',
          date_issued: null,
          subject_series: null,
        })
      }
      if (!figRes.error && figRes.data) setFigures(figRes.data as AimFigureRow[])
      if (!citRes.error && citRes.data) {
        // Normalize to "the OTHER document" regardless of which side of the
        // row this paragraph is on -- confirmed a real bug: the old query
        // only ever selected cited_type/cited_id, so a row matched via
        // "someone else cites ME" (cited_type=aim, cited_id=my own id) was
        // displayed as if it pointed at itself, instead of showing who the
        // real citing document was. Self-citations (a paragraph appearing on
        // both sides, if that data existed) are dropped rather than shown.
        const rows = citRes.data as {
          citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null
        }[]
        const other = rows
          .map((r) => (r.citing_type === 'aim' && r.citing_id === id
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'aim' && r.cited_id === id))
        setRelated(other)
      }
      setLoading(false)
    })
  }, [id])

  // Sibling paragraph numbers within this paragraph's own chapter, for
  // Prev/Next -- a lightweight second query once the chapter is known.
  useEffect(() => {
    if (!para?.chapter) return
    supabase
      .from('aim_paragraphs')
      .select('paragraph_number')
      .eq('chapter', para.chapter)
      .then(({ data }) => {
        if (data) {
          setSiblingParagraphs(
            (data as { paragraph_number: string }[])
              .map((r) => r.paragraph_number)
              .sort(compareParagraphNumbers),
          )
        }
      })
  }, [para?.chapter])

  const siblingIdx = para ? siblingParagraphs.indexOf(para.paragraph_number) : -1
  const prevParagraph = siblingIdx > 0 ? siblingParagraphs[siblingIdx - 1] : null
  const nextParagraph = siblingIdx >= 0 && siblingIdx < siblingParagraphs.length - 1 ? siblingParagraphs[siblingIdx + 1] : null

  const body = para?.body_text ?? ''
  const currentLabel = para ? para.paragraph_number : undefined

  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const pcgRefs = related.filter((r) => r.cited_type === 'pcg')
  // AIM-to-AIM is the single most common citation type in this corpus (89
  // rows) but previously had no bar to surface in at all -- confirmed live,
  // a real coverage gap, not correctly-empty data.
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const adRefs = related.filter((r) => r.cited_type === 'ad')

  const handleToggleBookmark = async () => {
    if (!para) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: para.paragraph_number,
      itemType: 'aim',
      document_number: para.paragraph_number,
      title: para.title ?? '',
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  // Gated synchronously here, not just relying on FolderPicker's own
  // internal backstop -- same rule as ac/[id].tsx's handleOpenFolderPicker,
  // so a free-tier tap always at least shows the paywall rather than
  // risking a silent no-op.
  const handleOpenFolderPicker = () => {
    if (!para) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  const handleShare = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    if (!para) return
    try {
      await Share.share({
        title: para.paragraph_number,
        message: buildRegShareLink('aim', para.paragraph_number, para.paragraph_number, para.title ?? undefined),
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
      <OverlayHeader
        // Confirmed live: a bare "Chapter 4" header gives no indication
        // which document you're even in (AIM? FAR? something else?) once
        // the app spans multiple regulatory sources — every other
        // detail screen's header carries its own source prefix (P/CG's
        // says "Pilot/Controller Glossary" outright), this was the one
        // silent exception.
        title={para?.chapter?.startsWith('A') ? `AIM — Appendix ${para.chapter.slice(1)}` : `AIM — Chapter ${para?.chapter ?? ''}`}
        onBack={() => router.back()}
        right={headerRight}
      />
      {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
      {!loading && para && (
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
      ) : !para ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Paragraph not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={100}
        >
          {para.section_title && (
            <Text style={[styles.section, { color: tokens.t3, fontSize: fs(12) }]}>{para.section_title}</Text>
          )}
          <Text style={[styles.paraNum, { color: tokens.blu, fontSize: fs(15) }]}>{para.paragraph_number}</Text>
          {para.title && (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{para.title}</Text>
          )}

          <View style={styles.barsWrap}>
            {/* Figures & Tables isn't a MagicLink -- it's this document's own
                figures, not a cross-document citation, so it keeps the plain
                (non-glowing) bar style instead of MagicLinkPod. */}
            <Pressable
              style={[styles.bar, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => setFiguresExpanded((e) => !e)}
              disabled={figures.length === 0}
            >
              <View style={styles.barLeft}>
                <Icon name="photo" size={15} color={tokens.t3} />
                <Text style={[styles.barLabel, { color: tokens.t1, fontSize: fs(13) }]}>Figures & Tables</Text>
              </View>
              <View style={{ flex: 1 }} />
              <Text style={[styles.barCount, { color: tokens.t3, fontSize: fs(12.5) }]}>{figures.length}</Text>
              {figures.length > 0 && (
                <Icon name={figuresExpanded ? 'chevron.up' : 'chevron.down'} size={11} color={tokens.t4} />
              )}
            </Pressable>
            <MagicLinkPod
              bars={[
                { icon: 'arrow.up.right.square', label: 'Related AIM', items: aimRefs },
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'list.bullet', label: 'FAR references', items: farRefs },
                { icon: 'questionmark.circle', label: 'P/CG terms', items: pcgRefs },
                { icon: 'wrench.and.screwdriver', label: 'Related ADs', items: adRefs },
              ]}
              currentLabel={currentLabel}
              hasPlusAccess={hasPlusAccess}
            />
          </View>

          {/* Confirmed a real, live UX bug: this used to render at the very
              bottom of the ScrollView (after the body text AND the
              References section), completely disconnected from the toggle
              bar above -- tapping "Figures & Tables" gave no visible
              feedback near the tap, and the actual thumbnail only appeared
              after scrolling all the way down. Moved to render immediately
              below its own toggle bar, where an expand/collapse action is
              expected to show its result. */}
          {figuresExpanded && figures.length > 0 && (
            <View style={styles.figuresWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.figScroll}>
                {figures.map((f) => (
                  <Pressable
                    key={f.id}
                    style={[styles.figCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
                  >
                    <Image source={{ uri: f.image_url }} style={styles.figThumb} resizeMode="cover" />
                    <Text style={[styles.figLabel, { color: tokens.t1, fontSize: fs(11.5) }]} numberOfLines={1}>{f.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          )}

          {body ? (
            <PlainTextBody
              ref={bodyRef}
              text={body}
              figures={figures}
              onOpenFigure={(f) => setViewerFigure({ id: f.id, label: f.label ?? '', caption: f.caption, page: 0, image_url: f.image_url })}
              currentLabel={currentLabel}
              highlightQuery={inDocSearch.debounced}
              activeMatch={inDocSearch.matchIdx}
              onMatchCount={inDocSearch.setMatchCount}
              scrollRef={scrollRef}
            />
          ) : (
            <Text style={[styles.body, { color: tokens.t2, fontSize: fs(14.5) }]}>No text available for this paragraph.</Text>
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
          {para.reference_text && (
            <View style={styles.refsWrap}>
              <Text style={[styles.refsLabel, { color: tokens.t1, fontSize: fs(13) }]}>References</Text>
              <PlainTextBody text={para.reference_text.replace(/\n/g, '\n\n')} />
            </View>
          )}

        </ScrollView>
        </TabletContainer>
      )}
      {para && (
        <PrevNextFooter
          prevLabel={prevParagraph}
          nextLabel={nextParagraph}
          onPrev={() => prevParagraph && router.replace(`/aim/${prevParagraph}` as any)}
          onNext={() => nextParagraph && router.replace(`/aim/${nextParagraph}` as any)}
        />
      )}

      <FigureViewer figure={viewerFigure} onClose={() => setViewerFigure(null)} />
      <FolderPicker
        visible={folderPickerVisible}
        itemType="aim"
        itemId={para?.paragraph_number ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={para ? {
          document_number: para.paragraph_number,
          title: para.title ?? '',
          date_issued: null,
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  empty: { fontSize: 15, textAlign: 'center' },
  content: { padding: 16, paddingBottom: 40 },
  section: { fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  paraNum: { fontWeight: '600', fontSize: 15 },
  title: { fontWeight: '600', fontSize: 17, marginTop: 2, marginBottom: 14, lineHeight: 23 },
  barsWrap: { gap: 6, marginBottom: 16 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  barLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { fontSize: 13 },
  barCount: { fontSize: 12.5 },
  body: { fontSize: 14.5, lineHeight: 22 },
  refsWrap: { marginTop: 20 },
  refsLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  figuresWrap: { marginTop: 22 },
  figuresLabel: { fontWeight: '600', fontSize: 14, marginBottom: 10 },
  figScroll: { gap: 10 },
  figCard: { width: 130, borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  figThumb: { width: '100%', height: 90 },
  figLabel: { fontSize: 11.5, padding: 8 },
})
