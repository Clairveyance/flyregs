import { useState, useEffect, useMemo } from 'react'
import { View, Text, Image, ScrollView, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { router } from 'expo-router'
import { useTheme, redshiftTokens, lightTokens } from '@/context/theme'
import { useAuth } from '@/context/auth'
import { useFS } from '@/context/fontScale'
import { ScreenHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { TabletContainer } from '@/components/TabletContainer'
import { useIsTablet } from '@/context/responsive'
import { getRefPackets, splitPacketTitle, type RefPacket } from '@/lib/refPackets'
import { getStudyMastery, getCurrency, type StudyMastery, type Currency } from '@/lib/study'
import { getMyCoins, type EarnedCoin } from '@/lib/coins'
import { getDuelStats, type DuelStats } from '@/lib/challenges'
import { getMyRatings, type RatingCode } from '@/lib/profileRatings'
import { getAvatarUrl, resolveAvatarPresetId, getDisplayName } from '@/lib/avatar'
import { getAvatarPreset, avatarColorFor } from '@/lib/avatarPresets'
import { useCachedImage } from '@/lib/imageCache'
import { NameTag } from '@/components/NameTag'
import { NEON_SIGN_FONT } from '@/lib/brand'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

// IA redesign (2026-07-28): this file used to be the Search tab. Search now
// lives entirely on Home (see (tabs)/index.tsx's inline search bar +
// results dropdown) — there is no more standalone search screen to hand off
// to, which freed this tab up to become the app's study/social/game hub
// instead: a lifetime-stats summary, Study Mode, Duels, and Ref Packets
// (moved here unchanged from the old BrowseView). Reachable by every tier
// (so Free/Plus users can see what they're missing, not just a locked
// blank screen) — each section shows its own lock indicator and gates on
// tap, matching the exact pattern Ref Packets already used before this
// redesign. See flyregs_decisions.md / project_flyregs_state.md for the
// full IA-redesign writeup.

// Identity-card stats cache -- RC: the nametag block "always takes a couple
// seconds to load... everything moves down" and causes real mis-taps.
// Root cause: the identity card's second/third lines (IdentityStats vs.
// "View your profile", and NameTag) start at ZERO height (mastery/currency/
// duelStats/ratings/coins all begin null/[]), then each of 5 independent
// Supabase calls resolves at its own pace and pops its own row in, growing
// the card in multiple separate steps and pushing every card below it down
// mid-interaction. Two fixes combined: (1) batch all 5 fetches into one
// Promise.all so the card grows ONCE, atomically, not five times; (2) cache
// the last-seen snapshot per user (in-memory for the rest of this app
// session, AsyncStorage across a cold relaunch) and hydrate from it
// immediately, so every visit after the very first one this install ever
// makes paints already-correct on the first frame -- matching how
// useCachedImage (imageCache.ts) already does "instant from cache, refresh
// live" for avatars.
type IdentitySnapshot = {
  mastery: StudyMastery | null
  currency: Currency | null
  duelStats: DuelStats | null
  ratings: RatingCode[]
  coins: EarnedCoin[]
}
const identityStatsMemCache: Record<string, IdentitySnapshot> = {}
const IDENTITY_CACHE_KEY_PREFIX = '@flyregs/identityStatsCache:'

// "The Wing" (renamed from "Community", RC 2026-08-08 — "you can take
// someone under your wing or v/v, you can spread your wings") gets its own
// header treatment instead of the shared plain-text ScreenHeader title: a
// cursive white neon-tube script, like the sign hanging on the wall of the
// place. Two stacked Text layers sharing the same font/color, back one
// blurred wider + dimmer, front one tighter + fully opaque — RN only gives
// one native shadow layer per Text, so this fakes the soft-outer/crisp-inner
// bloom a real multi-layer CSS text-shadow would give a neon tube.
function WingSign() {
  const fs = useFS()
  // Back on Pacifico (RC: tried a thinner-stroked font, Sacramento, but
  // preferred Pacifico back — "whatever the thinnest setting is, is fine").
  // Pacifico's own strokes are a fixed weight (single-weight typeface, no
  // Light variant), so the only real lever left is how much glow bloom sits
  // on top of them -- this is the thinnest of the two glow passes tried
  // (radius 8/opacity 0.55 on the back layer, 1.5 on the front, down from an
  // earlier 10/0.6/2 pass), since less blur bloom reads as a thinner sign
  // even though the underlying letterforms themselves can't get any thinner.
  const size = fs(24)
  // Hardcoded white the whole time -- didn't react to Red Shift like every
  // other lit/glowing element in the app. redshiftTokens.t1 is the palette's
  // own bright red-orange "lit text" tone, so a neon tube reads as switched
  // to red-safe lighting the same way everything else does.
  const { redShift, resolved } = useTheme()
  const neonColor = redShift ? redshiftTokens.t1 : '#fff'
  // RC, 2026-08-13: "our 'The Wing' white neon kind of disappears in the b/g
  // when in Light mode." True bug -- white glyphs + a white glow read fine
  // against the dark app background but vanish into lightTokens.bg (#E6EDF8,
  // itself nearly white). Real neon signs are still legible in daylight
  // because the tube sits on a darker physical backing board, not because
  // the glow itself changes color -- same fix here instead of tinting the
  // letters (which would actually change the sign's look, the thing RC
  // explicitly didn't want): one extra Text layer, same glyphs, same (0,0)
  // position, painted furthest back, using a dark shadow instead of a white
  // one. The opaque white front layer still fully covers its glyphs, so all
  // that reads is the blurred edge bleeding out past the white letters -- a
  // soft dark halo that gives the white script something to contrast
  // against, exactly the "glow to help it stand out" RC asked for. Dark
  // mode and Red Shift are untouched (lightHalo is false for both).
  const lightHalo = !redShift && resolved === 'light'
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      {lightHalo && (
        <Text
          style={[
            styles.neonText,
            {
              position: 'absolute',
              fontSize: size,
              color: lightTokens.t1,
              textShadowColor: lightTokens.t1,
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 10,
              opacity: 0.4,
            },
          ]}
        >
          The Wing
        </Text>
      )}
      <Text
        style={[
          styles.neonText,
          {
            position: 'absolute',
            fontSize: size,
            color: neonColor,
            textShadowColor: neonColor,
            textShadowOffset: { width: 0, height: 0 },
            textShadowRadius: 8,
            opacity: 0.55,
          },
        ]}
      >
        The Wing
      </Text>
      <Text
        style={[
          styles.neonText,
          {
            fontSize: size,
            color: neonColor,
            textShadowColor: neonColor,
            textShadowOffset: { width: 0, height: 0 },
            textShadowRadius: 1.5,
          },
        ]}
      >
        The Wing
      </Text>
    </View>
  )
}

export default function TheWingScreen() {
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  const { session, isPremium, hasPlusAccess, hasProAccess, avatarOverride } = useAuth()
  // RC, iPad: "our community screen is a great place for an ipad redesign.
  // all kinds of cool stuff to place and sort and divide up on a big
  // screen. be creative." Phone keeps the exact original stacked-list hub
  // (each card its own full-width row, its own group label above it) --
  // only isTablet swaps the 3 primary hub cards (Ask FlyRegs, Study Mode,
  // Duels) for a 3-up row of taller, icon-forward tiles under one shared
  // label, closer to how an iPad app-launcher groups a handful of
  // destinations than a settings-style list.
  const isTablet = useIsTablet()
  // Same resolution chain Account/Drawer use (avatarOverride takes priority
  // so a freshly picked photo/preset shows here in the same tick, no
  // waiting on a session refresh) -- this card previously hardcoded a bare
  // "Y" and "You" regardless of the real avatar/callsign, so neither ever
  // updated when either changed.
  const avatarPreset = getAvatarPreset(resolveAvatarPresetId(avatarOverride, session))
  const cachedAvatarUrl = useCachedImage(session?.user?.id ? `avatar_${session.user.id}` : null, getAvatarUrl(session))
  const avatarUrl = avatarOverride ? avatarOverride.uri : cachedAvatarUrl
  const displayName = getDisplayName(session)
  const [refPackets, setRefPackets] = useState<RefPacket[]>([])
  const [packetCat, setPacketCat] = useState<RefPacket['category'] | 'All'>('All')
  const [mastery, setMastery] = useState<StudyMastery | null>(null)
  const [currency, setCurrency] = useState<Currency | null>(null)
  const [duelStats, setDuelStats] = useState<DuelStats | null>(null)
  const [ratings, setRatings] = useState<RatingCode[]>([])
  const [coins, setCoins] = useState<EarnedCoin[]>([])
  // Display names and RefPack titles on this screen can run long and get cut
  // off the same way FAR Part titles do -- same hook/card pair as
  // far/index.tsx's own long-press preview, threaded down into
  // RefPacketGrid below.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview, consumeLongPress } = useLongPressPreview()

  useEffect(() => {
    getRefPackets().then(setRefPackets)
  }, [])

  // Stats are best-effort — a signed-in Free/Plus user (no Pro/Premium yet)
  // still has a real session and may still have Duel/coin history from a
  // past subscription, so this doesn't gate on tier, only on being signed in.
  useEffect(() => {
    if (!session) {
      setMastery(null); setCurrency(null); setDuelStats(null); setRatings([]); setCoins([])
      return
    }
    const uid = session.user.id

    // Instant paint from the last-seen snapshot for this user, if any --
    // same-session cache hits are zero-latency, a cold-launch cache hit is
    // one fast local read instead of the ~1-2s these 5 queries take
    // together over the network.
    const applySnapshot = (snap: IdentitySnapshot) => {
      setMastery(snap.mastery); setCurrency(snap.currency); setDuelStats(snap.duelStats)
      setRatings(snap.ratings); setCoins(snap.coins)
    }
    const mem = identityStatsMemCache[uid]
    if (mem) {
      applySnapshot(mem)
    } else {
      AsyncStorage.getItem(IDENTITY_CACHE_KEY_PREFIX + uid).then((raw) => {
        if (!raw) return
        try { applySnapshot(JSON.parse(raw)) } catch {}
      })
    }

    // Batched into one Promise.all (was 5 independent .then() calls) so the
    // card grows ONCE when fresh data lands, not in five separate steps at
    // five different times -- each inner .catch keeps a single failed query
    // from blanking out the others, matching the original per-call resilience.
    Promise.all([
      getStudyMastery().catch(() => null),
      getCurrency().catch(() => null),
      getMyCoins().catch(() => [] as EarnedCoin[]),
      getDuelStats().catch(() => null),
      getMyRatings(uid).catch(() => [] as RatingCode[]),
    ]).then(([m, c, co, d, r]) => {
      const snap: IdentitySnapshot = { mastery: m, currency: c, duelStats: d, ratings: r, coins: co }
      applySnapshot(snap)
      identityStatsMemCache[uid] = snap
      AsyncStorage.setItem(IDENTITY_CACHE_KEY_PREFIX + uid, JSON.stringify(snap)).catch(() => {})
    })
  }, [session])

  const hasAnyStats = !!(
    (mastery && mastery.seen > 0) ||
    (currency && currency.currentStreak > 0) ||
    (duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0))
  )

  const openStudy = () => {
    // hasProAccess (isPro || isPremium), not bare isPro -- same bug pattern
    // fixed in study.tsx itself (2026-08-14): a genuine Premium subscriber
    // shaped isPro:false/isPremium:true would pass study.tsx's own gate
    // fine (it uses hasProAccess) but never reach it, because THIS second
    // entry point into Study Mode was still bouncing them to the paywall
    // first. Found during the corpus-wide sweep for the same pattern.
    if (!hasProAccess) { router.push('/paywall'); return }
    router.push('/study')
  }

  // Duels itself is PREMIUM (paywall.tsx's PREMIUM_ADDITIONS, RC 2026-07-31)
  // -- confirmed live as a real bug, not just a stale comment: this card's
  // own lock icon and this check were still `isPro`, so a Pro (not
  // Premium) account saw NO lock here, tapped through, and only hit the
  // real gate two navigations later inside /challenges (which correctly
  // checks isPremium) -- Ready Room's OWN tier requirement is genuinely
  // correct (it's a separate, Pro-tier-and-above leaderboard per
  // PRO_ADDITIONS, gated on hasProAccess -- see ready-room.tsx, fixed
  // 2026-08-14 for the same bare-isPro pattern found here) and stays;
  // only THIS card's promise was wrong.
  const openDuels = () => {
    if (!isPremium) { router.push('/paywall?tier=premium'); return }
    router.push('/challenges')
  }

  // Community is a PAID area end to end (RC, 2026-07-31): Study Mode, Duels,
  // Ready Room, RefPacks and Challenge Coins all live here and none of them
  // are free. Previously the screen rendered for everyone with per-row locks,
  // which advertised a wall of padlocks instead of the feature set.
  if (!hasPlusAccess) {
    return (
      <View style={[styles.root, { backgroundColor: tokens.bg }]}>
        <ScreenHeader titleElement={<WingSign />} />
        <TabletContainer>
          <View style={styles.lockedWrap}>
            <Icon name="person.2.fill" size={fs(38)} color={tokens.blu} />
            <Text style={[styles.lockedTitle, { color: tokens.t1, fontSize: fs(17) }]}>
              The Wing is a paid feature
            </Text>
            <Text style={[styles.lockedBody, { color: tokens.t3, fontSize: fs(13.5) }]}>
              Study Mode flashcards, Duels against other players, RefPacks for your
              certificate, Challenge Coins and the Ready Room leaderboard all live here
              — and much more.
            </Text>
            <Pressable
              style={[styles.lockedBtn, { backgroundColor: tokens.blu }]}
              onPress={() => router.push('/paywall')}
            >
              <Text style={[styles.lockedBtnText, { fontSize: fs(15) }]}>See what's included</Text>
            </Pressable>
          </View>
        </TabletContainer>
      </View>
    )
  }

  // RC: "RR needs a diff icon, it's not really about 'Groups' so it needs
  // something diff... put it up in the right corner of The Wing (same as
  // it is inside SM now)." First swap (`medal.fill`) still read too much
  // like the Challenge Coins/trophy iconography already used elsewhere on
  // this same screen. `chart.bar.fill` reads as standings/leaderboard --
  // visually and conceptually distinct from both "a group of people" and
  // "an award," which is what Ready Room's 3 tabs (Study Activity, Duels,
  // Mastery) actually rank. Also changed to match on Study Mode's own
  // header (its longer-standing entry point into Ready Room), per RC's
  // explicit ask to keep both consistent.
  // Round 2: RC asked for the lightning bolt specifically -- free to reuse
  // it here now that Duels moved off it (first onto 'figure.fencing',
  // then onto 'trophy' per RC's round-2 ask -- see Icon.tsx).
  const readyRoomHeaderRight = (
    <Pressable onPress={() => router.push('/ready-room')} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="bolt.fill" size={fs(20)} color={tokens.gold} />
    </Pressable>
  )

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <ScreenHeader titleElement={<WingSign />} right={readyRoomHeaderRight} />
      <TabletContainer>
        <ScrollView contentContainerStyle={styles.content}>
          {session ? (
            // A single "who am I and what do I have" identity slate --
            // replaces the old stats strip + separate "View my profile"
            // row + always-expanded visibility/aircraft/ratings editor,
            // which duplicated most of what /profile/[userId] already
            // shows. Editing (visibility toggle, aircraft, ratings) now
            // lives on the profile screen itself, reached by tapping this.
            <Pressable
              style={[styles.identityCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => {
                if (consumeLongPress()) return
                router.push(`/profile/${session.user.id}` as any)
              }}
              onLongPress={(e) => showPreview(displayName, e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <View style={[styles.identityAvatar, { backgroundColor: avatarPreset ? avatarColorFor(avatarPreset, redShift) : tokens.goldlt, borderColor: tokens.goldbdr }]}>
                {avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.identityAvatarImage} />
                ) : avatarPreset ? (
                  <Icon name={avatarPreset.icon} size={fs(19)} color="#fff" />
                ) : (
                  <Text style={[styles.identityAvatarText, { color: tokens.gold, fontSize: fs(18) }]}>
                    {displayName.charAt(0).toUpperCase()}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.identityHandle, { color: tokens.t1, fontSize: fs(15.5) }]} numberOfLines={1}>{displayName}</Text>
                {hasAnyStats ? (
                  <IdentityStats
                    tokens={tokens}
                    fs={fs}
                    mastery={mastery}
                    currency={currency}
                    duelStats={duelStats}
                  />
                ) : (
                  <Text style={[styles.identitySub, { color: tokens.t3, fontSize: fs(12) }]}>View your profile</Text>
                )}
                <NameTag ratings={ratings} coins={coins} />
              </View>
              <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
            </Pressable>
          ) : (
            <Pressable
              style={[styles.signInCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
              onPress={() => router.push('/auth')}
            >
              <Icon name="person.crop.circle" size={fs(22)} color={tokens.blu} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.signInTitle, { color: tokens.t1, fontSize: fs(14) }]}>
                  Sign in to track your progress
                </Text>
                <Text style={[styles.signInSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  Study mastery, your Duel record, and Challenge Coins all live on your account.
                </Text>
              </View>
              <Icon name="chevron.right" size={fs(14)} color={tokens.t4} />
            </Pressable>
          )}

          {/* Ask FlyRegs (task #114) -- the semantic-search query UI, sitting
              apart from Home's own lexical SmartSearch (see
              smartsearch_architecture memory for why those stay separate).
              Plus-gated same as the rest of this screen -- no extra lock
              overlay needed here since hasPlusAccess is already required
              just to see this screen at all (unlike Study/Duels below,
              which need the higher isPro tier specifically). */}
          {isTablet ? (
            <>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>PLAY &amp; STUDY</Text>
              <View style={styles.hubTileRow}>
                <Pressable
                  style={[styles.hubTile, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={() => router.push('/semantic-search')}
                >
                  <View style={[styles.hubTileIconWrap, { backgroundColor: tokens.gdim }]}>
                    <Icon name="text.bubble.fill" size={fs(26)} color={tokens.grn} />
                  </View>
                  <Text style={[styles.hubTileTitle, { color: tokens.t1, fontSize: fs(15) }]}>Ask FlyRegs</Text>
                  <Text style={[styles.hubTileSub, { color: tokens.t3, fontSize: fs(12) }]}>
                    Plain-English answers to real questions
                  </Text>
                </Pressable>

                <Pressable
                  style={[styles.hubTile, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={openStudy}
                >
                  {!hasProAccess && <Icon name="lock.fill" size={fs(12)} color={tokens.t4} style={styles.hubTileLock} />}
                  <View style={[styles.hubTileIconWrap, { backgroundColor: tokens.bdim }]}>
                    <Icon name="rectangle.stack" size={fs(26)} color={tokens.blu} />
                  </View>
                  <Text style={[styles.hubTileTitle, { color: tokens.t1, fontSize: fs(15) }]}>Study Mode</Text>
                  <Text style={[styles.hubTileSub, { color: tokens.t3, fontSize: fs(12) }]}>
                    {mastery && mastery.seen > 0
                      ? `${mastery.mastered} of ${mastery.total_available} mastered`
                      : 'Spaced-repetition flashcards'}
                  </Text>
                </Pressable>

                <Pressable
                  style={[styles.hubTile, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                  onPress={openDuels}
                >
                  {!isPremium && <Icon name="lock.fill" size={fs(12)} color={tokens.t4} style={styles.hubTileLock} />}
                  <View style={[styles.hubTileIconWrap, { backgroundColor: tokens.goldlt }]}>
                    <Icon name="trophy" size={fs(26)} color={tokens.gold} />
                  </View>
                  <Text style={[styles.hubTileTitle, { color: tokens.t1, fontSize: fs(15) }]}>Challenge a friend</Text>
                  <Text style={[styles.hubTileSub, { color: tokens.t3, fontSize: fs(12) }]}>
                    Multiple-choice quiz, most correct wins
                  </Text>
                </Pressable>
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11) }]}>SEARCH</Text>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={() => router.push('/semantic-search')}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.gdim }]}>
                  <Icon name="text.bubble.fill" size={fs(19)} color={tokens.grn} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Ask FlyRegs</Text>
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    Ask a real question in plain English — get the passages that actually answer it
                  </Text>
                </View>
              </Pressable>

              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 18 }]}>STUDY &amp; PRACTICE</Text>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={openStudy}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.bdim }]}>
                  <Icon name="rectangle.stack" size={fs(19)} color={tokens.blu} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Study Mode</Text>
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    {mastery && mastery.seen > 0
                      ? `${mastery.mastered} of ${mastery.total_available} items mastered`
                      : 'Spaced-repetition flashcards across FAR, AIM, P/CG, and ACs'}
                  </Text>
                </View>
                {!hasProAccess && <Icon name="lock.fill" size={fs(13)} color={tokens.t4} />}
              </Pressable>

              <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginTop: 18 }]}>DUELS</Text>
              <Pressable
                style={[styles.hubCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}
                onPress={openDuels}
              >
                <View style={[styles.hubIconWrap, { backgroundColor: tokens.goldlt }]}>
                  <Icon name="trophy" size={fs(19)} color={tokens.gold} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hubTitle, { color: tokens.t1, fontSize: fs(14.5) }]}>Challenge a friend</Text>
                  {/* RC: "we don't want the user's score listed in this
                      descrip" -- the score already shows on the identity card
                      above (W-L chip) and on Profile's own Duel record section,
                      so this line stays the plain generic descriptor always. */}
                  <Text style={[styles.hubSub, { color: tokens.t3, fontSize: fs(12.5) }]}>
                    Multiple-choice quiz across FAR, AIM, P/CG, AC — most correct wins, time breaks ties
                  </Text>
                </View>
                {!isPremium && <Icon name="lock.fill" size={fs(13)} color={tokens.t4} />}
              </Pressable>
            </>
          )}

          {refPackets.length > 0 && (
            <RefPacketGrid
              refPackets={refPackets}
              tokens={tokens}
              hasPlusAccess={hasPlusAccess}
              category={packetCat}
              onSelectCategory={setPacketCat}
              showPreview={showPreview}
              hidePreview={hidePreview}
              consumeLongPress={consumeLongPress}
            />
          )}
        </ScrollView>
      </TabletContainer>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

