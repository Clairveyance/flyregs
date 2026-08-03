import { useState } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  LayoutAnimation,
  Platform,
  UIManager,
  Linking,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useReturnToMenu } from '@/context/drawer'
import { useFS } from '@/context/fontScale'
import { OverlayHeader } from '@/components/ScreenHeader'
import { Icon } from '@/components/Icon'
import { SUPPORT_EMAIL, APP_NAME } from '@/lib/appInfo'
import { getBadgeStyle, BadgeKind } from '@/lib/acBadge'
import { TierChip, type Tier } from '@/components/TierChip'

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

interface QA {
  q: string
  category: string
  /** Each entry renders as its own paragraph (or, prefixed with "• ", its
   * own bullet line) — long-format answers used to be a single dense string
   * with no visual breaks at all. A `{ badge, text }` entry renders the
   * actual colored NEW/UPD/VER pill (matching getBadgeStyle exactly) instead
   * of just spelling the word out, for the badges question specifically. A
   * `{ tier, text }` entry renders the same colored PRO/PREMIUM/PLUS chip
   * used everywhere else in the app (Drawer's account pill, the paywall)
   * instead of spelling the tier name out as plain text -- confirmed live,
   * RC: "when we mention any tier in the FAQ, let's use the actual colored
   * chips for those tiers to help them stand out." */
  a: (string | { badge: BadgeKind; text: string } | { tier: Tier; text: string })[]
}

// Section order for the grouped FAQ -- flat 17-question list became hard to
// scan as it grew, and had real gaps (nothing explained FAR/AIM/P/CG,
// SmartSearch, MagicLink, Study Mode itself, Duels, Parts Lookup, or
// Folders/Sharing, despite all being real shipped features). RC, live:
// "i think we'll need to add more FAQs. and we might want to section and
// categorize the FAQ page."
const CATEGORY_ORDER = [
  'Getting Started',
  'The Content Library',
  'Search',
  'Study Mode, Duels & Coins',
  'My Aircraft & RefPacks',
  'Notes, Folders & Highlights',
  'Subscriptions & Sync',
]

