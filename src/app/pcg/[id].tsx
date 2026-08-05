import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share, Alert } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import * as Sentry from '@sentry/react-native'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { BackToBreadcrumb, PrevNextFooter } from '@/components/DocNavBar'
import { Icon } from '@/components/Icon'
import { printReg } from '@/lib/printReg'
import { slugifyPcgTerm } from '@/lib/pcg'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { HeaderOverflowMenu } from '@/components/HeaderOverflowMenu'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { isDownloaded, addDownload, removeDownload, findDownload } from '@/lib/downloads'
import { DetailActionRow } from '@/components/DetailMeta'
import { addRecent } from '@/lib/recents'
import { linkifyText } from '@/lib/crossRefLinks'
import { setPendingBreadcrumb, consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch, InDocSearchTarget } from '@/lib/useInDocSearch'
import { searchPhrase, countOcc, highlightSpans } from '@/lib/searchHighlight'
import { buildRegShareLink } from '@/lib/regShare'
import { splitIntoParagraphs } from '@/lib/regTextFormat'

interface PcgTerm {
  slug: string
  term: string
  definition: string | null
  frequently_used: boolean
  see_refs: string[]
  external_refs: { label: string; url: string }[]
}

interface RelatedItem {
  cited_type: string
  cited_id: string
  label: string | null
}

