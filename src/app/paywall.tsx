import { useEffect, useState } from 'react'
import { View, Text, Image, Pressable, StyleSheet, ActivityIndicator, ScrollView, Platform } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { useAuth } from '@/context/auth'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'
import { purchaseSubscription, purchaseUnlock, restorePurchases, getSubscriptionDetails } from '@/lib/revenuecat'
import { getOwnedAircraftOldestFirst } from '@/lib/aircraftSharing'
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
// Eighth round, 2026-08-11 -- RC, direct correction after the app-wide
// gating sweep (gotcha_gating_sweep_2026_08_11.md): "back up sync is Pro.
// Any gating needs to be fixed to make sure only Pro and Prem have any
// bu/s." This list's own PLUS_FEATURES line ("Highlights, Notes, Bookmarks
// & Folders") and PRO_ADDITIONS' separate "Cross-device sync" line had
// quietly split into two different claims about the same feature -- Plus
// got to CREATE them, Pro got them SYNCED -- which was never RC's actual
// intent and doesn't match how any other Plus/Pro boundary on this screen
// works (nothing else splits "have it" from "sync it" across two tiers).
// Moved the whole feature to PRO_ADDITIONS; PLUS_FEATURES no longer
// mentions it at all. Gates fixed in the same pass: enforce_folder_cap(),
// enforce_bookmark_plus_gate(), enforce_note_plus_gate(), plus every
// client-side hasPlusAccess check gating creation of a folder/note/
// bookmark/highlight, all moved from has_plus_access()/hasPlusAccess to
// has_pro_access()/hasProAccess. Print & export, RefPacks, base Dictionary,
// AC/AD full text, and everything else already in PLUS_FEATURES are
// untouched -- this was specifically about the sync-backed organizational
// features, not a wholesale Plus-to-Pro shift.
//
// Ninth round, 2026-08-14 -- RC, direct correction to the eighth round
// above: "my quote has nothing to do with folders, h/l, etc. -- ONLY the
// 'bu/s' feature itself. that feature is a separate thing from
// folders/notes/bookmarks/highlights. All of those things are supposed to
// be part of Plus. It's just the bu/s feature that gets gated to Pro/Prem."
// The eighth round had read "back up sync is Pro" as covering base
// creation too, and moved the whole feature to PRO_ADDITIONS -- it didn't;
// only the literal "Back up & sync" toggle (cross-device push, in
// notes.tsx/saved.tsx) is Pro. Creating and using folders/notes/bookmarks/
// highlights locally is Plus, same as before the eighth round ever
// happened. Reverted: PLUS_FEATURES gets its own line back (the folder cap
// wording moved here too, since Plus and Pro now share the same numeric
// cap -- see PRO_FOLDER_CAP's comment in lib/folders.ts); PRO_ADDITIONS'
// line is reworded to describe ONLY the sync capability, not the base
// feature. Every gate reverted in the same pass -- see
// migrations_fix_folders_are_plus_not_pro.sql (server) and each detail
// screen's own hasProAccess -> hasPlusAccess fix (client) -- except the
// literal sync toggle itself (toggleSync in notes.tsx/saved.tsx), which
// stays hasProAccess, matching this list's own PRO_ADDITIONS line below.
//
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
//
// Sixth round, 2026-08-08 -- RC: "parts lookup is not avail at all for
// Free. remove it and double check that gate." Parts Lookup
// (parts-lookup.tsx) previously ran real searches for Free and showed the
// first 5 results with an "unlock Plus" upsell for the rest -- a real cap,
// but not the "not available at all" the label above already implied.
// Replaced with a single lock card before any search UI at all, same
// no-preview pattern as AD's own body text right next to it. Also added
// here for the first time -- audit gap, it was never on this list despite
// being a real, distinct Plus-gated screen. Same pass: AD's own list
// screen (ad/index.tsx) had an unguarded "NEW — LAST Nd" feed visible to
// every tier, never gated at all -- RC: "in Free, the AD page should not
// display the 'New' list at all. That's a paid tier feature." Now
// hasPlusAccess-gated (both the fetch and the render), matching this
// list's own AD body-text boundary.
//
// Seventh round, 2026-08-11 -- found during a post-build-31 corpus-wide
// sweep, not an RC-reported gap. `6495280` (2026-08-10) re-gated the
// Aviation Dictionary -- base content free -> Plus, Mnemonics specifically
// Plus -> Pro -- and updated all three Dictionary screens' own gates, but
// never touched this list: Mnemonics was still sitting in PLUS_FEATURES
// (a buyer paying for Plus and reading "Mnemonics" right there would hit a
// Pro upsell on tap), and the base Dictionary had no line here at all
// despite becoming, that same commit, a real distinct whole-screen
// Plus-gated feature exactly like RefPacks above it. Moved Mnemonics to
// PRO_ADDITIONS, added a Dictionary line to PLUS_FEATURES.
const PLUS_FEATURES = [
  { icon: 'doc.text',          label: 'Complete text of every Advisory Circular' },
  { icon: 'wrench.and.screwdriver', label: 'Full text of every Airworthiness Directive' },
  // Gating audit, 2026-08-22: 49 CFR (NTSB 830/TSA 1544+1552/HMR 175) is
  // gated hasPlusAccess at 5+ call sites throughout cfr49/[id].tsx, same
  // tier as AC/AD full text right above -- shipped but never appeared on
  // any tier list on this screen.
  // RC, 2026-08-23: dropped "hazmat" from the label -- HMR 175 (carriage by
  // aircraft) is live, but HMR 172 (the actual Hazmat Table) isn't built
  // yet, so calling this "hazmat" overpromises what's really here.
  { icon: 'shield.lefthalf.filled', label: 'Full text of 49 CFR (NTSB, TSA)' },
  // Aviation Dictionary re-gated 2026-08-10 (base content free -> Plus,
  // Mnemonics specifically Plus -> Pro, see dictionary_terms_gated /
  // search_dictionary()) -- this list previously had only the Mnemonics
  // line below, with no line at all for the base 10,000+-term Dictionary
  // itself, which is now equally a real, distinct Plus-gated feature.
  { icon: 'books.vertical.fill', label: 'Aviation Dictionary — 10,000+ terms across every handbook' },
  { icon: 'square.grid.2x2',   label: 'RefPacks — certificate-specific study collections' },
  { icon: 'printer',           label: 'Print & export any section' },
  { icon: 'magnifyingglass',   label: 'Unlimited search results' },
  { icon: 'doc.badge.clock',   label: "What's Changed — see exactly what the FAA revised" },
  { icon: 'wrench',            label: 'Parts Lookup — find ADs by a specific engine, propeller, or avionics part' },
  // Restored in the ninth-round correction above -- creating/using these
  // locally (not synced) is Plus, same as the folder cap itself
  // (PRO_FOLDER_CAP in lib/folders.ts, shared by Plus and Pro).
  { icon: 'highlighter',       label: 'Highlights, Notes, Bookmarks & Folders (up to 3)' },
  // Gating audit, 2026-08-22: DailyWord (account.tsx, dictionary/index.tsx,
  // notifications.ts) is gated hasPlusAccess -- a real, shipped daily
  // notification toggle that was missing from every tier list here,
  // same gap already found and fixed once for MagicLink/Ask FlyRegs/
  // aircraft-sharing above.
  { icon: 'text.book.closed',  label: 'Word of the Day — a new Aviation Dictionary term every day' },
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
  { icon: 'list.bullet',       label: 'Mnemonics — memory aids for checkride prep' },
  // RC, 2026-08-14 (first message): "back up and sync... doesn't show on
  // any of the paywalls" -- reworded to lead with the toggle's own real
  // name (notes.tsx/saved.tsx's literal "Back up & sync" label) so a reader
  // who knows the toggle by name has something to visually match it to.
  // Ninth-round correction (same day, second message, see above): this line
  // originally described the whole feature ("...Highlights, Notes,
  // Bookmarks & Folders (up to 3)") because the eighth round had wrongly
  // moved base creation here too. Only the sync capability itself belongs
  // in PRO_ADDITIONS now -- the base feature moved back to PLUS_FEATURES.
  { icon: 'icloud',    label: 'Back up & sync — access your Highlights, Notes, Bookmarks & Folders across devices' },
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
  { icon: 'trophy',            label: 'Duels — challenge other players to a reg quiz' },
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
  const { tier: paramTier, intent } = useLocalSearchParams<{ tier?: string; intent?: string }>()

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
  // RC gating audit, 2026-08-22, P2-4 (part 2): upgradeMode used to omit
  // 'pro' from availableTiers entirely -- Premium is still the intended
  // DEFAULT tab (defaultTier below is unchanged), but a Pro subscriber
  // genuinely has no other in-app path to switch their OWN Pro plan's
  // billing period if 'pro' was never even a selectable tab.
  const availableTiers: Tier[] = premiumRequired
    ? ['premium']
    : upgradeMode
    ? ['pro', 'premium']
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
    // Real bug, RC real-device report 2026-08-21 (Adrienne, via email):
    // "trying to downgrade from premium to pro and it won't even let her
    // click on the button." Root cause: this used to default to 'premium'
    // -- the tier already owned -- so the very first thing a Premium
    // subscriber saw on landing here (via manage-subscription.tsx's own
    // "Change Plan" row) was the big, primary CTA disabled and relabeled
    // "Current Plan" (viewingCurrentPlan below, which the CTA's own
    // `disabled` prop reads directly). The ONLY way to reach the actually
    // actionable "Downgrade to Pro" state was to first notice and tap the
    // small "Pro" tab in the tier-picker row above -- a secondary control
    // that never says "downgrade" anywhere on it. A real user tapping the
    // obvious, prominent, colored button and getting nothing (Pressable
    // with disabled=true doesn't fire onPress at all, no visual feedback
    // either beyond a slightly dimmed 0.6 opacity) is exactly "won't even
    // let me click on it." 'pro' is the only real, purchasable choice in
    // downgrade mode anyway -- default straight to it so the CTA is live
    // the moment this screen opens; tapping back to the "Premium" tab
    // still correctly shows the disabled "Current Plan" state for anyone
    // who wants to review what they already have first.
    //
    // RC gating audit, 2026-08-22: that default is wrong for a DIFFERENT
    // caller with the opposite intent -- AircraftDowngradeGate's own "Stay
    // with Premium" button also lands here with tier=premium (same param
    // this branch otherwise ignores), and got the same "downgrade to Pro
    // is the primary button" default, on a screen the user opened
    // specifically to confirm they're staying. intent=stay is the signal
    // that call site sets to ask for the actual tier param to be honored
    // instead of overridden.
    ? (intent === 'stay' && paramTier === 'premium' ? 'premium' : 'pro')
    : paramTier === 'pro' && availableTiers.includes('pro')
    ? 'pro'
    : paramTier === 'plus' && availableTiers.includes('plus')
    ? 'plus'
    : availableTiers[0]

  const [tier, setTier] = useState<Tier>(defaultTier)
  const [plan, setPlan] = useState<Plan>('annual')
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  // RC gating audit, 2026-08-22, P2-4: viewingCurrentPlan below used to key
  // ONLY on tier, so a Premium-monthly (or Pro-monthly) subscriber picking
  // their OWN tier to switch to annual instead got a hard-disabled "Current
  // Plan" button -- there was no in-app way to change billing period at
  // all, the same "obvious button does nothing" shape as the downgrade-
  // button bug fixed in 9542444. Needs the real current period, not just
  // the tier, to tell "already exactly this" apart from "same tier,
  // different period -- a real, purchasable change."
  const [currentPeriod, setCurrentPeriod] = useState<'monthly' | 'annual' | null>(null)
  // Real renewal date for the deferred-crossgrade messaging below -- RC,
  // 2026-08-23: confirmed live against Apple/RevenueCat's own documented
  // behavior that a same-tier monthly<->annual switch is a "crossgrade"
  // deferred to the CURRENT period's end (different durations never take
  // effect immediately, unlike a real tier upgrade) -- fair to the
  // subscriber (no lost paid days, no double charge) but silently wrong to
  // say nothing about, since the CTA used to read like an instant switch.
  const [currentExpiration, setCurrentExpiration] = useState<string | null>(null)
  useEffect(() => {
    getSubscriptionDetails().then((d) => { setCurrentPeriod(d.plan); setCurrentExpiration(d.expirationDate) })
  }, [])

  // isPro/isPremium/isUnlocked load asynchronously in AuthProvider — all still
  // false on this screen's first render for a real subscriber, so the tier
  // useState above locks in a guess before the real status arrives. Re-sync
  // once it does so the pricing/picker shown always matches reality.
  useEffect(() => {
    setTier(defaultTier)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, downgradeMode, hasPlusAccess])

  // Viewing the tier already owned (Premium subscriber on the Premium tab,
  // or Pro subscriber on the Pro tab) means looking at the current plan --
  // but only truly "nothing to buy" if the billing PERIOD also matches.
  // RC gating audit, 2026-08-22, P2-4: this used to key on tier alone, so
  // picking your own tier specifically to switch monthly<->annual got the
  // same disabled "Current Plan" button as picking a tier you don't own at
  // all -- there was no way to tell "already exactly this" apart from
  // "same tier, different period, a real purchase" until currentPeriod
  // (fetched above) made that distinction possible.
  const viewingOwnTier = (downgradeMode && tier === 'premium') || (upgradeMode && tier === 'pro')
  const viewingCurrentPlan = viewingOwnTier && (currentPeriod === null || plan === currentPeriod)
  // Same tier, different period -- a genuine billing-period switch, not a
  // tier change. RevenueCat treats this as an ordinary purchase of the
  // other period's product; confirmSubscribe() below doesn't need to know
  // the difference, only the label and confirm-copy do.
  const switchingPeriod = viewingOwnTier && !viewingCurrentPlan
  // Same format manage-subscription.tsx already uses for this exact date.
  const switchDateLabel = currentExpiration
    ? new Date(currentExpiration).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null

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
    // Checked before the generic downgradeMode/upgradeMode labels below --
    // otherwise switching your OWN tier's billing period read as
    // "Downgrade to Pro" or "Upgrade to Premium," which is wrong (no tier
    // is actually changing).
    : switchingPeriod
    ? `Switch to ${plan === 'annual' ? 'Annual' : 'Monthly'}`
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
      confirm({ title: 'Available on iOS', message: 'Download the FlyRegs iOS app to subscribe.', cancelLabel: null })
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
      // RC, 2026-08-22: "if a user DOES downgrade Prem>Pro, and have
      // multiple a/c, they must be notified first that they need to pick
      // only one a/c to take with them to Pro." AircraftDowngradeGate
      // already handles the actual choice AFTER the downgrade takes
      // effect (it has to -- Apple's own billing-period-end timing means
      // this purchase doesn't demote the account immediately), but this
      // is the one moment before the fact where the app can say it out
      // loud, while there's still a real choice to make.
      let aircraftCount = 0
      try {
        aircraftCount = (await getOwnedAircraftOldestFirst()).length
      } catch { /* best-effort -- don't block the downgrade on this lookup failing */ }
      const aircraftNote = aircraftCount > 1
        ? ` Pro only keeps 1 saved aircraft — you'll be asked to choose which of your ${aircraftCount} to keep; the rest, and their equipment/reminders/AD history, will be permanently deleted.`
        : ''
      confirm({
        title: 'Downgrade to Pro?',
        message: `You'll keep Premium features (shared folders, aircraft sharing, offline downloads, unlimited aircraft) until your current billing period ends, then move to Pro automatically. No refund for the time remaining.${aircraftNote}`,
        confirmLabel: 'Downgrade',
        destructive: true,
        finalTitle: 'Downgrade to Pro — confirm',
        onConfirm: () => confirmSubscribe(),
      })
      return
    }
    if (switchingPeriod) {
      // RC, 2026-08-23: confirmed against Apple/RevenueCat's own documented
      // behavior -- a same-tier monthly<->annual switch is a "crossgrade,"
      // and because the two periods have different durations it is ALWAYS
      // deferred to the current period's end, never immediate, regardless
      // of direction. Said out loud here, with the real date, before the
      // purchase sheet opens -- not just left to the post-purchase ack
      // below, since RC wants this known "at the time they make the
      // change," not only after.
      const whenLabel = switchDateLabel ? ` on ${switchDateLabel}` : ' at the end of your current billing period'
      confirm({
        title: `Switch to ${plan === 'annual' ? 'Annual' : 'Monthly'}?`,
        message: `You'll keep your current ${currentPeriod ?? 'plan'} billing until it renews${whenLabel} -- no charge today. From then on you'll be billed ${plan === 'annual' ? 'annually' : 'monthly'} at the ${plan === 'annual' ? 'annual' : 'monthly'} rate instead. Your tier and access don't change at all during this.`,
        confirmLabel: 'Switch',
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
      // RC gating audit, 2026-08-22, P2-5: a Premium->Pro downgrade
      // purchase is a real StoreKit "deferred downgrade" -- it succeeds,
      // but status.isPremium stays true until the current billing period
      // actually ends, so every visible piece of app state looks exactly
      // like it did before the tap. The sheet used to just silently
      // dismiss here -- someone who just tapped through a destructive,
      // two-step confirm got zero acknowledgment that anything happened,
      // a real "did that work?" moment and a plausible source of a repeat
      // tap or a support ticket.
      if (downgradeMode && tier === 'pro') {
        confirm({
          title: 'Downgrade Scheduled',
          message: "You'll keep Premium until your current billing period ends, then move to Pro automatically. You can change your mind any time before then from Manage Subscription.",
          cancelLabel: null,
          onConfirm: () => router.dismiss(),
        })
        return
      }
      // 2026-08-23: switchingPeriod is the SAME deferred-timing shape as
      // the downgrade above (a real, same-duration-mismatched crossgrade,
      // confirmed against Apple/RevenueCat's own docs -- never immediate),
      // so it needs the identical post-purchase acknowledgment, not just
      // the pre-purchase confirm in handleSubscribe above. tier/plan state
      // here still reads the OLD period until the real switch lands.
      if (switchingPeriod) {
        const whenLabel = switchDateLabel ? ` on ${switchDateLabel}` : ' at the end of your current billing period'
        confirm({
          title: 'Switch Scheduled',
          message: `You'll keep ${currentPeriod ?? 'your current'} billing until it renews${whenLabel}, then switch to ${plan === 'annual' ? 'annual' : 'monthly'} automatically. You can change your mind any time before then from Manage Subscription.`,
          cancelLabel: null,
          onConfirm: () => router.dismiss(),
        })
        return
      }
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
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
                Upgrade to Premium to unlock this — plus shared folders, aircraft sharing, offline downloads, and unlimited aircraft.
              </Text>
            </>
          ) : proRequired ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>This is a Pro feature</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
                Upgrade to Pro to unlock this — plus sync, AD alerts, and Study Mode.
              </Text>
            </>
          ) : upgradeMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>Take FlyRegs further</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
                Add shared folders, aircraft sharing, offline downloads, and unlimited saved aircraft to your Pro subscription.
              </Text>
            </>
          ) : downgradeMode ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>
                {viewingCurrentPlan ? 'Your current plan' : 'Switch to Pro'}
              </Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
                {viewingCurrentPlan
                  ? 'You\'re on Premium. Select Pro below to see what changes if you switch down.'
                  : 'You\'ll keep Premium features until your current billing period ends, then move to Pro automatically.'}
              </Text>
            </>
          ) : hasPlusAccess ? (
            <>
              <Text style={[styles.headline, { color: tokens.t1, fontSize: fs(20) }]}>Take FlyRegs further</Text>
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
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
              <Text style={[styles.sub, { color: tokens.t3, fontSize: fs(14), lineHeight: fs(14) * 1.43 }]}>
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

        {/* Deferred-crossgrade note -- RC, 2026-08-23: "we need to make sure
            this is reported to the end user... at the time they make the
            change, so they know what to expect." Shown on-screen BEFORE the
            tap (the confirm dialogs in handleSubscribe/confirmSubscribe say
            the same thing at the moment of and right after the purchase --
            this is the version visible the whole time the button is). Real
            date when known; falls back to generic "your current billing
            period" wording on the rare render where currentExpiration
            hasn't loaded yet. */}
        {switchingPeriod && (
          <Text style={[styles.switchNote, { color: tokens.t3, fontSize: fs(12.5), lineHeight: fs(12.5) * 1.36 }]}>
            {`Takes effect ${switchDateLabel ? `on ${switchDateLabel}` : 'at the end of your current billing period'} — no charge today, and your plan and access stay exactly the same until then.`}
          </Text>
        )}

        {/* Restore */}
        <Pressable
          style={styles.restoreRow}
          disabled={restoring}
          onPress={async () => {
            // Missing here until the 2026-08-29 "built but inert" sweep --
            // every OTHER restorePurchases()/purchase call site in the app
            // (account.tsx, Drawer.tsx, manage-subscription.tsx, and this
            // same screen's own handleSubscribe above) already guards on
            // Platform.OS === 'web' first, since restorePurchases() isn't
            // exported by revenuecat.web.ts at all -- this one threw
            // instead, landing on the generic "Error / Could not restore
            // purchases" dialog below rather than the correct messaging.
            if (Platform.OS === 'web') {
              confirm({ title: 'Available on iOS', message: 'Restore purchases from the FlyRegs iOS app.', cancelLabel: null })
              return
            }
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
            // restorePurchases() (revenuecat.ts) swallows every error from
            // Purchases.restorePurchases() and returns a plain "no
            // entitlement" status instead of throwing -- RevenueCat's native
            // SDK rejects a SECOND concurrent restore call while one is
            // already in flight (single global in-flight slot, same shape as
            // the printReg.ts double-tap bug), and without a guard here that
            // rejection surfaced as a false "No purchases found" for a real,
            // paying subscriber whenever the failed call's state update won
            // the race against the succeeding one. Code-traced, not a Sentry
            // report -- this failure mode returns a status object instead of
            // throwing, so it wouldn't generate a Sentry event even if it
            // fired on a real device. 2026-08-18 bug sweep.
            if (restoring) return
            setRestoring(true)
            try {
              const status = await restorePurchases()
              setIsPro(status.isPro)
              setIsPremium(status.isPremium)
              setIsUnlocked(status.isUnlocked)
              if (status.isPro || status.isPremium || status.isUnlocked) router.dismiss()
              else confirm({ title: 'No purchases found', message: 'No active purchases found for this Apple ID.', cancelLabel: null })
            } catch (err: any) {
              confirm({ title: 'Error', message: err?.message ?? 'Could not restore purchases.', cancelLabel: null })
            } finally {
              setRestoring(false)
            }
          }}
        >
          {restoring ? (
            <ActivityIndicator size="small" color={tokens.t4} />
          ) : (
            <Text style={[styles.restoreText, { color: tokens.t4, fontSize: fs(13) }]}>Restore Purchases</Text>
          )}
        </Pressable>

        <Text style={[styles.legal, { color: tokens.t4, fontSize: fs(11), lineHeight: fs(11) * 1.45 }]}>
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
  // lineHeight NOT set here -- always overridden inline with fs(14) * 1.43
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  sub: { fontSize: 14, textAlign: 'center', maxWidth: 300 },

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

  // lineHeight NOT set here -- always overridden inline with fs(12.5) * 1.36
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  switchNote: { textAlign: 'center', marginTop: 10, marginHorizontal: 12 },

  restoreRow: { alignItems: 'center', paddingVertical: 4 },
  restoreText: { fontSize: 13 },
  // lineHeight NOT set here -- always overridden inline with fs(11) * 1.45
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  legal: { fontSize: 11, textAlign: 'center' },
})
