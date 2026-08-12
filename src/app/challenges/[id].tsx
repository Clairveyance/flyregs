import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import {
  getMyChallenges, respondToChallenge, getNextChallengeQuestion, submitChallengeAnswer,
  getChallengeResults, getChallengeStandings, getDuelStats, sendDuelPush, createChallenge,
  MyChallenge, NextQuestion, AnswerResult, ChallengeResultRow, StandingRow, DuelStats, DuelItemType,
  KNOWLEDGE_LEVEL_LABELS, markCoinsSeen,
} from '@/lib/challenges'
import { RATING_SHORT_LABELS, STUDY_RATING_LABELS } from '@/lib/profileRatings'
import { slugifyPcgTerm } from '@/lib/pcg'
import { COIN_BY_CODE, type CoinDef } from '@/lib/coins'
import { CoinRevealModal } from '@/components/CoinRevealModal'
import { ConfettiBurst } from '@/components/Confetti'
import { useConfirm } from '@/components/ConfirmDialog'

type Phase = 'loading' | 'pending_response' | 'ready' | 'playing' | 'revealed' | 'waiting_opponent' | 'results' | 'declined'

const TYPE_LABEL: Record<DuelItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC' }
// Phrased as the ACTUAL QUESTION being asked, not as a label for the data
// type below it. Most questions now come from the authored study_facts bank
// (real answer-text choices), but any item without a live fact still falls
// back to "identify the source" (document-number choices) -- the label reads
// naturally either way. "FAR TITLE" stated it in schema terms and left the
// player to infer what to do with it.
const QUESTION_LABEL: Record<DuelItemType, string> = {
  pcg: 'WHICH TERM IS THIS THE DEFINITION OF?',
  far: 'WHICH FAR SECTION IS THIS?',
  aim: 'WHICH AIM PARAGRAPH IS THIS?',
  ac: 'WHICH ADVISORY CIRCULAR IS THIS?',
}

