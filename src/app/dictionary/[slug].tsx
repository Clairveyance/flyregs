import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable, Share } from 'react-native'
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
import { linkifyText } from '@/lib/crossRefLinks'
import { splitIntoParagraphs } from '@/lib/regTextFormat'
import { PrevNextFooter } from '@/components/DocNavBar'
import { DictionarySearchBar } from '@/components/DictionarySearchBar'
import { buildRegShareLink } from '@/lib/regShare'
import { MNEMONIC_GROUP_ORDER, MNEMONIC_UNGROUPED } from './index'

interface BreakdownItem {
  letter: string
  concept: string
  detail: string
}

interface Sense {
  definition: string
  usage: string | null
  // Present only for category='mnemonic' entries -- one row per letter,
  // rendered as an actual bulleted list (RC: "list them out as users
  // would read them. bullet listed with the first letter larger and
  // bold") instead of the flat prose paragraph every other entry uses.
  breakdown?: BreakdownItem[]
}

interface DictTerm {
  term: string
  senses: Sense[]
  source: string
  category: string
  pcg_term_id: string | null
  pcg_terms: { slug: string; term: string } | null
  see_also_slug: string | null
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

// Turns a FAR/AC/AIM/AD/P-CG citation inside a definition ("not itself
// listed in § 91.203...", "as defined by 14 CFR 103.1") into a real
// tappable link, using the exact same linkifyText() already used for
// FAR/AIM/P-CG/AC body text -- RC: "could we create hyperlinks out to the
// actual reg data if those regs appear in the Mn explanations?" This is a
// ONE-WAY, purely additive read: linkifyText() just scans plain text for
// citation-shaped substrings and has no connection whatsoever to
// reg_mnemonic_anchors (the separate table that highlights a mnemonic's
// OWN moniker, like "MEA", inside real FAR/AIM body text) -- applying it
// here can't affect that isolation in either direction, which was the one
// thing RC was careful to ask about.
// Originally gated to category='mnemonic' only; extended to every
// dictionary entry (RC: "yes, extend the citation links to handbook
// entries") after the handbook-definitions spot check found real,
// verbatim-FAA citations like ULTRALIGHT's "A vehicle as defined by 14
// CFR 103.1." sitting as dead text even though FlyRegs already has that
// section's full body available to link to.
function LinkedParagraph({ text, style, linkColor }: { text: string; style: object; linkColor: string }) {
  const segments = linkifyText(text)
  if (segments.length === 1 && segments[0].route === null) {
    return <Text style={style}>{text}</Text>
  }
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.route ? (
          <Text key={i} onPress={() => router.push(seg.route as any)} style={{ color: linkColor, fontWeight: '700' }}>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  )
}

// Some definitions (handbook/glossary sources especially) arrive as one
// flat run with no paragraph breaks at all, even when they plainly contain
// an enumerated list -- RC, real device: "everything needs to be broken up
// and presented in easily readable formats. this exists many places
// corpus wide." splitIntoParagraphs decides WHERE to break without
// changing a single word of the actual FAA/NOAA/etc source text (see its
// own comment in regTextFormat.ts); each resulting paragraph still runs
// through the same per-segment citation linkification as before, just one
// paragraph at a time instead of the whole definition as one giant Text.
function LinkedText({ text, style, linkColor }: { text: string; style: object; linkColor: string }) {
  const paragraphs = splitIntoParagraphs(text)
  if (paragraphs.length <= 1) {
    return <LinkedParagraph text={text} style={style} linkColor={linkColor} />
  }
  return (
    <View>
      {paragraphs.map((p, i) => (
        <LinkedParagraph
          key={i}
          text={p}
          style={i < paragraphs.length - 1 ? [style, styles.paraSpacing] : style}
          linkColor={linkColor}
        />
      ))}
    </View>
  )
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
  const [siblingMnemonics, setSiblingMnemonics] = useState<{ slug: string; term: string; mnemonic_group: string | null }[]>([])
  const [prevTerm, setPrevTerm] = useState<{ slug: string; term: string } | null>(null)
  const [nextTerm, setNextTerm] = useState<{ slug: string; term: string } | null>(null)
  const [seeAlsoTerm, setSeeAlsoTerm] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) return
    supabase.from('dictionary_terms').select('term, senses, source, category, pcg_term_id, pcg_terms(slug, term), see_also_slug').eq('slug', slug).single()
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

