import { useEffect, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, ScrollView, Platform } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'
import { purchaseSubscription, purchaseUnlock, restorePurchases } from '@/lib/revenuecat'
import { useFS } from '@/context/fontScale'
import { useConfirm } from '@/components/ConfirmDialog'

// TierBadge's own gold gradient fill -- RC: "the Premium paywall, buttons,
// etc need to look more 'golden' -- like the FlyRegs logo. it's our
// flagship product." Deliberately separate from MagicLinkPod.tsx's own
// GOLD_SPECTRUM_DARK/LIGHT, which is tuned for a thin animated rotating
// BORDER over a busy background -- this is an OPAQUE fill surface with an
// icon/label sitting directly on top, so a pale shimmer-stroke color like
// MagicLinkPod's own #F0D890 would wash out badly here. Real gold is
// light/mid luminance by nature (high R+G channels), which fights white
// text -- rather than darkening the fill toward brown to force
// white-text contrast, the badge uses dark ink (GOLD_INK) on a bright
// gold fill instead, like engraving on a gold plaque.
//
// The CTA button went through several rounds of its own bespoke gold
// treatment (an animated shimmer, then a couple of gradient tunings) that
// all landed short of what RC wanted -- see git history if curious. RC's
// actual final call: "just make the bottom button look like this one,"
// pointing at the tier-picker's own selected-tab fill, which is nothing
// but tokens.gold underneath white text (see GoldCta below). No custom
// gradient for the CTA at all in the end -- only the badge still uses one.
const BADGE_GOLD_DARK = ['#F0D890', '#D4AF37', '#B8860B'] as const
const BADGE_GOLD_LIGHT = ['#E8C468', '#C9A227', '#A8790F'] as const
const GOLD_INK = '#3D2B00'
// Red Shift: same 3-stop shape, reusing CoinMedal's own gold-rim colors so
// "Premium/gold" looks identical everywhere it appears under Red Shift.
const BADGE_GOLD_REDSHIFT = ['#FFC178', '#FF9A2E', '#B8541A'] as const
const GOLD_INK_REDSHIFT = '#3A1400'

const WING_ASPECT = 971 / 1071 // flyregs-wing.png width/height

type Plan = 'monthly' | 'annual'
type Tier = 'plus' | 'pro' | 'premium'

// ─── Feature definitions ──────────────────────────────────────────────────────
// Pricing pivot 2026-07-24 — see PROJECT_NOTES/flyregs_decisions.md. Reading
// and searching the FAR/AIM/P-CG/ADs is free, no account needed — don't list
// either here. Plus is the one-time content/productivity unlock; Pro and
// Premium are the subscription service layers on top of it.

