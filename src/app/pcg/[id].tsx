import { useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { BackToBreadcrumb, PrevNextFooter } from '@/components/DocNavBar'
import { Icon } from '@/components/Icon'
import { slugifyPcgTerm } from '@/lib/pcg'
import { MagicLinkPod } from '@/components/MagicLinkPod'
import { TabletContainer } from '@/components/TabletContainer'
import { FolderPicker } from '@/components/FolderPicker'
import { ConfirmCheck } from '@/components/ConfirmCheck'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { addRecent } from '@/lib/recents'
import { linkifyText } from '@/lib/crossRefLinks'
import { setPendingBreadcrumb, consumePendingBreadcrumb } from '@/lib/navBreadcrumb'
import { InDocSearchBar } from '@/components/InDocSearchBar'
import { useInDocSearch, InDocSearchTarget } from '@/lib/useInDocSearch'
import { searchPhrase, countOcc, highlightSpans } from '@/lib/searchHighlight'
import { buildRegShareLink } from '@/lib/regShare'

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
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const { hasPlusAccess, isPremium } = useAuth()
  const [term, setTerm] = useState<PcgTerm | null>(null)
  // A P/CG definition is a single short block (no separate paragraphs to
  // split, usually already fully visible), so unlike PlainTextBody's
  // per-paragraph scrollToMatch, matches here just need re-highlighting in
  // place -- no real scroll target needed.
  const noScrollRef = useRef<InDocSearchTarget>({ scrollToMatch: () => {} })
  const inDocSearch = useInDocSearch(noScrollRef)
  const [related, setRelated] = useState<RelatedItem[]>([])
  const [siblingTerms, setSiblingTerms] = useState<{ slug: string; term: string }[]>([])
  const [backTo, setBackTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [bookmarked, setBookmarked] = useState(false)
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

  // No PlainTextBody here (a P/CG definition is one short block, rendered
  // inline), so match counting is computed directly rather than via that
  // component's own onMatchCount callback.
  const hq = inDocSearch.debounced && inDocSearch.debounced.length >= 2 ? inDocSearch.debounced : null
  useEffect(() => {
    if (!hq || !term?.definition) { inDocSearch.setMatchCount(0); return }
    inDocSearch.setMatchCount(countOcc(term.definition, searchPhrase(hq)))
  }, [hq, term?.definition])

  const acRefs = related.filter((r) => r.cited_type === 'ac')
  const farRefs = related.filter((r) => r.cited_type === 'far' || r.cited_type === 'far_part')
  const aimRefs = related.filter((r) => r.cited_type === 'aim')
  const adRefs = related.filter((r) => r.cited_type === 'ad')

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

  const handleShare = async () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
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

          <Text style={[styles.def, { color: tokens.t2, fontSize: fs(15) }]}>
            {hq && term.definition ? (
              // Same simplification PlainTextBody/ACBody make while
              // actively searching: plain highlighted text, hyperlinks
              // suppressed for the duration of the search.
              highlightSpans(term.definition, hq, { base: 0, active: inDocSearch.matchIdx })
            ) : term.definition ? (
              linkifyText(term.definition).map((seg, i) =>
                seg.route ? (
                  <Text
                    key={i}
                    onPress={() => {
                      setPendingBreadcrumb(term.term)
                      router.push(seg.route as any)
                    }}
                    style={{ color: tokens.blu, fontWeight: '600' }}
                  >
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i}>{seg.text}</Text>
                ),
              )
            ) : (
              'See related term below — no standalone definition.'
            )}
          </Text>

          <View style={styles.barsWrap}>
            <MagicLinkPod
              bars={[
                { icon: 'doc.text', label: 'Related ACs', items: acRefs },
                { icon: 'list.bullet', label: 'FAR references', items: farRefs },
                { icon: 'arrow.up.right.square', label: 'AIM references', items: aimRefs },
                { icon: 'wrench.and.screwdriver', label: 'Related ADs', items: adRefs },
              ]}
              currentLabel={term.term}
              hasPlusAccess={hasPlusAccess}
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
  barsWrap: { gap: 6, marginTop: 16 },
  section: { marginTop: 22 },
  sectionLabel: { fontWeight: '600', fontSize: 13, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.3 },
  seeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth },
  seeText: { fontSize: 13.5, fontWeight: '500' },
  refRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  refText: { fontSize: 13.5 },
})