// ─── Identity stats (compact, inline in the identity card) ──────────────────

function IdentityStats({
  tokens,
  fs,
  mastery,
  currency,
  duelStats,
}: {
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  mastery: StudyMastery | null
  currency: Currency | null
  duelStats: DuelStats | null
}) {
  // Coin count used to also show here as a plain "N coins" text chip,
  // duplicating the tier-broken-out tally NameTag already renders one row
  // below -- confirmed confusing live ("coins earned should be on the row
  // below"). NameTag is now the single place coins show on this card.
  // RC: "this area looks too congested... let's build/use icons for
  // Mastery, Streak, and W-L so we can get rid of the words up there."
  // Streak (flame) and W-L (trophy, Duels' own icon) already had their
  // own distinct icon;
  // Mastery's `star.fill` didn't -- star is already doing double duty for
  // ratings/Premium/DailyReg elsewhere in the app, so it read ambiguous
  // here. `graduationcap.fill` is unique to Mastery, applied everywhere
  // Mastery shows as an icon+value chip (also profile/[userId].tsx's
  // OVERALL MASTERY section) -- Study Mode's own big gauge badge is a
  // separate bespoke visual, not an icon chip, so it's unaffected.
  const chips = useMemo(() => {
    const out: { icon: string; value: string; color: string }[] = []
    if (mastery && mastery.seen > 0) {
      out.push({ icon: 'graduationcap.fill', value: `${mastery.pct}%`, color: tokens.blu })
    }
    if (currency && currency.currentStreak > 0) {
      out.push({ icon: 'flame.fill', value: `${currency.currentStreak}d`, color: tokens.amb })
    }
    if (duelStats && (duelStats.wins > 0 || duelStats.losses > 0 || duelStats.ties > 0)) {
      out.push({ icon: 'trophy', value: `${duelStats.wins}-${duelStats.losses}`, color: tokens.grn })
    }
    return out
  }, [mastery, currency, duelStats, tokens])

  return (
    <View style={styles.identityStatsRow}>
      {chips.map((c, i) => (
        <View key={i} style={styles.identityStatChip}>
          <Icon name={c.icon} size={fs(11)} color={c.color} />
          <Text style={[styles.identityStatText, { color: tokens.t3, fontSize: fs(11.5) }]}>{c.value}</Text>
        </View>
      ))}
    </View>
  )
}