  // "See X" cross-reference -- RC: "some (like ultralight) don't have
  // enough of a real explanation." A scripted audit found 79 entries whose
  // whole definition was a bare "See X." stub with zero real content; 67
  // resolve unambiguously to another entry that HAS the real explanation
  // (see migrations_dictionary_see_also.sql). A separate small fetch here
  // (rather than a PostgREST embed) since this FK is self-referential and
  // the embed syntax wasn't resolving cleanly even after a schema-cache
  // reload -- not worth fighting further for a single extra field.
  useEffect(() => {
    if (!entry?.see_also_slug) { setSeeAlsoTerm(null); return }
    supabase.from('dictionary_terms').select('term').eq('slug', entry.see_also_slug).single()
      .then(({ data }) => setSeeAlsoTerm((data as { term: string } | null)?.term ?? null))
  }, [entry?.see_also_slug])

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

  // Prev/Next chevrons for mnemonic entries specifically -- RC: "we should
  // have some next/prev chevrons in the Mn pages, when you're viewing the
  // Mn itself, just move easily to the next one, etc." Ordered by group
  // then alphabetically, matching how the Mnemonics card on the index
  // screen itself groups and presents them (see MNEMONIC_GROUP_ORDER) --
  // jumping alphabetically across unrelated topic groups would feel
  // disconnected from that presentation. Only ~40 rows today, nowhere near
  // PostgREST's 1000-row cap, but paged with .range() anyway for
  // consistency with pcg/[id].tsx's own pattern. See the separate
  // all-categories effect below for "the A/D itself" (RC's own correction:
  // "not AD, A/D" -- the Aviation Dictionary as a whole, not Airworthiness
  // Directives, which briefly got this feature by mistake).
  useEffect(() => {
    if (entry?.category !== 'mnemonic') return
    let cancelled = false
    async function fetchAll() {
      const all: { slug: string; term: string; mnemonic_group: string | null }[] = []
      let from = 0
      const page = 1000
      while (!cancelled) {
        const { data } = await supabase
          .from('dictionary_terms')
          .select('slug, term, mnemonic_group')
          .eq('category', 'mnemonic')
          .order('term', { ascending: true })
          .range(from, from + page - 1)
        if (!data || data.length === 0) break
        all.push(...(data as { slug: string; term: string; mnemonic_group: string | null }[]))
        if (data.length < page) break
        from += page
      }
      if (!cancelled) setSiblingMnemonics(all)
    }
    fetchAll()
    return () => { cancelled = true }
  }, [entry?.category])

  const byMnemonicGroup = new Map<string, typeof siblingMnemonics>()
  for (const m of siblingMnemonics) {
    const g = m.mnemonic_group ?? MNEMONIC_UNGROUPED
    if (!byMnemonicGroup.has(g)) byMnemonicGroup.set(g, [])
    byMnemonicGroup.get(g)!.push(m)
  }
  const mnemonicGroups = MNEMONIC_GROUP_ORDER.filter((g) => byMnemonicGroup.has(g))
  for (const g of byMnemonicGroup.keys()) if (!mnemonicGroups.includes(g)) mnemonicGroups.push(g)
  const orderedMnemonics = mnemonicGroups.flatMap((g) => byMnemonicGroup.get(g)!)
  const mnemonicIdx = orderedMnemonics.findIndex((s) => s.slug === slug)
  const prevMnemonic = mnemonicIdx > 0 ? orderedMnemonics[mnemonicIdx - 1] : null
  const nextMnemonic = mnemonicIdx >= 0 && mnemonicIdx < orderedMnemonics.length - 1 ? orderedMnemonics[mnemonicIdx + 1] : null

