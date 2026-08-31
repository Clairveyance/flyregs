import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Modal, ScrollView, TextInput, Keyboard, KeyboardAvoidingView, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS, useInputFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import {
  getMyChallenges, getChallengeableUsers, createChallenge, respondToChallenge, getDuelStats, sendDuelPush,
  getUnseenCoins, markCoinsSeen, hideChallengeFromHistory, cancelChallenge, forfeitChallenge,
  MyChallenge, ChallengeableUser, DuelStats, DuelItemType, StudyLevel, ALL_STUDY_LEVELS, STUDY_LEVEL_LABELS,
} from '@/lib/challenges'
import { SwipeToDelete } from '@/components/SwipeToDelete'
import { CategoryClass, CATEGORY_CLASSES, RATING_SHORT_LABELS } from '@/lib/profileRatings'
import { useConfirm } from '@/components/ConfirmDialog'
import { COIN_BY_CODE, type CoinDef, TROPHY_BY_CODE } from '@/lib/coins'
import { CoinRevealModal } from '@/components/CoinRevealModal'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { resolveCallsignToUserId } from '@/lib/contactMatch'
import { FindFriendsPickerBody } from '@/components/FindFriendsSheet'
import { AvatarCircle } from '@/components/AvatarCircle'

const QUESTION_COUNTS = [3, 5, 10]
const ALL_TYPES: DuelItemType[] = ['far', 'aim', 'pcg', 'ac', 'dictionary', 'cfr49']
const TYPE_LABEL: Record<DuelItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC', dictionary: 'A/D', cfr49: '49 CFR' }
const MAX_OPPONENTS = 7
// RC: "everything in the app... must always open very fast and move
// between its own pages... this shouldn't be slowed down each time the
// internet is slow." Duels' list/stats are real per-account data, so this
// is uid-scoped -- same convention and cross-account-leak rationale as
// ready-room.tsx's READY_ROOM_CACHE_KEY_PREFIX (memory/gotcha_local_data_leaks_across_accounts.md).
const CHALLENGES_CACHE_KEY_PREFIX = '@flyregs/challenges-cache:'

