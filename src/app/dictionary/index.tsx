import { useEffect, useState, useRef, useCallback } from 'react'
import { View, Text, FlatList, Pressable, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS, useInputFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getWordOfTheDay, WordOfTheDay } from '@/lib/notifications'
import { splitIntoDisplayParagraphs } from '@/lib/regTextFormat'

interface TermHit {
  slug: string
  term: string
  definition: string | null
}

interface MnemonicHit {
  slug: string
  term: string
  mnemonic_group: string | null
}

export const MNEMONIC_UNGROUPED = 'Other'

// Same-for-every-viewer data (letter counts + mnemonic term/group names --
// NOT the mnemonic body text itself, which this screen never fetches; see
// dictionary/letter/[letter].tsx for the one query on this feature that
// actually pulls gated body content). No uid prefix needed -- matches Home's
// own HOME_CACHE_KEY pattern (src/app/(tabs)/index.tsx's `load`), just for
// this screen's own browse index instead of the app's front door.
const DICTIONARY_INDEX_CACHE_KEY = '@flyregs/dictionary-index-cache'

// v1 scope (2026-08-01): FAA JO 7340.2's official Contractions table
// (3,326 terms, category='contraction') -- see
// sync/migrations_dictionary_terms.sql for why this is additive to, not a
// copy of, pcg_terms (1,332 terms, its own existing screen at /pcg).
// Structure mirrors pcg/index.tsx deliberately (same A-Z browse + live
// search pattern) so the two glossary features feel like siblings, not
// unrelated screens.
export default function DictionaryIndexScreen() {
  const { tokens } = useTheme()
  const { hasPlusAccess, loading: authLoading } = useAuth()
  const fs = useFS()
  const ifs = useInputFS()
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [termHits, setTermHits] = useState<TermHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchSeq = useRef(0)
  const [wordOfDay, setWordOfDay] = useState<WordOfTheDay | null>(null)
  const [mnemonics, setMnemonics] = useState<MnemonicHit[]>([])

  useEffect(() => {
    getWordOfTheDay().then(setWordOfDay).catch(() => {})
  }, [])

  // Small, separate browse entry point for category='mnemonic' entries
  // (AVE-F, MEA's lost-comm sense, etc.) -- RC: "we could create a small
  // 'Mnemonic' filter inside the A/D which could house all the aviation
  // mnemonics." A handful of rows at most, so a direct client-side query
  // rather than a dedicated RPC.
  //
  // Cache-first, same shape as Home's own `load` (HOME_CACHE_KEY) -- letter
  // counts + the mnemonic term/group list are the two fetches this screen's
  // browse view needs before it can paint anything, and both are identical
  // for every viewer (see DICTIONARY_INDEX_CACHE_KEY's own comment), so a
  // bare cache key is correct here. RC: "everything in the app... must
  // always open very fast" -- this shows the last-known browse index
  // instantly instead of a blank spinner on every open.
  const load = useCallback(async () => {
    let lastGoodCounts: Record<string, number> = {}

    try {
      const cached = await AsyncStorage.getItem(DICTIONARY_INDEX_CACHE_KEY)
      if (cached) {
        const { counts: cc, mnemonics: cm } = JSON.parse(cached)
        if (cc && Object.keys(cc).length) { setCounts(cc); lastGoodCounts = cc }
        if (cm?.length) setMnemonics(cm as MnemonicHit[])
        setLoading(false)
      }
    } catch (_) {}

    try {
      const [countsRes, mnemonicsRes] = await Promise.all([
        supabase.rpc('count_dictionary_terms_by_letter'),
        supabase.from('dictionary_terms').select('slug, term, mnemonic_group').eq('category', 'mnemonic').order('term'),
      ])
      let freshCounts = lastGoodCounts
      if (countsRes.data) {
        const c: Record<string, number> = {}
        for (const row of countsRes.data as { letter: string; cnt: number }[]) c[row.letter] = row.cnt
        freshCounts = c
        setCounts(c)
      }
      const freshMnemonics = (mnemonicsRes.data ?? []) as MnemonicHit[]
      setMnemonics(freshMnemonics)

      AsyncStorage.setItem(DICTIONARY_INDEX_CACHE_KEY, JSON.stringify({
        counts: freshCounts,
        mnemonics: freshMnemonics,
      })).catch(() => {})
    } catch (_) {
      // Network failed -- cached data (if any) stays visible
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // search_dictionary matches term OR definition text (senses jsonb is part
  // of its search_vector), not just the headword -- RC: "the dictionary
  // should work both ways. search a word, get a def - and search a def or
  // phrase, get the terms (ex: user types 'a smooth landing', our system
  // shows 'greaser' as one of the results)." Same RPC already powers
  // Home's SmartSearch federation; using it here too means an exact-term
  // hit (typing "fa" for the term "FA") ranks first instead of getting
  // buried alphabetically behind 20 substring matches like "ADFAP" --
  // confirmed live as a real bug in the plain .ilike().order('term') this
  // replaces.
  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    if (trimmed.length < 2) { searchSeq.current++; setTermHits([]); setSearching(false); return }
    const seq = ++searchSeq.current
    setSearching(true)
    supabase
      .rpc('search_dictionary', { query: trimmed, result_limit: 30 })
      .then(({ data }) => {
        if (seq !== searchSeq.current) return
        setTermHits((data ?? []) as TermHit[])
        setSearching(false)
      })
  }, [])

  const handleQueryChange = (text: string) => {
    setQuery(text)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text), 250)
  }

  // '#' (symbol-leading contractions like "+FC") sorts last, everything
  // else alphabetically -- matches how the source table itself orders them.
  const letters = Object.keys(counts).sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const trimmedQuery = query.trim()

  // RC, 2026-08-10: "Plus gets the A/D, not the Mnemonics. Pro also gets
  // Mnemonics" -- reverses the earlier free-by-default call. Whole-screen
  // lock (no partial browse/search preview), matching RefPacks' pattern --
  // dictionary_terms_gated and search_dictionary both already redact real
  // content server-side regardless of this client gate; this is purely the
  // "don't even show the browse UI" layer.
  // hasPlusAccess is false for everyone until auth's `loading` resolves (see
  // context/auth.tsx) -- don't hand a real Plus subscriber the whole-screen
  // lock while the entitlement fetch is still in flight.
  if (!hasPlusAccess && authLoading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      </View>
    )
  }

  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.lockTitle, { color: tokens.t2, fontSize: fs(16) }]}>The Aviation Dictionary is a Plus feature</Text>
          <Text style={[styles.lockSub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            9,800+ terms, acronyms, and contractions from FAA/NOAA sources — searchable and cross-linked
            to the rest of the app.
          </Text>
          <Pressable style={[styles.lockBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=plus' as any)}>
            <Text style={[styles.lockBtnText, { fontSize: fs(15) }]}>Unlock Plus</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Aviation Dictionary" onBack={() => router.back()} />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (
        <TabletContainer>
          <View style={[styles.searchWrap, { backgroundColor: tokens.inp, borderColor: tokens.bdr2 }]}>
            <Icon name="magnifyingglass" size={fs(16)} color={tokens.t3} />
            <TextInput
              style={[styles.searchInput, { color: tokens.t1, fontSize: ifs(14) }]}
              placeholder="Find a term or acronym…"
              placeholderTextColor={tokens.t3}
              value={query}
              onChangeText={handleQueryChange}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
            />
            {query.length > 0 && (
              <Pressable onPress={() => { setQuery(''); setTermHits([]) }} hitSlop={8}>
                <Icon name="xmark.circle" size={fs(16)} color={tokens.t4} />
              </Pressable>
            )}
          </View>

          {trimmedQuery ? (
            searching ? (
              <View style={styles.center}>
                <ActivityIndicator color={tokens.blu} />
              </View>
            ) : (
              <FlatList
                style={styles.flatList}
                data={termHits}
                keyExtractor={(item) => item.slug}
                contentContainerStyle={styles.list}
                keyboardDismissMode="interactive"
                ListHeaderComponent={
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>
                    {termHits.length} MATCHING TERM{termHits.length === 1 ? '' : 'S'}
                  </Text>
                }
                ListEmptyComponent={
                  <Text style={[styles.emptyText, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
                    No terms found. Not every contraction has a plain-English match — try the raw code (e.g. "ACARS").
                  </Text>
                }
                renderItem={({ item }) => (
                  <Pressable
                    style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                    onPress={() => router.push(`/dictionary/${item.slug}` as any)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.termText, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.term}</Text>
                      {/* RC, real device, on a batch of long weather-glossary
                          definitions filling the whole results list: "can we
                          figure out how to break these chunks up as well?
                          need to be easier to read and digest." A search
                          results list is a scanning context (comparing many
                          candidates), not a reading one -- 3 lines is still
                          enough to judge relevance without a 200-word
                          definition dominating the row. This narrows the
                          older "no numberOfLines cap" rule to just this
                          screen; the term detail page still shows full text. */}
                      {item.definition && (
                        <Text style={[styles.defText, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]} numberOfLines={3}>{item.definition}</Text>
                      )}
                    </View>
                    <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                  </Pressable>
                )}
              />
            )
          ) : (
            <FlatList
              style={styles.flatList}
              data={letters}
              keyExtractor={(l) => l}
              contentContainerStyle={styles.list}
              keyboardDismissMode="interactive"
              ListHeaderComponent={
                <>
                  {/* DailyWordCard/MnemonicsCard used to render as fixed
                      siblings above this FlatList, outside its own scroll --
                      fine collapsed, but an expanded Mnemonics card (35
                      entries across 8 groups) had nowhere to scroll and
                      just got clipped by the screen. Moving both into the
                      header means they scroll together with the letter rows
                      below, using the FlatList's own scroll instead of
                      needing one of their own. */}
                  <DailyWordCard wordOfDay={wordOfDay} tokens={tokens} />
                  {mnemonics.length > 0 && <MnemonicsCard mnemonics={mnemonics} tokens={tokens} fs={fs} />}
                  <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>{total} TERMS</Text>
                </>
              }
              renderItem={({ item: letter }) => (
                <Pressable
                  style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push(`/dictionary/letter/${encodeURIComponent(letter)}` as any)}
                >
                  <Text style={[styles.letter, { color: tokens.blu, fontSize: fs(16) }]}>{letter}</Text>
                  <View style={{ flex: 1 }} />
                  <View style={[styles.countPill, { backgroundColor: tokens.bg3 }]}>
                    <Text style={[styles.countText, { color: tokens.t3, fontSize: fs(11.5) }]}>{counts[letter]}</Text>
                  </View>
                  <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
                </Pressable>
              )}
            />
          )}
        </TabletContainer>
      )}
    </View>
  )
}

// Mirrors Home's DailyRegCard pattern exactly, including its Plus gate --
// RC, live (2026-08-02), after first asking for this free for everyone
// (2026-08-01) then reconsidering given the app's overall free/paid
// balance: "i think, since we're keeping the search free and open, we can
// gate the DailyWord like we do w/ DailyReg." Search/browse stays
// unlimited and free (matches AC's own pattern); this one curated daily
// pick is now Plus+, same locked-teaser-when-not-entitled treatment as
// DailyRegCard so the feature stays discoverable rather than vanishing.
// RC: "the D and W of DailyWord should have larger font, like ML" -- the two
// compound-word letters ("Daily" + "Word") get bumped up, same spirit as
// MagicLink's own label treatment, without copying its full letter-by-letter
// shimmer animation for what's otherwise a plain small-caps label everywhere
// else on this screen.
function DailyWordLabel({ color, fs }: { color: string; fs: (n: number) => number }) {
  return (
    <Text style={[styles.wordCardLabel, { color, fontSize: fs(10.5) }]}>
      <Text style={{ fontSize: fs(13.5) }}>D</Text>AILY<Text style={{ fontSize: fs(13.5) }}>W</Text>ORD
    </Text>
  )
}

function DailyWordCard({ wordOfDay, tokens }: { wordOfDay: WordOfTheDay | null; tokens: ReturnType<typeof useTheme>['tokens'] }) {
  const fs = useFS()
  const { hasPlusAccess } = useAuth()
  const [expanded, setExpanded] = useState(false)
  if (!wordOfDay) return null
  if (!hasPlusAccess) {
    return (
      <Pressable
        style={[styles.wordCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
        onPress={() => router.push('/paywall?tier=plus' as any)}
      >
        <View style={styles.wordCardRow}>
          <View style={[styles.wordCardIcon, { backgroundColor: tokens.goldlt }]}>
            <Icon name="lock.fill" size={fs(13)} color={tokens.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <DailyWordLabel color={tokens.t3} fs={fs} />
            <Text style={[styles.wordCardTerm, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
              A fun new term every day — unlock with Plus
            </Text>
          </View>
          <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
        </View>
      </Pressable>
    )
  }
  return (
    <Pressable
      style={[styles.wordCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => setExpanded((e) => !e)}
    >
      <View style={styles.wordCardRow}>
        <View style={[styles.wordCardIcon, { backgroundColor: tokens.goldlt }]}>
          <Icon name="star.fill" size={fs(14)} color={tokens.gold} />
        </View>
        <View style={{ flex: 1 }}>
          <DailyWordLabel color={tokens.t3} fs={fs} />
          <Text style={[styles.wordCardTerm, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={expanded ? undefined : 1}>
            {wordOfDay.term}
          </Text>
        </View>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t4} />
      </View>
      {expanded && (
        // Branch on wordOfDay.definition itself, not hasPlusAccess -- a
        // mnemonic-category pick (52 real rows in the pool, category now
        // returned by get_word_of_the_day() -- see notifications.ts's
        // WordOfTheDay comment) needs has_pro_access() to read, a genuinely
        // higher bar than every other category's Plus gate. A Plus-but-not-
        // Pro viewer who lands here on a mnemonic day gets definition=null
        // from the already-past-this-point hasPlusAccess check above, so
        // without this branch the card would silently expand to an empty
        // body (splitIntoDisplayParagraphs([null]) -> []) instead of
        // explaining why, or -- before this fix -- leaked the real
        // Pro-gated text because the RPC redacted everything at the single
        // Plus bar. Found + fixed 2026-08-19/20 access-points sweep.
        wordOfDay.definition ? (
          <>
            {splitIntoDisplayParagraphs(wordOfDay.definition).map((para, i, arr) => (
              <Text
                key={i}
                style={[
                  styles.wordCardDef,
                  { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 },
                  i < arr.length - 1 && { marginBottom: 8 },
                ]}
              >
                {para}
              </Text>
            ))}
            <Pressable
              style={[styles.wordCardJump, { borderColor: tokens.bdr }]}
              onPress={() => router.push(`/dictionary/${wordOfDay.slug}` as any)}
            >
              <Text style={[styles.wordCardJumpText, { color: tokens.blu, fontSize: fs(13) }]}>Open full entry</Text>
              <Icon name="chevron.right" size={fs(12)} color={tokens.blu} />
            </Pressable>
          </>
        ) : (
          <Pressable
            style={[styles.wordCardJump, { borderColor: tokens.bdr, marginTop: 4 }]}
            onPress={(e) => { e.stopPropagation(); router.push('/paywall?tier=pro' as any) }}
          >
            <Icon name="lock.fill" size={fs(12)} color={tokens.gold} />
            <Text style={[styles.wordCardJumpText, { color: tokens.t2, fontSize: fs(13) }]}>
              Today's pick is a mnemonic — unlock with Pro
            </Text>
          </Pressable>
        )
      )}
    </Pressable>
  )
}

// RC: "isolated in a way that would allow MEA to be found there as the
// moniker, but not have it interact with or disturb the 'real' MEA in
// the regs." Each row here is its own dictionary_terms entry
// (category='mnemonic', see sync/migrations_mnemonics.sql) -- a real MEA
// entry (Minimum En Route Altitude) exists elsewhere under M with its own
// slug; this list and that entry never collide.
// Collapsed by default -- RC: "there are hundreds or even thousands of
// mnemonics" once this grows past today's handful, so an always-expanded
// list can't be the default the way it's fine to be with 2 entries.
// RC, once the list grew past a handful: "might be nice to 'categorize'
// them, like what these lists do" (referring to his own grouped source
// material). Groups render in a fixed, sensible order rather than
// alphabetically -- preflight/ADM concerns first, in-flight emergencies
// last, roughly the order a pilot encounters them -- with anything
// ungrouped (mnemonic_group null) collected under "Other" at the end so
// it's never silently dropped.
export const MNEMONIC_GROUP_ORDER = [
  'Preflight Planning & Risk Management',
  'VFR & Equipment Requirements',
  'IFR Flight Planning & En Route',
  'Approaches & Transitions',
  'Weather & Navigation Instrument Errors',
  'Spatial Disorientation & Illusions',
  'Engine Failures & Emergencies',
  MNEMONIC_UNGROUPED,
]

// RC, 2026-08-10: "Plus gets the A/D, not the Mnemonics. Pro also gets
// Mnemonics" -- Mnemonics need Pro specifically, a step above the Plus gate
// that now covers the rest of the Dictionary (see the screen-level gate
// above). Same locked-teaser pattern as DailyWordCard -- the card stays
// visible and discoverable even to a Plus (non-Pro) user, tapping it routes
// to the paywall instead of expanding, and the individual mnemonic entries
// themselves are ALSO gated (see dictionary/[slug].tsx) so a Plus user
// can't route around this card by deep-linking or search.
function MnemonicsCard({ mnemonics, tokens, fs }: { mnemonics: MnemonicHit[]; tokens: ReturnType<typeof useTheme>['tokens']; fs: (n: number) => number }) {
  const { hasProAccess } = useAuth()
  const [expanded, setExpanded] = useState(false)
  const byGroup = new Map<string, MnemonicHit[]>()
  for (const m of mnemonics) {
    const g = m.mnemonic_group ?? MNEMONIC_UNGROUPED
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(m)
  }
  const groups = MNEMONIC_GROUP_ORDER.filter((g) => byGroup.has(g))
  for (const g of byGroup.keys()) if (!groups.includes(g)) groups.push(g) // any future group not yet in MNEMONIC_GROUP_ORDER still shows, just at the end

  if (!hasProAccess) {
    return (
      <Pressable
        style={[styles.mnemonicsCard, { backgroundColor: tokens.bg2, borderColor: tokens.blu }]}
        onPress={() => router.push('/paywall?tier=pro' as any)}
      >
        <View style={[styles.mnemonicsHeader, styles.wordCardRow]}>
          <View style={[styles.wordCardIcon, { backgroundColor: tokens.goldlt }]}>
            <Icon name="lock.fill" size={fs(13)} color={tokens.gold} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.wordCardLabel, { color: tokens.blu, fontSize: fs(10.5), fontWeight: '900' }]}>
              MNEMONICS · {mnemonics.length}
            </Text>
            <Text style={[styles.wordCardTerm, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={2}>
              Memory aids for checkride prep — unlock with Pro
            </Text>
          </View>
          <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
        </View>
      </Pressable>
    )
  }

  return (
    // Blue border + bold label, NOT the gold glow/tint treatment -- RC:
    // "I don't want the Mn bar to have the same glow/accents as ML - that's
    // a specific feature for ML... let's just use the blue, perhaps very
    // slightly thicker, and embolden the Mn word inside. That should be
    // enough on its own." Normal bg2 background (same as every other card
    // on this screen), just the border/label calling it out.
    <View style={[styles.mnemonicsCard, { backgroundColor: tokens.bg2, borderColor: tokens.blu }]}>
      <Pressable style={styles.mnemonicsHeader} onPress={() => setExpanded((e) => !e)}>
        <Text style={[styles.wordCardLabel, { color: tokens.blu, fontSize: fs(10.5), fontWeight: '900' }]}>
          MNEMONICS · {mnemonics.length}
        </Text>
        <Icon name={expanded ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.blu} />
      </Pressable>
      {expanded && groups.map((group, gi) => (
        <View key={group}>
          <Text style={[styles.mnemonicGroupLabel, { color: tokens.t3, fontSize: fs(10.5) }, gi > 0 && { marginTop: 10 }]}>
            {group.toUpperCase()}
          </Text>
          {byGroup.get(group)!.map((m, i, arr) => (
            <Pressable
              key={m.slug}
              style={[styles.mnemonicRow, gi === groups.length - 1 && i === arr.length - 1 && { borderBottomWidth: 0 }, { borderColor: tokens.bdr }]}
              onPress={() => router.push(`/dictionary/${m.slug}` as any)}
            >
              <Text style={[styles.mnemonicTerm, { color: tokens.gold, fontSize: fs(14) }]}>{m.term}</Text>
              <Icon name="chevron.right" size={fs(13)} color={tokens.t4} />
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  lockTitle: { fontWeight: '600', marginTop: 6 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  lockSub: { textAlign: 'center', maxWidth: 300 },
  lockBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  lockBtnText: { color: '#fff', fontWeight: '700' },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 10, height: 40,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12,
  },
  searchInput: { flex: 1 },

  wordCard: {
    marginHorizontal: 12, marginTop: 10, borderRadius: 12, borderWidth: 1, padding: 12,
  },
  wordCardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wordCardIcon: {
    width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  wordCardLabel: { fontWeight: '700', letterSpacing: 0.5, marginBottom: 2 },
  wordCardTerm: { fontWeight: '600' },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  wordCardDef: { marginTop: 10 },
  wordCardJump: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 10, alignSelf: 'flex-start', borderBottomWidth: 1, paddingBottom: 2,
  },
  wordCardJumpText: { fontWeight: '600' },

  mnemonicsCard: {
    marginHorizontal: 12, marginTop: 10, marginBottom: 12, borderRadius: 12, borderWidth: 1.5, paddingHorizontal: 12,
  },
  mnemonicsHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12,
  },
  mnemonicGroupLabel: { fontWeight: '700', letterSpacing: 0.4, paddingBottom: 6 },
  mnemonicRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 11, borderBottomWidth: 1,
  },
  mnemonicTerm: { fontWeight: '700' },

  flatList: { flex: 1 },
  list: { padding: 12, paddingBottom: 32 },
  groupLabel: { fontWeight: '600', letterSpacing: 0.5, marginBottom: 8, paddingLeft: 2 },
  // lineHeight NOT set here -- always overridden inline with fs(13.5) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  emptyText: { textAlign: 'center', marginTop: 20, paddingHorizontal: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6,
  },
  letter: { fontWeight: '700', width: 24 },
  termText: { fontWeight: '500' },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  defText: { marginTop: 2 },
  countPill: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  countText: { fontWeight: '600' },
})