const FAQ: QA[] = [
  {
    q: 'What does FlyRegs cover?',
    category: 'Getting Started',
    a: [
      'Five FAA source libraries in one app: the Federal Aviation Regulations (FAR), the Aeronautical Information Manual (AIM), the Pilot/Controller Glossary (P/CG), Advisory Circulars (ACs), and Airworthiness Directives (ADs) — all kept current from the FAA\'s own published text.',
      'Every one of them is cross-referenced together (see "What is MagicLink?" below), so a regulation, its related AIM guidance, its glossary terms, and any AC or AD that touches it are all reachable from wherever you\'re reading.',
    ],
  },
  {
    q: 'What is an Advisory Circular?',
    category: 'Getting Started',
    a: ['Advisory Circulars (ACs) are documents the FAA publishes to provide guidance and accepted means of compliance with the federal aviation regulations. They are not regulations themselves, but they explain how to meet them.'],
  },
  {
    q: 'Are the documents official?',
    category: 'Getting Started',
    a: [
      `${APP_NAME} presents the FAA's published text and PDFs, which are in the public domain. We organize and index them for fast reference, but we do not alter the official content.`,
      'Always confirm currency against faa.gov before relying on any document operationally.',
    ],
  },
  {
    q: 'Do I need an account?',
    category: 'Getting Started',
    a: [
      'No — browsing the entire library and searching to find an AC are both free, with no account needed, and no limit on how many you can look up. Every AC\'s detail page shows its full Table of Contents plus the beginning of its text for free.',
      { tier: 'pro', text: 'The complete text of every AC, in-document search, bookmarks, notes, and folders.' },
      { tier: 'premium', text: 'Everything in Pro, plus cloud sync, sharing, offline downloads, and update alerts.' },
      'An account is only required when you start a subscription — creating one is free and doesn\'t unlock anything by itself.',
    ],
  },
  {
    q: 'How often is the library updated?',
    category: 'The Content Library',
    a: [
      'We check the FAA for new and revised content every week, so the library stays current automatically — no need to manually refresh or check faa.gov yourself.',
      'The "What\'s New" feed on the Home screen shows everything issued or updated in the last 90 days by default (adjustable — see the next question).',
    ],
  },
  {
    q: 'What do the NEW, UPD, and VER badges mean?',
    category: 'The Content Library',
    a: [
      { badge: 'new', text: 'an AC issued recently.' },
      { badge: 'upd', text: 'the same AC number revised in place, with real changes you can jump between inside the document.' },
      { badge: 'ver', text: 'an AC that moved to a new letter version (for example 20-136B → 20-136C), replacing the prior version rather than editing it in place.' },
      'All three roll off automatically after 90 days by default — set Badge Duration in the menu to 14, 30, 90, or 180 days instead if you want them (and the Home "What\'s New" feed) to move faster or slower.',
    ],
  },
  {
    q: 'How does search work?',
    category: 'Search',
    a: ['Search runs across FAR, AIM, P/CG, AC, and AD numbers, titles, and document text. Type a number like "91-74" or "91.155", or a topic like "icing" or "fatigue" — results rank by relevance.'],
  },
  {
    q: 'What is SmartSearch?',
    category: 'Search',
    a: [
      'Everyday-language search expansion: FAA text uses precise regulatory wording ("fuel," "parachute operations") that rarely matches how you\'d actually phrase a search ("gas," "skydiving"). SmartSearch bridges common words to the FAA terms that actually appear in the corpus, then pulls in related regulatory terms found in similar contexts, automatically.',
      'You don\'t turn it on — it runs on every search. If a query looks expanded, results may include near-miss matches on top of exact ones.',
    ],
  },
  {
    q: 'What is MagicLink?',
    category: 'Search',
    a: [
      'An automatic cross-reference panel that appears on FAR, AIM, P/CG, AC, and AD pages, surfacing the related terms, regulations, citations, and Letters of Interpretation (LOIs) connected to whatever you\'re reading — so you don\'t have to go search for them yourself.',
      'Tap the MagicLink pod to expand its categories. Counts are visible to everyone.',
      { tier: 'plus', text: 'Actually opening a linked item from the pod requires this — the entry-level tier, not a full subscription.' },
    ],
  },
  {
    q: 'What is Study Mode?',
    category: 'Study Mode, Duels & Coins',
    a: [
      'Flashcard practice pulled from P/CG terms, FAR sections, AIM (real content questions, not paragraph-number trivia), and AC descriptions. Filter by content type, knowledge level (student through CFI/mechanic), and category/class, and set how many cards a session pulls.',
      'Each session draws a fresh random batch, so starting a new session doesn\'t just replay the same cards in the same order.',
    ],
  },
  {
    q: 'How does Overall Mastery work, and how do I increase it?',
    category: 'Study Mode, Duels & Coins',
    a: [
      'An item counts as "mastered" once you\'ve answered it correctly 2 times IN A ROW — missing it resets that item back to zero, so it has to be 2 consecutive correct reviews, not 2 total. The percentage shown is mastered items ÷ the full library (not just what\'s in your current filter), so it grows slowly by design.',
      'Study Mode uses spaced repetition: once you get an item right, it won\'t come back up for review again for a while, and that gap grows longer each additional time you get it right in a row. So the fastest way to move the number is steady, repeated correct reviews over multiple sessions — not cramming the same session over and over in one sitting.',
    ],
  },
  {
    q: 'What are Challenge Coins?',
    category: 'Study Mode, Duels & Coins',
    a: [
      'App-verified achievement badges for real study activity — study streaks, P/CG mastery milestones, and Duel wins. Unlike your self-reported ratings, coins are only ever awarded automatically off data FlyRegs already tracks.',
      'Tap any coin (My Account → Challenge Coins) to see exactly what unlocks it, whether you\'ve earned it yet or not. Coins get more ornamented the higher the tier — bronze, silver, and gold versions of the same coin are visually distinct, not just recolored.',
    ],
  },
  {
    q: 'What are Duels?',
    category: 'Study Mode, Duels & Coins',
    a: [
      'A head-to-head multiple-choice quiz against another FlyRegs user, drawing questions from FAR, AIM, P/CG, and AC content. Challenge someone from Community, and you\'ll each get notified when it\'s your turn to answer.',
      'Wins build toward Duel-specific Challenge Coins, and the Ready Room shows a leaderboard of top Duel performance.',
    ],
  },
  {
    q: 'What is My Aircraft, and how do AD reminders work?',
    category: 'My Aircraft & RefPacks',
    a: [
      'My Aircraft (My Account → Airworthiness Directives) lets you save the aircraft you fly by make and model, so FlyRegs can match new and revised Airworthiness Directives (ADs) against just the ones that actually apply to you — not the full corpus of thousands.',
      'AD applicability text is written against the FAA\'s official type designator (e.g. "PA-28-181"), not always the marketing name you\'d know your plane by (e.g. "Warrior") — there\'s an optional Type Designator field on each saved aircraft for this, auto-suggested for common models, so matching stays accurate either way.',
      { tier: 'premium', text: 'Adds equipment tags for specific parts, engines, or avionics installed on your aircraft (more precise AD matching than make/model alone), plus reminders you set yourself for recurring compliance items — an inspection interval, a life-limited part — that alert you when one comes due.' },
      { tier: 'pro', text: '1 saved aircraft.' },
      { tier: 'premium', text: 'Unlimited aircraft, plus equipment tags and reminders.' },
    ],
  },
  {
    q: 'Can I search for a specific part — an engine, prop, or avionics box?',
    category: 'My Aircraft & RefPacks',
    a: [
      { tier: 'pro', text: 'Parts Lookup searches a catalog of parts actually named in real AD applicability text, independent of any aircraft you\'ve saved. If a search for a common shop term comes back empty (the catalog is bounded to what\'s genuinely named in an AD, not a universal parts database), it falls back to showing the closest matching category instead of a dead end.' },
      { tier: 'premium', text: 'Tagging a specific part to one of your saved aircraft (so AD alerts catch part-keyed ADs too, not just airframe ones) — see My Aircraft above.' },
    ],
  },
  {
    q: 'What are RefPacks?',
    category: 'My Aircraft & RefPacks',
    a: [
      'RefPacks are certificate and rating study guides built directly from the FAA\'s own Airman Certification Standards (ACS) and Practical Test Standards (PTS) — the same documents your practical test is actually based on — broken into Areas of Operation, Tasks, and each Task\'s Knowledge, Risk Management, and Skill elements.',
      'Every element is tappable: it runs a search across FAR, AIM, P/CG, and AC for that specific topic and shows the real regulatory text, instead of leaving you to go find it yourself. A Task\'s "Related Regulations" box also auto-searches on the Task\'s own title the moment you open it.',
      'Find RefPacks under Community → RefPacks, organized by aircraft category (Airplane, Rotorcraft, Powered-Lift) and, within each, by rating/certificate — Private, Commercial, ATP, Flight Instructor, Aviation Mechanic, and more.',
    ],
  },
  {
    q: 'How do notes and auto-linking work?',
    category: 'Notes, Folders & Highlights',
    a: ['Open the Notes tab and tap + New. When you type an AC number like "61-65" or "91-74B" in a note, it is detected automatically and turned into a tappable chip that opens the current version of that AC. No suffix required.'],
  },
  {
    q: 'What are folders, and how does sharing work?',
    category: 'Notes, Folders & Highlights',
    a: [
      { tier: 'pro', text: 'Folders let you organize bookmarks into your own custom collections instead of one flat Saved list — a folder per course, per aircraft, per certificate you\'re working on.' },
      { tier: 'premium', text: 'Sharing a folder gives everyone with access the same folder, kept in sync — useful for a flight school, maintenance shop, or study group working from the same set of references. Recipients see a read-only copy that updates as the owner adds or removes items.' },
    ],
  },
  {
    q: 'How does highlighting work?',
    category: 'Notes, Folders & Highlights',
    a: [
      { tier: 'pro', text: 'Long-press any paragraph or section to highlight it in yellow — it\'s saved instantly to your Saved list, no extra confirmation needed. Long-press the same spot again to remove it.' },
      'Tap a highlight from Saved and the AC opens scrolled straight to that spot instead of the top of the document.',
    ],
  },
  {
    q: 'What happens to a highlight if the AC is later updated?',
    category: 'Notes, Folders & Highlights',
    a: [
      'Your highlight stays in Saved either way, but if the FAA revises the exact section you highlighted, the highlight can no longer point to a specific spot in the new text — opening it from Saved will land you at the top of the document instead of jumping to that section.',
      'Saved rows affected by this show a "Section changed" note. Nothing is deleted; you can always remove the highlight yourself if it\'s no longer useful.',
    ],
  },
  {
    q: 'What does a subscription unlock?',
    category: 'Subscriptions & Sync',
    a: [
      { tier: 'pro', text: 'Everything in Plus (full text access, highlighting, Parts Lookup, MagicLink navigation, RefPacks), plus cross-device sync, AD alerts, AC update alerts, 1 saved aircraft, and Community (Study Mode, Duels, Challenge Coins).' },
      { tier: 'premium', text: 'Everything in Pro, plus cloud backup and sync across devices, shared folders for teams, flight schools, and maintenance shops, offline downloads, unlimited saved aircraft with equipment tags and reminders, and update alerts.' },
    ],
  },
  {
    q: 'What\'s the difference between Back up & sync and Offline?',
    category: 'Subscriptions & Sync',
    a: [
      'These are two separate paid features that solve different problems:',
      { tier: 'pro', text: 'Back up & sync — mirrors your bookmarks, folders, and notes to the cloud, so they follow your account to a new phone, a second device (like a tablet), or survive a reinstall instead of living only on this one device. It\'s off by default; turn it on in Saved.' },
      { tier: 'premium', text: 'Offline — downloads the actual AC content to your device so you can open and read it with no internet connection at all (a flight, a hangar with no signal). This works independent of Back up & sync — offline downloads stay on your device either way.' },
      'Sharing a folder doesn\'t require Back up & sync to be on — a shared folder reaches your collaborators on its own, while the rest of your library stays exactly as local-only as you\'ve set it.',
    ],
  },
  {
    q: 'What is AC Update Alerts?',
    category: 'Subscriptions & Sync',
    a: [
      { tier: 'pro', text: 'A notification setting (My Account → Notifications) that sends a push notification whenever an Advisory Circular is issued or revised, so you find out the moment something changes instead of only seeing it on your next visit to the Home "What\'s New" feed.' },
      'This is specifically about ACs. Airworthiness Directive alerts are a separate, related feature — see "What is My Aircraft, and how do AD reminders work?" above. AD alerts matter most for aircraft owners and operators, and there\'s no separate on/off switch for them in Notifications: they\'re automatic once you\'ve saved an aircraft and have push notifications enabled.',
    ],
  },
  {
    q: 'What is DailyReg?',
    category: 'Subscriptions & Sync',
    a: [{ tier: 'pro', text: 'A notification setting that sends one push notification a day surfacing a single FAR, AIM, P/CG, AD, or AC section — a low-effort way to keep something in front of you regularly, separate from actively studying or looking something up yourself.' }],
  },
  {
    q: 'What are Duel Alerts?',
    category: 'Subscriptions & Sync',
    a: [{ tier: 'pro', text: 'A notification setting that pushes a notification when someone challenges you to a Duel — FlyRegs\' head-to-head multiple-choice quiz across FAR, AIM, P/CG, and AC — or when a Duel you\'re in updates, so you don\'t have to keep checking Community to see if it\'s your turn.' }],
  },
  {
    q: 'How do I cancel?',
    category: 'Subscriptions & Sync',
    a: [
      'Subscriptions are managed by Apple or Google — there\'s no cancel toggle inside FlyRegs itself. Open your App Store or Google Play account settings to view or cancel. Your access continues until the end of the current billing period.',
      'Deleting your FlyRegs account does NOT cancel an active subscription — Apple/Google will keep billing you until you cancel it directly through the store, even if the account itself is gone. Cancel the subscription first if you\'re also deleting your account.',
    ],
  },
]