// ─── Ref Packet grid ─────────────────────────────────────────────────────────
// Certificate/rating study-and-reference guides built from the FAA's own
// ACS/PTS structure — moved here unchanged from the old Search tab's
// BrowseView as part of the 2026-07-28 IA redesign (this tab's whole reason
// for being repurposed was to house exactly this kind of content).

const PACKET_CATS: (RefPacket['category'] | 'All')[] = ['All', 'Airplane', 'Rotorcraft', 'Powered-Lift']

function RefPacketGrid({
  refPackets,
  tokens,
  hasPlusAccess,
  category,
  onSelectCategory,
  showPreview,
  hidePreview,
  consumeLongPress,
}: {
  refPackets: RefPacket[]
  tokens: ReturnType<typeof useTheme>['tokens']
  hasPlusAccess: boolean
  category: RefPacket['category'] | 'All'
  onSelectCategory: (c: RefPacket['category'] | 'All') => void
  showPreview: ReturnType<typeof useLongPressPreview>['showPreview']
  hidePreview: ReturnType<typeof useLongPressPreview>['hidePreview']
  consumeLongPress: ReturnType<typeof useLongPressPreview>['consumeLongPress']
}) {
  const fs = useFS()
  const filtered = category === 'All' ? refPackets : refPackets.filter((p) => p.category === category)

  // Multi-section source PDFs (sync/pts_multisection_scraper.py) previously
  // showed as N separate, nearly-identical cards ("Sport Pilot... —
  // Section 1/2/3") -- confirmed live as genuinely hard to tell apart even
  // with the suffix badge. Grouped into one card per source document here;
  // the in-pack Section picker (ref-packets/[code].tsx) is where a specific
  // section actually gets chosen, matching how a pilot thinks about it
  // ("the Sport Pilot ACS", not three unrelated things).
  const groups = useMemo(() => {
    const byTitle = new Map<string, RefPacket[]>()
    for (const p of filtered) {
      const { mainTitle } = splitPacketTitle(p.title)
      const list = byTitle.get(mainTitle) ?? []
      list.push(p)
      byTitle.set(mainTitle, list)
    }
    return Array.from(byTitle.entries()).map(([mainTitle, members]) => ({
      mainTitle,
      members: members.sort((a, b) => a.code.localeCompare(b.code)),
    }))
  }, [filtered])

  const openPacket = (p: RefPacket) => {
    if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
    router.push(`/ref-packets/${p.code}` as any)
  }

  return (
    <View style={{ marginTop: 18 }}>
      <View style={styles.packetHeaderRow}>
        <Text style={[styles.groupLabel, { color: tokens.t3, fontSize: fs(11), marginBottom: 0 }]}>
          {/* "RefPacks", not "Ref Packets" -- the branded, single-word form
              (matching "MagicLink"'s own naming convention), with the same
              first-letter-of-each-word-pops treatment MagicLink's wordmark
              uses, so this reads as an equally intentional brand element
              rather than a generic section label. */}
          {'REFPACKS'.split('').map((ch, i) => (
            <Text key={i} style={{ fontSize: fs(i === 0 || i === 3 ? 13 : 11) }}>{ch}</Text>
          ))}
        </Text>
        {!hasPlusAccess && <Icon name="lock.fill" size={fs(11)} color={tokens.t4} />}
      </View>
      {/* RC, live, real 13 mini: "the Powered Lift chip is running off
          screen to the right." A horizontal ScrollView with no visible
          scrollbar (showsHorizontalScrollIndicator={false}) and no edge
          fade gave zero affordance that "Powered-Lift" -- the longest of
          the 4 labels -- was swipeable rather than just cut off; on a
          375pt-wide device the 4 chips plus their gaps don't all fit in
          one screen-width row. Only 4 categories total, so wrapping to a
          second line is a cleaner fix than a scroll hint: every chip is
          always fully visible on any device width, no gesture required. */}
      <View style={[styles.packetCatRow, styles.packetCatWrap]}>
        {PACKET_CATS.map((c) => {
          const active = category === c
          return (
            <Pressable
              key={c}
              style={[
                styles.packetCatChip,
                { backgroundColor: active ? tokens.gold : tokens.bg2, borderColor: active ? tokens.gold : tokens.bdr },
              ]}
              onPress={() => onSelectCategory(c)}
            >
              <Text style={[styles.packetCatText, { color: active ? '#000' : tokens.t2, fontSize: fs(12.5) }]}>{c}</Text>
            </Pressable>
          )
        })}
      </View>
      <View style={styles.packetGrid}>
        {groups.map(({ mainTitle, members }) => {
          const primary = members[0]
          const multi = members.length > 1
          const totalAreas = members.reduce((sum, m) => sum + m.areaCount, 0)
          const totalTasks = members.reduce((sum, m) => sum + m.taskCount, 0)
          return (
            <Pressable
              key={mainTitle}
              style={[styles.packetCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
              onPress={() => {
                if (consumeLongPress()) return
                openPacket(primary)
              }}
              onLongPress={(e) => showPreview(mainTitle, e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Icon name="rosette" size={fs(18)} color={tokens.gold} />
              {multi && (
                <View style={[styles.packetSuffixBadge, { backgroundColor: tokens.goldlt, borderColor: tokens.goldbdr }]}>
                  <Text style={[styles.packetSuffixText, { color: tokens.gold, fontSize: fs(10) }]} numberOfLines={1}>
                    {members.length} sections
                  </Text>
                </View>
              )}
              <Text style={[styles.packetTitle, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={3}>
                {mainTitle}
              </Text>
              <Text style={[styles.packetMeta, { color: tokens.t4, fontSize: fs(10.5) }]}>
                {totalAreas} areas · {totalTasks} tasks
              </Text>
            </Pressable>
          )
        })}
        {/* Not a real acs_documents row -- Multiengine is Area X *within*
            both the Private and Commercial Airplane ACS docs above, not its
            own document, so it can't come from getRefPackets()'s doc-map.
            RC, after the single-card-with-a-toggle version shipped: "just
            make two RPs, one pvt multi and one COM multi... you could build
            the toggle inside one if you can easily parse out the proper
            material for each." Two hand-added cards now (was one) so the
            right certificate's real standard is one tap away, not hidden
            behind a toggle the user has to already know exists -- both
            still route into the same multi-engine.tsx screen (the toggle
            stays there too, for a user who wants to compare), just with a
            `cert` param so each card opens straight to its own material. */}
        {(category === 'All' || category === 'Airplane') && (
          <>
            <Pressable
              style={[styles.packetCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
              onPress={() => {
                if (consumeLongPress()) return
                if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
                router.push('/ref-packets/multi-engine?cert=FAA-S-ACS-6C' as any)
              }}
              onLongPress={(e) => showPreview('Multiengine Operations — Private', e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Icon name="rosette" size={fs(18)} color={tokens.gold} />
              <Text style={[styles.packetTitle, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={3}>
                Multiengine Operations — Private
              </Text>
              <Text style={[styles.packetMeta, { color: tokens.t4, fontSize: fs(10.5) }]}>AMEL · AMES</Text>
            </Pressable>
            <Pressable
              style={[styles.packetCard, { backgroundColor: tokens.bg2, borderColor: tokens.goldbdr }]}
              onPress={() => {
                if (consumeLongPress()) return
                if (!hasPlusAccess) { router.push('/paywall?tier=plus'); return }
                router.push('/ref-packets/multi-engine?cert=FAA-S-ACS-7B' as any)
              }}
              onLongPress={(e) => showPreview('Multiengine Operations — Commercial', e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Icon name="rosette" size={fs(18)} color={tokens.gold} />
              <Text style={[styles.packetTitle, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={3}>
                Multiengine Operations — Commercial
              </Text>
              <Text style={[styles.packetMeta, { color: tokens.t4, fontSize: fs(10.5) }]}>AMEL · AMES</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  neonText: {
    fontFamily: NEON_SIGN_FONT,
    color: '#fff',
    textShadowColor: '#fff',
    textShadowOffset: { width: 0, height: 0 },
  },
  lockedWrap: { alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10, paddingTop: 80 },
  lockedTitle: { fontWeight: '700', marginTop: 6 },
  lockedBody: { textAlign: 'center', lineHeight: 20, maxWidth: 330 },
  lockedBtn: { borderRadius: 22, paddingHorizontal: 24, paddingVertical: 12, marginTop: 12 },
  lockedBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  root: { flex: 1 },
  content: { padding: 12, paddingBottom: 40 },

  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    marginBottom: 8,
    paddingLeft: 2,
  },

  signInCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 18,
  },
  signInTitle: { fontWeight: '600' },
  signInSub: { marginTop: 2, lineHeight: 17 },

  identityCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 18,
  },
  identityAvatar: { width: 42, height: 42, borderRadius: 21, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  identityAvatarImage: { width: '100%', height: '100%' },
  identityAvatarText: { fontWeight: '800' },
  identityHandle: { fontWeight: '700' },
  identitySub: { marginTop: 2 },
  identityStatsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  identityStatChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  identityStatText: { fontWeight: '600' },

  hubCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14, borderWidth: 1, padding: 14,
  },
  hubIconWrap: {
    width: 38, height: 38, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  hubTitle: { fontWeight: '600' },
  hubSub: { marginTop: 2, lineHeight: 17 },

  // iPad tile grid (see isTablet branch above) -- icon-forward, centered,
  // taller tiles instead of the phone's icon-left list rows.
  hubTileRow: { flexDirection: 'row', gap: 14 },
  hubTile: {
    flex: 1, borderRadius: 18, borderWidth: 1, padding: 20,
    alignItems: 'center', gap: 8, minHeight: 148, justifyContent: 'center',
    position: 'relative',
  },
  hubTileIconWrap: {
    width: 56, height: 56, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginBottom: 2,
  },
  hubTileTitle: { fontWeight: '700', textAlign: 'center' },
  hubTileSub: { textAlign: 'center', lineHeight: 16 },
  hubTileLock: { position: 'absolute', top: 12, right: 12 },

  // Ref Packet grid
  packetHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, paddingLeft: 2 },
  packetCatRow: { marginBottom: 10 },
  // gap handles spacing between chips now (both directions, since this
  // wraps) -- packetCatChip no longer needs its own marginRight.
  packetCatWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  packetCatChip: {
    borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6,
  },
  packetCatText: { fontWeight: '600' },
  packetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  packetCard: {
    width: '31%', borderRadius: 14, borderWidth: 1, padding: 10, gap: 6, minHeight: 92,
  },
  packetTitle: { fontWeight: '600', lineHeight: 16 },
  packetMeta: { marginTop: 'auto' },
  packetSuffixBadge: {
    alignSelf: 'flex-start', borderRadius: 6, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2,
  },
  packetSuffixText: { fontWeight: '700' },
})