// These lists are the PRODUCT PROMISE, so they are kept honest against the
// actual gate in code. Audited 2026-07-31 by reading every gate:
//   hasPlusAccess (= Plus OR Pro OR Premium) -> belongs in PLUS_FEATURES
//   hasProAccess  (= Pro OR Premium)         -> belongs in PRO_ADDITIONS
//   isPremium                                -> PREMIUM_ADDITIONS
// Three corrections came out of that audit:
//   - "Print & export any section" is a PLUS feature, but handleShare()
//     gated on isPremium in all six reg screens (ac/far/aim/pcg/ad/loi) and
//     there was no print function anywhere -- a Plus buyer paying for that
//     line got bounced to the Premium upsell. Confirmed with RC that Plus is
//     correct, so the GATE was fixed (now hasPlusAccess) and a real print
//     feature added (src/lib/printReg.ts). This line stays here.
//   - "(up to 3 folders)" described a cap that does not exist in code.
//   - What's Changed was hasPlusAccess-gated but appeared in NO tier list.
//   - Duels is PREMIUM (RC, 2026-07-31) -- was gated hasPlusAccess.
//   - Parts Lookup is FREE like the AD list, with results capped for free
//     users the same way, so it is not sold as a tier feature at all.
// A fourth correction, 2026-07-31 (later same day): MagicLink was briefly
// listed here as PLUS_FEATURES, matching its gate at the time
// (`if (!hasPlusAccess)`) -- RC then corrected the gate itself: "no, ML has
// to at least be Pro tier." The gate (MagicLinkPod.tsx) and this list moved
// together, not independently -- see hasProAccess in context/auth.tsx.
//
// Fifth round, 2026-08-03 -- RC reviewed the real tier-comparison chart
// (PROJECT_NOTES/flyregs_tier_comparison.html) built from this exact list
// and moved several boundaries at once, each gate updated in the same pass:
//   - DailyReg: Plus -> Pro ("daily reg is Pro gated, not Plus"). Card
//     (index.tsx) and notification (account.tsx) are now both Pro instead
//     of split across two tiers -- one line here instead of two.
//   - Legal Interpretations: had NO gate at all (a real bug -- this list
//     already claimed Plus, decisions.md claimed Plus, neither was ever
//     enforced in loi/[slug].tsx). RC went further than restoring Plus:
//     "LOIs are a Pro feature" -- new hasProAccess gate, previewText().
//   - Airworthiness Directives: were fully free tier-wide, RC: "ADs
//     shouldn't come alive until Plus... mainly for O&Os anyway" -- new
//     hasPlusAccess gate on the body text (ad/[id].tsx), no preview at all
//     (stricter than AC's, see that screen's own comment for why).
//   - AC preview: RC: "free tier can preview 2 sections of an AC, not 5" --
//     previewBlockCount() is now a flat 2, was a 2-5 range.
//   - Mnemonics: were fully free inside the Aviation Dictionary (which
//     stays free) -- RC: "if we did make it free, at the very least we'd
//     remove the Mnemonic look up and gate that at Plus." New hasPlusAccess
//     gate on both the index card and the entry detail page.
const PLUS_FEATURES = [
  { icon: 'doc.text',          label: 'Complete text of every Advisory Circular' },
  { icon: 'wrench.and.screwdriver', label: 'Full text of every Airworthiness Directive' },
  { icon: 'list.bullet',       label: 'Mnemonics — memory aids for checkride prep' },
  { icon: 'square.grid.2x2',   label: 'RefPacks — certificate-specific study collections' },
  // Audit gap: the 3-folder cap (PLUS_FOLDER_CAP in (tabs)/saved.tsx) was
  // disclosed in the FAQ ("Folders (up to 3)") but never here, so a Plus
  // buyer wasn't told about it until after purchase.
  { icon: 'highlighter',       label: 'Highlights, Notes, Bookmarks & Folders (up to 3)' },
  { icon: 'printer',           label: 'Print & export any section' },
  { icon: 'magnifyingglass',   label: 'Unlimited search results' },
  { icon: 'doc.badge.clock',   label: "What's Changed — see exactly what the FAA revised" },
]

const PRO_ADDITIONS = [
  // MagicLink's own expand-and-navigate gate is `if (!hasProAccess)` --
  // listed here, not PLUS_FEATURES, per the correction above. Previously
  // missing from every tier list on this whole screen despite being
  // explicitly called "the feature no competitor has" in its own tier
  // decision doc -- confirmed live, RC: "def put ML on the feature list."
  { icon: 'sparkles',          label: 'MagicLink — automatic cross-references across FAR, AIM, P/CG, AC, AD & LOIs' },
  // Ask FlyRegs moved from Plus to Pro, 2026-08-02 (RC: "It needs to be
  // gated to Pro for sure") -- same "gate and promise move together"
  // discipline as every correction above; semantic-search.tsx's own gate
  // moved from hasPlusAccess to hasProAccess in the same change.
  { icon: 'text.bubble.fill',  label: 'Ask FlyRegs — ask a real question in plain English, get the passages that answer it' },
  { icon: 'checkmark.seal.fill', label: 'Legal Interpretations — full text of every LOI' },
  { icon: 'icloud',    label: 'Cross-device sync for your highlights, notes & bookmarks' },
  { icon: 'bell.badge', label: 'Airworthiness Directive alerts for your saved aircraft' },
  { icon: 'doc.badge.clock', label: 'Advisory Circular update alerts' },
  { icon: 'airplane',  label: '1 saved aircraft, with your own reminders for recurring maintenance' },
  { icon: 'rectangle.stack', label: 'Study Mode flashcards & mastery tracking' },
  { icon: 'rosette',   label: 'Challenge Coins for streaks & milestones' },
  { icon: 'person.2.fill', label: 'Ready Room leaderboard' },
  { icon: 'star.fill', label: 'DailyReg — a hand-picked reg every day' },
]