export default function ChallengesScreen() {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const ifs = useInputFS()
  const { session, isPremium, loading: authLoading } = useAuth()
  const [challenges, setChallenges] = useState<MyChallenge[]>([])
  const [myStats, setMyStats] = useState<DuelStats | null>(null)
  const [loading, setLoading] = useState(true)
  // Mirrors the latest challenges/myStats for load()'s own cache-write
  // below. load() is deliberately stable-identity ([] deps), so it can't
  // safely close over fresh challenges/myStats state without risking the
  // stale-closure class this codebase has already been bitten by
  // (memory/gotcha_stale_closure_runsearch.md) -- same idiom as
  // ready-room.tsx's rowsRef/uidRef.
  const dataRef = useRef<{ challenges: MyChallenge[]; myStats: DuelStats | null }>({ challenges: [], myStats: null })
  const uidRef = useRef<string | null>(null)
  const [pickerVisible, setPickerVisible] = useState(false)
  // RC: the New Duel sheet used to be one long scroll -- filters, then
  // opponents, then Start -- with nothing marking the handoff between
  // "choosing what to duel on" and "choosing who to duel." He read that as
  // opponent selection not working at all ("that doesn't help you select
  // anybody new"), because picking a filter chip didn't visibly DO
  // anything -- there was no button to press to move forward. Split into
  // an explicit 2-step wizard: filters -> Continue -> opponents -> Start.
  // RC, real device, on the opponents step: "the choose opp screen only has
  // people already there, it needs to have a way to select new oppos too
  // (search, callsign, text invite, groups, etc). from this screen. this is
  // the main way to start a duel." 'findFriends' is a 3rd sub-step of this
  // same step (not a separate modal -- stacking a second native <Modal>
  // is the exact bug already fixed elsewhere in this app), Back from it
  // returns to 'opponents', not all the way to 'filters'.
  const [step, setStep] = useState<'filters' | 'opponents' | 'findFriends'>('filters')
  const [opponents, setOpponents] = useState<ChallengeableUser[]>([])
  const [selectedOpponents, setSelectedOpponents] = useState<string[]>([])
  // Callsign search, same debounced validate-as-you-type pattern already
  // proven in the aircraft/folder Invite by Callsign flows.
  const [newOppCallsign, setNewOppCallsign] = useState('')
  const [callsignCheck, setCallsignCheck] = useState<'idle' | 'checking' | 'found' | 'not_found'>('idle')
  useEffect(() => {
    const trimmed = newOppCallsign.trim()
    if (!trimmed) { setCallsignCheck('idle'); return }
    setCallsignCheck('checking')
    const t = setTimeout(() => {
      resolveCallsignToUserId(trimmed)
        .then((userId) => setCallsignCheck(userId ? 'found' : 'not_found'))
        .catch(() => setCallsignCheck('idle'))
    }, 400)
    return () => clearTimeout(t)
  }, [newOppCallsign])
  const [questionCount, setQuestionCount] = useState(5)
  const [activeTypes, setActiveTypes] = useState<DuelItemType[]>([])
  const [activeLevels, setActiveLevels] = useState<StudyLevel[]>([])
  const [activeCategoryClasses, setActiveCategoryClasses] = useState<CategoryClass[]>([])
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [unseenCoinQueue, setUnseenCoinQueue] = useState<string[]>([])
  // Same "clean up the filter rows" ask, same fix as study.tsx (2026-08-12):
  // Category/Class + Rating collapsed behind their own toggle so the New
  // Duel sheet's common case (Content + Level) stays short.
  const [moreFiltersExpanded, setMoreFiltersExpanded] = useState(false)
  // A duel row's opponent-list label can run long (multiple names) and get
  // cut off the same way FAR Part titles do -- same hook/card pair as
  // far/index.tsx's own long-press preview.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  // ALL and individual chips are mutually exclusive: ALL can't be "pared
  // down" (it already means everything), so picking any individual chip
  // starts a fresh explicit selection and picking ALL clears it -- see
  // study.tsx's identical fix for why (both could render as selected at
  // once before, confirmed confusing live).
  // Any filter change invalidates a "no questions match those filters"
  // error -- leaving it up while the player fixes the selection reads as
  // though the fix didn't work.
  const toggleType = (t: DuelItemType) => {
    setCreateError(null)
    setActiveTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    )
  }

  const toggleLevel = (l: StudyLevel) => {
    setCreateError(null)
    setActiveLevels((prev) =>
      prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]
    )
  }

  const toggleCategoryClass = (c: CategoryClass) => {
    setCreateError(null)
    setActiveCategoryClasses((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    )
  }

  const load = useCallback(() => {
    setLoading(true)
    // Same stale-isPremium-cache race as openPicker's own comment below --
    // get_duel_stats() also raises if the server's live entitlement check
    // disagrees with this screen's cached isPremium gate. Silent catch (not
    // a user-facing dialog) matches this function's own background-refresh
    // nature -- markCoinsSeen right below does the same.
    getMyChallenges()
      .then((rows) => {
        setChallenges(rows)
        dataRef.current.challenges = rows
        // Cache for next open -- see CHALLENGES_CACHE_KEY_PREFIX's own
        // comment for the uid-scoping rationale. Merges in myStats' latest
        // known value via dataRef so a fast challenges-only refresh never
        // overwrites stats with stale/empty data, and vice versa below.
        if (uidRef.current) {
          AsyncStorage.setItem(CHALLENGES_CACHE_KEY_PREFIX + uidRef.current, JSON.stringify(dataRef.current)).catch(() => {})
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    getDuelStats()
      .then((stats) => {
        setMyStats(stats)
        dataRef.current.myStats = stats
        if (uidRef.current) {
          AsyncStorage.setItem(CHALLENGES_CACHE_KEY_PREFIX + uidRef.current, JSON.stringify(dataRef.current)).catch(() => {})
        }
      })
      .catch(() => {})
    // Catch-up path for the coin-toast timing bug (2026-08-11): a Duel win's
    // coin only reveals synchronously to whichever player's submission
    // happened to finish the challenge, not necessarily the real winner if
    // that was the other (possibly-offline) player. Whoever that is sees it
    // here instead, the next time they open the Duels hub.
    // .catch(() => {}) to match the two calls above -- get_unseen_coins()
    // throws on any RPC error (lib/challenges.ts), and this chain had no
    // catch at all, so a transient failure on a screen that refetches on
    // EVERY focus was an unhandled rejection. Silent, same as the rest of
    // this background refresh.
    getUnseenCoins().then((codes) => { if (codes.length) setUnseenCoinQueue(codes) }).catch(() => {})
  }, [])

  useFocusEffect(useCallback(() => { if (isPremium) load() }, [isPremium, load]))

  // Cache-first paint, RC: "everything in the app... must always open very
  // fast" -- hydrates from this user's last-known snapshot so the Duels hub
  // shows real content immediately instead of a spinner. The real fetch in
  // `load()` above still always runs regardless (on every focus, unchanged)
  // and overwrites this with fresh data once it resolves.
  useEffect(() => {
    uidRef.current = session?.user?.id ?? null
    if (!session) {
      // Clear on sign-out -- this screen doesn't unmount between accounts on
      // a shared device any more than my-aircraft/index.tsx's own fleet
      // list does, so leftover rows here would be the same class of
      // cross-account leak this whole prefix exists to avoid.
      setChallenges([]); setMyStats(null)
      dataRef.current = { challenges: [], myStats: null }
      return
    }
    AsyncStorage.getItem(CHALLENGES_CACHE_KEY_PREFIX + session.user.id).then((cached) => {
      if (!cached) return
      try {
        const snap = JSON.parse(cached) as { challenges?: MyChallenge[]; myStats?: DuelStats | null }
        if (snap.challenges?.length) { setChallenges(snap.challenges); dataRef.current.challenges = snap.challenges }
        if (snap.myStats) { setMyStats(snap.myStats); dataRef.current.myStats = snap.myStats }
        if (snap.challenges?.length || snap.myStats) setLoading(false)
      } catch (_) {}
    }).catch(() => {})
  }, [session])

  const dismissUnseenCoin = () => {
    const [shown, ...rest] = unseenCoinQueue
    if (shown) markCoinsSeen([shown]).catch(() => {})
    setUnseenCoinQueue(rest)
  }

  const openPicker = () => {
    // RC, real device (Sentry): "Duels requires Premium" -- a raw Postgres
    // exception from get_challengeable_users() itself -- surfaced as an
    // unhandled promise rejection with no .catch() anywhere. This screen's
    // own `isPremium` client cache (only refreshed on sign-in/~hourly JWT
    // refresh, same known-stale-cache class of bug found repeatedly this
    // session) can briefly disagree with the server's live entitlement
    // check, most likely right after a background/foreground cycle -- the
    // real event showed a cancelled RevenueCat refresh while backgrounded,
    // then this picker opened moments after foregrounding. Before this fix,
    // `setPickerVisible(true)` below still ran unconditionally, so the
    // sheet opened and just sat there with an opponents list that would
    // never populate and no error shown -- indistinguishable from the app
    // "locking up" to whoever's tapping it.
    getChallengeableUsers().then(setOpponents).catch(() => {
      confirm({
        title: 'Could Not Load',
        message: 'Your Premium status could not be confirmed right now. Please try again in a moment.',
        cancelLabel: null,
      })
    })
    setSelectedOpponents([])
    setCreateError(null)
    setStep('filters')
    setPickerVisible(true)
  }

  const toggleOpponent = (userId: string) => {
    setSelectedOpponents((prev) => {
      if (prev.includes(userId)) return prev.filter((x) => x !== userId)
      if (prev.length >= MAX_OPPONENTS) {
        confirm({ title: 'Duel is full', message: `Duels support up to ${MAX_OPPONENTS + 1} total participants.`, cancelLabel: null })
        return prev
      }
      return [...prev, userId]
    })
  }

  // Adds someone found via Callsign search or Find Friends who ISN'T
  // already in the getChallengeableUsers() list -- e.g. a real friend who
  // hasn't opted into the Ready Room leaderboard, or simply someone not
  // duelled before. Folded into the SAME list/selection state as the
  // existing opponents rather than a separate "new" section, so the cap
  // check and Start Duel button both just work unchanged.
  const addOpponent = (userId: string, displayLabel: string) => {
    if (selectedOpponents.length >= MAX_OPPONENTS && !selectedOpponents.includes(userId)) {
      confirm({ title: 'Duel is full', message: `Duels support up to ${MAX_OPPONENTS + 1} total participants.`, cancelLabel: null })
      return
    }
    setOpponents((prev) => (prev.some((o) => o.userId === userId) ? prev : [...prev, { userId, displayLabel, avatarUrl: null, avatarPreset: null }]))
    setSelectedOpponents((prev) => (prev.includes(userId) ? prev : [...prev, userId]))
    setNewOppCallsign('')
    setCallsignCheck('idle')
    Keyboard.dismiss()
  }

  // Shown INLINE in the sheet rather than via Alert.alert: the only failure
  // a player can actually act on is "no questions match those filters", and
  // the fix is two inches above the button they just pressed. (Alert is also
  // a no-op on react-native-web, so the preview showed no feedback at all.)
  const handleStartDuel = async () => {
    if (selectedOpponents.length === 0 || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const id = await createChallenge(selectedOpponents, questionCount, activeTypes, activeLevels, activeCategoryClasses)
      setPickerVisible(false)
      sendDuelPush(id, 'invited')
      router.push(`/challenges/${id}` as any)
    } catch (err: any) {
      setCreateError(err?.message ?? 'Could not create the duel.')
    }
    setCreating(false)
  }

  // respond_to_challenge legitimately rejects now (the duel finished or was
  // cancelled while this invite sat in the list), so this can't be a bare
  // await -- an unhandled rejection here used to leave the row looking
  // untouched with no explanation.
  const handleRespond = async (c: MyChallenge, accept: boolean) => {
    try {
      await respondToChallenge(c.challengeId, accept)
    } catch (err: any) {
      confirm({ title: 'Duel unavailable', message: err?.message ?? 'That duel is no longer available.', cancelLabel: null })
      load()
      return
    }
    if (accept) {
      sendDuelPush(c.challengeId, 'accepted')
      router.push(`/challenges/${c.challengeId}` as any)
    } else load()
  }

  // RC 2026-08-16: "basic swipe to delete, so users can clean up their
  // duel history. total W/L count will still show in other areas and on
  // leaderboard, etc." -- hideChallengeFromHistory only touches THIS
  // user's own challenge_participants row, so wins/losses/ties
  // (user_duel_stats) and the other participant's own history are
  // untouched. Optimistic removal from local state, with a rollback +
  // error dialog if the RPC fails (same shape as every other mutation on
  // this screen, e.g. handleRespond above).
  //
  // RC 2026-08-22, exact rule: "A person can send a challenge and then
  // delete the challenge before they start playing and the challenge just
  // goes away even if the other person has already started, but once they
  // start the challenge and hit go on the first question, they are not
  // allowed to leave the game without forfeiting and can't delete the
  // challenge without also forfeiting." hideChallengeFromHistory is a pure
  // PER-USER cosmetic hide that never touched the other side at all -- a
  // "deleted" pending/active duel stayed fully visible and playable for the
  // opponent forever (bug 2). It's still correct for an ALREADY-OVER duel
  // (completed/cancelled, nothing left to propagate), but a still-'active'
  // one now routes through the real exit that matches how far the caller
  // got: still pending -> decline (same as the X button); accepted but
  // haven't answered anything -> cancelChallenge (a clean, no-penalty exit
  // that the server also now blocks past this point, see sync/migrations_
  // fix_duel_forfeit_and_cancel.sql); already answered >=1 question ->
  // forfeitChallenge, which the server completes immediately in the
  // opponent's favor.
  const handleDeleteFromHistory = (c: MyChallenge) => {
    if (c.status === 'active') {
      if (c.myStatus === 'pending') {
        handleRespond(c, false)
        return
      }
      const othersLabel = c.others.length === 1 ? (c.others[0]?.label ?? 'Your opponent') : 'The other players'
      if (c.myAnsweredCount > 0) {
        confirm({
          title: 'Forfeit Duel',
          message: `You've already answered ${c.myAnsweredCount} question${c.myAnsweredCount === 1 ? '' : 's'} in this duel. Leaving now forfeits it — ${othersLabel} will win automatically.`,
          confirmLabel: 'Forfeit',
          destructive: true,
          twoStep: false,
          onConfirm: async () => {
            setChallenges((prev) => prev.filter((x) => x.challengeId !== c.challengeId))
            try {
              await forfeitChallenge(c.challengeId)
            } catch (err: any) {
              load()
              throw err
            }
          },
        })
        return
      }
      confirm({
        title: c.amChallenger ? 'Cancel Duel' : 'Leave Duel',
        message: c.amChallenger
          ? "Cancel this duel? It'll be removed for everyone, even if someone else already started playing."
          : "Leave this duel? You haven't answered any questions yet, so there's no penalty.",
        confirmLabel: c.amChallenger ? 'Cancel Duel' : 'Leave',
        destructive: true,
        twoStep: false,
        onConfirm: async () => {
          setChallenges((prev) => prev.filter((x) => x.challengeId !== c.challengeId))
          try {
            await cancelChallenge(c.challengeId)
          } catch (err: any) {
            load()
            throw err
          }
        },
      })
      return
    }
    confirm({
      title: 'Delete Duel',
      message: `Remove this duel from your history? Your win/loss record and leaderboard stats won't change${c.others.length === 1 ? '' : ' — this only hides it from your list'}.`,
      confirmLabel: 'Delete',
      destructive: true,
      twoStep: false,
      onConfirm: async () => {
        setChallenges((prev) => prev.filter((x) => x.challengeId !== c.challengeId))
        try {
          await hideChallengeFromHistory(c.challengeId)
        } catch (err: any) {
          load()
          throw err
        }
      },
    })
  }

  // isPremium starts false and only becomes authoritative once auth's own
  // `loading` resolves (cold launch, and the SIGNED_IN event a Face ID
  // sign-in raises -- see context/auth.tsx). A duel-invite push notification
  // deep-links straight into this area, so a real Premium subscriber
  // genuinely can land here inside that window and be told Duels is a
  // feature they don't have. Wait for the real answer.
  if (!isPremium && authLoading) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Duels" onBack={() => router.back()} />
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      </View>
    )
  }

  if (!isPremium) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Duels" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Duels are a Premium feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Challenge 1-7 other players to a free-for-all multiple-choice quiz across FAR, AIM, P/CG, and ACs — most correct answers wins, with time as the tiebreaker.
          </Text>
          {/* This lock screen had no CTA at all -- a free user who found
              Duels hit a dead end with no way to unlock it, unlike Study
              Mode's lock right next to it. */}
          <Pressable style={[styles.upgradeBtn, { backgroundColor: tokens.blu }]} onPress={() => router.push('/paywall?tier=premium')}>
            <Text style={[styles.upgradeBtnText, { fontSize: fs(15) }]}>Unlock Premium</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader
        title="Duels"
        onBack={() => router.back()}
        right={
          <Pressable onPress={openPicker} hitSlop={12} style={{ padding: 4 }}>
            <Icon name="plus" size={fs(22)} color={tokens.gold} />
          </Pressable>
        }
      />
      {myStats && (myStats.wins > 0 || myStats.losses > 0 || myStats.ties > 0) && (
        <View style={[styles.myStatsBar, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}>
          <Icon name="rosette" size={fs(16)} color={tokens.gold} />
          <Text style={[styles.myStatsText, { color: tokens.t1, fontSize: fs(13.5) }]}>
            <Text style={{ color: tokens.gold, fontWeight: '700' }}>{myStats.wins}</Text> wins ·{' '}
            <Text style={{ color: tokens.t2 }}>{myStats.losses}</Text> losses
            {myStats.ties > 0 ? ` · ${myStats.ties} ties` : ''}
          </Text>
        </View>
      )}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={tokens.blu} />
        </View>
      ) : challenges.length === 0 ? (
        <View style={styles.center}>
          <Icon name="trophy" size={fs(36)} color={tokens.t4} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>No duels yet</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.41 }]}>
            Tap + to challenge one or more players from Ready Room.
          </Text>
        </View>
      ) : (
        <FlatList
          data={challenges}
          keyExtractor={(c) => c.challengeId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <ChallengeRow
              item={item}
              tokens={tokens}
              fs={fs}
              onRespond={handleRespond}
              onDelete={handleDeleteFromHistory}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          )}
        />
      )}

      {/* RC (2026-08-29, real device): "the pop-up is compressed and not
          showing all the proper data" -- this was the only bottom-sheet
          Modal anywhere in the app using animationType="fade"; every other
          KeyboardAvoidingView+TextInput bottom sheet (5 instances in
          my-aircraft/[id].tsx alone) uses "slide". "fade" cross-dissolves
          the whole Modal in place rather than sliding it in via a real
          transform, which changes how/when its content's on-screen frame
          settles relative to KeyboardAvoidingView's own padding
          recalculation -- a real device with the keyboard already up (as
          shown in the reported screenshot, mid Callsign-search) is exactly
          where that timing gap would show up as compressed/overlapping
          content, while this environment's web preview (no real keyboard
          animation to race against) never could have caught it. Matched to
          the proven-working pattern rather than left as the one outlier. */}
      <Modal visible={pickerVisible} transparent animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        {/* RC, real device: "can't access. k/b pops up covering everything
            and the box doesn't adjust up" -- the Callsign search input is
            new to this sheet (it never had a text field before), and the
            sheet was never wrapped in a KeyboardAvoidingView the way every
            other bottom sheet with a TextInput in this app already is
            (see my-aircraft/[id].tsx's Invite by Callsign modal, the exact
            same pattern). */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}
        >
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr, paddingBottom: Math.max(18, insets.bottom + 8) }]}>
            {/* Suppressed for the findFriends sub-step -- FindFriendsPickerBody
                renders its own header (Close + "Find Friends" title), same
                convention already used everywhere else this component is
                embedded (aircraft/folder invite flows) rather than
                stacking two headers. */}
            {step !== 'findFriends' && (
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {step !== 'filters' && (
                  <Pressable onPress={() => setStep('filters')} hitSlop={10}>
                    <Icon name="chevron.left" size={fs(18)} color={tokens.blu} />
                  </Pressable>
                )}
                <Text style={[styles.modalTitle, { color: tokens.t1, fontSize: fs(16) }]}>
                  {step === 'filters' ? 'New Duel' : 'Choose Opponents'}
                </Text>
              </View>
              <Pressable onPress={() => setPickerVisible(false)} hitSlop={10}>
                <Icon name="xmark" size={fs(18)} color={tokens.t3} />
              </Pressable>
            </View>
            )}

            {step === 'findFriends' && (
              <View style={{ maxHeight: 420 }}>
                <FindFriendsPickerBody
                  onClose={() => setStep('opponents')}
                  onSelect={(callsign) => {
                    // .catch(() => {}): resolveCallsignToUserId throws, and
                    // all three call sites in this file are onPress/onSubmit
                    // handlers with nowhere for a rejection to land. A
                    // failure here just means the opponent isn't added.
                    resolveCallsignToUserId(callsign).then((id) => { if (id) addOpponent(id, callsign) }).catch(() => {})
                    setStep('opponents')
                  }}
                />
              </View>
            )}

            {/* BB-091 corpus-wide audit ("checks to all other CTA and popups
                app wide"): `modalCard` had a `maxHeight: '85%'` but no
                ScrollView around this body -- 6 filter rows plus a
                potentially-long opponent list plus the Start button, on a
                plain View, meant the maxHeight just truncated the content
                with no way to reach whatever fell past it. Same pattern
                already fixed for my-aircraft/[id].tsx's ReminderFormModal
                and AvatarEditModal -- header stays pinned outside. */}
            {step !== 'findFriends' && (
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {step === 'filters' && (<>
            <Text style={[styles.modalLabel, { color: tokens.t3, fontSize: fs(11) }]}>QUESTIONS</Text>
            <View style={styles.countRow}>
              {QUESTION_COUNTS.map((n) => (
                <Pressable
                  key={n}
                  style={[
                    styles.countChip,
                    { backgroundColor: questionCount === n ? tokens.gold : tokens.bg2, borderColor: questionCount === n ? tokens.gold : tokens.bdr },
                  ]}
                  onPress={() => setQuestionCount(n)}
                >
                  <Text style={[styles.countChipText, { color: questionCount === n ? '#000' : tokens.t2, fontSize: fs(13) }]}>{n}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.modalLabel, { color: tokens.gold, fontSize: fs(11), marginTop: 14 }]}>CONTENT</Text>
            <View style={styles.countRow}>
              <Pressable
                style={[
                  styles.countChip,
                  { backgroundColor: activeTypes.length === 0 ? tokens.goldlt : tokens.bg2, borderColor: activeTypes.length === 0 ? tokens.goldbdr : tokens.bdr },
                ]}
                onPress={() => { setCreateError(null); setActiveTypes([]) }}
              >
                <Text style={[styles.countChipText, { color: activeTypes.length === 0 ? tokens.gold : tokens.t3, fontSize: fs(13) }]}>ALL</Text>
              </Pressable>
              {ALL_TYPES.map((t) => {
                const active = activeTypes.includes(t)
                return (
                  <Pressable
                    key={t}
                    style={[
                      styles.countChip,
                      { backgroundColor: active ? tokens.goldlt : tokens.bg2, borderColor: active ? tokens.goldbdr : tokens.bdr },
                    ]}
                    onPress={() => toggleType(t)}
                  >
                    <Text style={[styles.countChipText, { color: active ? tokens.gold : tokens.t3, fontSize: fs(13) }]}>{TYPE_LABEL[t]}</Text>
                  </Pressable>
                )
              })}
            </View>

            {/* Student pilots shouldn't get quizzed on ATP/CFI-only material
                and vice versa; a mechanic session shouldn't pull pilot
                certification questions at all -- classification is real FAR
                structure (far_knowledge_levels() in the DB), not a guess.
                Blue accent (vs. CONTENT's gold) so the two filter groups
                read as distinct dimensions, not one ambiguous chip row. */}
            <Text style={[styles.modalLabel, { color: tokens.blu, fontSize: fs(11), marginTop: 14 }]}>KNOWLEDGE LEVEL</Text>
            <View style={styles.countRow}>
              <Pressable
                style={[
                  styles.countChip,
                  { backgroundColor: activeLevels.length === 0 ? tokens.bdim : tokens.bg2, borderColor: activeLevels.length === 0 ? tokens.blu : tokens.bdr },
                ]}
                onPress={() => { setCreateError(null); setActiveLevels([]) }}
              >
                <Text style={[styles.countChipText, { color: activeLevels.length === 0 ? tokens.blu : tokens.t3, fontSize: fs(13) }]}>ALL</Text>
              </Pressable>
              {ALL_STUDY_LEVELS.map((l) => {
                const active = activeLevels.includes(l)
                return (
                  <Pressable
                    key={l}
                    style={[
                      styles.countChip,
                      { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.blu : tokens.bdr },
                    ]}
                    onPress={() => toggleLevel(l)}
                  >
                    <Text style={[styles.countChipText, { color: active ? tokens.blu : tokens.t3, fontSize: fs(13) }]}>{STUDY_LEVEL_LABELS[l]}</Text>
                  </Pressable>
                )
              })}
            </View>

            {/* RC, real device: "give this 'more filters' some space, it's
                hard to click, it's so close" -- this toggle's tap target
                was just the bare text/icon height, sitting right above the
                Next button with only 16px between them. Real padding (not
                just hitSlop) both enlarges the touch area AND pushes the
                Next button further away, so a slightly-off tap doesn't
                clip the other control. */}
            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 14, paddingVertical: 10 }}
              onPress={() => setMoreFiltersExpanded((v) => !v)}
              hitSlop={8}
            >
              <Icon name={moreFiltersExpanded ? 'chevron.up' : 'chevron.down'} size={fs(11)} color={tokens.t3} />
              <Text style={{ color: tokens.t3, fontSize: fs(11.5), fontWeight: '600' }}>
                {moreFiltersExpanded ? 'Fewer filters' : 'More filters (Category/Class)'}
                {!moreFiltersExpanded && activeCategoryClasses.length > 0 ? ' •' : ''}
              </Text>
            </Pressable>
            {moreFiltersExpanded && (
            <>
            {/* Green accent, same as Study Mode's own Category/Class row --
                keeps an ASEL-only opponent from getting quizzed on
                glider/helicopter-specific material and vice versa. */}
            <Text style={[styles.modalLabel, { color: tokens.grn, fontSize: fs(11), marginTop: 14 }]}>CATEGORY / CLASS</Text>
            <View style={styles.countRow}>
              <Pressable
                style={[
                  styles.countChip,
                  { backgroundColor: activeCategoryClasses.length === 0 ? tokens.bdim : tokens.bg2, borderColor: activeCategoryClasses.length === 0 ? tokens.grn : tokens.bdr },
                ]}
                onPress={() => { setCreateError(null); setActiveCategoryClasses([]) }}
              >
                <Text style={[styles.countChipText, { color: activeCategoryClasses.length === 0 ? tokens.grn : tokens.t3, fontSize: fs(13) }]}>ALL</Text>
              </Pressable>
              {CATEGORY_CLASSES.map((c) => {
                const active = activeCategoryClasses.includes(c)
                return (
                  <Pressable
                    key={c}
                    style={[
                      styles.countChip,
                      { backgroundColor: active ? tokens.bdim : tokens.bg2, borderColor: active ? tokens.grn : tokens.bdr },
                    ]}
                    onPress={() => toggleCategoryClass(c)}
                  >
                    <Text style={[styles.countChipText, { color: active ? tokens.grn : tokens.t3, fontSize: fs(13) }]}>{RATING_SHORT_LABELS[c]}</Text>
                  </Pressable>
                )
              })}
            </View>
            </>
            )}

            {/* RC: "select filters, and then the bottom of that pop up
                would have a button that would apply the filters and then
                allow you to then go select your opponent." Nothing else
                on this step depends on the chosen filters server-side
                (they scope the QUESTIONS in the duel, not who's eligible
                to play it) -- this button's job is purely to make the
                handoff to opponent-picking an explicit, visible step. */}
            <Pressable
              style={[styles.startBtn, { backgroundColor: tokens.gold, flexDirection: 'row', justifyContent: 'center', gap: 6 }]}
              onPress={() => setStep('opponents')}
            >
              <Text style={[styles.startBtnText, { fontSize: fs(13.5) }]}>NEXT: CHOOSE OPPONENTS</Text>
              <Icon name="chevron.right" size={fs(13)} color="#000" />
            </Pressable>
            </>
            )}

            {step === 'opponents' && (<>
            {/* RC, real device: "the choose opp screen only has people
                already there, it needs to have a way to select new oppos
                too (search, callsign, text invite, groups, etc). from this
                screen. this is the main way to start a duel." Same
                debounced Callsign search already proven in the aircraft/
                folder Invite by Callsign flows, plus the same Find Friends
                (contacts) component reused as another step in this same
                sheet -- both feed the same addOpponent(), so a match from
                either path just appears in the list below, pre-selected. */}
            <Text style={[styles.modalLabel, { color: tokens.t3, fontSize: fs(11) }]}>ADD SOMEONE NEW</Text>
            <TextInput
              value={newOppCallsign}
              onChangeText={setNewOppCallsign}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Their Callsign"
              placeholderTextColor={tokens.t4}
              style={[styles.inviteInput, { color: tokens.t1, borderColor: callsignCheck === 'not_found' ? tokens.red : tokens.bdr, fontSize: ifs(15) }]}
              onSubmitEditing={() => {
                if (callsignCheck === 'found') resolveCallsignToUserId(newOppCallsign.trim()).then((id) => id && addOpponent(id, newOppCallsign.trim())).catch(() => {})
              }}
            />
            {callsignCheck === 'checking' && <Text style={{ color: tokens.t3, fontSize: fs(12.5), marginTop: 4 }}>Checking…</Text>}
            {callsignCheck === 'not_found' && <Text style={{ color: tokens.red, fontSize: fs(12.5), marginTop: 4 }}>No FlyRegs user with this Callsign</Text>}
            {callsignCheck === 'found' && (
              <Pressable
                style={[styles.addByCallsignBtn, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}
                onPress={() => resolveCallsignToUserId(newOppCallsign.trim()).then((id) => id && addOpponent(id, newOppCallsign.trim())).catch(() => {})}
              >
                <Icon name="plus" size={fs(13)} color={tokens.gold} />
                <Text style={{ color: tokens.gold, fontSize: fs(13), fontWeight: '700' }}>Add {newOppCallsign.trim()}</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.findFriendsLink}
              hitSlop={10}
              onPress={() => { Keyboard.dismiss(); setStep('findFriends') }}
            >
              <Icon name="person.2.fill" size={fs(13)} color={tokens.blu} />
              <Text style={{ color: tokens.blu, fontSize: fs(12.5), fontWeight: '600' }}>Find Friends from Contacts</Text>
            </Pressable>

            <Text style={[styles.modalLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 16 }]}>
              OPPONENTS{selectedOpponents.length > 0 ? ` (${selectedOpponents.length} of ${MAX_OPPONENTS} max)` : ''}
            </Text>
            {opponents.length === 0 ? (
              // Confirmed the actual opt-in/challengeable-user mechanism has
              // no bug (verified live with a second account): a friend who
              // hasn't flipped "Show me on the Ready Room leaderboard" just
              // won't show up in this pre-populated list on its own -- but
              // now that ADD SOMEONE NEW above exists, that's no longer a
              // dead end, so this empty state points there instead of
              // reading like "nothing you can do."
              <View style={[styles.noOpponentsCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="person.2.fill" size={fs(20)} color={tokens.t3} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.noOpponentsTitle, { color: tokens.t2, fontSize: fs(13.5) }]}>No recent opponents</Text>
                  <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.41, textAlign: 'left', marginTop: 3 }]}>
                    Use Callsign search or Find Friends above to add someone.
                  </Text>
                </View>
              </View>
            ) : (
              opponents.map((o) => {
                const selected = selectedOpponents.includes(o.userId)
                return (
                  <Pressable
                    key={o.userId}
                    style={[styles.opponentRow, { borderTopColor: tokens.bdr }]}
                    onPress={() => toggleOpponent(o.userId)}
                  >
                    <View style={[styles.checkbox, { borderColor: selected ? tokens.gold : tokens.bdr, backgroundColor: selected ? tokens.goldlt : 'transparent' }]}>
                      {selected && <Icon name="checkmark" size={fs(12)} color={tokens.gold} />}
                    </View>
                    <AvatarCircle imageUri={o.avatarUrl} presetId={o.avatarPreset} fallbackLabel={o.displayLabel} size={fs(28)} />
                    <Text style={[styles.opponentText, { color: tokens.t1, fontSize: fs(14) }]}>{o.displayLabel}</Text>
                  </Pressable>
                )
              })
            )}

            {createError && (
              <View style={[styles.createError, { backgroundColor: tokens.bg2, borderColor: tokens.red }]}>
                <Icon name="exclamationmark.triangle" size={fs(14)} color={tokens.red} />
                <Text style={[styles.createErrorText, { color: tokens.t2, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>{createError}</Text>
              </View>
            )}

            {selectedOpponents.length > 0 && (
              <Pressable
                style={[styles.startBtn, { backgroundColor: tokens.gold, opacity: creating ? 0.6 : 1 }]}
                onPress={handleStartDuel}
                disabled={creating}
              >
                {creating ? <ActivityIndicator size="small" color="#000" /> : (
                  <Text style={[styles.startBtnText, { fontSize: fs(13.5) }]}>
                    START DUEL ({selectedOpponents.length + 1} PLAYER{selectedOpponents.length + 1 === 1 ? '' : 'S'})
                  </Text>
                )}
              </Pressable>
            )}
            </>
            )}
            </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <CoinRevealModal
        // Without the TROPHY_BY_CODE fallback a trophy code here yielded a null
        // coin, CoinRevealModal returned null, onClose never fired, and
        // dismissUnseenCoin never ran -- so the queue head stuck on that code
        // FOREVER, blocking every coin behind it and re-stalling on each focus.
        coin={unseenCoinQueue[0] ? COIN_BY_CODE[unseenCoinQueue[0]] ?? TROPHY_BY_CODE[unseenCoinQueue[0]] ?? null : null}
        onClose={dismissUnseenCoin}
      />
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

function ChallengeRow({
  item, tokens, fs, onRespond, onDelete, showPreview, hidePreview, consumeLongPress,
}: {
  item: MyChallenge
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  onRespond: (c: MyChallenge, accept: boolean) => void
  onDelete: (c: MyChallenge) => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const isPendingForMe = item.myStatus === 'pending'
  const acceptedOthers = item.others.filter((o) => o.status === 'active')
  const pendingOthers = item.others.filter((o) => o.status === 'pending')
  const othersLabel = item.others.length <= 2
    ? item.others.map((o) => o.label).join(', ')
    : `${item.others.slice(0, 2).map((o) => o.label).join(', ')} +${item.others.length - 2} more`

  // 'cancelled' had no case here and fell through to the "x/y answered"
  // label, which read as an in-progress duel. It's a real state now: the DB
  // cancels a duel once every invitee has declined (migrations_duels_2.sql)
  // -- OR, since 2026-08-22, once the creator cancels it outright before
  // playing (cancelChallenge, bug 2's fix), which can happen even after an
  // invitee already started answering. "Cancelled — nobody accepted" was a
  // fair assumption when decline-cascade was the ONLY cause; it's now
  // sometimes flatly false (you may well have accepted and even played a
  // few questions before the creator cancelled it out from under you), so
  // this no longer guesses at a specific reason.
  const statusLabel =
    item.status === 'cancelled' ? (item.myStatus === 'declined' ? 'You declined' : 'Cancelled')
    : item.status === 'completed' ? 'Completed'
    : isPendingForMe ? `${item.others.find((o) => o.status !== 'pending')?.label ?? 'Someone'} wants to duel you`
    // Only reachable in a 3+ player duel: forfeiting completes the WHOLE
    // challenge immediately in the common 2-player case (see
    // forfeitChallenge/finalize_challenge_if_done), so item.status would
    // already be 'completed' there -- this only shows while other players
    // are still actively finishing the duel out among themselves.
    : item.myStatus === 'forfeited' ? 'You forfeited this duel'
    : pendingOthers.length > 0 && acceptedOthers.length === 0 ? 'Waiting for them to accept'
    : `${item.myAnsweredCount}/${item.questionCount} answered · ${acceptedOthers.length} of ${item.others.length} joined`

  return (
    <View style={styles.swipeWrap}>
    <SwipeToDelete
      onDelete={() => onDelete(item)}
      onPress={() => {
        if (consumeLongPress()) return
        // navigate, not push -- see _layout.tsx's notification handler for
        // why stacking a second instance of the same duel screen is the root
        // cause of "the question changed when I came back" (same duel
        // screen already open deeper in this tab's stack reuses it instead
        // of a fresh, potentially-divergent instance on top).
        if (!isPendingForMe) router.navigate(`/challenges/${item.challengeId}` as any)
      }}
      onLongPress={(e) => showPreview(othersLabel, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <View style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
        <Pressable
          onPress={(e) => {
            e.stopPropagation()
            // Group duels (2+ others) have no single person to open --
            // the trophy stays purely decorative there, same as before.
            if (item.others.length === 1) {
              router.push(`/profile/${item.others[0].userId}?label=${encodeURIComponent(item.others[0].label)}` as any)
            }
          }}
          hitSlop={6}
        >
          {item.others.length === 1 ? (
            <AvatarCircle
              imageUri={item.others[0].avatarUrl}
              presetId={item.others[0].avatarPreset}
              fallbackLabel={item.others[0].label}
              size={fs(34)}
            />
          ) : (
            <View style={[styles.avatarDot, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
              <Icon name="trophy" size={fs(14)} color={tokens.gold} />
            </View>
          )}
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: tokens.t1, fontSize: fs(14.5) }]} numberOfLines={1}>{othersLabel}</Text>
          <Text style={[styles.rowSub, { color: tokens.t3, fontSize: fs(12) }]}>{statusLabel}</Text>
        </View>
        {isPendingForMe ? (
          <View style={styles.respondRow}>
            <Pressable style={[styles.respondBtn, { borderColor: tokens.bdr }]} onPress={() => onRespond(item, false)}>
              <Icon name="xmark" size={fs(14)} color={tokens.t3} />
            </Pressable>
            <Pressable style={[styles.respondBtn, styles.respondBtnAccept, { borderColor: tokens.goldbdr, backgroundColor: tokens.goldlt }]} onPress={() => onRespond(item, true)}>
              <Icon name="checkmark" size={fs(14)} color={tokens.gold} />
            </Pressable>
          </View>
        ) : (
          <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
        )}
      </View>
    </SwipeToDelete>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.41
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  emptySub: { textAlign: 'center', maxWidth: 300 },

  myStatsBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 12, borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  myStatsText: { fontWeight: '500' },

  list: { padding: 12, paddingBottom: 32 },
  swipeWrap: { marginBottom: 8, borderRadius: 14, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 13,
  },
  avatarDot: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontWeight: '600' },
  rowSub: { marginTop: 2 },
  respondRow: { flexDirection: 'row', gap: 8 },
  respondBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  respondBtnAccept: {},

  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, padding: 18, maxHeight: '85%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontWeight: '700' },
  modalLabel: { fontWeight: '600', letterSpacing: 0.5 },
  countRow: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  noOpponentsCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    borderRadius: 12, borderWidth: 1, padding: 12, marginTop: 8,
  },
  noOpponentsTitle: { fontWeight: '700' },
  countChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, borderWidth: 1 },
  countChipText: { fontWeight: '700' },
  opponentRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  opponentText: { fontWeight: '500', flex: 1 },
  inviteInput: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontWeight: '600' },
  findFriendsLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6 },
  addByCallsignBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 10, borderWidth: 1, paddingVertical: 9, marginTop: 8,
  },
  createError: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, padding: 11, marginTop: 14,
  },
  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  createErrorText: { flex: 1 },
  startBtn: { borderRadius: 20, alignItems: 'center', paddingVertical: 13, marginTop: 16 },
  startBtnText: { color: '#000', fontWeight: '800', letterSpacing: 0.6, fontSize: 13.5 },
})
