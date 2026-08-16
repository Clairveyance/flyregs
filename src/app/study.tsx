import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import Reanimated, { useSharedValue, useAnimatedStyle, withTiming, withRepeat, Easing } from 'react-native-reanimated'
import { router, useLocalSearchParams } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getStudyQueue, getStudyPoolCount, recordStudyReview, getStudyMastery, getCurrency, getStudyFactsForItems, StudyCard, StudyMastery, Currency, StudyItemType, StudyFact } from '@/lib/study'
import { COIN_BY_CODE, type CoinDef } from '@/lib/coins'
import { CoinRevealModal } from '@/components/CoinRevealModal'
import { StudyLevel, ALL_STUDY_LEVELS, STUDY_LEVEL_LABELS, markCoinsSeen } from '@/lib/challenges'
import { CategoryClass, CATEGORY_CLASSES, RATING_SHORT_LABELS } from '@/lib/profileRatings'
import { isBookmarked, toggleBookmark } from '@/lib/bookmarks'
import { buildStudyCard, type QuizSourceType } from '@/lib/quizQuestion'
import { normalizeRegBody } from '@/lib/regTextFormat'

const TYPE_LABEL: Record<StudyItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC', dictionary: 'A/D' }
const ALL_TYPES: StudyItemType[] = ['far', 'aim', 'pcg', 'ac', 'dictionary']

// Neutral starting tone for the mastery ring at 0% -- interpolated toward
// tokens.gold as mastery % rises (see masteryGlow above).
const MASTERY_RING_DULL = '#5a5a62'