  // Prev/Next for every OTHER entry -- RC: "the A/D needs the same
  // prev/next chevrons like we have in AIM and elsewhere," i.e. the
  // Aviation Dictionary as a whole (10,081 rows across contraction/
  // handbook/informal), not just the 37-row mnemonic subset above. Same
  // reasoning as ad/[id].tsx's own prev/next: 10k rows is too large to
  // fetch in full the way pcg/[id].tsx does for its 1,332, and there's no
  // natural small scope to fetch (unlike FAR's per-Part scoping), so this
  // uses two targeted lt/gt + limit(1) queries against the whole table
  // instead. Deliberately NOT scoped to the current entry's own category
  // or starting letter -- like flipping pages in a real dictionary, "next"
  // after the last "M" word should land on the first "N" word, matching
  // how the index screen's own letter-browse presents one continuous
  // alphabetized list rather than category- or letter-siloed ones.
  useEffect(() => {
    if (!entry || entry.category === 'mnemonic') return
    supabase.from('dictionary_terms').select('slug, term').lt('term', entry.term).order('term', { ascending: false }).limit(1)
      .then(({ data }) => setPrevTerm((data?.[0] as { slug: string; term: string } | undefined) ?? null))
    supabase.from('dictionary_terms').select('slug, term').gt('term', entry.term).order('term', { ascending: true }).limit(1)
      .then(({ data }) => setNextTerm((data?.[0] as { slug: string; term: string } | undefined) ?? null))
  }, [entry?.term, entry?.category])

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

  // The Aviation Dictionary was the ONE detail screen with no Share button --
  // it had bookmark and folder like every other type, so a term could be
  // saved and foldered but not sent, and the only way to share one was to
  // open Saved and share it from there. Same Plus gate and same
  // buildRegShareLink path the other five non-AC types use (see
  // loi/[slug].tsx's identical handler); flyregs.com/reg/ now accepts
  // type=dictionary, so the recipient actually lands in the app.
  const handleShare = async () => {
    if (!hasPlusAccess) { router.push('/paywall' as any); return }
    if (!entry || typeof slug !== 'string') return
    try {
      await Share.share({
        title: entry.term,
        message: buildRegShareLink('dictionary', slug, entry.term, entry.senses[0]?.definition ?? undefined),
      })
    } catch {
      // User cancelled or share unavailable
    }
  }

  const headerRight = entry ? (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
      <Pressable onPress={handleShare} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="square.and.arrow.up" size={fs(21)} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
      <Pressable onPress={handleOpenFolderPicker} hitSlop={12} style={{ padding: 4 }}>
        <Icon name="folder.badge.plus" size={fs(21)} color={hasPlusAccess ? tokens.t2 : tokens.t4} />
      </Pressable>
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
      <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} right={headerRight} />
      <DictionarySearchBar />
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