const PREMIUM_ADDITIONS = [
  { icon: 'person.2.fill',     label: 'Shared, collaborative folders for CFIs, schools, and shops' },
  { icon: 'arrow.down.circle', label: 'Offline downloads — no internet required' },
  { icon: 'bolt.fill',         label: 'Duels — challenge other players to a reg quiz' },
  { icon: 'airplane',          label: 'Unlimited saved aircraft (up from 1 on Pro)' },
  // Found undocumented on this screen during the 2026-08-03 chart audit --
  // my-aircraft/[id].tsx already gated this on isPremium (not just isPro,
  // unlike the rest of My Aircraft), it just was never written down here.
  { icon: 'wrench.and.screwdriver.fill', label: 'Tag specific parts to your aircraft for part-keyed AD alerts' },
  // Confirmed gap: my-aircraft/[id].tsx's share flow (Viewer/Editor invite
  // links, gated isPremium — see aircraftSharing.ts) was fully built and
  // shipped but never appeared on this screen's own feature list.
  { icon: 'link',              label: 'Share an aircraft — invite a Viewer or Editor to see or help track compliance' },
  // Audit gap: the whole "Share" feature family (share.ts's shareAC/
  // shareNote/shareReg/shareMany -- branded share cards, not the plain-link
  // Plus-tier "Print & export") is isPremium-gated at 6+ call sites
  // (notes.tsx, recents.tsx, saved.tsx, ac/[id].tsx's Share Passage) but was
  // never mentioned on this screen at all, distinct from both Plus's export
  // and the aircraft-sharing line just above.
  { icon: 'square.and.arrow.up', label: 'Share notes, passages & regs as branded cards to any app' },
]

// ─── Pricing ──────────────────────────────────────────────────────────────────