// P/CG entries are free to read in full, same as browsing/searching any
// content type — the gating boundary is on ACs/FARs/AIM's full body text,
// not the glossary itself, which is short by nature and part of what makes
// search results useful even for a free-tier user deciding whether to
// subscribe.
export default function PcgTermScreen() {
  const { id, hl } = useLocalSearchParams<{ id: string; hl?: string }>()
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, hasProAccess, isPremium } = useAuth()
  const [term, setTerm] = useState<PcgTerm | null>(null)
  // A P/CG definition is a single short block (no separate paragraphs to
  // split, usually already fully visible), so unlike PlainTextBody's
  // per-paragraph scrollToMatch, matches here just need re-highlighting in
  // place -- no real scroll target needed.
  const noScrollRef = useRef<InDocSearchTarget>({ scrollToMatch: () => {} })
  const inDocSearch = useInDocSearch(noScrollRef)

  // Opened from a Study Mode flashcard bookmark, which stored the passage the
  // Q/A came from (see study.tsx + routeForBookmark). Same seeding FAR/AIM
  // already do. This was a REAL live gap, not a hypothetical: routeForBookmark
  // has always built `/pcg/<id>?hl=<snippet>` for P/CG bookmarks (its own
  // comment even says "see each screen's own `hl` param handling"), study.tsx
  // has always set blockText for every study type including 'pcg' -- but this
  // screen never read the param, so those bookmarks opened with the term
  // un-highlighted and the search box empty. Confirmed live before fixing:
  // /pcg/ABEAM?hl=aircraft highlighted nothing.
  //
  // Highlighting is the whole payoff here rather than scrolling -- a P/CG
  // definition is one short block that's already fully on screen (hence
  // noScrollRef above), so seeding the query lights up the matched phrase
  // in place, which is exactly what "jump to that passage" means for this
  // content type.
  const seededHlRef = useRef<string | null>(null)
  useEffect(() => {
    if (typeof hl !== 'string' || !hl.trim()) return
    if (seededHlRef.current === hl) return
    seededHlRef.current = hl
    inDocSearch.onQueryChange(hl)
  }, [hl, inDocSearch])
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [siblingTerms, setSiblingTerms] = useState<{ slug: string; term: string }[]>([])
  const [backTo, setBackTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState(false)
  const [folderPickerVisible, setFolderPickerVisible] = useState(false)
  const [confirmLabel, setConfirmLabel] = useState<string | undefined>()
  const [confirmTick, setConfirmTick] = useState(0)
  const [scrollY, setScrollY] = useState(0)
  const scrollRef = useRef<ScrollView>(null)

  // Keyed off the term's own resolved slug, not the raw route param — a
  // cross-reference link can land here with an un-normalized id that gets
  // retried/corrected above (see the retry block), and bookmarking that
  // transient value would silently fail to match what's actually shown.
  useEffect(() => {
    if (!term) return
    isBookmarked(term.slug).then(setBookmarked)
    // Same resolved-slug keying as the bookmark check above, for the same
    // reason: an un-normalized route param would check the wrong id.
    isDownloaded(term.slug).then(setDownloaded)
    addRecent({
      id: term.slug,
      itemType: 'pcg',
      document_number: term.term,
      title: term.term,
      date_issued: null,
      subject_series: null,
    })
  }, [term])

  // Consumed once per screen instance (on mount / id change), not on every
  // render -- see navBreadcrumb.ts's single-slot design.
  useEffect(() => {
    setBackTo(consumePendingBreadcrumb())
  }, [id])

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
        // Still nothing -- most often no network. Fall back to the offline
        // copy if this term was downloaded; without this branch "Download"
        // is write-only storage and the saved term reads as "not found" in
        // exactly the offline case the feature exists for.
        const cached = await findDownload(id)
        if (cached) {
          setTerm({
            slug: cached.id,
            term: cached.document_number,
            definition: cached.body_text ?? null,
            frequently_used: false,
            see_refs: [],
            external_refs: [],
          })
        }
        setLoading(false)
      })
  }, [id])

  // MagicLink cross-references -- confirmed a real gap: pcg/[id].tsx had no
  // Related ACs/FAR/AIM/AD bars at all (only its own separate see_refs/
  // external_refs, which cover pcg-to-pcg "See X" links, a different
  // relationship). Keyed off the term's own resolved slug, matching the
  // bookmark effect above.
  useEffect(() => {
    if (!term) return
    supabase
      .from('document_citations')
      .select('citing_type, citing_id, cited_type, cited_id, label')
      .or(`and(cited_type.eq.pcg,cited_id.eq.${term.slug}),and(citing_type.eq.pcg,citing_id.eq.${term.slug})`)
      .then(({ data, error }) => {
        if (error || !data) return
        const rows = data as { citing_type: string; citing_id: string; cited_type: string; cited_id: string; label: string | null }[]
        const other = rows
          .map((r) => (r.citing_type === 'pcg' && r.citing_id === term.slug
            ? { cited_type: r.cited_type, cited_id: r.cited_id, label: r.label }
            : { cited_type: r.citing_type, cited_id: r.citing_id, label: r.label }))
          .filter((r) => !(r.cited_type === 'pcg' && r.cited_id === term.slug))
        setRelated(other)
      })
  }, [term])

  // Alphabetical Prev/Next -- confirmed a real gap: unlike FAR/AIM (which
  // already have Prev/Next within their own Part/chapter), the P/CG
  // glossary had no forward/back navigation at all despite being a
  // naturally alphabetically-ordered reference, exactly like a dictionary.
  // 1,332 rows is small enough to fetch once in full rather than needing a
  // letter-scoped query (which would need extra logic to cross from the
  // last term of one letter to the first of the next) -- but a plain
  // unpaginated select() silently truncates at PostgREST's 1000-row
  // default (confirmed live: this hid "TAXI" and everything after it,
  // since "T" falls past row 1000 alphabetically -- same cap far/index.tsx
  // already documents dealing with), so this pages through with .range().
  useEffect(() => {
    let cancelled = false
    async function fetchAll() {
      const all: { slug: string; term: string }[] = []
      let from = 0
      const page = 1000
      while (!cancelled) {
        const { data } = await supabase
          .from('pcg_terms')
          .select('slug, term')
          .order('term', { ascending: true })
          .range(from, from + page - 1)
        if (!data || data.length === 0) break
        all.push(...(data as { slug: string; term: string }[]))
        if (data.length < page) break
        from += page
      }
      if (!cancelled) setSiblingTerms(all)
    }
    fetchAll()
    return () => { cancelled = true }
  }, [])

  const siblingIdx = term ? siblingTerms.findIndex((s) => s.slug === term.slug) : -1
  const prevTerm = siblingIdx > 0 ? siblingTerms[siblingIdx - 1] : null
  const nextTerm = siblingIdx >= 0 && siblingIdx < siblingTerms.length - 1 ? siblingTerms[siblingIdx + 1] : null

  // No PlainTextBody here (P/CG doesn't need its scroll/paragraph-ref
  // machinery -- a definition is always short enough to be on screen
  // without scrolling), so match counting is computed directly rather than
  // via that component's own onMatchCount callback. The definition text
  // ITSELF, though, is not always one short sentence -- it's scraped with
  // whitespace fully flattened (sync/pcg_scraper.py) and can run to
  // several sentences plus an inline enumerated list, same underlying
  // shape as the dictionary "wall of text" bug -- see splitIntoParagraphs.
  const hq = inDocSearch.debounced && inDocSearch.debounced.length >= 2 ? inDocSearch.debounced : null
  useEffect(() => {
    if (!hq || !term?.definition) { inDocSearch.setMatchCount(0); return }
    inDocSearch.setMatchCount(countOcc(term.definition, searchPhrase(hq)))
  }, [hq, term?.definition])

  // Split for DISPLAY only -- match counting above still runs over the
  // raw, unsplit string, so it's unaffected by where these breaks land.
  // defParaBase mirrors PlainTextBody's own paraBase: a running count of
  // matches in EARLIER paragraphs, so highlightSpans's `active` index
  // (a single number across the whole definition) lands on the right
  // occurrence inside the right paragraph instead of always assuming
  // paragraph 0.
  const defParagraphs = useMemo(() => splitIntoParagraphs(term?.definition), [term?.definition])
  const defParaBase = useMemo(() => {
    if (!hq) return []
    const phrase = searchPhrase(hq)
    const bases: number[] = []
    let running = 0
    for (const para of defParagraphs) {
      bases.push(running)
      running += countOcc(para, phrase)
    }
    return bases
  }, [defParagraphs, hq])

  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const adRefs = related.filter((r) => r.cited_type === 'ad')
  const loiRefs = related.filter((r) => r.cited_type === 'loi')

  const handleToggleBookmark = async () => {
    if (!term) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setBookmarked((prev) => !prev) // optimistic
    const next = await toggleBookmark({
      id: term.slug,
      itemType: 'pcg',
      document_number: term.term,
      title: term.term,
      date_issued: null,
      office: null,
      subject_series: null,
    })
    setBookmarked(next)
  }

  const handleOpenFolderPicker = () => {
    if (!term) return
    if (!hasPlusAccess) { router.push('/paywall'); return }
    setFolderPickerVisible(true)
  }

  // Premium-gated like every other type's download. The `!downloaded` guard
  // on the paywall check is deliberate: a user who lapses from Premium can
  // still REMOVE what they already saved, rather than being stuck with
  // undeletable offline copies behind a paywall.
  const handleDownload = async () => {
    if (!term) return
    if (!isPremium && !downloaded) { router.push('/paywall?tier=premium'); return }
    if (downloaded) {
      setDownloaded(false)
      await removeDownload(term.slug)
      return
    }
    setDownloadBusy(true)
    try {
      await addDownload({
        id: term.slug,
        type: 'pcg',
        document_number: term.term,
        title: term.term,
        subject_series: null,
        size: (term.definition ?? '').length,
        body_text: term.definition ?? null,
      })
      setDownloaded(true)
    } catch {
      Alert.alert('Error', "Couldn't save this term for offline reading. Try again in a moment.")
    }
    setDownloadBusy(false)
  }

  // Print is the other half of the Plus "Print & export any section"
  // promise -- until now the app had no print at all, only the share
  // sheet (which exports a LINK, not the text).
  const handlePrint = async () => {
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!term) return
    try {
      await printReg({
        documentNumber: term.term,
        title: null,
        body: term.definition ?? '',
        kindLabel: 'P/CG',
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
    // Share/export is a PLUS feature (paywall PLUS_FEATURES), not Premium.
    // Gating it on isPremium bounced a Plus buyer to a Premium upsell for
    // something they had already paid for.
    if (!hasPlusAccess) { router.push('/paywall'); return }
    if (!term) return
    try {
      await Share.share({
        title: term.term,
        message: buildRegShareLink('pcg', term.slug, term.term, term.definition ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const headerRight = term ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      {scrollY > 200 && (
        <Pressable
          onPress={() => scrollRef.current?.scrollTo({ y: 0, animated: true })}
          hitSlop={12}
          style={{ padding: 4 }}
        >
          <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
        </Pressable>
      )}
      <HeaderOverflowMenu
        items={[
          { icon: 'printer', label: 'Print', onPress: handlePrint, disabled: !hasPlusAccess },
          { icon: 'square.and.arrow.up', label: 'Share', onPress: handleShare, disabled: !hasPlusAccess },
          { icon: 'folder.badge.plus', label: 'Add to Folder', onPress: handleOpenFolderPicker, disabled: !hasPlusAccess },
        ]}
      />
      <Pressable onPress={handleToggleBookmark} hitSlop={12} style={{ padding: 4 }}>
        <Icon
          name={bookmarked ? 'bookmark.fill' : 'bookmark'}
          size={fs(21)}
          color={bookmarked ? tokens.blu : tokens.t2}
        />
      </Pressable>
    </View>
  ) : undefined

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Pilot/Controller Glossary" onBack={() => router.back()} right={headerRight} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : !term ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: tokens.t3, fontSize: fs(15) }]}>Term not found.</Text>
        </View>
      ) : (
        <TabletContainer>
        {backTo && <BackToBreadcrumb label={backTo} onPress={() => router.back()} />}
        <InDocSearchBar
          query={inDocSearch.query}
          onQueryChange={inDocSearch.onQueryChange}
          onClear={inDocSearch.onClear}
          matchCount={inDocSearch.matchCount}
          matchIdx={inDocSearch.matchIdx}
          onPrev={inDocSearch.goToPrev}
          onNext={inDocSearch.goToNext}
        />
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.content}
          onScroll={(e) => setScrollY(e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={100}
        >
          <Text style={[styles.term, { color: tokens.t1, fontSize: fs(19) }]}>{term.term}</Text>
          {term.frequently_used && (
            <View style={[styles.freqPill, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
              <Text style={[styles.freqText, { color: tokens.t3, fontSize: fs(11) }]}>Frequently used</Text>
            </View>
          )}

          {term.definition && defParagraphs.length > 0 ? (
            defParagraphs.map((para, i) => (
              <Text
                key={i}
                style={[
                  styles.def,
                  { color: tokens.t2, fontSize: fs(15) },
                  i < defParagraphs.length - 1 && styles.defParaSpacing,
                ]}
              >
                {hq ? (
                  // Same simplification PlainTextBody/ACBody make while
                  // actively searching: plain highlighted text, hyperlinks
                  // suppressed for the duration of the search.
                  highlightSpans(para, hq, { base: defParaBase[i] ?? 0, active: inDocSearch.matchIdx, redShift })
                ) : (
                  linkifyText(para).map((seg, si) =>
                    seg.route ? (
                      <Text
                        key={si}
                        onPress={() => {
                          setPendingBreadcrumb(term.term)
                          router.push(seg.route as any)
                        }}
                        style={{ color: tokens.blu, fontWeight: '600' }}
                      >
                        {seg.text}
                      </Text>
                    ) : (
                      <Text key={si}>{seg.text}</Text>
                    ),
                  )
                )}
              </Text>
            ))
          ) : (
            <Text style={[styles.def, { color: tokens.t2, fontSize: fs(15) }]}>
              See related term below — no standalone definition.
            </Text>
          )}

          {/* Download only -- the P/CG is scraped from FAA HTML and has no
              PDF of its own to open. */}
          <View style={{ marginTop: 16 }}>
            <DetailActionRow
              onDownload={handleDownload}
              downloaded={downloaded}
              downloadBusy={downloadBusy}
              tokens={tokens}
            />
          </View>

          <View style={styles.barsWrap}>
            <MagicLinkPod
              bars={[
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'list.bullet', label: 'FAR references', items: farRefs },
                { icon: 'arrow.up.right.square', label: 'AIM references', items: aimRefs },
                { icon: 'wrench.and.screwdriver', label: 'Related ADs', items: adRefs },
                { icon: 'checkmark.seal.fill', label: 'Related LOIs', items: loiRefs },
              ]}
              currentLabel={term.term}
              hasProAccess={hasProAccess}
            />
          </View>

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
                  <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
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
        </TabletContainer>
      )}
      {term && (
        <PrevNextFooter
          prevLabel={prevTerm ? prevTerm.term : null}
          nextLabel={nextTerm ? nextTerm.term : null}
          onPrev={() => prevTerm && router.replace(`/pcg/${prevTerm.slug}` as any)}
          onNext={() => nextTerm && router.replace(`/pcg/${nextTerm.slug}` as any)}
        />
      )}
      <FolderPicker
        visible={folderPickerVisible}
        itemType="pcg"
        itemId={term?.slug ?? ''}
        onClose={() => setFolderPickerVisible(false)}
        onAdded={(msg) => { setConfirmLabel(msg); setConfirmTick((t) => t + 1) }}
        acMeta={term ? {
          document_number: term.term,
          title: term.term,
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
  term: { fontWeight: '700', fontSize: 19, marginBottom: 8 },
  freqPill: { alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 14 },
  freqText: { fontSize: 11, fontWeight: '600' },
  def: { fontSize: 15, lineHeight: 22 },
  defParaSpacing: { marginBottom: 12 },
  // Breathing room around the action/MagicLink stack. These bars used to
  // butt straight up against the Download button above and the body text
  // below, so the whole block read as one cramped slab.
  // marginTop matches the internal `gap` -- see aim/[id].tsx's own comment
  // (RC, annotated screenshot): the two gaps were 14px and 10px, uneven.
  barsWrap: { gap: 10, marginTop: 10, marginBottom: 22 },
  section: { marginTop: 22 },
  sectionLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  seeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  seeText: { fontSize: 13.5, fontWeight: '500' },
  refRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  refText: { fontSize: 13.5 },
})