            {entry.category === 'mnemonic' && !hasPlusAccess ? (
              // RC, 2026-08-03: "remove the Mnemonic look up and gate that
              // at Plus." No partial reveal (unlike AC's 2-section preview)
              // -- a mnemonic's whole value IS its letter-by-letter
              // breakdown, so showing half of one is a worse experience
              // than showing none. The term itself (its "moniker," e.g.
              // "AVIATES") still shows above -- just not what it means.
              <Pressable
                style={[styles.proGate, { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 }]}
                onPress={() => router.push('/paywall?tier=plus' as any)}
              >
                <Icon name="lock.fill" size={fs(20)} color={tokens.blu} />
                <Text style={[styles.proGateTitle, { color: tokens.t1, fontSize: fs(16) }]}>Unlock this mnemonic with Plus</Text>
                <Text style={[styles.proGateSub, { color: tokens.t3, fontSize: fs(13.5) }]}>
                  See the full letter-by-letter breakdown for every memory aid in the Aviation Dictionary.
                </Text>
                <View style={[styles.proGateBtn, { backgroundColor: tokens.blu }]}>
                  <Text style={[styles.proGateBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
                </View>
              </Pressable>
            ) : entry.senses.map((s, i) => (
              <View key={i} style={[styles.senseCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {entry.senses.length > 1 && (
                  <Text style={[styles.senseNum, { color: tokens.t4, fontSize: fs(11) }]}>SENSE {i + 1}</Text>
                )}
                <LinkedText text={s.definition} style={[styles.definition, { color: tokens.t1, fontSize: fs(16) }]} linkColor={tokens.blu} />
                {s.breakdown && s.breakdown.length > 0 && (
                  <View style={styles.breakdownList}>
                    {s.breakdown.map((b, bi) => (
                      <View key={bi} style={styles.breakdownRow}>
                        <Text style={[styles.breakdownLetter, { color: tokens.gold, fontSize: fs(22) }]}>{b.letter}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.breakdownConcept, { color: tokens.t1, fontSize: fs(15) }]}>{b.concept}</Text>
                          {b.detail ? (
                            <LinkedText text={b.detail} style={[styles.breakdownDetail, { color: tokens.t2, fontSize: fs(13.5) }]} linkColor={tokens.blu} />
                          ) : null}
                        </View>
                      </View>
                    ))}
                  </View>
                )}
                {s.usage && (
                  <View style={[styles.usagePill, { backgroundColor: tokens.bdim }]}>
                    <Text style={[styles.usageText, { color: tokens.blu, fontSize: fs(11.5) }]}>
                      {USAGE_LABELS[s.usage] ?? s.usage}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            {entry.see_also_slug && seeAlsoTerm && (
              // "See X" stub entries had zero real content of their own --
              // this makes the referenced term a real tap-through to the
              // full entry that actually explains it, instead of a dead end.
              <Pressable
                style={[styles.pcgLinkCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push(`/dictionary/${entry.see_also_slug}` as any)}
              >
                <Icon name="arrow.turn.down.right" size={fs(16)} color={tokens.blu} />
                <Text style={[styles.pcgLinkText, { color: tokens.blu, fontSize: fs(13.5) }]}>
                  See {seeAlsoTerm}
                </Text>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )}

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
                <Icon name="headset" size={fs(16)} color={tokens.blu} />
                <Text style={[styles.pcgLinkText, { color: tokens.blu, fontSize: fs(13.5) }]}>
                  Also in the Pilot/Controller Glossary
                </Text>
                <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
              </Pressable>
            )}

            <Text style={[styles.sourceLine, { color: tokens.t4, fontSize: fs(11.5) }]}>Source: {entry.source}</Text>
          </ScrollView>
        </TabletContainer>
      )}
      {entry?.category === 'mnemonic' ? (
        <PrevNextFooter
          prevLabel={prevMnemonic ? prevMnemonic.term : null}
          nextLabel={nextMnemonic ? nextMnemonic.term : null}
          onPrev={() => prevMnemonic && router.replace(`/dictionary/${prevMnemonic.slug}` as any)}
          onNext={() => nextMnemonic && router.replace(`/dictionary/${nextMnemonic.slug}` as any)}
        />
      ) : entry ? (
        <PrevNextFooter
          prevLabel={prevTerm ? prevTerm.term : null}
          nextLabel={nextTerm ? nextTerm.term : null}
          onPrev={() => prevTerm && router.replace(`/dictionary/${prevTerm.slug}` as any)}
          onNext={() => nextTerm && router.replace(`/dictionary/${nextTerm.slug}` as any)}
        />
      ) : null}
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
  paraSpacing: { marginBottom: 12 },
  breakdownList: { gap: 12, marginTop: 4 },
  breakdownRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  breakdownLetter: { fontWeight: '800', width: 26 },
  breakdownConcept: { fontWeight: '700' },
  breakdownDetail: { marginTop: 2, lineHeight: 19 },
  usagePill: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
  usageText: { fontWeight: '600' },
  pcgLinkCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginTop: 4,
  },
  pcgLinkText: { flex: 1, fontWeight: '600' },
  sourceLine: { marginTop: 8, paddingHorizontal: 2 },
  proGate: {
    marginTop: 4,
    marginBottom: 10,
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