// RC, real duel screenshot circling a live timer stuck open at 553.0s (the
// tab sat idle mid-question): past a minute, raw seconds stops being
// readable at a glance -- switch to M:SS.s once it crosses 60s, tenths still
// ticking. Below 60s stays exactly as before (plain seconds + tenths).
function formatDuelSeconds(ms: number): string {
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return totalSeconds.toFixed(1)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds - minutes * 60
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`
}
// Same formatting, with the "s" unit only when it's still meaningful (once
// the colon shows up, "9:13.0s" would be redundant -- the colon already
// says "this is a duration").
function formatDuelSecondsLabel(ms: number): string {
  const formatted = formatDuelSeconds(ms)
  return ms < 60000 ? `${formatted}s` : formatted
}

// The Challenger picks Content/Level filters when starting a Duel, but
// nothing showed either player what was actually selected -- an opponent
// had no way to know they were about to be quizzed on, say, ATP-only FAR
// material. Reads straight off the challenges row (itemTypes/levels,
// persisted at creation time by create_challenge()), so it's the same for
// both players rather than something only the Challenger's own client knew.
function FilterSummary({ challenge, tokens, fs }: { challenge: MyChallenge; tokens: ReturnType<typeof useTheme>['tokens']; fs: (n: number) => number }) {
  if (!challenge.itemTypes?.length && !challenge.levels?.length && !challenge.categoryClasses?.length && !challenge.ratings?.length) return null
  return (
    <View style={styles.filterSummaryRow}>
      {(challenge.itemTypes ?? []).map((t) => (
        <View key={t} style={[styles.filterPill, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
          <Text style={[styles.filterPillText, { color: tokens.gold, fontSize: fs(10.5) }]}>{TYPE_LABEL[t]}</Text>
        </View>
      ))}
      {(challenge.levels ?? []).map((l) => (
        <View key={l} style={[styles.filterPill, { backgroundColor: tokens.bdim, borderColor: tokens.blu }]}>
          <Text style={[styles.filterPillText, { color: tokens.blu, fontSize: fs(10.5) }]}>{KNOWLEDGE_LEVEL_LABELS[l]}</Text>
        </View>
      ))}
      {(challenge.categoryClasses ?? []).map((c) => (
        <View key={c} style={[styles.filterPill, { backgroundColor: tokens.bdim, borderColor: tokens.grn }]}>
          <Text style={[styles.filterPillText, { color: tokens.grn, fontSize: fs(10.5) }]}>{RATING_SHORT_LABELS[c]}</Text>
        </View>
      ))}
      {(challenge.ratings ?? []).map((r) => (
        <View key={r} style={[styles.filterPill, { backgroundColor: tokens.bdim, borderColor: tokens.amb }]}>
          <Text style={[styles.filterPillText, { color: tokens.amb, fontSize: fs(10.5) }]}>{STUDY_RATING_LABELS[r]}</Text>
        </View>
      ))}
    </View>
  )
}

export default function ChallengeGameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { tokens } = useTheme()
  const { isPremium } = useAuth()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
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
  const [revealCoin, setRevealCoin] = useState<CoinDef | null>(null)
  const [liveMs, setLiveMs] = useState(0)
  const [rematching, setRematching] = useState(false)
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
    // Duel Alerts (the push that gets someone here) are Pro+, but actually
    // playing a Duel is Premium-only -- a Pro challenger's invite can reach
    // a Pro (non-Premium) recipient. Gate synchronously here, same pattern
    // as every other "tapped a gated action" spot in the app (BB-006):
    // check first, never let a doomed respond_to_challenge call reach the
    // server just to bounce back a raw "Duels requires Premium" string
    // inside a dialog titled "Duel unavailable" -- confusing, and no path
    // to actually upgrade. Decline never requires Premium (respond_to_
    // challenge only checks entitlement when p_accept is true), so it's
    // untouched.
    if (accept && !isPremium) {
      router.push('/paywall?tier=premium' as any)
      return
    }
    try {
      await respondToChallenge(id, accept)
    } catch (err: any) {
      // The duel can legitimately be over by the time this invite is
      // answered (everyone else finished, or the last invitee declined).
      confirm({ title: 'Duel unavailable', message: err?.message ?? 'That duel is no longer available.', cancelLabel: null })
      loadState()
      return
    }
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
    let r: AnswerResult
    try {
      r = await submitChallengeAnswer(question.questionId, choice, timeMs)
    } catch (err: any) {
      // Submitting into a duel that ended underneath you (e.g. the last
      // other player declined and it finalized). Reload rather than
      // stranding the player on a dead question with a spinner.
      setSelectedChoice(null)
      confirm({ title: 'Duel unavailable', message: err?.message ?? 'That duel is no longer available.', cancelLabel: null })
      loadState()
      return
    }
    setMyTimeMs(timeMs)
    setResult(r)
    setPhase('revealed')
    if (r.newCoins.length) {
      getDuelStats().then(setMyStats)
      // Same reveal moment Study Mode uses (see CoinRevealModal) -- fires
      // after the answer-correct/incorrect state above so it doesn't cover
      // that feedback the instant you tap an answer.
      const coin = COIN_BY_CODE[r.newCoins[0]]
      if (coin) setTimeout(() => setRevealCoin(coin), 400)
      // Mark seen now -- otherwise get_unseen_coins() (challenges/index.tsx's
      // catch-up check, built for the duel-win-toast-only-shown-to-finalizer
      // bug) doesn't know this coin was already shown here, and re-reveals
      // the same coin a second time next time the Duels hub loads. Same fix
      // as study.tsx's identical reveal path. Best-effort, non-blocking.
      markCoinsSeen(r.newCoins).catch(() => {})
    }
    if (r.challengeCompleted && id) sendDuelPush(id, 'completed')
  }

  const handleNext = () => {
    setSelectedChoice(null)
    setResult(null)
    setMyTimeMs(0)
    loadState()
  }

  // RC: "rematch is good. though one player taps it, the other still has
  // to accept the rematch, just like a new invite - only that they can do
  // it right there." No new backend needed -- create_challenge is already
  // generic, so a rematch is just re-inviting the SAME opponent(s) with
  // the SAME filters this duel was played under. The opponent sees it land
  // in their own Duels list and accepts it exactly like any other invite;
  // "right there" just means the challenger gets an immediate new-duel
  // screen instead of having to rebuild the same picker from scratch.
  const handleRematch = async () => {
    if (!challenge || rematching) return
    const opponentIds = challenge.others.map((o) => o.userId)
    if (opponentIds.length === 0) return
    // Same BB-006 pre-check as handleRespond above, same reason: reaching
    // this results screen at all required being Premium when the duel was
    // accepted, but Premium can lapse between then and tapping Rematch --
    // without this, createChallenge()'s real server rejection ("Duels
    // requires Premium") would surface raw inside "Could not start rematch,"
    // no upgrade path, found in the same post-build-31 sweep that caught
    // handleRespond's version of this gap.
    if (!isPremium) {
      router.push('/paywall?tier=premium' as any)
      return
    }
    setRematching(true)
    try {
      const newId = await createChallenge(
        opponentIds,
        challenge.questionCount,
        challenge.itemTypes ?? undefined,
        challenge.levels ?? undefined,
        challenge.categoryClasses ?? undefined,
        challenge.ratings ?? undefined
      )
      sendDuelPush(newId, 'invited')
      router.replace(`/challenges/${newId}` as any)
    } catch (err: any) {
      confirm({ title: 'Could not start rematch', message: err?.message ?? 'Unknown error', cancelLabel: null })
      setRematching(false)
    }
  }

  const otherCount = challenge?.others.length ?? 0
  const stillPending = challenge?.others.filter((o) => o.status === 'pending') ?? []
  const stillPlaying = challenge?.others.filter(
    (o) => o.status === 'active' && o.answeredCount < (challenge?.questionCount ?? 0)
  ) ?? []
  const waitingCopy =
    stillPending.length > 0 && stillPlaying.length === 0
      ? stillPending.length === 1
        ? `Waiting on ${stillPending[0].label} to accept the invite — you'll see the full results once everyone's played.`
        : `Waiting on ${stillPending.length} invited players to accept — you'll see the full results once everyone's played.`
      : stillPending.length > 0
        ? "Waiting on the other players — some are still playing and some haven't accepted yet."
        : otherCount === 1
          ? `Waiting on ${challenge?.others[0]?.label} to finish — you'll see the full results once they do.`
          : "Waiting on the other players to finish — you'll see the full results once everyone's done."

  const title = !challenge ? 'Duel'
    : otherCount === 1 ? `Duel · ${challenge.others[0].label}`
    // 0 others is real: the only opponent deleted their account (their
    // participant row cascades away). "Duel · 1 players" read as a bug.
    : otherCount === 0 ? 'Duel'
    : `Duel · ${otherCount + 1} players`

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={title} onBack={() => router.back()} />

      {challenge && phase !== 'loading' && <FilterSummary challenge={challenge} tokens={tokens} fs={fs} />}

      {(phase === 'ready' || phase === 'playing' || phase === 'revealed') && myStats && (
        <View style={[styles.statsBar, { borderBottomColor: tokens.bdr }]}>
          <StatPill label="You" stats={myStats} tokens={tokens} fs={fs} />
        </View>
      )}

      {phase === 'loading' ? (
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      ) : phase === 'declined' ? (
        // 'cancelled' now has a distinct cause from 'I declined': the DB
        // cancels a duel when nobody is left to play it (every invitee
        // declined), so "Duel declined" would misattribute that to the
        // viewer. See sync/migrations_duels_2.sql.
        <View style={styles.center}>
          <Icon name="xmark.circle" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>
            {challenge?.myStatus === 'declined' ? 'You declined this duel' : 'Duel cancelled'}
          </Text>
          {challenge?.myStatus !== 'declined' && (
            <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
              {otherCount === 1
                ? `${challenge?.others[0]?.label ?? 'Your opponent'} declined, so there was nobody to duel.`
                : 'Everyone invited declined, so there was nobody to duel.'}
            </Text>
          )}
        </View>
      ) : phase === 'pending_response' ? (
        <View style={styles.center}>
          <Icon name="bolt.fill" size={fs(36)} color={tokens.gold} />
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
        // "Waiting on them to finish" was wrong whenever the other player
        // hadn't even accepted yet -- a real state now that a duel no longer
        // completes out from under a pending invitee (migrations_duels.sql).
        <View style={styles.center}>
          <Icon name="hourglass" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>You've answered every question</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>{waitingCopy}</Text>
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
            <Text style={[styles.goBtnSmallText, { fontSize: fs(14) }]}>GO</Text>
          </Pressable>
        </View>
      ) : phase === 'playing' ? (
        <View style={styles.playArea}>
          <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(11.5) }]}>
            QUESTION {(question?.sortOrder ?? 0) + 1} OF {challenge?.questionCount}
          </Text>

          <View style={[styles.timerArea, { borderColor: tokens.goldbdr, backgroundColor: tokens.bg2 }]}>
            <Text style={[styles.timerText, { color: tokens.gold, fontSize: fs(36) }]}>
              {formatDuelSeconds(liveMs)}
              {liveMs < 60000 && <Text style={[styles.timerUnit, { color: tokens.t3, fontSize: fs(14) }]}> s</Text>}
            </Text>
          </View>

          <View style={[styles.questionArea, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}>
            <Text style={[styles.questionLabel, { color: tokens.t3, fontSize: fs(10.5) }]}>
              {question ? QUESTION_LABEL[question.itemType] : ''}
            </Text>
            <Text style={[styles.prompt, { color: tokens.t1, fontSize: fs(18) }]}>{question?.prompt}</Text>
          </View>

          {/* RC, real duel screenshot: "put two columns for these answers so
              they're grouped together better" -- was one long vertical
              stack of up to 6 options. */}
          <View style={styles.choicesArea}>
            {question?.choices.map((choice) => (
              <Pressable
                key={choice}
                style={[styles.choiceBtn, styles.choiceBtnHalf, { borderColor: tokens.bdr, backgroundColor: tokens.bg2 }]}
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
            size={fs(40)}
            color={result?.isCorrect ? tokens.grn : tokens.red}
          />
          <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(17) }]}>
            {result?.isCorrect ? 'Correct!' : `Answer: ${result?.correctAnswer}`}
          </Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
            Your time: {formatDuelSecondsLabel(myTimeMs)} (only counts if everyone tied with you got it right)
          </Text>
          {/* "0 of 0 others answered this one so far" is what this read
              before anyone accepted the invite -- seen live. */}
          <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5) }]}>
            {(result?.othersTotalCount ?? 0) === 0
              ? "You're playing ahead — nobody else has joined yet"
              : `${result?.othersAnsweredCount ?? 0} of ${result?.othersTotalCount} other${result?.othersTotalCount === 1 ? '' : 's'} answered this one so far`}
          </Text>
          <Pressable style={[styles.goBtnSmall, { backgroundColor: tokens.gold }]} onPress={handleNext}>
            <Text style={[styles.goBtnSmallText, { fontSize: fs(14) }]}>{result?.challengeCompleted ? 'SEE FULL RESULTS' : 'NEXT QUESTION'}</Text>
          </Pressable>
        </View>
      ) : phase === 'results' ? (
        <ResultsView
          results={results}
          standings={standings}
          tokens={tokens}
          fs={fs}
          canRematch={otherCount > 0}
          rematching={rematching}
          onRematch={handleRematch}
        />
      ) : null}
      <CoinRevealModal coin={revealCoin} onClose={() => setRevealCoin(null)} />
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

