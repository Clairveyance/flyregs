import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import {
  getMyChallenges, respondToChallenge, getNextChallengeQuestion, submitChallengeAnswer,
  getChallengeResults, getChallengeStandings, getDuelStats, sendDuelPush,
  MyChallenge, NextQuestion, AnswerResult, ChallengeResultRow, StandingRow, DuelStats, DuelItemType,
} from '@/lib/challenges'
import { COIN_BY_CODE } from '@/lib/coins'

type Phase = 'loading' | 'pending_response' | 'ready' | 'playing' | 'revealed' | 'waiting_opponent' | 'results' | 'declined'

const TYPE_LABEL: Record<DuelItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC' }
const QUESTION_LABEL: Record<DuelItemType, string> = { pcg: 'DEFINITION', far: 'FAR TITLE', aim: 'AIM TITLE', ac: 'ADVISORY CIRCULAR' }

export default function ChallengeGameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const fs = useFS()
  const [phase, setPhase] = useState<Phase>('loading')
  const [challenge, setChallenge] = useState<MyChallenge | null>(null)
  const [question, setQuestion] = useState<NextQuestion | null>(null)
  const [selectedChoice, setSelectedChoice] = useState<string | null>(null)
  const [result, setResult] = useState<AnswerResult | null>(null)
  const [myTimeMs, setMyTimeMs] = useState(0)
  const [results, setResults] = useState<ChallengeResultRow[]>([])
  const [standings, setStandings] = useState<StandingRow[]>([])
  const [myStats, setMyStats] = useState<DuelStats | null>(null)
  const [liveMs, setLiveMs] = useState(0)
  const startedAt = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadState = useCallback(async () => {
    if (!id) return
    const list = await getMyChallenges()
    const c = list.find((x) => x.challengeId === id) ?? null
    setChallenge(c)
    if (c) getDuelStats().then(setMyStats)
    if (!c) { setPhase('loading'); return }
    if (c.status === 'cancelled' || c.myStatus === 'declined') { setPhase('declined'); return }
    if (c.myStatus === 'pending') { setPhase('pending_response'); return }
    if (c.status === 'completed') {
      const [r, s] = await Promise.all([getChallengeResults(id), getChallengeStandings(id)])
      setResults(r)
      setStandings(s)
      setPhase('results')
      return
    }
    // active
    const q = await getNextChallengeQuestion(id)
    if (!q) { setPhase('waiting_opponent'); return }
    setQuestion(q)
    setPhase('ready')
  }, [id])

  useEffect(() => { loadState() }, [loadState])

  // Live-ticking stopwatch while playing -- the mockup specifically called
  // for a prominent, visibly-running timer, not just a value revealed after
  // submitting. Purely cosmetic (the real, authoritative time is captured
  // via Date.now() at submit and graded server-side) -- a few ms of JS
  // interval drift here has zero effect on the actual score. Time now only
  // matters as a tiebreaker when players land on the same correct count,
  // but it's still worth showing live -- it's what you're racing.
  useEffect(() => {
    if (phase === 'playing') {
      tickRef.current = setInterval(() => setLiveMs(Date.now() - startedAt.current), 47)
    } else if (tickRef.current) {
      clearInterval(tickRef.current)
      tickRef.current = null
    }
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [phase])

  const handleRespond = async (accept: boolean) => {
    if (!id) return
    await respondToChallenge(id, accept)
    if (accept) sendDuelPush(id, 'accepted')
    loadState()
  }

  const handleGo = () => {
    startedAt.current = Date.now()
    setLiveMs(0)
    setPhase('playing')
  }

  // Multiple choice, one shot -- tapping a choice submits it immediately,
  // no separate confirm step (a confirm step would just invite
  // second-guessing on a "one shot" format).
  const handleChoice = async (choice: string) => {
    if (!question || selectedChoice) return
    setSelectedChoice(choice)
    const timeMs = Date.now() - startedAt.current
    const r = await submitChallengeAnswer(question.questionId, choice, timeMs)
    setMyTimeMs(timeMs)
    setResult(r)
    setPhase('revealed')
    if (r.newCoins.length) getDuelStats().then(setMyStats)
    if (r.challengeCompleted && id) sendDuelPush(id, 'completed')
  }

  const handleNext = () => {
    setSelectedChoice(null)
    setResult(null)
    setMyTimeMs(0)
    loadState()
  }

  const otherCount = challenge?.others.length ?? 0
  const title = !challenge ? 'Duel'
    : otherCount === 1 ? `Duel · ${challenge.others[0].label}`
    : `Duel · ${otherCount + 1} players`

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={title} onBack={() => router.back()} />

      {(phase === 'ready' || phase === 'playing' || phase === 'revealed') && myStats && (
        <View style={[styles.statsBar, { borderBottomColor: tokens.bdr }]}>
          <StatPill label="You" stats={myStats} tokens={tokens} fs={fs} />
        </View>
      )}

      {phase === 'loading' ? (
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      ) : phase === 'declined' ? (
        <View style={styles.center}>
          <Icon name="xmark.circle" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Duel declined</Text>
        </View>
      ) : phase === 'pending_response' ? (
        <View style={styles.center}>
          <Icon name="bolt.fill" size={36} color={tokens.gold} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>
            {otherCount === 1 ? `${challenge?.others[0].label} wants to duel you` : `You've been invited to a ${otherCount + 1}-player duel`}
          </Text>
          <View style={styles.answerRow}>
            <Pressable style={[styles.answerBtn, { borderColor: tokens.bdr }]} onPress={() => handleRespond(false)}>
              <Text style={[styles.answerBtnText, { color: tokens.t2, fontSize: fs(14) }]}>Decline</Text>
            </Pressable>
            <Pressable style={[styles.answerBtn, styles.answerBtnGood, { borderColor: tokens.goldbdr, backgroundColor: tokens.goldlt }]} onPress={() => handleRespond(true)}>
              <Text style={[styles.answerBtnText, { color: tokens.gold, fontSize: fs(14) }]}>Accept</Text>
            </Pressable>
          </View>
        </View>
      ) : phase === 'waiting_opponent' ? (
        <View style={styles.center}>
          <Icon name="hourglass" size={36} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>You've answered every question</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            {otherCount === 1
              ? `Waiting on ${challenge?.others[0].label} to finish — you'll see the full results once they do.`
              : "Waiting on the other players to finish — you'll see the full results once everyone's done."}
          </Text>
        </View>
      ) : phase === 'ready' ? (
        <View style={styles.center}>
          <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(12) }]}>
            QUESTION {(question?.sortOrder ?? 0) + 1} OF {challenge?.questionCount}
          </Text>
          <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(22) }]}>Ready?</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            The clock starts the instant you hit GO. One shot at each answer.
          </Text>
          <Pressable style={[styles.goBtnSmall, { backgroundColor: tokens.gold }]} onPress={handleGo}>
            <Text style={styles.goBtnSmallText}>GO</Text>
          </Pressable>
        </View>
      ) : phase === 'playing' ? (
        <View style={styles.playArea}>
          <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(11.5) }]}>
            QUESTION {(question?.sortOrder ?? 0) + 1} OF {challenge?.questionCount}
          </Text>

          <View style={[styles.timerArea, { borderColor: tokens.goldbdr, backgroundColor: tokens.bg2 }]}>
            <Text style={[styles.timerText, { color: tokens.gold, fontSize: fs(36) }]}>
              {(liveMs / 1000).toFixed(1)}
              <Text style={[styles.timerUnit, { color: tokens.t3, fontSize: fs(14) }]}> s</Text>
            </Text>
          </View>

          <View style={[styles.questionArea, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
            <Text style={[styles.questionLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>
              {question ? QUESTION_LABEL[question.itemType] : ''}
            </Text>
            <Text style={[styles.prompt, { color: tokens.t1, fontSize: fs(18) }]}>{question?.prompt}</Text>
          </View>

          <View style={styles.choicesArea}>
            {question?.choices.map((choice) => (
              <Pressable
                key={choice}
                style={[styles.choiceBtn, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}
                onPress={() => handleChoice(choice)}
              >
                <Text style={[styles.choiceText, { color: tokens.t1, fontSize: fs(14.5) }]}>{choice}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : phase === 'revealed' ? (
        <View style={styles.center}>
          <Icon
            name={result?.isCorrect ? 'checkmark.circle' : 'xmark.circle'}
            size={40}
            color={result?.isCorrect ? tokens.grn : tokens.red}
          />
          <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(17) }]}>
            {result?.isCorrect ? 'Correct!' : `Answer: ${result?.correctAnswer}`}
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Your time: {(myTimeMs / 1000).toFixed(1)}s (only counts if everyone tied with you got it right)
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>
            {result?.othersAnsweredCount ?? 0} of {result?.othersTotalCount ?? 0} other{result?.othersTotalCount === 1 ? '' : 's'} answered this one so far
          </Text>
          {result && result.newCoins.length > 0 && (
            <View style={[styles.coinToast, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
              <Icon name="rosette" size={16} color={tokens.gold} />
              <Text style={[styles.coinToastText, { color: tokens.gold, fontSize: fs(13) }]}>
                Earned: {result.newCoins.map((c) => COIN_BY_CODE[c]?.name ?? c).join(', ')}
              </Text>
            </View>
          )}
          <Pressable style={[styles.goBtnSmall, { backgroundColor: tokens.gold }]} onPress={handleNext}>
            <Text style={styles.goBtnSmallText}>{result?.challengeCompleted ? 'SEE FULL RESULTS' : 'NEXT QUESTION'}</Text>
          </Pressable>
        </View>
      ) : phase === 'results' ? (
        <ResultsView results={results} standings={standings} tokens={tokens} fs={fs} />
      ) : null}
    </View>
  )
}

function StatPill({
  label, stats, tokens, fs,
}: {
  label: string
  stats: DuelStats
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  return (
    <View style={styles.statPill}>
      <Text style={[styles.statLabel, { color: tokens.t3, fontSize: fs(10.5) }]} numberOfLines={1}>{label.toUpperCase()}</Text>
      <Text style={[styles.statValue, { color: tokens.gold, fontSize: fs(14) }]}>
        {stats.wins}W · {stats.losses}L{stats.ties > 0 ? ` · ${stats.ties}T` : ''}
      </Text>
    </View>
  )
}

function ResultsView({
  results, standings, tokens, fs,
}: {
  results: ChallengeResultRow[]
  standings: StandingRow[]
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
}) {
  const me = standings.find((s) => s.isMe)
  const winner = standings.find((s) => s.finalRank === 1)
  const outcome = !me ? 'lost' : me.finalRank !== 1 ? 'lost' : me.tieGroupSize > 1 ? 'tied' : 'won'

  return (
    <View style={styles.resultsWrap}>
      <View style={styles.resultsSummary}>
        <Icon name={outcome === 'won' ? 'rosette' : 'bolt.fill'} size={32} color={tokens.gold} />
        <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(18) }]}>
          {outcome === 'won' ? 'You won!' : outcome === 'tied' ? "It's a tie for first!" : `${winner?.label ?? 'Someone'} won this one`}
        </Text>
      </View>

      <View style={styles.standingsList}>
        {standings.map((s) => (
          <View
            key={s.userId}
            style={[
              styles.standingRow,
              { backgroundColor: s.isMe ? tokens.goldlt : tokens.bg2, borderColor: s.finalRank === 1 ? tokens.goldbdr : tokens.bdr },
            ]}
          >
            <Text style={[styles.standingRank, { color: s.finalRank === 1 ? tokens.gold : tokens.t3, fontSize: fs(15) }]}>
              #{s.finalRank}
            </Text>
            <Text style={[styles.standingLabel, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
              {s.isMe ? 'You' : s.label}
            </Text>
            <Text style={[styles.standingScore, { color: tokens.t2, fontSize: fs(13) }]}>
              {s.correctCount} correct
              {s.tieGroupSize > 1 ? ` · ${(s.tiebreakMs / 1000).toFixed(1)}s` : ''}
            </Text>
          </View>
        ))}
      </View>

      <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>PER-QUESTION BREAKDOWN</Text>
      {results.map((r) => (
        <View key={r.sortOrder} style={[styles.resultRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <View style={styles.resultTermRow}>
            <View style={[styles.typeBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
              <Text style={[styles.typeBadgeText, { color: tokens.gold, fontSize: fs(9.5) }]}>{TYPE_LABEL[r.itemType]}</Text>
            </View>
            <Text style={[styles.resultTerm, { color: tokens.t1, fontSize: fs(13.5) }]}>{r.term}</Text>
          </View>
          {r.answers.map((a) => (
            <Text
              key={a.userId}
              style={[styles.resultAnswer, { color: a.isCorrect ? tokens.grn : tokens.red, fontSize: fs(12) }]}
            >
              {a.isMe ? 'You' : a.label}: {a.isCorrect ? '✓' : '✕'}{a.timeMs != null ? ` ${(a.timeMs / 1000).toFixed(1)}s` : ''}
            </Text>
          ))}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6, textAlign: 'center' },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 300 },

  statsBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 18, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  statPill: { alignItems: 'center', gap: 2 },
  statLabel: { fontWeight: '600', letterSpacing: 0.5 },
  statValue: { fontWeight: '700' },

  progress: { fontWeight: '700', letterSpacing: 0.6, textAlign: 'center' },
  readyTitle: { fontWeight: '700' },
  goBtnSmall: { borderRadius: 20, paddingHorizontal: 26, paddingVertical: 11, marginTop: 14, alignItems: 'center' },
  goBtnSmallText: { color: '#000', fontWeight: '800', fontSize: 14, letterSpacing: 0.6 },

  playArea: { flex: 1, padding: 18, gap: 12, justifyContent: 'center' },
  timerArea: {
    borderRadius: 16, borderWidth: 1.5, paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
  },
  timerText: { fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.5 },
  timerUnit: { fontWeight: '600' },
  questionArea: { borderRadius: 16, borderWidth: 1, padding: 18, gap: 8, minHeight: 110, justifyContent: 'center' },
  questionLabel: { fontWeight: '700', letterSpacing: 1 },
  prompt: { fontWeight: '600', lineHeight: 24 },

  choicesArea: { gap: 8 },
  choiceBtn: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 13 },
  choiceText: { fontWeight: '600', textAlign: 'center' },

  answerRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  answerBtn: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 22, paddingVertical: 10 },
  answerBtnGood: {},
  answerBtnText: { fontWeight: '700' },

  coinToast: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, marginTop: 8,
  },
  coinToastText: { fontWeight: '700' },

  resultsWrap: { flex: 1, padding: 16, gap: 10 },
  resultsSummary: { alignItems: 'center', gap: 6, paddingVertical: 16 },

  standingsList: { gap: 6, marginBottom: 6 },
  standingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  standingRank: { fontWeight: '800', width: 30, fontVariant: ['tabular-nums'] },
  standingLabel: { flex: 1, fontWeight: '600' },
  standingScore: { fontWeight: '600', fontVariant: ['tabular-nums'] },

  sectionTitle: { fontWeight: '700', letterSpacing: 0.5, marginTop: 6 },
  resultRow: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 5 },
  resultTermRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  typeBadge: { borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 1.5 },
  typeBadgeText: { fontWeight: '700', letterSpacing: 0.3 },
  resultTerm: { fontWeight: '700', flexShrink: 1 },
  resultAnswer: { fontWeight: '600' },
})
