import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView, AppState } from 'react-native'
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import {
  getMyChallenges, respondToChallenge, getNextChallengeQuestion, submitChallengeAnswer,
  getChallengeResults, getChallengeStandings, getDuelStats, sendDuelPush, createChallenge, forfeitChallenge,
  MyChallenge, NextQuestion, AnswerResult, ChallengeResultRow, StandingRow, DuelStats, DuelItemType,
  STUDY_LEVEL_LABELS, markCoinsSeen,
} from '@/lib/challenges'
import { RATING_SHORT_LABELS, STUDY_RATING_LABELS } from '@/lib/profileRatings'
import { slugifyPcgTerm } from '@/lib/pcg'
import { COIN_BY_CODE, type CoinDef } from '@/lib/coins'
import { CoinRevealModal } from '@/components/CoinRevealModal'
import { ConfettiBurst } from '@/components/Confetti'
import { useConfirm } from '@/components/ConfirmDialog'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

type Phase = 'loading' | 'pending_response' | 'waiting_accept' | 'ready' | 'playing' | 'revealed' | 'waiting_opponent' | 'results' | 'declined' | 'not_found' | 'error'

const TYPE_LABEL: Record<DuelItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC', dictionary: 'A/D', cfr49: '49 CFR' }
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
  dictionary: 'WHICH TERM IS THIS THE DEFINITION OF?',
  cfr49: 'WHICH 49 CFR SECTION IS THIS?',
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
          <Text style={[styles.filterPillText, { color: tokens.blu, fontSize: fs(10.5) }]}>{STUDY_LEVEL_LABELS[l]}</Text>
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
  const { isPremium, loading: authLoading } = useAuth()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const [phase, setPhase] = useState<Phase>('loading')
  // Read by the focus/AppState refetch effects below, without making them
  // re-subscribe on every phase change -- see their own comment for why
  // they need the CURRENT phase without depending on it.
  const phaseRef = useRef<Phase>('loading')
  useEffect(() => { phaseRef.current = phase }, [phase])
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
  // getMyChallenges() (or any of the follow-up fetches below) can genuinely
  // fail -- transient network blip, a 500, signed-out mid-session -- same
  // class of gap as the semantic-search "transient 500, no retry" bug found
  // elsewhere in this project. Before this fix, an exception here was an
  // unhandled promise rejection: phase stayed 'loading' forever with no way
  // to tell "still fetching" apart from "will never resolve." Surfaced as an
  // actual error state with a Retry button instead.
  const [loadError, setLoadError] = useState<string | null>(null)
  // RC (real device, feedback a6633018, 2026-08-30): "the screen doesn't do
  // anything when you tap the check-in [Check again] button." loadState()
  // itself was always working -- it re-fetches and re-derives phase exactly
  // like the automatic focus/foreground refreshes above -- but when the
  // opponent genuinely still hasn't accepted, phase doesn't change and
  // nothing on screen moves, which reads identically to "the tap did
  // nothing." A brief spinner on the button itself is purely a tap
  // acknowledgment, independent of whether the refetch finds anything new.
  const [checkingAgain, setCheckingAgain] = useState(false)
  const startedAt = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // RC, real duel test: "most of them just flashed on the screen and didn't
  // give any time to read it." The reveal screen itself has no timer or
  // auto-advance -- it only changes on an explicit NEXT QUESTION tap -- so
  // this isn't the phase disappearing on its own. Choices submit on tap
  // with zero visual "processing" state while submitChallengeAnswer's
  // network round-trip is in flight; a player's finger tapping again out of
  // impatience (or just moving fast through a test run) can land exactly
  // where NEXT QUESTION renders the instant the reveal appears, skipping it
  // before there was ever anything to read. Guards against that specific
  // race rather than the reveal itself being wrong.
  const revealedAt = useRef(0)

  const loadState = useCallback(async () => {
    if (!id) return
    setLoadError(null)
    try {
      const list = await getMyChallenges()
      const c = list.find((x) => x.challengeId === id) ?? null
      setChallenge(c)
      if (c) getDuelStats().then(setMyStats)
      // Previously fell back to 'loading' here, which is indistinguishable
      // from a still-in-flight fetch -- a stale deep link, an old push
      // notification pointing at an already-purged duel, or a genuine data
      // desync all rendered as a spinner that would never resolve. This is
      // a real, distinguishable terminal state now (see phase === 'not_found'
      // below), not a loading state.
      if (!c) { setPhase('not_found'); return }
      if (c.status === 'cancelled' || c.myStatus === 'declined') { setPhase('declined'); return }
      if (c.myStatus === 'pending') { setPhase('pending_response'); return }
      // RC, real duel test: "i selected a person to duel and it just
      // started the game before knowing if they accepted. it needs to send
      // a real invite, get a response, then, if accepted, start the
      // match." create_challenge() puts the CREATOR's own participant row
      // straight to 'active' at creation time -- by design, this app's
      // duels are fully async (see challenges.ts's own header comment) and
      // a challenger playing ahead of an opponent who hasn't answered YET
      // is intentional and already has its own UI ("You're playing ahead
      // -- nobody else has joined yet"). But that's a different thing from
      // this: nothing ever gated the challenger from starting before ANY
      // invite had even been accepted. Gate specifically on that -- once
      // at least one opponent has accepted, the async "everyone plays at
      // their own pace" behavior is unchanged.
      if (c.amChallenger && c.status === 'active' && !c.others.some((o) => o.status === 'active')) {
        setPhase('waiting_accept')
        return
      }
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
    } catch (err: any) {
      setLoadError(err?.message ?? 'Could not load this duel.')
      setPhase('error')
    }
  }, [id])

  // useFocusEffect, not a plain mount-only useEffect -- found in the
  // 2026-08-29 "built but inert" sweep: this screen only ever fetched once,
  // so a duel that changed state while this screen was backgrounded or the
  // user had tab-switched away (the opponent finishing while you're stuck
  // on 'waiting_opponent', an invite finally getting accepted while stuck
  // on 'waiting_accept') never updated on return -- the exact "screen
  // stays mounted, needs a refetch on focus" gap already fixed on 8+ other
  // screens across this app. Guarded on phaseRef, not the initial mount's
  // own loadState() call -- 'playing'/'revealed' are purely client-driven
  // (set by tapping GO / submitting an answer, never by loadState() itself,
  // see those setPhase call sites), so refiring loadState() while either is
  // current would silently reset a live, timed question back to 'ready'
  // out from under the player. Every other phase is "waiting for something
  // external" or idle, where re-syncing to the real server state is exactly
  // the point.
  useFocusEffect(useCallback(() => {
    if (phaseRef.current !== 'playing' && phaseRef.current !== 'revealed') loadState()
  }, [loadState]))

  // ...plus a foreground refresh, matching the identical pair of listeners
  // my-aircraft/index.tsx already has for the same reason -- useFocusEffect
  // alone doesn't fire when the app comes back from the background, only on
  // an actual screen transition, and a real duel can complete while the
  // phone is simply locked mid-match. Same phaseRef guard as above.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && phaseRef.current !== 'playing' && phaseRef.current !== 'revealed') loadState()
    })
    return () => sub.remove()
  }, [loadState])

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
    // !authLoading: isPremium starts false and stays false until auth's own
    // `loading` resolves (see context/auth.tsx). This screen is the direct
    // landing spot for a duel-invite push notification, so "cold launch,
    // tap Accept immediately" is the single most likely real-world way to
    // hit that window -- and it would send a paying Premium subscriber to a
    // Premium paywall instead of into their duel. Swallow the tap for that
    // fraction of a second; tapping again once auth has landed works.
    if (accept && !isPremium) {
      if (!authLoading) router.push('/paywall?tier=premium' as any)
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
    revealedAt.current = Date.now()
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
    // mySetCompleted without challengeCompleted: this user just finished
    // their own questions but at least one other participant hasn't --
    // nudge whoever's still playing. If this finish WAS the last one
    // needed, challengeCompleted is already true and the branch above
    // covers it -- get_duel_push_target's own targeting for 'answered'
    // also excludes anyone who's already finished, so there's no double
    // push either way.
    else if (r.mySetCompleted && id) sendDuelPush(id, 'answered')
  }

  const handleNext = () => {
    // See revealedAt's own comment -- ignore a tap that lands within the
    // same beat as the reveal appearing, so a reflexive double-tap can't
    // skip past it before it was ever visible.
    if (Date.now() - revealedAt.current < 600) return
    // RC, real duel test, round 2: the 600ms double-tap guard above fixed
    // ONE way the reveal could be skipped, but not this -- a normal,
    // deliberate single tap on NEXT QUESTION still produced "a weird flash
    // of some information too fast to read." Root cause: this cleared
    // `result` synchronously while `phase` was still 'revealed' (it only
    // changes once loadState's network round-trip resolves), so the
    // 'revealed' branch re-rendered for that whole in-flight gap with a
    // null result -- a red X, "Answer: undefined", "Your time: 0.0s", and
    // "You're playing ahead" all rendered correctly per the code but wrong
    // for the moment, then vanished the instant real data arrived. Flip to
    // 'loading' (a plain spinner) FIRST so there's nothing stale left on
    // screen to flash while the fetch is in flight.
    setPhase('loading')
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
      // Same authLoading reasoning as handleRespond above -- a results-screen
      // deep link from a "duel finished" push can put a real Premium
      // subscriber on this button before entitlements have resolved.
      if (!authLoading) router.push('/paywall?tier=premium' as any)
      return
    }
    setRematching(true)
    try {
      const newId = await createChallenge(
        opponentIds,
        challenge.questionCount,
        challenge.itemTypes ?? undefined,
        // Ratings folded into levels now (see StudyLevel's own comment) --
        // merge both here too, so a rematch of an OLD duel (created before
        // this change, whose rating values still live in the separate
        // `ratings` column) carries its full original filter forward
        // instead of silently dropping the rating half.
        [...(challenge.levels ?? []), ...(challenge.ratings ?? [])],
        challenge.categoryClasses ?? undefined
      )
      sendDuelPush(newId, 'invited')
      router.replace(`/challenges/${newId}` as any)
    } catch (err: any) {
      confirm({ title: 'Could not start rematch', message: err?.message ?? 'Unknown error', cancelLabel: null })
      setRematching(false)
    }
  }

  // RC, 2026-08-22, exact rule: "once they start the challenge and hit go
  // on the first question, they are not allowed to leave the game without
  // forfeiting" -- "started" is derived the same way the rest of this fix
  // derives it server-side (see forfeitChallenge/cancel_challenge in
  // challenges.ts): at least one question already answered in THIS duel.
  // Below that, or once you've already answered everything you have left
  // to answer (myAnsweredCount === questionCount -- you're just waiting on
  // others, nothing to forfeit), or once the duel is already over, backing
  // out is a plain, unconfirmed nav exactly like before.
  const handleBack = () => {
    const stillMine = challenge != null && challenge.status === 'active' && challenge.myStatus === 'active'
    const started = stillMine && challenge!.myAnsweredCount > 0 && challenge!.myAnsweredCount < challenge!.questionCount
    if (!started || !id) {
      router.back()
      return
    }
    const othersLabel = (challenge?.others.length ?? 0) === 1 ? (challenge?.others[0]?.label ?? 'your opponent') : 'the other players'
    confirm({
      title: 'Forfeit Duel?',
      message: `You've answered ${challenge!.myAnsweredCount} of ${challenge!.questionCount} questions. Leaving now forfeits the duel — ${othersLabel} will win automatically.`,
      confirmLabel: 'Forfeit & Leave',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        await forfeitChallenge(id)
        router.back()
      },
    })
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
      <OverlayHeader title={title} onBack={handleBack} />

      {/* RC, real duel reports: long answer choices ran off the bottom of
          the playing screen with no way to scroll down to them, and the
          per-question breakdown on the results screen had the same problem
          -- this whole body had no ScrollView at all before, so anything
          taller than one phone screen was simply unreachable. Same
          flexGrow-on-contentContainer pattern as study.tsx's own card
          screen (see its scrollContent comment): short phases (loading,
          "Ready?", the reveal screen) still center via their own flex:1
          `center`/`playArea` styles, while tall ones (many choices, a long
          results list) grow past the viewport and scroll. */}
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
      {challenge && phase !== 'loading' && <FilterSummary challenge={challenge} tokens={tokens} fs={fs} />}

      {(phase === 'ready' || phase === 'playing' || phase === 'revealed') && myStats && (
        <View style={[styles.statsBar, { borderBottomColor: tokens.bdr }]}>
          <StatPill label="You" stats={myStats} tokens={tokens} fs={fs} />
        </View>
      )}

      {phase === 'loading' ? (
        <View style={styles.center}><ActivityIndicator color={tokens.blu} /></View>
      ) : phase === 'not_found' ? (
        <View style={styles.center}>
          <Icon name="questionmark.circle" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Duel not found</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            This duel may have been deleted, or the link is out of date.
          </Text>
          <Pressable style={[styles.goBtnSmall, { backgroundColor: tokens.bg2, borderWidth: 1, borderColor: tokens.bdr, marginTop: 14 }]} onPress={() => router.back()}>
            <Text style={[styles.goBtnSmallText, { color: tokens.t2, fontSize: fs(14) }]}>Go Back</Text>
          </Pressable>
        </View>
      ) : phase === 'error' ? (
        <View style={styles.center}>
          <Icon name="exclamationmark.triangle" size={fs(36)} color={tokens.red} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Couldn't load this duel</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            {loadError ?? 'Something went wrong. Check your connection and try again.'}
          </Text>
          <Pressable style={[styles.goBtnSmall, { backgroundColor: tokens.gold, marginTop: 14 }]} onPress={() => loadState()}>
            <Text style={[styles.goBtnSmallText, { fontSize: fs(14) }]}>Retry</Text>
          </Pressable>
        </View>
      ) : phase === 'declined' ? (
        // 'cancelled' now has a distinct cause from 'I declined': the DB
        // cancels a duel when nobody is left to play it (every invitee
        // declined), so "Duel declined" would misattribute that to the
        // viewer. See sync/migrations_duels_2.sql. As of 2026-08-22 it can
        // ALSO mean the creator cancelled it outright before playing
        // (cancelChallenge, bug 2's fix) -- possibly after you'd already
        // accepted and answered a few questions -- so this no longer
        // guesses at "everyone declined" as the one and only reason.
        <View style={styles.center}>
          <Icon name="xmark.circle" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>
            {challenge?.myStatus === 'declined' ? 'You declined this duel' : 'Duel cancelled'}
          </Text>
        </View>
      ) : phase === 'pending_response' ? (
        <View style={styles.center}>
          <Icon name="trophy" size={fs(36)} color={tokens.gold} />
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
      ) : phase === 'waiting_accept' ? (
        <View style={styles.center}>
          <Icon name="hourglass" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Waiting for a response</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            {otherCount === 1
              ? `${challenge?.others[0]?.label ?? 'They'} hasn't accepted your invite yet — the duel starts once they do.`
              : "Nobody's accepted your invite yet — the duel starts once at least one player does."}
          </Text>
          <Pressable
            style={[styles.goBtnSmall, { backgroundColor: tokens.gold, marginTop: 14, opacity: checkingAgain ? 0.6 : 1 }]}
            disabled={checkingAgain}
            onPress={async () => { setCheckingAgain(true); await loadState(); setCheckingAgain(false) }}
          >
            {checkingAgain
              ? <ActivityIndicator color="#000" size="small" />
              : <Text style={[styles.goBtnSmallText, { fontSize: fs(14) }]}>Check again</Text>}
          </Pressable>
        </View>
      ) : phase === 'waiting_opponent' ? (
        // "Waiting on them to finish" was wrong whenever the other player
        // hadn't even accepted yet -- a real state now that a duel no longer
        // completes out from under a pending invitee (migrations_duels.sql).
        <View style={styles.center}>
          <Icon name="hourglass" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>You've answered every question</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>{waitingCopy}</Text>
        </View>
      ) : phase === 'ready' ? (
        <View style={styles.center}>
          <Text style={[styles.progress, { color: tokens.t4, fontSize: fs(12) }]}>
            QUESTION {(question?.sortOrder ?? 0) + 1} OF {challenge?.questionCount}
          </Text>
          <Text style={[styles.readyTitle, { color: tokens.t1, fontSize: fs(22) }]}>Ready?</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
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
            <Text style={[styles.prompt, { color: tokens.t1, fontSize: fs(18), lineHeight: fs(18) * 1.33 }]}>{question?.prompt}</Text>
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
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Your time: {formatDuelSecondsLabel(myTimeMs)} (only counts if everyone tied with you got it right)
          </Text>
          {/* "0 of 0 others answered this one so far" is what this read
              before anyone accepted the invite -- seen live. */}
          <Text style={[styles.emptySub, { color: tokens.t4, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.41 }]}>
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
      </ScrollView>
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

// r.term is the item's own identifier for every type except P/CG (needs
// slugifyPcgTerm -- its slug isn't stored, only reconstructible from the
// term) and dictionary (r.itemId is the real, stored slug -- unlike pcg's
// term, a dictionary term doesn't reduce to its own slug algorithmically,
// see get_challenge_results()'s own comment for why itemId exists).
function openResultItem(r: ChallengeResultRow) {
  if (!r.term) return
  if (r.itemType === 'pcg') router.push(`/pcg/${slugifyPcgTerm(r.term)}` as any)
  else if (r.itemType === 'dictionary') router.push(`/dictionary/${r.itemId}` as any)
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
  // A standings row's display label (a duel opponent's chosen name) can run
  // long and get cut off the same way FAR Part titles do -- same hook/card
  // pair as far/index.tsx's own long-press preview. ResultsView renders once
  // per screen (not once per row), so the hook lives here rather than being
  // threaded down from the top-level screen component.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  return (
    <View style={styles.resultsWrap}>
      {outcome === 'won' && <ConfettiBurst />}
      <View style={styles.resultsSummary}>
        <Icon name={outcome === 'won' ? 'rosette' : 'trophy'} size={fs(32)} color={tokens.gold} />
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
            <Pressable
              style={{ flex: 1 }}
              onLongPress={(e) => showPreview(s.isMe ? 'You' : s.label, e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Text style={[styles.standingLabel, { color: tokens.t1, fontSize: fs(14) }]} numberOfLines={1}>
                {s.isMe ? 'You' : s.label}
              </Text>
            </Pressable>
            <Text style={[styles.standingScore, { color: s.isForfeited ? tokens.red : tokens.t2, fontSize: fs(13) }]}>
              {/* RC: "they need to be told that they forfeit" -- this is the
                  one shared, both-players-see-it place that fact lives,
                  rather than only a one-time dialog on the forfeiter's own
                  device. */}
              {s.isForfeited ? 'Forfeited' : `${s.correctCount} correct${s.tieGroupSize > 1 ? ` · ${formatDuelSecondsLabel(s.tiebreakMs)}` : ''}`}
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
            <Text style={[styles.resultPrompt, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]} numberOfLines={3}>
              {r.definition}
            </Text>
          )}
          {r.answers.map((a) => (
            <Text
              key={a.userId}
              style={[styles.resultAnswer, { color: a.isCorrect ? tokens.grn : tokens.red, fontSize: fs(12) }]}
            >
              {/* get_challenge_results now also returns a forfeiter's row
                  (see sync/migrations_fix_duel_forfeit_and_cancel.sql) --
                  they may never have reached this specific question, which
                  reads as a real answer/answerText/timeMs of null (a LEFT
                  JOIN with nothing to join). Previously every non-`true`
                  isCorrect rendered as a hard ✕ ("got it wrong"), which is
                  wrong for "never got here at all." */}
              {a.isMe ? 'You' : a.label}: {a.isCorrect == null ? (a.isForfeited ? 'forfeited before this one' : 'did not answer') : a.isCorrect ? '✓' : '✕'}
              {a.isCorrect === false && a.answerText ? ` ${a.answerText}` : ''}
              {a.timeMs != null ? ` · ${formatDuelSecondsLabel(a.timeMs)}` : ''}
            </Text>
          ))}
        </Pressable>
      ))}
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 24 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6, textAlign: 'center' },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  emptySub: { textAlign: 'center', maxWidth: 300 },

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
  // lineHeight NOT set here -- always overridden inline with fs(18) * 1.33
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  prompt: { fontWeight: '600' },

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
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  resultPrompt: { marginBottom: 5 },
  resultAnswer: { fontWeight: '600' },
})