const PRICING = {
  plus:    { oneTime: '$17.99' },
  pro:     { monthly: '$1.99', annual: '$12.99', annualSaving: 'Save 46%' },
  premium: { monthly: '$3.99', annual: '$24.99', annualSaving: 'Save 48%' },
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function PaywallScreen() {
  const { tokens, resolved, redShift } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  const { session, isPro, isPremium, isUnlocked, hasPlusAccess, setIsPro, setIsPremium, setIsUnlocked } = useAuth()
  const insets = useSafeAreaInsets()
  const { tier: paramTier } = useLocalSearchParams<{ tier?: string }>()

  // downgradeMode: Premium subscribers -- shows the tier picker again (Plus
  // isn't offered here since Premium already includes it) so Pro is a real,
  // selectable option, same as before the pricing pivot.
  const downgradeMode = isPremium
  // upgradeMode: Pro (not yet Premium) subscribers -- Premium is the only
  // real "more" option, since they already have everything Plus/Pro offer.
  const upgradeMode = isPro && !isPremium
  // premiumRequired: arrived from a gate that specifically needs Premium
  // (shared folders, offline, unlimited aircraft/folders) and doesn't have
  // it yet -- lock to Premium, since Plus/Pro genuinely don't unlock it.
  const premiumRequired = paramTier === 'premium' && !isPremium
  // proRequired: arrived from a gate that specifically needs Pro (e.g.
  // MagicLink, per the 2026-07-31 correction -- see hasProAccess's own
  // comment in context/auth.tsx) and doesn't have it yet -- lock the
  // picker to Pro/Premium so Plus (which genuinely does NOT unlock it)
  // isn't offered as if it would. Same shape as premiumRequired above,
  // just one rung down the ladder.
  const proRequired = paramTier === 'pro' && !isPro && !isPremium
  const locked = upgradeMode || premiumRequired || proRequired

  // The tiers actually worth showing: skip anything already owned. A Plus
  // owner hitting a Pro/Premium gate should never see Plus offered again.
  const availableTiers: Tier[] = (upgradeMode || premiumRequired)
    ? ['premium']
    : proRequired
    ? ['pro', 'premium']
    : downgradeMode
    ? ['pro', 'premium']
    : hasPlusAccess
    ? ['pro', 'premium']
    : ['plus', 'pro', 'premium']

  const defaultTier: Tier = (upgradeMode || premiumRequired)
    ? 'premium'
    : proRequired
    ? 'pro'
    : downgradeMode
    ? 'premium'
    : paramTier === 'pro' && availableTiers.includes('pro')
    ? 'pro'
    : paramTier === 'plus' && availableTiers.includes('plus')
    ? 'plus'
    : availableTiers[0]

  const [tier, setTier] = useState<Tier>(defaultTier)
  const [plan, setPlan] = useState<Plan>('annual')
  const [loading, setLoading] = useState(false)

  // isPro/isPremium/isUnlocked load asynchronously in AuthProvider — all still
  // false on this screen's first render for a real subscriber, so the tier
  // useState above locks in a guess before the real status arrives. Re-sync
  // once it does so the pricing/picker shown always matches reality.
  useEffect(() => {
    setTier(defaultTier)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, downgradeMode, hasPlusAccess])

  // Viewing "premium" while downgradeMode is true means looking at the
  // CURRENT plan, not something new to buy -- nothing to purchase, and the
  // CTA below is disabled/relabeled for exactly this case.
  const viewingCurrentPlan = downgradeMode && tier === 'premium'

  // Pro/Premium always show as marginal additions on top of the tier below --
  // "Everything in Plus, plus:" / "Everything in Plus and Pro, plus:" -- not
  // just for viewers who already own the lower tier. Previously this only
  // applied to upgrade flows, so a first-time viewer saw a single flattened
  // list repeating every lower-tier feature (and, confirmed live, a real
  // contradiction: Pro's "1 saved aircraft" and Premium's "Unlimited saved
  // aircraft" both appearing in Premium's own flattened list at once).
  const features = tier === 'plus' ? PLUS_FEATURES : tier === 'pro' ? PRO_ADDITIONS : PREMIUM_ADDITIONS
  // Plus has a different shape (one-time, no monthly/annual) -- only read
  // subscription pricing when the picker is actually showing a subscription.
  const subPricing = tier === 'premium' ? PRICING.premium : PRICING.pro

  const tierLabel = tier === 'plus' ? 'Plus' : tier === 'pro' ? 'Pro' : 'Premium'
  const ctaLabel = viewingCurrentPlan
    ? 'Current Plan'
    : downgradeMode
    ? 'Downgrade to Pro'
    : premiumRequired || upgradeMode
    ? 'Upgrade to Premium'
    : proRequired
    ? 'Upgrade to Pro'
    : `Get ${tierLabel}`

  // The badge tier always reads "Premium" once the user is locked into a
  // Premium-only or Pro→Premium flow; a proRequired lock reads "Pro"
  // instead (tier state already tracks 'pro' for it via defaultTier, so
  // just falling through to the normal `tier` branch is correct); otherwise
  // it follows whichever tier they currently have selected in the picker.
  const badgeTier: Tier = premiumRequired || upgradeMode ? 'premium' : tier

  const handleSubscribe = async () => {
    if (Platform.OS === 'web') {
      confirm({ title: 'Available on iOS & Android', message: 'Download the FlyRegs app to subscribe.', cancelLabel: null })
      return
    }
    if (!session) {
      confirm({
        title: 'Sign in first',
        message: 'Create a free account to continue.',
        confirmLabel: 'Sign In',
        onConfirm: () => router.replace('/auth'),
      })
      return
    }
    if (viewingCurrentPlan) return
    if (downgradeMode && tier === 'pro') {
      confirm({
        title: 'Downgrade to Pro?',
        message: "You'll keep Premium features (shared folders, aircraft sharing, offline downloads, unlimited aircraft) until your current billing period ends, then move to Pro automatically. No refund for the time remaining.",
        confirmLabel: 'Downgrade',
        destructive: true,
        finalTitle: 'Downgrade to Pro — confirm',
        onConfirm: () => confirmSubscribe(),
      })
      return
    }
    await confirmSubscribe()
  }

  const confirmSubscribe = async () => {
    setLoading(true)
    try {
      // premiumRequired/upgradeMode force Premium (the only real option);
      // proRequired does NOT force Premium -- Pro genuinely satisfies it,
      // so purchase whatever the picker actually has selected.
      const activeTier = premiumRequired || upgradeMode ? 'premium' : tier
      const status = activeTier === 'plus'
        ? await purchaseUnlock()
        : await purchaseSubscription(activeTier, plan)
      setIsPro(status.isPro)
      setIsPremium(status.isPremium)
      setIsUnlocked(status.isUnlocked)
      router.dismiss()
    } catch (err: any) {
      // User cancelled — no alert needed
      if (!err?.message?.includes('cancel') && !err?.userCancelled) {
        confirm({ title: 'Error', message: err?.message ?? 'Something went wrong.', cancelLabel: null })
      }
    }
    setLoading(false)
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Math.max(insets.top, 16), borderBottomColor: tokens.bdr }]}>
        <Text style={[styles.headerTitle, { color: tokens.t1, fontSize: fs(16) }]}>
          {premiumRequired || upgradeMode ? 'Upgrade to Premium' : proRequired ? 'Upgrade to Pro' : downgradeMode ? 'Manage Your Plan' : 'Unlock FlyRegs'}
        </Text>
        <Pressable onPress={() => router.dismiss()} hitSlop={8} style={styles.closeBtn}>
          <Icon name="xmark" size={fs(18)} color={tokens.t3} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Image
            source={require('@/assets/images/flyregs-wing.png')}
            style={{ width: fs(54), height: fs(54) / WING_ASPECT, marginBottom: 2 }}
            resizeMode="contain"
          />
          <TierBadge tier={badgeTier} tokens={tokens} fs={fs} isDark={resolved === 'dark'} redShift={redShift} />
          {premiumRequired ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>This is a Premium feature</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Upgrade to Premium to unlock this — plus shared folders, aircraft sharing, offline downloads, and unlimited aircraft.
              </Text>
            </>
          ) : proRequired ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>This is a Pro feature</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Upgrade to Pro to unlock this — plus sync, AD alerts, and Study Mode.
              </Text>
            </>
          ) : upgradeMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>Take FlyRegs further</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                Add shared folders, aircraft sharing, offline downloads, and unlimited saved aircraft to your Pro subscription.
              </Text>
            </>
          ) : downgradeMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>
                {viewingCurrentPlan ? 'Your current plan' : 'Switch to Pro'}
              </Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                {viewingCurrentPlan
                  ? 'You\'re on Premium. Select Pro below to see what changes if you switch down.'
                  : 'You\'ll keep Premium features until your current billing period ends, then move to Pro automatically.'}
              </Text>
            </>
          ) : hasPlusAccess ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>Take FlyRegs further</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                You already have Plus. Add sync, alerts, sharing, and offline access with a subscription.
              </Text>
            </>
          ) : (
            // RC: "this verbage only works for the Plus paywall. it's out
            // of place here. need new language for Pro and Prem" -- this
            // branch used one static "Unlock these extras forever" line
            // regardless of which tab was selected, but that one-time-
            // purchase framing only makes sense for Plus. Now keyed off
            // the actually-selected tier tab, each with its own pitch.
            // Plus's own line also does double duty per RC: "remind
            // customers that pro and premium subscriptions already include
            // everything in Plus... they don't have to buy Plus and then
            // upgrade" -- so a viewer landing on Plus isn't left thinking
            // it's a required first step.
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>The complete FAA reference</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14) }]}>
                {tier === 'plus' ? (
                  <>
                    FAR, AIM, P/CG & ADs are free. Unlock these extras forever with a one-time purchase — or skip
                    straight to <Text style={{ color: tokens.blu, fontWeight: '700' }}>Pro</Text> or{' '}
                    <Text style={{ color: tokens.gold, fontWeight: '700' }}>Premium</Text> and get everything in
                    Plus automatically, plus a lot more.
                  </>
                ) : tier === 'pro' ? (
                  <>
                    FAR, AIM, P/CG & ADs are free. Subscribe to{' '}
                    <Text style={{ color: tokens.blu, fontWeight: '700' }}>Pro</Text> for MagicLink, Ask FlyRegs,
                    cross-device sync, and everything in Plus — all in one plan.
                  </>
                ) : (
                  <>
                    FAR, AIM, P/CG & ADs are free. Go{' '}
                    <Text style={{ color: tokens.gold, fontWeight: '700' }}>Premium</Text> for the complete
                    experience — everything in Plus and Pro, plus offline access, aircraft sharing, and shared folders.
                  </>
                )}
              </Text>
            </>
          )}
        </View>

        {/* Tier picker — hidden only when there's truly nothing to choose
            (premiumRequired/upgradeMode narrow availableTiers to a single
            entry). proRequired still offers a real choice (Pro or Premium,
            since Premium is a superset) so the picker stays, defaulted to
            Pro rather than hidden outright. */}
        {availableTiers.length > 1 && (
          <View style={[styles.tierPicker, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
            {availableTiers.map((t) => (
              <Pressable
                key={t}
                style={[styles.tierBtn, tier === t && { backgroundColor: t === 'plus' ? tokens.amb : t === 'premium' ? tokens.gold : tokens.blu }]}
                onPress={() => setTier(t)}
              >
                <Text style={[styles.tierBtnText, { color: tier === t ? '#fff' : tokens.t3, fontSize: fs(14) }]}>
                  {t === 'plus' ? 'Plus' : t === 'pro' ? 'Pro' : 'Premium'}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Feature list */}
        <View style={[styles.featureBox, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {tier !== 'plus' && (
            // RC: "we need to highlight this better, and use the color Plus
            // chip in the line. the goal is to get subs... lead them there
            // amap." Bumped up from a small muted caption to a real,
            // tinted banner with each tier's own accent color on its name --
            // the same colors already used for the tier picker/badges above,
            // so "Plus" always reads amber and "Pro" always reads blue
            // wherever they appear on this screen.
            <View style={[
              styles.featureHeader,
              { borderBottomColor: tokens.bdr, backgroundColor: (tier === 'premium' ? tokens.gold : tokens.blu) + '14' },
            ]}>
              <Text style={[styles.featureHeaderText, { color: tokens.t2, fontSize: fs(13) }]}>
                Everything in <Text style={{ color: tokens.amb, fontWeight: '800' }}>Plus</Text>
                {tier === 'premium' ? (
                  <> and <Text style={{ color: tokens.blu, fontWeight: '800' }}>Pro</Text></>
                ) : null}
                , plus:
              </Text>
            </View>
          )}
          {features.map((f, i) => (
            <View
              key={f.label}
              style={[
                styles.featureRow,
                i < features.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.bdr },
              ]}
            >
              <Icon
                name={f.icon}
                size={fs(17)}
                color={tier === 'premium' || upgradeMode || premiumRequired ? tokens.gold : tier === 'plus' ? tokens.amb : tokens.blu}
              />
              <Text style={[styles.featureText, { color: tokens.t1, fontSize: fs(14) }]}>{f.label}</Text>
            </View>
          ))}
        </View>

        {/* Plan picker — Plus is a single one-time purchase, no monthly/annual */}
        <View style={styles.planHeaderRow}>
          <Text style={[styles.pickLabel, { color: tokens.t3, fontSize: fs(11) }]}>
            {tier === 'plus' ? 'ONE-TIME PURCHASE' : 'CHOOSE A PLAN'}
          </Text>
          <TierBadge tier={badgeTier} tokens={tokens} fs={fs} isDark={resolved === 'dark'} redShift={redShift} compact />
        </View>
        {tier === 'plus' ? (
          <Pressable
            style={[
              styles.planCard,
              styles.planCardSolo,
              { backgroundColor: tokens.amb + '18', borderColor: tokens.amb },
            ]}
          >
            <Text style={[styles.planTitle, { color: tokens.amb, fontSize: fs(12) }]}>PLUS</Text>
            <Text style={[styles.planPrice, { color: tokens.t1, fontSize: fs(28) }]}>{PRICING.plus.oneTime}</Text>
            <Text style={[styles.planPeriod, { color: tokens.t3, fontSize: fs(12) }]}>one-time — yours forever</Text>
          </Pressable>
        ) : (
          <View style={styles.planRow}>
            <PlanCard
              title="Monthly"
              price={subPricing.monthly}
              period="/mo"
              badge={null}
              selected={plan === 'monthly'}
              onPress={() => setPlan('monthly')}
              tokens={tokens}
              isPremium={tier === 'premium' || upgradeMode || premiumRequired}
            />
            <PlanCard
              title="Annual"
              price={subPricing.annual}
              period="/yr"
              badge={subPricing.annualSaving}
              selected={plan === 'annual'}
              onPress={() => setPlan('annual')}
              tokens={tokens}
              isPremium={tier === 'premium' || upgradeMode || premiumRequired}
            />
          </View>
        )}

        {/* CTA -- Premium gets the golden shimmer treatment (RC: "it's our
            flagship product... maybe even some subtle shimmer"); Plus/Pro
            keep the plain flat-color button, unchanged. */}
        {tier === 'premium' || upgradeMode || premiumRequired ? (
          <GoldCta
            label={ctaLabel}
            onPress={handleSubscribe}
            disabled={loading || viewingCurrentPlan}
            loading={loading}
          />
        ) : (
          <Pressable
            style={[
              styles.cta,
              { backgroundColor: tier === 'plus' ? tokens.amb : tokens.blu },
              (loading || viewingCurrentPlan) && styles.ctaDisabled,
            ]}
            onPress={handleSubscribe}
            disabled={loading || viewingCurrentPlan}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={[styles.ctaText, { fontSize: fs(16) }]}>{ctaLabel}</Text>
            )}
          </Pressable>
        )}

        {/* Restore */}
        <Pressable style={styles.restoreRow} onPress={async () => {
          // Same account-required rule as purchasing itself (see
          // handleSubscribe above) -- restoring must never hand out
          // entitlements to a signed-out session.
          if (!session) {
            confirm({
              title: 'Sign in first',
              message: 'Create a free account to restore your purchases.',
              confirmLabel: 'Sign In',
              onConfirm: () => router.replace('/auth'),
            })
            return
          }
          try {
            const status = await restorePurchases()
            setIsPro(status.isPro)
            setIsPremium(status.isPremium)
            setIsUnlocked(status.isUnlocked)
            if (status.isPro || status.isPremium || status.isUnlocked) router.dismiss()
            else confirm({ title: 'No purchases found', message: 'No active purchases found for this Apple ID.', cancelLabel: null })
          } catch (err: any) {
            confirm({ title: 'Error', message: err?.message ?? 'Could not restore purchases.', cancelLabel: null })
          }
        }}>
          <Text style={[styles.restoreText, { color: tokens.t4, fontSize: fs(13) }]}>Restore Purchases</Text>
        </Pressable>

        <Text style={[styles.legal, { color: tokens.t4, fontSize: fs(11) }]}>
          {tier === 'plus'
            ? 'One-time purchase, billed once through the App Store. Prices shown in USD.'
            : 'Subscription renews automatically. Cancel anytime in App Store or Google Play settings. Prices shown in USD.'}
        </Text>
      </ScrollView>
    </View>
  )
}

// ─── Gold CTA (Premium only) ────────────────────────────────────────────────
// Three tries at a bespoke gold treatment (animated shimmer, then a plain
// gradient, then a brighter gradient) all landed short of what RC wanted.
// RC's actual final call: "just make the bottom button look like this
// one" -- pointing at the tier-picker's own selected "Premium" tab, which
// is nothing but a flat tokens.gold fill with white text (see the tier
// picker's own tierBtn a few dozen lines up). No gradient, no custom
// color constants -- this is that exact same treatment, just applied to
// the CTA's shape.

function GoldCta({
  label, onPress, disabled, loading,
}: {
  label: string
  onPress: () => void
  disabled: boolean
  loading: boolean
}) {
  const fs = useFS()
  const { tokens } = useTheme()

  return (
    <Pressable
      style={[styles.cta, { backgroundColor: tokens.gold }, disabled && styles.ctaDisabled]}
      onPress={onPress}
      disabled={disabled}
    >
      {loading ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={[styles.ctaText, { fontSize: fs(16) }]}>{label}</Text>
      )}
    </Pressable>
  )
}

// ─── Tier Badge ───────────────────────────────────────────────────────────────
// Eye-catching pill naming the exact plan on offer — shown once up top by the
// headline and again just above the pricing cards, so it's never ambiguous
// which plan a user is about to buy.

function TierBadge({
  tier, tokens, fs, compact, isDark, redShift,
}: {
  tier: Tier
  tokens: ReturnType<typeof useTheme>['tokens']
  fs: (n: number) => number
  compact?: boolean
  isDark: boolean
  redShift: boolean
}) {
  const isPremium = tier === 'premium'
  const isPlus = tier === 'plus'
  const accentColor = isPremium ? (redShift ? GOLD_INK_REDSHIFT : GOLD_INK) : isPlus ? tokens.amb : tokens.blu
  const bg = isPlus ? tokens.amb + '20' : tokens.bdim
  const bdr = isPremium ? tokens.goldbdr : isPlus ? tokens.amb + '48' : tokens.bbdr

  const content = (
    <>
      <Icon name={isPremium ? 'crown.fill' : isPlus ? 'plus.circle.fill' : 'star.fill'} size={fs(compact ? 11 : 13)} color={accentColor} />
      <Text style={[
        styles.tierBadgeText,
        compact && styles.tierBadgeTextCompact,
        { color: accentColor, fontSize: fs(compact ? 11 : 13) },
      ]}>
        {tier === 'plus' ? 'PLUS' : tier === 'pro' ? 'PRO' : 'PREMIUM'}
      </Text>
    </>
  )

  // Premium's badge gets a real gold gradient fill instead of a flat tint --
  // RC: "the Premium paywall, buttons, etc need to look more 'golden' --
  // like the FlyRegs logo. it's our flagship product." Own BADGE_GOLD_*
  // constants, not shared with the CTA button -- see the comment where
  // those are defined for why a shared gradient looked "dull" on the
  // larger button surface even at identical color values.
  if (isPremium) {
    return (
      <LinearGradient
        colors={redShift ? BADGE_GOLD_REDSHIFT : isDark ? BADGE_GOLD_DARK : BADGE_GOLD_LIGHT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.tierBadge, compact && styles.tierBadgeCompact, { borderColor: bdr }]}
      >
        {content}
      </LinearGradient>
    )
  }

  return (
    <View style={[
      styles.tierBadge,
      compact && styles.tierBadgeCompact,
      { backgroundColor: bg, borderColor: bdr },
    ]}>
      {content}
    </View>
  )
}

// ─── Plan Card ────────────────────────────────────────────────────────────────

function PlanCard({
  title, price, period, badge, selected, onPress, tokens, isPremium,
}: {
  title: string
  price: string
  period: string
  badge: string | null
  selected: boolean
  onPress: () => void
  tokens: ReturnType<typeof useTheme>['tokens']
  isPremium: boolean
}) {
  const accentColor = isPremium ? tokens.gold : tokens.blu
  const fs = useFS()

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.planCard,
        {
          backgroundColor: selected ? (isPremium ? tokens.goldlt : tokens.bdim) : tokens.bg2,
          borderColor: selected ? accentColor : tokens.bdr,
        },
      ]}
    >
      {badge ? (
        <View style={[styles.planBadge, { backgroundColor: accentColor }]}>
          <Text style={[styles.planBadgeText, { fontSize: fs(10.5) }]}>{badge}</Text>
        </View>
      ) : (
        <View style={styles.planBadgePlaceholder} />
      )}
      <Text style={[styles.planTitle, { color: selected ? accentColor : tokens.t2, fontSize: fs(12) }]}>
        {title}
      </Text>
      <Text style={[styles.planPrice, { color: tokens.t1, fontSize: fs(24) }]}>{price}</Text>
      <Text style={[styles.planPeriod, { color: tokens.t3, fontSize: fs(12) }]}>{period}</Text>
    </Pressable>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  headerTitle: { fontWeight: '600', fontSize: 16 },
  closeBtn: { position: 'absolute', right: 16, bottom: 12 },

  content: { padding: 20, gap: 16 },

  hero: { gap: 6, alignItems: 'center', paddingVertical: 4 },
  headline: { fontWeight: '700', fontSize: 20, textAlign: 'center' },
  sub: { fontSize: 14, textAlign: 'center', lineHeight: 20, maxWidth: 300 },

  tierPicker: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    padding: 3,
    gap: 2,
  },
  tierBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
  },
  tierBtnText: { fontSize: 14, fontWeight: '700' },

  tierBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  tierBadgeCompact: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tierBadgeText: { fontWeight: '800', letterSpacing: 1 },
  tierBadgeTextCompact: { letterSpacing: 0.7 },

  featureBox: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  featureHeader: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  featureHeaderText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  featureText: { fontSize: 14, flex: 1 },

  pickLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
    paddingLeft: 2,
  },
  planHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -4,
  },
  planRow: { flexDirection: 'row', gap: 10 },
  planCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    alignItems: 'center',
    gap: 2,
  },
  planCardSolo: { paddingVertical: 18 },
  planBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginBottom: 4,
  },
  planBadgeText: { color: '#fff', fontSize: 10.5, fontWeight: '700' },
  planBadgePlaceholder: { height: 22, marginBottom: 4 },
  planTitle: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  planPrice: { fontSize: 24, fontWeight: '800', marginTop: 4 },
  planPeriod: { fontSize: 12 },

  cta: {
    borderRadius: 14,
    height: 54,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 4,
  },
  ctaDisabled: { opacity: 0.6 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  restoreRow: { alignItems: 'center', paddingVertical: 4 },
  restoreText: { fontSize: 13 },
  legal: { fontSize: 11, textAlign: 'center', lineHeight: 16 },
})