export default function FAQScreen() {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const fs = useFS()
  const [open, setOpen] = useState<number | null>(0)

  const toggle = (i: number) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut)
    setOpen((prev) => (prev === i ? null : i))
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Help & FAQ" onBack={backToMenu} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Text style={[styles.intro, { color: tokens.t2, fontSize: fs(14) }]}>
          Answers to common questions. Still stuck? Reach out and we'll help.
        </Text>

        {CATEGORY_ORDER.map((category) => {
          const items = FAQ
            .map((item, i) => ({ item, i }))
            .filter(({ item }) => item.category === category)
          if (items.length === 0) return null
          return (
            <View key={category} style={styles.categoryBlock}>
              <Text style={[styles.categoryLabel, { color: tokens.t3, fontSize: fs(11.5) }]}>
                {category.toUpperCase()}
              </Text>
              <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
                {items.map(({ item, i }, pos) => {
                  const expanded = open === i
                  return (
                    <View
                      key={i}
                      style={[
                        styles.item,
                        pos < items.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.bdr },
                      ]}
                    >
                      <Pressable style={styles.qRow} onPress={() => toggle(i)}>
                        <Text style={[styles.q, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.q}</Text>
                        <Icon
                          name={expanded ? 'chevron.up' : 'chevron.down'}
                          size={fs(15)}
                          color={tokens.t3}
                        />
                      </Pressable>
                      {expanded && (
                        <View style={styles.aWrap}>
                          {item.a.map((para, pi) => {
                            const spacing = pi < item.a.length - 1 ? styles.aSpacing : undefined
                            if (typeof para === 'object' && 'badge' in para) {
                              const badge = getBadgeStyle(para.badge, tokens)
                              return (
                                <View key={pi} style={[styles.badgeLine, spacing]}>
                                  <View style={[styles.badgePill, { backgroundColor: badge.background, borderColor: badge.border }]}>
                                    <Text style={[styles.badgePillText, { color: badge.color, fontSize: fs(9) }]}>{badge.label}</Text>
                                  </View>
                                  <Text style={[styles.a, { flex: 1, color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
                                    {para.text}
                                  </Text>
                                </View>
                              )
                            }
                            if (typeof para === 'object' && 'tier' in para) {
                              return (
                                <View key={pi} style={[styles.badgeLine, spacing]}>
                                  <TierChip tier={para.tier} />
                                  <Text style={[styles.a, { flex: 1, color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
                                    {para.text}
                                  </Text>
                                </View>
                              )
                            }
                            return (
                              <Text
                                key={pi}
                                style={[
                                  styles.a,
                                  spacing,
                                  { color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 },
                                ]}
                              >
                                {para}
                              </Text>
                            )
                          })}
                        </View>
                      )}
                    </View>
                  )
                })}
              </View>
            </View>
          )
        })}

        {/* Contact CTA */}
        <Pressable
          style={[styles.contactBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
          onPress={() =>
            Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} Support`)}`)
          }
        >
          <Icon name="envelope" size={fs(17)} color={tokens.blu} />
          <Text style={[styles.contactText, { color: tokens.blu, fontSize: fs(14.5) }]}>Email support</Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 14 },
  intro: { fontSize: 14, lineHeight: 21, paddingHorizontal: 2 },
  categoryBlock: { gap: 8 },
  categoryLabel: { fontWeight: '700', letterSpacing: 0.6, paddingHorizontal: 4 },
  card: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  item: { paddingHorizontal: 14 },
  qRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    gap: 12,
  },
  q: { flex: 1, fontSize: 14.5, fontWeight: '600', lineHeight: 20 },
  aWrap: { paddingBottom: 14, paddingRight: 8 },
  a: { fontSize: 14, lineHeight: 21 },
  aSpacing: { marginBottom: 10 },
  badgeLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  badgePill: { borderRadius: 5, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, marginTop: 1 },
  badgePillText: { fontWeight: '700', letterSpacing: 0.3 },
  contactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 13,
  },
  contactText: { fontSize: 14.5, fontWeight: '600' },
})