// r.term is the item's own identifier for every type except P/CG, where it's
// the term text and the route wants the slug.
function openResultItem(r: ChallengeResultRow) {
  if (!r.term) return
  if (r.itemType === 'pcg') router.push(`/pcg/${slugifyPcgTerm(r.term)}` as any)
  else router.push(`/${r.itemType}/${r.term}` as any)
}

function ResultsView({
  results, standings, tokens, fs, canRematch, rematching, onRematch,
}: {
  results: ChallengeResultRow[]
  standings: StandingRow[]
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  canRematch: boolean
  rematching: boolean
  onRematch: () => void
}) {
  const me = standings.find((s) => s.isMe)
  const winner = standings.find((s) => s.finalRank === 1)
  const outcome = !me ? 'lost' : me.finalRank !== 1 ? 'lost' : me.tieGroupSize > 1 ? 'tied' : 'won'

  return (
    <View style={styles.resultsWrap}>
      {outcome === 'won' && <ConfettiBurst />}
      <View style={styles.resultsSummary}>
        <Icon name={outcome === 'won' ? 'rosette' : 'bolt.fill'} size={fs(32)} color={tokens.gold} />
        <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(18) }]}>
          {outcome === 'won' ? 'You won!' : outcome === 'tied' ? "It's a tie for first!" : `${winner?.label ?? 'Someone'} won this one`}
        </Text>
      </View>

      {canRematch && (
        <Pressable
          style={[styles.rematchButton, { backgroundColor: tokens.gold, opacity: rematching ? 0.6 : 1 }]}
          onPress={onRematch}
          disabled={rematching}
        >
          {rematching ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <>
              <Icon name="arrow.triangle.2.circlepath" size={fs(15)} color="#000" />
              <Text style={styles.rematchButtonText}>Rematch</Text>
            </>
          )}
        </Pressable>
      )}

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
              {s.tieGroupSize > 1 ? ` · ${formatDuelSecondsLabel(s.tiebreakMs)}` : ''}
            </Text>
          </View>
        ))}
      </View>

      {/* The breakdown used to show only r.term -- i.e. the answer key --
          so a player reviewing a duel saw "AIM 9-1-6  You: ✕" with no way
          to tell what the question had been or what they'd picked. Both
          r.definition (the prompt) and a.answerText (the pick) were already
          being fetched and thrown away. Rows also open the source document
          now: the moment right after you get one wrong is exactly when you
          want to read the actual reg. */}
      <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>PER-QUESTION BREAKDOWN</Text>
      {results.map((r) => (
        <Pressable
          key={r.sortOrder}
          style={[styles.resultRow, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
          onPress={() => openResultItem(r)}
        >
          <View style={styles.resultTermRow}>
            <View style={[styles.typeBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
              <Text style={[styles.typeBadgeText, { color: tokens.gold, fontSize: fs(9.5) }]}>{TYPE_LABEL[r.itemType]}</Text>
            </View>
            <Text style={[styles.resultTerm, { color: tokens.t1, fontSize: fs(13.5) }]}>{r.term}</Text>
            <Icon name="chevron.right" size={fs(12)} color={tokens.t4} />
          </View>
          {!!r.definition && (
            <Text style={[styles.resultPrompt, { color: tokens.t3, fontSize: fs(12.5) }]} numberOfLines={3}>
              {r.definition}
            </Text>
          )}
          {r.answers.map((a) => (
            <Text
              key={a.userId}
              style={[styles.resultAnswer, { color: a.isCorrect ? tokens.grn : tokens.red, fontSize: fs(12) }]}
            >
              {a.isMe ? 'You' : a.label}: {a.isCorrect ? '✓' : '✕'}
              {!a.isCorrect && a.answerText ? ` ${a.answerText}` : ''}
              {a.timeMs != null ? ` · ${formatDuelSecondsLabel(a.timeMs)}` : ''}
            </Text>
          ))}
        </Pressable>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6, textAlign: 'center' },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 300 },

  filterSummaryRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center',
    paddingHorizontal: 16, paddingTop: 10,
  },
  filterPill: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 },
  filterPillText: { fontWeight: '700', letterSpacing: 0.3 },

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

  choicesArea: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceBtn: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 13, justifyContent: 'center' },
  choiceBtnHalf: { width: '48%' },
  choiceText: { fontWeight: '600', textAlign: 'center' },

  answerRow: { flexDirection: 'row', gap: 12, marginTop: 10 },
  answerBtn: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 22, paddingVertical: 10 },
  answerBtnGood: {},
  answerBtnText: { fontWeight: '700' },

  resultsWrap: { flex: 1, padding: 16, gap: 10 },
  resultsSummary: { alignItems: 'center', gap: 6, paddingVertical: 16 },
  rematchButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    borderRadius: 20, paddingVertical: 12, marginBottom: 4,
  },
  rematchButtonText: { color: '#000', fontWeight: '800', fontSize: 14.5, letterSpacing: 0.4 },

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
  resultPrompt: { lineHeight: 17, marginBottom: 5 },
  resultAnswer: { fontWeight: '600' },
})
