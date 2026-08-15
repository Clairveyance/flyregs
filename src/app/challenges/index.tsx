import { useEffect, useState, useCallback } from 'react'
import { View, Text, FlatList, Pressable, StyleSheet, ActivityIndicator, Modal, ScrollView } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useAuth } from '@/context/auth'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import {
  getMyChallenges, getChallengeableUsers, createChallenge, respondToChallenge, getDuelStats, sendDuelPush,
  getUnseenCoins, markCoinsSeen,
  MyChallenge, ChallengeableUser, DuelStats, DuelItemType, StudyLevel, ALL_STUDY_LEVELS, STUDY_LEVEL_LABELS,
} from '@/lib/challenges'
import { CategoryClass, CATEGORY_CLASSES, RATING_SHORT_LABELS } from '@/lib/profileRatings'
import { useConfirm } from '@/components/ConfirmDialog'
import { COIN_BY_CODE, type CoinDef } from '@/lib/coins'
import { CoinRevealModal } from '@/components/CoinRevealModal'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

const QUESTION_COUNTS = [3, 5, 10]
const ALL_TYPES: DuelItemType[] = ['far', 'aim', 'pcg', 'ac']
const TYPE_LABEL: Record<DuelItemType, string> = { pcg: 'P/CG', far: 'FAR', aim: 'AIM', ac: 'AC' }
const MAX_OPPONENTS = 7