// pcg_terms.term is stored shouting-case ("CLEARED AS FILED") -- the source
// citation line reads better title-cased, matching how every other citation
// (§ section, AIM paragraph, AC number) already reads as normal prose.
function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
  const ar = (pa >> 16) & 255, ag = (pa >> 8) & 255, ab = pa & 255
  const br = (pb >> 16) & 255, bg = (pb >> 8) & 255, bb = pb & 255
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t)
  return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`
}

// "See the definition, guess the term" (P/CG: see the meaning, guess the
// word; AC: see the description, guess the number) is the direction most
// pilots actually study in -- default, but not everyone's preference (an
// AC number-recall drill wants the reverse), so it's a real toggle,
// persisted across sessions like fontScale's own AsyncStorage pattern.
type RevealDirection = 'defFirst' | 'termFirst'
const REVEAL_DIRECTION_KEY = '@flyregs/study-reveal-direction'

// The deck size was a bare hardcoded 20 with no UI anywhere naming it or
// letting the user change it -- confirmed confusing live ("where is this
// 1/20 preset coming from? how does the user control that?"). Mirrors
// Duels' own QUESTIONS chip row (3/5/10) for the same concept in that
// feature, persisted the same way revealDirection is.
const SESSION_SIZES = [10, 20, 30, 50] as const

// Caps how tall a flashcard can grow before its text scrolls internally --
// without this, a long definition made the card (and the invisible sizer
// that reserves height for whichever face is longer) fill nearly the
// entire screen even when the currently-visible face was just two words,
// confirmed live as its own new bug once the "buttons unreachable" fix
// landed.
const MAX_CARD_HEIGHT = 340
const SESSION_SIZE_KEY = '@flyregs/study-session-size'
// Must match FlashCard's own withTiming duration below. handleAnswer defers
// swapping to the next card by exactly this long so the reverse-flip
// animation finishes showing the CURRENT card's front face before content
// changes underneath it -- see handleAnswer for the bug this fixes.
const FLIP_DURATION = 420

export default function StudyScreen() {
  const { tokens, resolved, redShift } = useTheme()
  const fs = useFS()
  // hasProAccess (isPro || isPremium), not bare isPro -- found during the
  // Plus/Pro folder audit (2026-08-14): a real Premium subscriber (isPro:
  // false, isPremium: true) hit this exact bug elsewhere (saved.tsx/
  // notes.tsx's Back up & sync toggle) and it was present here too, locking
  // a paying Premium customer out of Study Mode entirely.
  const { hasProAccess } = useAuth()
  // Entry point from a RefPack's "Study This Rating" button (see
  // refPackKnowledgeLevel() in refPackets.ts) -- pre-scopes the Knowledge
  // Level filter to that rating so the user lands in an already-relevant
  // deck instead of re-selecting the same level by hand. Read once on
  // mount only; this screen doesn't need to react to the param changing
  // after the fact since it's not re-navigated-to without a fresh mount.
  const { level: levelParam } = useLocalSearchParams<{ level?: string }>()
  const [loading, setLoading] = useState(true)
  const [deck, setDeck] = useState<StudyCard[]>([])
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  // Mastery ring: starts a dull neutral tone and grows toward full gold as
  // mastery % rises, with a soft pulsing glow whose intensity also scales
  // with %, evoking MagicLink's own gold shimmer without needing its full
  // rotating-gradient-border rig (that trick measures/sizes off a real
  // layout box -- overkill for a fixed 64px badge). Confirmed live, RC:
  // "this ring should be a 'duller' color to begin with, and 'grow' gold
  // (and maybe even shimmer like our ML a bit) as you increase your total %
  // of mastery."
  const masteryGlow = useSharedValue(0)
  useEffect(() => {
    if (!mastery || mastery.pct <= 0) { masteryGlow.value = 0; return }
    masteryGlow.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) }), -1, true)
  }, [mastery?.pct])
  // Hooks can't be called conditionally, so this reads unconditionally at
  // the top level (unlike the JSX below, which only renders once `mastery`
  // is loaded) -- pct falls back to 0 pre-load, which just means no glow.
  const masteryPct = mastery?.pct ?? 0
  const masteryGlowStyle = useAnimatedStyle(() => ({ shadowOpacity: masteryGlow.value * (masteryPct / 100) * 0.75 }))
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [poolCount, setPoolCount] = useState<number | null>(null)
  const [sessionDone, setSessionDone] = useState(false)
  const [revealCoin, setRevealCoin] = useState<CoinDef | null>(null)
  const [revealDirection, setRevealDirection] = useState<RevealDirection>('defFirst')
  const [sessionSize, setSessionSize] = useState<number>(20)
  // Collapsed by default -- with Content, Knowledge Level, Category/Class,
  // and Session Size all as chip rows, the filter block was pushing the
  // actual flashcard below the fold on first load (confirmed live: "this
  // will prevent the actual Q/A content from being pushed down that it has
  // to be scrolled to to see"). A summary line stays visible either way so
  // the active selection is never hidden, just the chip rows themselves.
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  // RC, 2026-08-12: "clean up the study/duel filter rows" -- with all 5
  // groups expanded, Category/Class alone wraps to 3 lines (11 chips) and
  // the whole panel pushed the actual flashcard almost entirely below the
  // fold. Content + Knowledge Level + Session Size are the 3 groups most
  // people touch; Category/Class and Rating are real but secondary axes
  // (see their own comments below) -- collapsed behind their own toggle so
  // the common case stays short, full functionality still one tap away.
  const [moreFiltersExpanded, setMoreFiltersExpanded] = useState(false)
  // Real content-recall Q/A, now for FAR and AIM (and opportunistically
  // P/CG/AC) -- see getStudyFactsForItems' own comment for why this used to
  // be AIM-only despite FAR/P-CG/AC facts already existing live in the same
  // table. Keyed `${item_type}:${item_id}`, fetched inside load() below
  // once the deck itself is known.
  const [studyFacts, setStudyFacts] = useState<Map<string, StudyFact>>(new Map())

  useEffect(() => {
    AsyncStorage.getItem(REVEAL_DIRECTION_KEY).then((raw) => {
      if (raw === 'termFirst' || raw === 'defFirst') setRevealDirection(raw)
    })
    AsyncStorage.getItem(SESSION_SIZE_KEY).then((raw) => {
      const n = raw ? parseInt(raw, 10) : NaN
      if ((SESSION_SIZES as readonly number[]).includes(n)) setSessionSize(n)
    })
  }, [])

  const changeSessionSize = (n: number) => {
    setSessionSize(n)
    AsyncStorage.setItem(SESSION_SIZE_KEY, String(n))
  }

  const toggleRevealDirection = () => {
    setRevealDirection((prev) => {
      const next = prev === 'defFirst' ? 'termFirst' : 'defFirst'
      AsyncStorage.setItem(REVEAL_DIRECTION_KEY, next)
      return next
    })
    setFlipped(false)
  }
  // Empty selection means "all types" (still what the backend expects --
  // itemTypes.length > 0 ? itemTypes : null) but ALL and individual chips
  // are now mutually exclusive in the UI: ALL can't be "pared down" since
  // by definition it already means everything, so tapping any individual
  // chip starts a fresh explicit selection (clearing ALL's highlight), and
  // tapping ALL clears any explicit selection back to empty. Previously
  // both could render as selected at once (every individual chip lit up
  // gold *because* ALL was active) -- confirmed confusing live.
  const [activeTypes, setActiveTypes] = useState<StudyItemType[]>([])
  const [activeLevels, setActiveLevels] = useState<StudyLevel[]>(() =>
    levelParam && (ALL_STUDY_LEVELS as string[]).includes(levelParam) ? [levelParam as StudyLevel] : []
  )
  const [activeCategoryClasses, setActiveCategoryClasses] = useState<CategoryClass[]>([])

  // True when the deck is narrowed at all. Used to relabel the mastery
  // counter, which always reports the WHOLE corpus and otherwise appears to
  // contradict the "N items match the filters" line directly beneath it.
  const filtersActive =
    activeTypes.length > 0 || activeLevels.length > 0 || activeCategoryClasses.length > 0

  // Same "how many dimensions are narrowed" count Home's own filter button
  // badge uses (tabs)/index.tsx's activeFilterCount) -- counts active
  // GROUPS (content/level/category-class), not total individual chips
  // selected within them, for consistency app-wide.
  const activeFilterCount = [
    activeTypes.length > 0,
    activeLevels.length > 0,
    activeCategoryClasses.length > 0,
  ].filter(Boolean).length

  const toggleType = (t: StudyItemType) => {
    setActiveTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    )
  }

  const toggleLevel = (l: StudyLevel) => {
    setActiveLevels((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]
    )
  }

  const toggleCategoryClass = (c: CategoryClass) => {
    setActiveCategoryClasses((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    )
  }

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      getStudyQueue(sessionSize, activeTypes, activeLevels, activeCategoryClasses),
      getStudyMastery(),
      getCurrency(),
      getStudyPoolCount(activeTypes, activeLevels, activeCategoryClasses),
    ])
      .then(([queue, m, c, pool]) =>
        // Facts are fetched AFTER the deck (not in the same Promise.all --
        // getStudyFactsForItems needs the deck's own item_ids to ask for)
        // and only for the up-to-20 items actually in it, not the whole
        // study_facts table -- see that function's own comment.
        getStudyFactsForItems(queue.map((c) => ({ item_type: c.item_type, item_id: c.item_id }))).then((facts) => {
          setStudyFacts(facts)
          // AIM and FAR items with no authored content fact are excluded
          // rather than falling back to citation-recall ("Which AIM
          // paragraph covers X?" / "Which FAR section is this?") -- see
          // getStudyFactsForItems' own comment. Coverage is high enough on
          // both (94% of FAR, ~100%+ of quizzable AIM, since some facted
          // AIM paragraphs fall outside the stricter D7 quizzable-uniqueness
          // view) that excluding the rest costs little. P/CG and AC do NOT
          // exclude: P/CG's own fallback (term<->definition) already IS
          // real content, not citation recall, and AC's fact coverage is
          // still sparse (13%, authoring AC was always scoped as a much
          // bigger separate job) -- excluding there would gut the AC pool
          // rather than just trim it.
          const filtered = queue.filter((c) =>
            c.item_type !== 'aim' && c.item_type !== 'far' ? true : facts.has(`${c.item_type}:${c.item_id}`)
          )
          setDeck(filtered)
          setMastery(m)
          setCurrency(c)
          setPoolCount(pool)
          setIndex(0)
          setFlipped(false)
          setSessionDone(filtered.length === 0)
        })
      )
      .finally(() => setLoading(false))
  }, [activeTypes, activeLevels, activeCategoryClasses, sessionSize])

  useEffect(() => {
    if (hasProAccess) load()
  }, [hasProAccess, load])

  const current = deck[index]

  // "Save for later" -- explicitly requested this session ("it would be
  // nice to be able to 'mark' quiz questions to be put into some kind of
  // 'storage bank'... or add it to a folder, or bookmark it"). Reuses the
  // exact same bookmark system as everywhere else in the app (Saved tab,
  // folders, sync) rather than a separate storage bank -- a flashcard IS
  // just the underlying FAR/AIM/P-CG/AC item, so bookmarking it here and
  // finding it in Saved later is the same mental model as bookmarking it
  // from the item's own detail screen.
  const [currentBookmarked, setCurrentBookmarked] = useState(false)
  useEffect(() => {
    if (!current) { setCurrentBookmarked(false); return }
    let cancelled = false
    isBookmarked(current.item_id).then((v) => { if (!cancelled) setCurrentBookmarked(v) })
    return () => { cancelled = true }
  }, [current?.item_id])

  const handleToggleBookmark = async () => {
    if (!current) return
    // Already indirectly gated by the whole screen's hasProAccess check
    // below (a non-Pro user can never reach this handler at all) -- this
    // synchronous re-check is just the same defensive backstop every other
    // bookmark handler in the app has (see FolderPicker.tsx's matching
    // comment), in case that ever changes.
    if (!hasProAccess) { router.push('/paywall?tier=pro'); return }
    // document_number/title must match what each type's OWN detail screen
    // writes (far/[id].tsx, aim/[id].tsx, pcg/[id].tsx, ac/[id].tsx), or
    // the same document bookmarked from two places renders differently in
    // Saved. Confirmed live as a real bug: passing the raw item_id here
    // showed a P/CG card as "TRAFFIC_NO_FACTOR" (the slug) stacked above
    // "TRAFFIC NO FACTOR" (the term) -- the same words twice.
    //
    // `current.term` is the queue's own display string, which for FAR/AIM/AC
    // already embeds the number ("§ 91.3 Responsibility...", "AC 121-33B:
    // Emergency Medical Equipment") -- strip that prefix back off for the
    // title so it isn't repeated next to document_number.
    const t = current.item_type
    const docNumber =
      t === 'far' ? `§ ${current.item_id}`
      // dictionary/[slug].tsx bookmarks itself with document_number =
      // entry.term (its slug is an internal id, not a citation) -- same
      // shape as pcg's own term-as-document_number convention, for the
      // same "bookmarked from two places must render identically" reason
      // this whole block exists.
      : t === 'pcg' || t === 'dictionary' ? current.term
      : current.item_id
    const title =
      t === 'far' ? current.term.replace(/^§\s*[\d.]+\s*/, '')
      : t === 'ac' ? current.term.replace(/^AC\s+[^:]+:\s*/, '')
      : t === 'aim' ? current.term.replace(/^[\d-]+\s*/, '')
      : current.term
    // Mark WHERE in the reg this Q/A came from, so opening the bookmark
    // jumps to that passage instead of the top of the document -- the same
    // idea as an AC highlight, reusing the existing blockText/blockSnippet
    // fields. Deliberately does NOT set `acId`: saved.tsx's stale-highlight
    // check filters on `blockText && acId` and resolves acId against
    // advisory_circulars, so setting it on a FAR/AIM/P-CG bookmark would
    // make every one of them render as "Section changed -- won't jump to
    // this spot anymore".
    //
    // Snippet comes from the definition text, not the displayed question:
    // shortenQuestion() may append an ellipsis, which would never match the
    // real body text it has to be found in.
    //
    // Real bug, confirmed live: a FAR/AIM section's body_text is routinely
    // several source paragraphs (intro clause, then "(a) Issue—", then
    // "(1) Original airworthiness...", etc., each separated by a blank line
    // in the raw scrape). Slicing straight from the RAW multi-paragraph
    // blob let passageSnippet's window span two or three of those -- e.g.
    // 183.31 produced "...following:\n\n(a) Issue—\n\n(1) Original
    // airworthiness" as one snippet. PlainTextBody/ACBody search one
    // NORMALIZED PARAGRAPH AT A TIME (normalizeRegBody splits on blank
    // lines), so a query spanning three of them can never match any single
    // one -- reopening the bookmark populated the search box (the raw hl
    // param) but highlighted nothing, exactly as reported. Fix: normalize
    // first, then only ever snippet from the FIRST resulting paragraph, so
    // the captured span can never cross a boundary the search itself
    // treats as absolute.
    const firstPara = normalizeRegBody(current.definition ?? '').split('\n\n')[0] ?? ''
    const raw = firstPara.trim()
    const snippet = passageSnippet(raw)
    const next = await toggleBookmark({
      id: current.item_id,
      itemType: t,
      document_number: docNumber,
      title,
      date_issued: null,
      office: null,
      subject_series: null,
      blockText: snippet || undefined,
      blockSnippet: snippet || undefined,
    })
    setCurrentBookmarked(next)
  }

  const handleAnswer = (correct: boolean) => {
    if (!current) return
    const item = current // capture -- index/current may have advanced by the time the network call resolves

    // Bug this fixes, confirmed live: tapping Knew/Missed used to set
    // BOTH setIndex(i+1) and setFlipped(false) in the same tick, after
    // awaiting the network call. The content swap (new card's Q/A) is
    // instant, but the flip-back is a 420ms animation -- so for that
    // whole window the card was mid-rotation showing the NEW card's BACK
    // face (its answer), spoiling it before the user ever saw its
    // question. Fix: flip back immediately (using the CURRENT card's own
    // content, so the reverse animation shows the right thing), and defer
    // the actual index advance until that animation has finished.
    setFlipped(false)
    const advance = () => {
      if (index + 1 >= deck.length) {
        setSessionDone(true)
        getStudyMastery().then(setMastery).catch(() => {})
      } else {
        setIndex((i) => i + 1)
      }
    }
    setTimeout(advance, FLIP_DURATION)

    recordStudyReview(item.item_id, correct, item.item_type)
      .then((result) => {
        if (result.newCoins.length > 0) {
          // Fires well after the card has already advanced -- a rewarding
          // moment shouldn't block or race the flip/advance flow.
          const coin = COIN_BY_CODE[result.newCoins[0]]
          if (coin) setTimeout(() => setRevealCoin(coin), 300)
          // Mark seen right away, not on modal dismiss -- the reveal here IS
          // the "shown to the user" moment. Without this, get_unseen_coins()
          // (the Duels-hub catch-up check built for the duel-win-toast-only-
          // shown-to-finalizer bug, see challenges/index.tsx) has no way to
          // know this coin was already celebrated here, and re-shows the
          // exact same coin a second time the next time the user opens the
          // Duels hub. Best-effort, same as the rest of this call chain --
          // never block the study flow on it.
          markCoinsSeen(result.newCoins).catch(() => {})
        }
      })
      .catch(() => {}) // best-effort -- don't block the study flow on a network blip
    getCurrency().then(setCurrency).catch(() => {})
  }

  if (!hasProAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Study Mode" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Study Mode is a Pro feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Flashcards, mastery tracking, and daily practice — join Pro to start building real recall, not just lookups.
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Pro</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  // RC: "RR needs a diff icon, it's not really about 'Groups'... change it
  // in SM screen to be the same thing" -- matches The Wing's own header
  // icon for this exact link now (search.tsx), see that file's comment.
  // Round 2: RC asked for the lightning bolt specifically -- free to reuse
  // it here now that Duels moved off it (first onto 'figure.fencing',
  // then onto 'trophy' per RC's round-2 ask -- see Icon.tsx).
  const headerRight = (
    <Pressable onPress={() => router.push('/ready-room')} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="bolt.fill" size={fs(20)} color={tokens.gold} />
    </Pressable>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Study Mode" onBack={() => router.back()} right={headerRight} />

      <TabletContainer>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      <Pressable style={styles.filtersHeader} onPress={() => setFiltersExpanded((v) => !v)} hitSlop={6}>
        {/* Same slider.horizontal.3 glyph Home's own filter button uses (see
            (tabs)/index.tsx) -- one consistent "this is a filter control"
            icon app-wide instead of a plain chevron. Tinted blue whenever
            any dimension is narrowed from its default, same as Home's own
            active-filter tint. RC, real device, second pass: the row's old
            "All content · 20 cards" summary duplicated the "Studying: X"
            line lower on this same screen, and the trailing chevron was a
            second "tap to expand" cue doing the same job as the icon itself
            -- "if these are saying basically the same thing, we don't need
            both... just keep the icon up top, and make it bigger." Right-
            aligned (filtersHeader's justifyContent) to match Home's filter
            button sitting on the right of its own row -- RC flagged the
            mismatch (left here, right on Home) as an inconsistency. */}
        <View style={styles.filtersIconWrap}>
          <Icon
            name="slider.horizontal.3"
            size={fs(24)}
            color={activeTypes.length > 0 || activeLevels.length > 0 || activeCategoryClasses.length > 0 ? tokens.blu : tokens.t3}
          />
          {activeFilterCount > 0 && (
            <View style={[styles.filterBadge, { backgroundColor: tokens.blu, borderColor: tokens.bg }]}>
              {/* Hardcoded black text (styles.filterBadgeText) only has real
                  contrast against Dark's bright tokens.blu (#4B8EF5, ~6.5:1).
                  Light's tokens.blu (#1A50CC) and Red Shift's (#BC4824) are
                  both notably darker/more saturated -- black-on-them measures
                  ~3:1 and ~4:1, under WCAG AA's 4.5:1 for text this small.
                  White clears AA on both of those (~6.9:1, ~5.1:1) while only
                  dropping Dark to ~3.2:1 -- so pick per-theme instead of one
                  fixed color, same "each theme is a real render, not a tint"
                  principle the rest of theme.tsx already follows. */}
              <Text style={[styles.filterBadgeText, { fontSize: fs(9.5), color: resolved === 'dark' && !redShift ? '#000' : '#fff' }]}>{activeFilterCount}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.filtersHeaderText, { color: tokens.t2, fontSize: fs(13.5) }]}>Filters</Text>
      </Pressable>
      {filtersExpanded && (
      <>
      <Text style={[styles.filterGroupLabel, { color: tokens.gold, fontSize: fs(10) }]}>CONTENT</Text>
      <View style={styles.filterRow}>
        <Pressable
          style={[
            styles.filterChip,
            { backgroundColor: activeTypes.length === 0 ? tokens.goldlt : tokens.bg2, borderColor: activeTypes.length === 0 ? tokens.goldbdr : tokens.bdr },
          ]}
          onPress={() => setActiveTypes([])}
        >
          <Text style={[styles.filterChipText, { color: activeTypes.length === 0 ? tokens.gold : tokens.t3, fontSize: fs(11.5) }]}>ALL</Text>
        </Pressable>
        {ALL_TYPES.map((t) => {
          const active = activeTypes.includes(t)
          return (
            <Pressable
              key={t}
              style={[
                styles.filterChip,
                { backgroundColor: active ? tokens.goldlt : tokens.bg2, borderColor: active ? tokens.goldbdr : tokens.bdr },
              ]}
              onPress={() => toggleType(t)}
            >
              <Text style={[styles.filterChipText, { color: active ? tokens.gold : tokens.t3, fontSize: fs(11.5) }]}>
                {TYPE_LABEL[t]}
              </Text>
            </Pressable>
          )
        })}
      </View>
      {/* Blue accent (vs. content's gold) so the two filter groups read as
          visually distinct dimensions at a glance, not one long ambiguous
          chip row. */}
      {/* RC, 2026-08-13: folded Instrument/Airframe/Powerplant into this
          same row/state instead of a separate RATING group -- see
          StudyLevel's own comment in challenges.ts for the full "why."
          One shared multi-select, one strict-intersection filter; every
          value (cert level or rating) can now genuinely be turned off. */}
      <Text style={[styles.filterGroupLabel, styles.levelFilterRow, { color: tokens.blu, fontSize: fs(10) }]}>KNOWLEDGE LEVEL</Text>
      <View style={styles.filterRow}>
        <Pressable
          style={[
            styles.filterChip,
            { backgroundColor: activeLevels.length === 0 ? tokens.bdim : tokens.bg2, borderColor: activeLevels.length === 0 ? tokens.blu : tokens.bdr },
          ]}
          onPress={() => setActiveLevels([])}
        >
          <Text style={[styles.filterChipText, { color: activeLevels.length === 0 ? tokens.blu : tokens.t3, fontSize: fs(11.5) }]}>ALL</Text>
        </Pressable>
        {ALL_STUDY_LEVELS.map((l) => {
          const active = activeLevels.includes(l)
          return (
            <Pressable
              key={l}
              style={[
                styles.filterChip,
                { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.blu : tokens.bdr },
              ]}
              onPress={() => toggleLevel(l)}
            >
              <Text style={[styles.filterChipText, { color: active ? tokens.blu : tokens.t3, fontSize: fs(11.5) }]}>
                {STUDY_LEVEL_LABELS[l]}
              </Text>
            </Pressable>
          )
        })}
      </View>

      <Pressable
        style={[styles.moreFiltersToggle, styles.levelFilterRow]}
        onPress={() => setMoreFiltersExpanded((v) => !v)}
      >
        <Icon name={moreFiltersExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.t3} />
        <Text style={[styles.moreFiltersToggleText, { color: tokens.t3, fontSize: fs(11.5) }]}>
          {moreFiltersExpanded ? 'Fewer filters' : 'More filters (Category/Class)'}
          {!moreFiltersExpanded && activeCategoryClasses.length > 0 ? ' •' : ''}
        </Text>
      </Pressable>
      {moreFiltersExpanded && (
      <>
      {/* Green accent, distinct from CONTENT (gold) and KNOWLEDGE LEVEL
          (blue) -- a third filter dimension so an ASEL student stops
          getting glider/helicopter-only questions and vice versa. Only a
          minority of content is genuinely category/class-specific (most
          FAR/AC/P-CG entries apply to every rating), so unmatched items
          stay visible under any selection -- same "NULL means universal"
          convention as Knowledge Level's own far_knowledge_levels(). */}
      <Text style={[styles.filterGroupLabel, styles.levelFilterRow, { color: tokens.grn, fontSize: fs(10) }]}>CATEGORY / CLASS</Text>
      <View style={styles.filterRow}>
        <Pressable
          style={[
            styles.filterChip,
            { backgroundColor: activeCategoryClasses.length === 0 ? tokens.bdim : tokens.bg2, borderColor: activeCategoryClasses.length === 0 ? tokens.grn : tokens.bdr },
          ]}
          onPress={() => setActiveCategoryClasses([])}
        >
          <Text style={[styles.filterChipText, { color: activeCategoryClasses.length === 0 ? tokens.grn : tokens.t3, fontSize: fs(11.5) }]}>ALL</Text>
        </Pressable>
        {CATEGORY_CLASSES.map((c) => {
          const active = activeCategoryClasses.includes(c)
          return (
            <Pressable
              key={c}
              style={[
                styles.filterChip,
                { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.grn : tokens.bdr },
              ]}
              onPress={() => toggleCategoryClass(c)}
            >
              <Text style={[styles.filterChipText, { color: active ? tokens.grn : tokens.t3, fontSize: fs(11.5) }]}>
                {RATING_SHORT_LABELS[c]}
              </Text>
            </Pressable>
          )
        })}
      </View>
      </>
      )}

      <Text style={[styles.filterGroupLabel, styles.levelFilterRow, { color: tokens.t3, fontSize: fs(10) }]}>SESSION SIZE</Text>
      <View style={styles.filterRow}>
        {SESSION_SIZES.map((n) => {
          const active = sessionSize === n
          return (
            <Pressable
              key={n}
              style={[
                styles.filterChip,
                { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.blu : tokens.bdr },
              ]}
              onPress={() => changeSessionSize(n)}
            >
              <Text style={[styles.filterChipText, { color: active ? tokens.blu : tokens.t3, fontSize: fs(11.5) }]}>{n}</Text>
            </Pressable>
          )
        })}
      </View>
      </>
      )}

      {/* Hidden once a card is actively on screen (current && !sessionDone)
          -- RC, real device: "make it so that while playing, the app
          centers the 'gaming area' up on the screen." The mastery/streak
          summary is pre-session and post-session context, not something
          you need on every single flip; dropping it during play reclaims
          the vertical space that was pushing the answer buttons off the
          bottom of the screen. */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : (sessionDone || !current) && (mastery || (currency && currency.currentStreak > 0)) ? (
        // Mastery + streak grouped into one bordered card instead of two
        // loose rows stacked directly in the scroll flow -- RC, real
        // device: "the other stuff is pretty packed together." Grouping
        // "your stats" as one visually contained unit reads as organized;
        // two ungrouped rows back to back just reads as more stacking.
        <View style={[styles.statsCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {mastery && (
            <View style={styles.gaugeRow}>
              {/* A plain color-graded badge, not a partial-fill ring -- a ring
                  drawn from rotated View borders only sweeps correctly up to
                  50%; rendering past that needs react-native-svg, a new native
                  dependency this session can't build/test (web preview only).
                  Honest and correct beats a good-looking-until-51% gauge. What
                  IS accurate without SVG: the border color and glow intensity
                  both track mastery % directly (dull -> gold, see masteryGlow
                  above), so the badge still visibly communicates progress. */}
              <Reanimated.View
                style={[
                  styles.gaugeBadge,
                  {
                    backgroundColor: tokens.bg,
                    borderColor: lerpColor(MASTERY_RING_DULL, tokens.gold, mastery.pct / 100),
                    shadowColor: tokens.gold,
                    shadowRadius: 9,
                    shadowOffset: { width: 0, height: 0 },
                  },
                  masteryGlowStyle,
                ]}
              >
                <Text style={[styles.gaugeNum, { color: tokens.t1, fontSize: fs(19) }]}>{mastery.pct}</Text>
                <Text style={[styles.gaugeUnit, { color: tokens.t4, fontSize: fs(8.5) }]}>PCT</Text>
              </Reanimated.View>
              <View style={styles.gaugeMeta}>
                <Text style={[styles.gaugeMetaTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>Overall Mastery</Text>
                <Text style={[styles.gaugeMetaSub, { color: tokens.t4, fontSize: fs(11.5) }]}>
                  {/* "items total" is the WHOLE corpus (mastery is tracked across
                      everything, not per filter). Saying "6,283 items total" while
                      the filter line right below reads "1,316 items match" reads as
                      a contradiction, so it's labelled as the full corpus whenever
                      a filter is narrowing the deck. */}
                  {mastery.mastered} mastered of {mastery.seen} reviewed ·{' '}
                  {mastery.total_available} {filtersActive ? 'in full corpus' : 'items total'}
                </Text>
              </View>
            </View>
          )}

          {currency && currency.currentStreak > 0 && (
            <View style={[styles.currencyBadge, mastery ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.bdr } : null]}>
              <View style={[styles.currencyIcon, { borderColor: tokens.gold }]}>
                <Icon name="bolt.fill" size={fs(14)} color={tokens.gold} />
              </View>
              <View>
                <Text style={[styles.currencyTitle, { color: tokens.t1, fontSize: fs(13) }]}>
                  Current — {currency.currentStreak} day{currency.currentStreak === 1 ? '' : 's'}
                </Text>
                <Text style={[styles.currencySub, { color: tokens.t4, fontSize: fs(10.5) }]}>
                  Lapses after a day with no study session
                </Text>
              </View>
            </View>
          )}
        </View>
      ) : null}

      {!loading && sessionDone && (
        <View style={styles.center}>
          <Icon name="checkmark.circle" size={fs(40)} color={tokens.gold} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>
            {deck.length === 0 ? 'Nothing due right now' : 'Session complete'}
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            {deck.length === 0
              ? "You've reviewed everything that's due. Check back later, or come back tomorrow for more."
              : 'Come back tomorrow — cards you missed will resurface sooner than the ones you know cold.'}
          </Text>
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={load}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Refresh</Text>
          </Pressable>
        </View>
      )}

      {!loading && !sessionDone && current && (
        <View style={styles.cardArea}>
          {/* Names every active CONTENT/KNOWLEDGE LEVEL filter, not just the
              current card's own single type -- the gold type badge below
              only ever showed what THIS card happens to be, which reads
              like a bug once more than one content type is selected
              (confirmed confusing live: "it should list each filter
              you're using"). */}
          <Text style={[styles.activeFilters, { color: tokens.t3, fontSize: fs(11) }]}>
            Studying: {activeTypes.length === 0 ? 'All content' : activeTypes.map((t) => TYPE_LABEL[t]).join(', ')}
            {activeLevels.length > 0 ? ` · ${activeLevels.map((l) => STUDY_LEVEL_LABELS[l]).join(', ')}` : ''}
            {activeCategoryClasses.length > 0 ? ` · ${activeCategoryClasses.map((c) => RATING_SHORT_LABELS[c]).join(', ')}` : ''}
          </Text>
          <View style={styles.progressRow}>
            <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(11.5) }]}>
              {index + 1} / {deck.length}{current.is_new ? ' · new' : ''}
            </Text>
            {/* Flip (term/definition order) moved here from its own standalone
                row up near Filters -- RC, real device: "the 'flip Q/A' button
                is oddly placed." It's a per-card control, so it now lives with
                the other per-card control (bookmark) instead of floating up
                near session setup; it also only shows once a card actually
                exists to flip. Condensed from a full sentence to icon + two
                words so it fits this tighter row without recreating the same
                clutter it was moved to fix. */}
            <View style={styles.cardControls}>
              <Pressable onPress={toggleRevealDirection} hitSlop={10} style={styles.flipBtn}>
                <Icon name="arrow.uturn.left" size={fs(15)} color={tokens.t3} />
                <Text style={[styles.flipBtnText, { color: tokens.t3, fontSize: fs(11) }]}>
                  {revealDirection === 'defFirst' ? 'Def first' : 'Term first'}
                </Text>
              </Pressable>
              <Pressable onPress={handleToggleBookmark} hitSlop={10} style={styles.bookmarkBtn}>
                <Icon name={currentBookmarked ? 'bookmark.fill' : 'bookmark'} size={fs(20)} color={currentBookmarked ? tokens.gold : tokens.t3} />
              </Pressable>
            </View>
          </View>
          {poolCount != null && (
            // This session is always a small batch (getStudyQueue caps at
            // 20) -- without this, "1 / 20" reads like the whole filtered
            // pool is 20 items, which is wrong the moment ALL is selected
            // (thousands). Shows what the CONTENT/KNOWLEDGE LEVEL filters
            // above actually resolve to, so it stays honest either way.
            <Text style={[styles.poolCount, { color: tokens.t4, fontSize: fs(11) }]}>
              {poolCount.toLocaleString()} item{poolCount === 1 ? '' : 's'} match{poolCount === 1 ? 'es' : ''} the filters above
            </Text>
          )}

          <View style={styles.cardWithBadge}>
            {/* Which reg this Q/A is FROM, made hard to miss -- was a tiny
                pill sitting in the progress row above the card, easy to
                skim right past. Confirmed live: "let's make this chip more
                prominent... something easier to recognize." Now a tag
                overlapping the card's own top-left corner, like a label
                clipped onto it, so it reads as part of the card itself
                rather than incidental metadata next to it. */}
            <View style={[styles.typeBadge, { backgroundColor: tokens.gold, borderColor: tokens.bg }]}>
              <Text style={[styles.typeBadgeText, { color: '#1c1c1f', fontSize: fs(13) }]}>{TYPE_LABEL[current.item_type]}</Text>
            </View>
            <FlashCard
              term={current.term}
              definition={current.definition}
              itemType={current.item_type}
              fact={studyFacts.get(`${current.item_type}:${current.item_id}`)}
              direction={revealDirection}
              flipped={flipped}
              onPress={() => setFlipped((f) => !f)}
              tokens={tokens}
              fs={fs}
            />
          </View>

          {/* Always rendered (not `{flipped && ...}`) so it never appears as
              NEW content that pushes the page taller on flip -- that was the
              actual bug behind RC's "I have to scroll down" complaint: the
              row didn't exist in the tree until flipped became true. Each
              button now toggles its OWN opacity/pointerEvents (not the whole
              row at once, like before) so Reveal and Missed/Knew can be
              inverses of each other within the same fixed-height row.
              RC, real device, second pass: pinning this row low on screen
              fixed the "buttons moved on flip" bug, but created a new one --
              "now the user has to tap the card, then go down to tap the
              button." The card itself still flips on tap (unchanged), but
              Reveal gives a second, reachable way to do it without a thumb
              trip up to the card and back down to this row. */}
          <View style={styles.answerRow}>
            <Pressable
              style={[styles.answerBtn, { borderColor: tokens.bdr, opacity: flipped ? 1 : 0, pointerEvents: flipped ? 'auto' : 'none' }]}
              onPress={() => handleAnswer(false)}
            >
              <Icon name="xmark" size={fs(16)} color={tokens.t3} />
              <Text style={[styles.answerText, { color: tokens.t2, fontSize: fs(13.5) }]} numberOfLines={1}>Missed it</Text>
            </Pressable>
            {/* Icon-only and NOT flex:1, unlike the two answer buttons either
                side of it -- RC, real device, annotated screenshot: "these
                buttons are looking crammed to the edges on my phone... that
                'reveal' button can be smaller, even just a 'flip' icon, to
                save space." A 3-way equal flex split left Missed it/Knew it
                noticeably narrower than before this button existed; giving
                Reveal a small fixed width instead gives the other two back
                most of that room. */}
            <Pressable
              style={[styles.revealBtn, { borderColor: tokens.bbdr, backgroundColor: tokens.bdim, opacity: flipped ? 0 : 1, pointerEvents: flipped ? 'none' : 'auto' }]}
              onPress={() => setFlipped((f) => !f)}
              hitSlop={8}
            >
              <Icon name="arrow.triangle.2.circlepath" size={fs(17)} color={tokens.blu} />
            </Pressable>
            <Pressable
              style={[styles.answerBtn, styles.answerBtnGood, { borderColor: tokens.goldbdr, backgroundColor: tokens.goldlt, opacity: flipped ? 1 : 0, pointerEvents: flipped ? 'auto' : 'none' }]}
              onPress={() => handleAnswer(true)}
            >
              <Icon name="checkmark" size={fs(16)} color={tokens.gold} />
              <Text style={[styles.answerText, { color: tokens.gold, fontSize: fs(13.5) }]} numberOfLines={1}>Knew it</Text>
            </Pressable>
          </View>
        </View>
      )}
      </ScrollView>
      </TabletContainer>
      <CoinRevealModal coin={revealCoin} onClose={() => setRevealCoin(null)} />
    </View>
  )
}

// ─── Flash card (vertical-axis flip) ────────────────────────────────────────
// Front (term) and back (definition) are two stacked, absolutely-positioned
// faces sharing one rotateY progress value -- the standard flip-card
// technique: the back face starts pre-rotated 180deg so it's showing
// exactly when the front finishes rotating away, and backfaceVisibility
// hides whichever face is turned away from the viewer instead of needing a
// separate opacity toggle timed to the halfway point.

// Confirmed live as a real complaint, not a nitpick: a full multi-sentence
// P/CG definition with several blanked-out phrases reads as a dense
// paragraph puzzle, not a quick quiz question -- and since cardSizer sizes
// the whole card off this same text, a long question also produced an
// oversized, mostly-empty box even for cards whose answer face was two
// words. Only the QUESTION side gets shortened -- the reveal/answer side
// always shows the full, unedited FAA text (see feedback_data_is_king.md:
// the source text itself is the product, truncating what the user is
// actually being told the answer IS would misinform them, not just look
// bad). Cuts at the nearest sentence boundary at or before the limit; falls
// back to the nearest word boundary if the first sentence alone is still
// too long.
// A bookmarked flashcard highlights the passage its Q/A came from, so the
// snippet has to END SOMEWHERE THAT READS AS A COMPLETE THOUGHT. Cutting at
// a word boundary looked broken in the real app -- the highlight stopped
// mid-clause ("...areas of aviation safety and") with no visible reason,
// which reads as a rendering bug rather than a deliberate marker.
//
// Prefer the last sentence end inside a generous window; a leading stub like
// AIM's "General." is far too short to be the whole highlight, hence the
// MIN floor. Falls back to a word boundary only when the passage genuinely
// contains no sentence break.
const SNIPPET_MAX = 220
const SNIPPET_MIN = 45
function passageSnippet(raw: string): string {
  const text = raw.trim()
  if (text.length <= SNIPPET_MIN) return text
  const window = text.slice(0, SNIPPET_MAX)
  let best = -1
  const re = /[.!?](?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(window)) !== null) {
    if (m.index + 1 >= SNIPPET_MIN) best = m.index + 1
  }
  if (best > 0) return text.slice(0, best)
  const cut = text.slice(0, SNIPPET_MAX)
  const lastSpace = cut.lastIndexOf(' ')
  return lastSpace > SNIPPET_MIN ? cut.slice(0, lastSpace) : cut
}

const QUESTION_MAX_CHARS = 170
function shortenQuestion(text: string, max = QUESTION_MAX_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const window = trimmed.slice(0, max + 1)
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '))
  if (sentenceEnd > 40) return trimmed.slice(0, sentenceEnd + 1)
  const wordBoundary = window.slice(0, max).lastIndexOf(' ')
  return `${trimmed.slice(0, wordBoundary > 40 ? wordBoundary : max)}…`
}

function FlashCard({
  term,
  definition,
  itemType,
  fact,
  direction,
  flipped,
  onPress,
  tokens,
  fs,
}: {
  term: string
  definition: string
  itemType: StudyItemType
  /** Real content-recall Q/A for this item, when one exists -- see
   * getStudyFactsForItems' own comment. Overrides buildStudyCard entirely
   * when present, for any item type; undefined when none was authored. */
  fact?: StudyFact
  direction: RevealDirection
  flipped: boolean
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withTiming(flipped ? 1 : 0, { duration: FLIP_DURATION, easing: Easing.inOut(Easing.quad) })
  }, [flipped])

  // opacity is a belt-and-suspenders addition to backfaceVisibility, not a
  // replacement for it -- confirmed live as a real bug once each face's
  // text got wrapped in a ScrollView (see cardTextScroll): RN Web's
  // backface-visibility:hidden doesn't reliably hide a nested scrollable
  // container's content once rotated past 90deg in every browser, so the
  // rotated-away face's (mirrored) text was bleeding through on top of the
  // visible face. Snapping opacity to 0 at the halfway point (when the
  // card is edge-on anyway, so the cut isn't visible) hides it regardless
  // of the browser's own backface-visibility support.
  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1400 }, { rotateY: `${progress.value * 180}deg` }],
    opacity: progress.value < 0.5 ? 1 : 0,
  }))
  const backStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1400 }, { rotateY: `${progress.value * 180 - 180}deg` }],
    opacity: progress.value >= 0.5 ? 1 : 0,
  }))

  // No fill-in-the-blank redaction, for any type -- confirmed unwanted
  // live and explicitly rejected twice ("NO blank spaces. just ask a
  // straight question. then let the user tap to reveal."). A P/CG
  // definition that happens to reuse its own term's word (roughly 54% of
  // terms do, per a direct DB audit) just reads as ordinary prose; the
  // flip still reveals the actual term, which is the thing being tested,
  // not the blanked word itself.
  // A REAL question, not a slab of the regulation. `term` embeds the
  // document number for FAR/AIM/AC ("§ 91.3 Responsibility and authority..."),
  // so it is split back into number + title to anchor the question properly.
  // See quizQuestion.ts for why the card used to show raw reg text and why
  // that made the deck unusable.
  const docNumber =
    itemType === 'far' ? `§ ${term.match(/^§?\s*([\d.]+)/)?.[1] ?? term}`
    : itemType === 'aim' ? (term.match(/^([\d-]+)/)?.[1] ?? term)
    : itemType === 'ac' ? (term.match(/^AC\s+([^:]+)/)?.[1] ?? term)
    : term
  const docTitle =
    itemType === 'far' ? term.replace(/^§?\s*[\d.]+\s*/, '')
    : itemType === 'ac' ? term.replace(/^AC\s+[^:]+:\s*/, '')
    : itemType === 'aim' ? term.replace(/^[\d-]+\s*/, '')
    : term
  // RC's flashcard contract (2026-07-31): Q is one short sentence, A is a
  // reg name/number — see buildStudyCard() for the full shape per type. The
  // old model revealed the raw regulation body as the "answer", which was a
  // wall of text and got rejected on sight.
  //
  // AIM is the one exception: a real authored content fact (see `fact`'s
  // own comment) completely replaces buildStudyCard's "Which AIM paragraph
  // covers X?" shape when one exists for this paragraph -- reference-recall
  // on an internal indexing scheme isn't a real skill, rejected live by RC.
  // Reverse direction flips it the same way P/CG's def<->term already does:
  // see the answer, recall the question.
  const faces = fact
    ? { question: fact.question, answer: fact.answer, reverseFront: fact.answer, reverseBack: fact.question }
    : buildStudyCard({
        type: itemType as QuizSourceType,
        documentNumber: docNumber,
        title: docTitle,
        text: definition,
      })

  const frontText = direction === 'defFirst' ? faces.question : faces.reverseFront
  const backText = direction === 'defFirst' ? faces.answer : faces.reverseBack

  // Style by what the face actually CONTAINS, not by which direction we're
  // in. The direction-based version assumed the defFirst back face was
  // always a short term -- but for FAR/AIM it's the full passage, so a
  // multi-paragraph body got rendered in the big bold centered term style.
  // Seen live on AIM 11-2-1: every line clipped at both edges
  // ("t 107 sUAS", "wledge test"). Content-driven selection also gets the
  // new short AC answer ("AC 36-1H") the large treatment it deserves.
  const isLongFace = (s: string) => (s ?? '').length > 120
  const frontStyleText = isLongFace(frontText) ? styles.cardDef : styles.cardTerm
  const backStyleText = isLongFace(backText) ? styles.cardDef : styles.cardTerm
  const frontColor = direction === 'defFirst' ? tokens.t2 : tokens.t1
  const backColor = direction === 'defFirst' ? tokens.t1 : tokens.t2
  const frontFs = isLongFace(frontText) ? fs(15) : fs(22)
  const backFs = isLongFace(backText) ? fs(15) : fs(22)

  // RC: "Q/As are better. but for FAR AIM etc, when the worded answer is
  // revealed, underneath that and smaller it should show the FAR or AIM
  // section/part that the answer came from (even though it's not part of
  // our official answer) we still want to show it for ref." `docNumber`
  // above is already the real source citation (§ section / AIM paragraph /
  // AC number) -- P/CG was excluded on the reasoning that its `term` IS the
  // citation already, nothing separate to point to.
  //
  // RC, 2026-08-13, real example: that reasoning only holds when there's NO
  // authored `fact` -- without one, buildStudyCard's P/CG card genuinely
  // does put the term on one face and the definition on the other, so the
  // term is always already visible. But once a `fact` exists, `faces`
  // above is built entirely from fact.question/fact.answer -- neither of
  // which is the glossary term itself (e.g. a "what three items are NOT
  // included" question whose answer is the three items, not "CLEARED AS
  // FILED") -- so the term silently disappeared with nothing telling the
  // user which glossary entry the question came from. Same citation-line
  // treatment as FAR/AIM/AC now applies here too, specifically for this
  // fact-backed case, using the term itself (title-cased -- pcg_terms
  // stores it shouting-case, "CLEARED AS FILED") as the citation text.
  const showCitation = itemType === 'far' || itemType === 'aim' || itemType === 'ac' || ((itemType === 'pcg' || itemType === 'dictionary') && !!fact)
  // dictionary_terms.term is already correctly cased in the source data
  // (unlike pcg_terms.term, always shouting-case) -- toTitleCase() would
  // wrongly lowercase real acronyms like "COMBATS" or "RAOB".
  const citationText = itemType === 'pcg' ? toTitleCase(term) : itemType === 'dictionary' ? term : docNumber

  return (
    <Pressable style={styles.cardOuter} onPress={onPress}>
      {/* Invisible sizer, stacked normally (not absolute like the two real
          faces below) so it's what actually gives cardOuter its height.
          Without this, the container's height came from whichever face
          happened to be in normal flow (the front one) -- fine when both
          faces are similar length, but confirmed live as a real bug for a
          long AIM definition + short term: flipping to the short back
          face left the tall front-sized gap empty above the answer
          buttons, pushing them far down the screen for no visible reason.
          Stacking both real texts here (rather than measuring and taking
          the max) means the card is sized for the longer of the two,
          whichever one that is. */}
      <View style={styles.cardSizer} pointerEvents="none">
        <Text style={[frontStyleText, { fontSize: frontFs, opacity: 0 }]}>{frontText}</Text>
        {/* Sized in here too, or a citation line pushes the real content
            past the sizer's own height and has to scroll for the extra
            ~20px instead of just fitting. */}
        {showCitation && <Text style={[styles.cardCitation, itemType === 'pcg' && styles.cardCitationItalic, { fontSize: fs(11), opacity: 0 }]}>{citationText}</Text>}
        <Text style={[backStyleText, { fontSize: backFs, opacity: 0 }]}>{backText}</Text>
      </View>
      <Reanimated.View
        style={[styles.card, styles.cardFace, frontStyle, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
      >
        {/* Card height is now capped (see cardSizer/card's maxHeight) so a
            long definition can't blow the card up to fill the whole
            screen -- confirmed live as its own new bug once the sizer fix
            landed: a two-line answer sat inside a nearly-empty box the
            height of the longest possible question. Overflow scrolls
            inside the card instead of growing it further. */}
        <ScrollView style={styles.cardTextScroll} contentContainerStyle={styles.cardTextScrollContent}>
          <Text style={[frontStyleText, { color: frontColor, fontSize: frontFs }]}>{frontText}</Text>
          {showCitation && frontText === faces.answer && (
            <Text style={[styles.cardCitation, itemType === 'pcg' && styles.cardCitationItalic, { color: tokens.t4, fontSize: fs(11) }]}>{citationText}</Text>
          )}
        </ScrollView>
        <Text style={[styles.cardHint, { color: tokens.t4, fontSize: fs(11) }]}>Tap to reveal</Text>
      </Reanimated.View>
      <Reanimated.View
        style={[styles.card, styles.cardFace, styles.cardBack, backStyle, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
      >
        <ScrollView style={styles.cardTextScroll} contentContainerStyle={styles.cardTextScrollContent}>
          <Text style={[backStyleText, { color: backColor, fontSize: backFs }]}>{backText}</Text>
          {showCitation && backText === faces.answer && (
            <Text style={[styles.cardCitation, itemType === 'pcg' && styles.cardCitationItalic, { color: tokens.t4, fontSize: fs(11) }]}>{citationText}</Text>
          )}
        </ScrollView>
        <Text style={[styles.cardHint, { color: tokens.t4, fontSize: fs(11) }]}>Tap to flip back</Text>
      </Reanimated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // flexGrow (not flex) on the ScrollView's own content container: lets
  // short content (loading/empty states, which use flex:1 centering
  // internally) still fill and center within the viewport, while letting
  // genuinely tall content (a long definition + answer buttons) grow past
  // the viewport and actually scroll -- the screen had no ScrollView at
  // all before this, so a long card's answer buttons could run off the
  // bottom of the screen with no way to reach them.
  scrollContent: { flexGrow: 1, paddingBottom: 24 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 280 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },

  filterGroupLabel: { fontWeight: '700', letterSpacing: 0.5, paddingHorizontal: 20, paddingTop: 14 },
  moreFiltersToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 20 },
  moreFiltersToggleText: { fontWeight: '600' },
  filtersHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 },
  filtersHeaderText: { fontWeight: '700' },
  // Same shape/position as Home's own filterBadge ((tabs)/index.tsx) --
  // top-right of the icon, a bg-colored ring so it reads as a distinct
  // dot rather than clipping into the glyph underneath.
  filtersIconWrap: { position: 'relative' },
  filterBadge: {
    position: 'absolute', top: -6, right: -8, minWidth: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3, borderWidth: 1.5,
  },
  // RC, live: white-on-blue at this size didn't show up well -- black reads
  // clearer against tokens.blu's mid-brightness. Matches Home's own badge
  // (tabs)/index.tsx, same fix applied there too.
  filterBadgeText: { color: '#000', fontSize: 9.5, fontWeight: '800' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingTop: 8 },
  levelFilterRow: { marginTop: 10 },
  filterChip: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  filterChipText: { fontWeight: '700', letterSpacing: 0.3 },

  // Mastery + streak now live inside this one bordered card (see the JSX
  // comment above) instead of as two bare rows -- gives "your stats" a
  // visible boundary instead of blending into the rest of the stacked
  // controls above/below it.
  statsCard: { marginHorizontal: 20, marginTop: 14, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  gaugeRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 14 },
  gaugeBadge: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  gaugeNum: { fontWeight: '700' },
  gaugeUnit: { letterSpacing: 0.5, marginTop: -2 },
  gaugeMeta: { flex: 1 },
  gaugeMetaTitle: { fontWeight: '600' },
  gaugeMetaSub: { marginTop: 2 },

  currencyBadge: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 },
  currencyIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  currencyTitle: { fontWeight: '600' },
  currencySub: { marginTop: 1 },

  cardArea: { flex: 1, padding: 20, alignItems: 'center' },
  activeFilters: { fontWeight: '600', marginBottom: 6, textAlign: 'center' },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 6 },
  cardControls: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  flipBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  flipBtnText: { fontWeight: '600' },
  // 24 (was 12) so the card's overlaid type badge -- which pokes up 14px
  // above the card's own top edge, see typeBadge below -- can never
  // encroach on this text. RC, real device: "make sure the 'reg tag' isn't
  // covering up the question pool count": at the old 12px margin the badge's
  // -14px reach already ate into it by 2px at baseline, before even
  // accounting for font metrics/line-height at larger text-size-slider
  // settings -- there was never real clearance here, at any scale.
  poolCount: { marginBottom: 24 },
  progress: { fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
  // Relative anchor for the overlaid type badge below -- width matches the
  // card's own 100% so the badge's left-alignment lines up with the card's
  // left edge, not the (potentially narrower) TabletContainer around it.
  // Fixed at MAX_CARD_HEIGHT (not sized to content, unlike cardOuter/
  // cardSizer below) so the answer-button row that follows always lands at
  // the exact same Y position, on every card, flipped or not -- RC, real
  // device: "the Missed/Knew buttons are just off the bottom, so each time
  // the answer flips over, I have to scroll down... design the M/K buttons
  // to stay fixed... so they never overlap." A short card just leaves quiet
  // space below it inside this box instead of the card itself stretching --
  // the card's own visible box still shrink-wraps to content (see
  // cardSizer), so a short answer still doesn't sit in an oversized empty
  // bordered box either.
  cardWithBadge: { width: '100%', alignItems: 'center', height: MAX_CARD_HEIGHT },
  // Overlaps the card's own top-left corner by half its own height (top is
  // negative) -- reads as a tag clipped onto the card, not a separate
  // element floating above it. zIndex/elevation so it draws over the
  // card's border on both platforms.
  typeBadge: {
    position: 'absolute', top: -14, left: 18, zIndex: 2, elevation: 4,
    borderRadius: 8, borderWidth: 2, paddingHorizontal: 11, paddingVertical: 5,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4,
  },
  bookmarkBtn: { padding: 2 },
  typeBadgeText: { fontWeight: '800', letterSpacing: 0.5 },
  cardOuter: { width: '100%', minHeight: 200 },
  // Reserves cardOuter's real height (see the sizer comment above) -- both
  // real faces are absolutely positioned now (moved from just the back
  // face onto the shared cardFace style below), since this is what gives
  // the container its layout height instead. Capped at MAX_CARD_HEIGHT so
  // a long definition can't blow the card up to fill the whole screen;
  // matches `card`'s own cap so the sizer and the real faces agree on the
  // ceiling.
  cardSizer: { width: '100%', minHeight: 200, maxHeight: MAX_CARD_HEIGHT, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  card: {
    width: '100%', minHeight: 200, maxHeight: MAX_CARD_HEIGHT, borderRadius: 18, borderWidth: 1, padding: 24,
  },
  cardFace: {
    backfaceVisibility: 'hidden',
    // bottom: 0 (not just top/left/right) so this actually stretches to
    // fill cardOuter's full height -- without it, an absolutely positioned
    // view with no explicit height sizes to its OWN content only, so once
    // cardOuter was made tall enough for the longer face (see cardSizer),
    // the shorter face just floated as a small box at the top with a
    // large empty gap below it before the answer buttons, which was worse
    // than the original bug.
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  },
  cardBack: {},
  // Fills `card` (minus its padding) and centers short content the same
  // way the old plain View + justifyContent:'center' did; content taller
  // than the card's capped height scrolls within this instead of pushing
  // the card's own bounds out.
  cardTextScroll: { flex: 1, width: '100%' },
  cardTextScrollContent: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 18 },
  // width:'100%' is load-bearing. cardTextScrollContent centers its children
  // with alignItems:'center', which makes a Text size to its own intrinsic
  // width instead of the card's -- a long passage then overflowed the card
  // and was clipped at BOTH edges rather than wrapping.
  cardTerm: { fontWeight: '700', textAlign: 'center', width: '100%' },
  cardDef: { textAlign: 'center', lineHeight: 22, width: '100%' },
  cardCitation: { textAlign: 'center', marginTop: 10, fontWeight: '600', letterSpacing: 0.3 },
  // RC, 2026-08-13: "maybe in italics, if that helps" -- for the P/CG
  // source term specifically, distinguishing "this is the glossary entry
  // the question came from" from FAR/AIM/AC's plain-style section/doc
  // citation just above it.
  cardCitationItalic: { fontStyle: 'italic' },
  cardHint: { position: 'absolute', bottom: 14 },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20, width: '100%' },
  answerBtn: {
    flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 14, borderWidth: 1, paddingVertical: 13, paddingHorizontal: 4,
  },
  answerBtnGood: {},
  // Fixed square icon button, not flex:1 -- see the JSX comment above. Same
  // height as answerBtn's own (13 vertical padding either side of a fs(17)
  // icon lands close enough to answerBtn's real rendered height that the
  // row reads as one aligned set, without needing to hardcode a match).
  revealBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: 14, borderWidth: 1,
  },
  answerText: { fontWeight: '600' },
})
