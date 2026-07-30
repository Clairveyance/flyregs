import { useEffect, useState, useCallback } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Alert } from 'react-native'
import Reanimated, { useSharedValue, useAnimatedStyle, withTiming, Easing } from 'react-native-reanimated'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { getStudyQueue, recordStudyReview, getStudyMastery, getCurrency, StudyCard, StudyMastery, Currency, StudyItemType } from '@/lib/study'
import { COIN_BY_CODE } from '@/lib/coins'

const TYPE_LABEL: Record<StudyItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC' }
const ALL_TYPES: StudyItemType[] = ['far', 'aim', 'pcg', 'ac']

export default function StudyScreen() {
  const { tokens } = useTheme()
  const fs = useFS()
  const { isPro } = useAuth()
  const [loading, setLoading] = useState(true)
  const [deck, setDeck] = useState<StudyCard[]>([])
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [sessionDone, setSessionDone] = useState(false)
  // Empty selection means "all types" -- avoids a confusing zero-result
  // state on first load and matches Duels' filter default.
  const [activeTypes, setActiveTypes] = useState<StudyItemType[]>([])

  const toggleType = (t: StudyItemType) => {
    // Empty selection displays as "all active" -- expand to the explicit
    // full list first so tapping one chip deselects just that one, not
    // collapses down to a single-type filter.
    setActiveTypes((prev) => {
      const base = prev.length === 0 ? ALL_TYPES : prev
      return base.includes(t) ? base.filter((x) => x !== t) : [...base, t]
    })
  }

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getStudyQueue(20, activeTypes), getStudyMastery(), getCurrency()])
      .then(([queue, m, c]) => {
        setDeck(queue)
        setMastery(m)
        setCurrency(c)
        setIndex(0)
        setFlipped(false)
        setSessionDone(queue.length === 0)
      })
      .finally(() => setLoading(false))
  }, [activeTypes])

  useEffect(() => {
    if (isPro) load()
  }, [isPro, load])

  const current = deck[index]

  const handleAnswer = async (correct: boolean) => {
    if (!current) return
    try {
      const result = await recordStudyReview(current.item_id, correct)
      if (result.newCoins.length > 0) {
        // Fires after state below settles the next card, not before -- a
        // rewarding moment shouldn't block advancing to the next question.
        const coin = COIN_BY_CODE[result.newCoins[0]]
        if (coin) {
          setTimeout(() => Alert.alert(`Coin earned: ${coin.name}`, coin.description), 300)
        }
      }
    } catch { /* best-effort -- don't block the study flow on a network blip */ }
    getCurrency().then(setCurrency).catch(() => {})
    if (index + 1 >= deck.length) {
      setSessionDone(true)
      getStudyMastery().then(setMastery).catch(() => {})
    } else {
      setIndex((i) => i + 1)
      setFlipped(false)
    }
  }

  if (!isPro) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Study Mode" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={36} color={tokens.blu} />
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

  const headerRight = (
    <Pressable onPress={() => router.push('/ready-room')} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="person.2.fill" size={20} color={tokens.gold} />
    </Pressable>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Study Mode" onBack={() => router.back()} right={headerRight} />

      <TabletContainer>
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
          const active = activeTypes.length === 0 || activeTypes.includes(t)
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
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : mastery && (
        <View style={styles.gaugeRow}>
          {/* A plain gold-bordered badge, not a partial-fill ring -- a ring
              drawn from rotated View borders only sweeps correctly up to
              50%; rendering past that needs react-native-svg, a new native
              dependency this session can't build/test (web preview only).
              Honest and correct beats a good-looking-until-51% gauge. */}
          <View style={[styles.gaugeBadge, { backgroundColor: tokens.bg2, borderColor: tokens.gold }]}>
            <Text style={[styles.gaugeNum, { color: tokens.t1, fontSize: fs(19) }]}>{mastery.pct}</Text>
            <Text style={[styles.gaugeUnit, { color: tokens.t4, fontSize: fs(8.5) }]}>PCT</Text>
          </View>
          <View style={styles.gaugeMeta}>
            <Text style={[styles.gaugeMetaTitle, { color: tokens.t1, fontSize: fs(13.5) }]}>Overall Mastery</Text>
            <Text style={[styles.gaugeMetaSub, { color: tokens.t4, fontSize: fs(11.5) }]}>
              {mastery.mastered} mastered of {mastery.seen} reviewed · {mastery.total_available} items total
            </Text>
          </View>
        </View>
      )}

      {!loading && currency && currency.currentStreak > 0 && (
        <View style={styles.currencyBadge}>
          <View style={[styles.currencyIcon, { borderColor: tokens.gold }]}>
            <Icon name="bolt.fill" size={14} color={tokens.gold} />
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

      {!loading && sessionDone && (
        <View style={styles.center}>
          <Icon name="checkmark.circle" size={40} color={tokens.gold} />
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
          <View style={styles.progressRow}>
            <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(11.5) }]}>
              {index + 1} / {deck.length}{current.is_new ? ' · new' : ''}
            </Text>
            <View style={[styles.typeBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
              <Text style={[styles.typeBadgeText, { color: tokens.gold, fontSize: fs(10.5) }]}>{TYPE_LABEL[current.item_type]}</Text>
            </View>
          </View>

          <FlashCard
            term={current.term}
            definition={current.definition}
            flipped={flipped}
            onPress={() => setFlipped((f) => !f)}
            tokens={tokens}
            fs={fs}
          />

          {flipped && (
            <View style={styles.answerRow}>
              <Pressable
                style={[styles.answerBtn, { borderColor: tokens.bdr }]}
                onPress={() => handleAnswer(false)}
              >
                <Icon name="xmark" size={16} color={tokens.t3} />
                <Text style={[styles.answerText, { color: tokens.t2, fontSize: fs(13.5) }]}>Missed it</Text>
              </Pressable>
              <Pressable
                style={[styles.answerBtn, styles.answerBtnGood, { borderColor: tokens.goldbdr, backgroundColor: tokens.goldlt }]}
                onPress={() => handleAnswer(true)}
              >
                <Icon name="checkmark" size={16} color={tokens.gold} />
                <Text style={[styles.answerText, { color: tokens.gold, fontSize: fs(13.5) }]}>Knew it</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
      </TabletContainer>
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

function FlashCard({
  term,
  definition,
  flipped,
  onPress,
  tokens,
  fs,
}: {
  term: string
  definition: string
  flipped: boolean
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const progress = useSharedValue(0)

  useEffect(() => {
    progress.value = withTiming(flipped ? 1 : 0, { duration: 420, easing: Easing.inOut(Easing.quad) })
  }, [flipped])

  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1400 }, { rotateY: `${progress.value * 180}deg` }],
  }))
  const backStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 1400 }, { rotateY: `${progress.value * 180 - 180}deg` }],
  }))

  return (
    <Pressable style={styles.cardOuter} onPress={onPress}>
      <Reanimated.View
        style={[styles.card, styles.cardFace, frontStyle, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
      >
        <Text style={[styles.cardTerm, { color: tokens.t1, fontSize: fs(22) }]}>{term}</Text>
        <Text style={[styles.cardHint, { color: tokens.t4, fontSize: fs(11) }]}>Tap to reveal</Text>
      </Reanimated.View>
      <Reanimated.View
        style={[styles.card, styles.cardFace, styles.cardBack, backStyle, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
      >
        <Text style={[styles.cardDef, { color: tokens.t2, fontSize: fs(15) }]}>{definition}</Text>
        <Text style={[styles.cardHint, { color: tokens.t4, fontSize: fs(11) }]}>Tap to flip back</Text>
      </Reanimated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 280 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },

  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingTop: 14 },
  filterChip: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  filterChipText: { fontWeight: '700', letterSpacing: 0.3 },

  gaugeRow: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 },
  gaugeBadge: { width: 64, height: 64, borderRadius: 32, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  gaugeNum: { fontWeight: '700' },
  gaugeUnit: { letterSpacing: 0.5, marginTop: -2 },
  gaugeMeta: { flex: 1 },
  gaugeMetaTitle: { fontWeight: '600' },
  gaugeMetaSub: { marginTop: 2 },

  currencyBadge: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 12 },
  currencyIcon: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  currencyTitle: { fontWeight: '600' },
  currencySub: { marginTop: 1 },

  cardArea: { flex: 1, padding: 20, alignItems: 'center' },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  progress: { fontVariant: ['tabular-nums'], letterSpacing: 0.3 },
  typeBadge: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 7, paddingVertical: 2 },
  typeBadgeText: { fontWeight: '700', letterSpacing: 0.4 },
  cardOuter: { width: '100%', minHeight: 200 },
  card: {
    width: '100%', minHeight: 200, borderRadius: 18, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14,
  },
  cardFace: {
    backfaceVisibility: 'hidden',
  },
  cardBack: {
    position: 'absolute', top: 0, left: 0,
  },
  cardTerm: { fontWeight: '700', textAlign: 'center' },
  cardDef: { textAlign: 'center', lineHeight: 22 },
  cardHint: { position: 'absolute', bottom: 14 },
  answerRow: { flexDirection: 'row', gap: 12, marginTop: 20, width: '100%' },
  answerBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderRadius: 14, borderWidth: 1, paddingVertical: 13,
  },
  answerBtnGood: {},
  answerText: { fontWeight: '600' },
})