export default function ChallengesScreen() {
  const { tokens } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { isPremium } = useAuth()
  const [challenges, setChallenges] = useState<MyChallenge[]>([])
  const [myStats, setMyStats] = useState<DuelStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [pickerVisible, setPickerVisible] = useState(false)
  // RC: the New Duel sheet used to be one long scroll -- filters, then
  // opponents, then Start -- with nothing marking the handoff between
  // "choosing what to duel on" and "choosing who to duel." He read that as
  // opponent selection not working at all ("that doesn't help you select
  // anybody new"), because picking a filter chip didn't visibly DO
  // anything -- there was no button to press to move forward. Split into
  // an explicit 2-step wizard: filters -> Continue -> opponents -> Start.
  const [step, setStep] = useState<'filters' | 'opponents'>('filters')
  const [opponents, setOpponents] = useState<ChallengeableUser[]>([])
  const [selectedOpponents, setSelectedOpponents] = useState<string[]>([])
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
    getMyChallenges().then(setChallenges).finally(() => setLoading(false))
    getDuelStats().then(setMyStats)
    // Catch-up path for the coin-toast timing bug (2026-08-11): a Duel win's
    // coin only reveals synchronously to whichever player's submission
    // happened to finish the challenge, not necessarily the real winner if
    // that was the other (possibly-offline) player. Whoever that is sees it
    // here instead, the next time they open the Duels hub.
    getUnseenCoins().then((codes) => { if (codes.length) setUnseenCoinQueue(codes) })
  }, [])

  useFocusEffect(useCallback(() => { if (isPremium) load() }, [isPremium, load]))

  const dismissUnseenCoin = () => {
    const [shown, ...rest] = unseenCoinQueue
    if (shown) markCoinsSeen([shown]).catch(() => {})
    setUnseenCoinQueue(rest)
  }

  const openPicker = () => {
    getChallengeableUsers().then(setOpponents)
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

  if (!isPremium) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <OverlayHeader title="Duels" onBack={() => router.back()} />
        <View style={styles.center}>
          <Icon name="lock.fill" size={fs(36)} color={tokens.blu} />
          <Text style={[styles.emptyTitle, { color: tokens.t2, fontSize: fs(16) }]}>Duels are a Premium feature</Text>
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
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
          <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(13.5) }]}>
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
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          )}
        />
      )}

      <Modal visible={pickerVisible} transparent animationType="fade" onRequestClose={() => setPickerVisible(false)}>
        <View style={[styles.modalBackdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
          <View style={[styles.modalCard, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
            <View style={styles.modalHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {step === 'opponents' && (
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

            {/* BB-091 corpus-wide audit ("checks to all other CTA and popups
                app wide"): `modalCard` had a `maxHeight: '85%'` but no
                ScrollView around this body -- 6 filter rows plus a
                potentially-long opponent list plus the Start button, on a
                plain View, meant the maxHeight just truncated the content
                with no way to reach whatever fell past it. Same pattern
                already fixed for my-aircraft/[id].tsx's ReminderFormModal
                and AvatarEditModal -- header stays pinned outside. */}
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

            <Pressable
              style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 14 }}
              onPress={() => setMoreFiltersExpanded((v) => !v)}
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
            <Text style={[styles.modalLabel, { color: tokens.t3, fontSize: fs(11) }]}>
              OPPONENTS{selectedOpponents.length > 0 ? ` (${selectedOpponents.length} of ${MAX_OPPONENTS} max)` : ''}
            </Text>
            {opponents.length === 0 ? (
              // Confirmed the actual opt-in/challengeable-user mechanism has
              // no bug (verified live with a second account): this is a
              // real cold-start state, not broken -- a friend needs their
              // own FlyRegs account AND to flip "Show me on the Ready Room
              // leaderboard" (Account > Community) before they'll show up
              // here. There's no in-app invite path for someone who doesn't
              // have the app yet -- that's tracked separately. RC, real
              // device, looking at exactly this state: "how do you hit 'go'
              // or start the game?" -- a plain paragraph here read like
              // filler text rather than a real stopping point, so this is
              // now a bordered notice with an icon, matching the app's other
              // empty-state treatments, to read clearly as "this is expected,
              // here's what to do" instead of looking unfinished.
              <View style={[styles.noOpponentsCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                <Icon name="person.2.fill" size={fs(20)} color={tokens.t3} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.noOpponentsTitle, { color: tokens.t2, fontSize: fs(13.5) }]}>No one to challenge yet</Text>
                  <Text style={[styles.emptySub, { color: tokens.t3, fontSize: fs(12.5), textAlign: 'left', marginTop: 3 }]}>
                    A friend needs their own FlyRegs account, with "Show me on the Ready Room leaderboard"
                    turned on in Account &gt; The Wing, before they'll show up here.
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
                    <Text style={[styles.opponentText, { color: tokens.t1, fontSize: fs(14) }]}>{o.displayLabel}</Text>
                  </Pressable>
                )
              })
            )}

            {createError && (
              <View style={[styles.createError, { backgroundColor: tokens.bg2, borderColor: tokens.red }]}>
                <Icon name="exclamationmark.triangle" size={fs(14)} color={tokens.red} />
                <Text style={[styles.createErrorText, { color: tokens.t2, fontSize: fs(12.5) }]}>{createError}</Text>
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
          </View>
        </View>
      </Modal>
      <CoinRevealModal
        coin={unseenCoinQueue[0] ? COIN_BY_CODE[unseenCoinQueue[0]] ?? null : null}
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
  item, tokens, fs, onRespond, showPreview, hidePreview, consumeLongPress,
}: {
  item: MyChallenge
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  onRespond: (c: MyChallenge, accept: boolean) => void
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
  // cancels a duel once every invitee has declined (migrations_duels_2.sql).
  const statusLabel =
    item.status === 'cancelled' ? (item.myStatus === 'declined' ? 'You declined' : 'Cancelled — nobody accepted')
    : item.status === 'completed' ? 'Completed'
    : isPendingForMe ? `${item.others.find((o) => o.status !== 'pending')?.label ?? 'Someone'} wants to duel you`
    : pendingOthers.length > 0 && acceptedOthers.length === 0 ? 'Waiting for them to accept'
    : `${item.myAnsweredCount}/${item.questionCount} answered · ${acceptedOthers.length} of ${item.others.length} joined`

  return (
    <Pressable
      style={[styles.row, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
      onPress={() => {
        if (consumeLongPress()) return
        if (!isPendingForMe) router.push(`/challenges/${item.challengeId}` as any)
      }}
      onLongPress={(e) => showPreview(othersLabel, e)}
      onPressOut={hidePreview}
      delayLongPress={350}
    >
      <Pressable
        style={[styles.avatarDot, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}
        onPress={(e) => {
          e.stopPropagation()
          if (item.others.length === 1) {
            router.push(`/profile/${item.others[0].userId}?label=${encodeURIComponent(item.others[0].label)}` as any)
          }
        }}
        hitSlop={6}
      >
        <Icon name="trophy" size={fs(14)} color={tokens.gold} />
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
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, gap: 8 },
  emptyTitle: { fontWeight: '600', marginTop: 6 },
  upgradeBtn: { borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11, marginTop: 10 },
  upgradeBtnText: { color: '#fff', fontWeight: '700' },
  emptySub: { textAlign: 'center', lineHeight: 19, maxWidth: 300 },

  myStatsBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 12, marginTop: 12, borderRadius: 12, borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  myStatsText: { fontWeight: '500' },

  list: { padding: 12, paddingBottom: 32 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 13, marginBottom: 8,
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
  createError: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 12, borderWidth: 1, padding: 11, marginTop: 14,
  },
  createErrorText: { flex: 1, lineHeight: 17 },
  startBtn: { borderRadius: 20, alignItems: 'center', paddingVertical: 13, marginTop: 16 },
  startBtnText: { color: '#000', fontWeight: '800', letterSpacing: 0.6, fontSize: 13.5 },
})
