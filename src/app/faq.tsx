import { useRef, useState } from 'react'
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
import { TierChip, inlineTierText, type Tier } from '@/components/TierChip'

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
   * chips for those tiers to help them stand out." When `text` itself
   * contains embedded "\n• " lines, each one renders as its own indented
   * sub-bullet under the chip's lead line instead of raw \n-joined text --
   * 2026-08-03 readability pass: the old rendering put a bullet glyph in
   * front of a wrapped multi-line string with no hanging indent, so a
   * wrapped line landed flush left under the bullet instead of under the
   * text above it. */
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
      'Seven libraries in one app. Six are FAA source material, kept current from the FAA\'s own published text:',
      '• Federal Aviation Regulations (FAR)',
      '• Aeronautical Information Manual (AIM)',
      '• Pilot/Controller Glossary (P/CG)',
      '• Advisory Circulars (ACs)',
      '• Airworthiness Directives (ADs)',
      '• Legal Interpretations (LOIs)',
      'Every one of them is cross-referenced together (see "What is MagicLink?" below), so a regulation, its related AIM guidance, its glossary terms, and any AC, AD, or LOI that touches it are all reachable from wherever you\'re reading.',
      'The seventh is the Aviation Dictionary — not FAA material itself, but a 9,800+ term reference (plus a curated collection of aviation mnemonics) that we built and keep current ourselves, so pilots have one place for both the official terminology and the everyday shorthand no government glossary covers. It\'s big and genuinely useful, which is why it gets its own answer below ("What is the Aviation Dictionary?") even though it\'s called out separately from the six FAA sources.',
      'Browsing and searching the six FAA libraries is free. What each plan adds on top:',
      '• FAR, AIM and the P/CG are free to read in full — those never sit behind a plan.',
      '• Complete AC and AD text is Plus.',
      '• Full Legal Interpretation letters are Pro.',
      '• The Aviation Dictionary itself is Plus; its Mnemonics are Pro.',
    ],
  },
  {
    q: 'What is an Advisory Circular?',
    category: 'Getting Started',
    a: ['Advisory Circulars (ACs) are documents the FAA publishes to provide guidance and accepted means of compliance with the federal aviation regulations. They are not regulations themselves, but they explain how to meet them.'],
  },
  {
    q: 'What are Legal Interpretations (LOIs)?',
    category: 'Getting Started',
    a: [
      'Letters the FAA\'s Office of the Chief Counsel sends in response to a specific question about how a regulation applies in practice — real answers to real edge cases, not general guidance like an AC. Each one is named after whoever requested it, not the topic, so full-text search is the fastest way to find one on a subject rather than browsing.',
      'Browse by year from the LOI tab, or find one connected to whatever you\'re reading via MagicLink.',
      { tier: 'pro', text: 'Opening the full text of a letter. Anyone can find an LOI and see its citation for free — reading it requires this.' },
    ],
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
      { tier: 'plus', text: 'A one-time purchase, not a subscription:\n• Complete text of every AC and AD\n• Aviation Dictionary, RefPacks & What\'s Changed\n• In-document search\n• Print & export any section' },
      { tier: 'pro', text: 'Everything in Plus, plus:\n• Notes, highlights, bookmarks & folders (up to 3), synced across devices\n• AD and AC update alerts, DailyReg\n• MagicLink, Ask FlyRegs & full Legal Interpretations\n• Dictionary Mnemonics, Study Mode, Challenge Coins & Ready Room\n• 1 saved aircraft, with your own reminders' },
      { tier: 'premium', text: 'Everything in Pro, plus:\n• Offline downloads\n• Shared folders, unlimited\n• Duels\n• Unlimited saved aircraft, with equipment tags & sharing' },
      'An account is only required when you start a subscription (Pro or Premium, either of which already includes everything Plus does) or make the one-time Plus purchase — creating an account by itself is free and doesn\'t unlock anything.',
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
      { badge: 'new', text: 'an AC, AD, or LOI issued recently.' },
      { badge: 'upd', text: 'the same AC number revised in place, with real changes you can jump between inside the document.' },
      { badge: 'ver', text: 'an AC that moved to a new letter version (for example 20-136B → 20-136C), replacing the prior version rather than editing it in place.' },
      'All three roll off automatically after 90 days by default — set Badge Duration in the menu to 14, 30, 90, or 180 days instead if you want them (and the Home "What\'s New" feed) to move faster or slower.',
    ],
  },
  {
    q: 'What is What\'s Changed?',
    category: 'The Content Library',
    a: [
      { tier: 'plus', text: 'A real, browsable history of exactly what changed in every revision across the library, grouped by date — not just a badge telling you something was updated.' },
      // Went stale when the Home label was shortened from "See changes" to
      // "All ›" -- the FAQ was still telling people to look for a link that
      // no longer says that.
      'Scroll the Home screen\'s What\'s New strip, or tap "All ›" above it, to see everything.',
    ],
  },
  {
    q: 'What is the Aviation Dictionary?',
    category: 'The Content Library',
    a: [
      'A 9,800+ term reference covering FAA contractions (radio/ATC shorthand like IMAIR or ALARM), handbook glossary terms, and informal terms pilots and mechanics actually use — separate from the official Pilot/Controller Glossary (P/CG), which only covers the FAA\'s own formal definitions.',
      { tier: 'plus', text: 'Browsing and searching the Dictionary.' },
      { tier: 'pro', text: 'The curated collection of aviation mnemonics inside the Dictionary (ARROW, GUMPS, the 5 Cs, and more), each one linked back to the regulation or concept it\'s actually grounded in.' },
    ],
  },
  {
    q: 'How does search work?',
    category: 'Search',
    a: [
      'Search runs across FAR, AIM, P/CG, AC, and AD numbers, titles, and document text. Type a number like "91-74" or "91.155", or a topic like "icing" or "fatigue" — results rank by relevance.',
      { tier: 'plus', text: 'Free shows the first 10 results from the Home search bar; this unlocks the full list.' },
      'There are two different search tools, and picking the right one matters:\n• Know the number or the term? Use the search bar. SmartSearch widens it automatically so everyday words still find FAA wording.\n• Have a question instead of a keyword? Use Ask FlyRegs (Pro), which matches on meaning rather than words.\n• Both are explained in their own answers below.',
    ],
  },
  {
    q: 'What is SmartSearch?',
    category: 'Search',
    a: [
      'Everyday-language search expansion: FAA text uses precise regulatory wording ("fuel," "parachute operations") that rarely matches how you\'d actually phrase a search ("gas," "skydiving"). SmartSearch bridges common words to the FAA terms that actually appear in the corpus, then pulls in related regulatory terms found in similar contexts, automatically.',
      'It runs on every search, free for everyone — there\'s nothing to turn on.',
      'It searches by WORD, though, which is worth knowing:\n• Give it keywords, not sentences. "minimum safe altitude congested" lands on § 91.119 immediately.\n• A full question works against you here. Every extra word ("how close to a house can I fly my plane") is one more word to match, and results drift.\n• For questions phrased the way you\'d actually say them, use Ask FlyRegs instead — see below.',
    ],
  },
  {
    q: 'What is MagicLink?',
    category: 'Search',
    a: [
      'An automatic cross-reference panel that appears on FAR, AIM, P/CG, AC, AD, and LOI pages, surfacing the related terms, regulations, citations, and Letters of Interpretation connected to whatever you\'re reading — so you don\'t have to go search for them yourself.',
      'Tap the MagicLink pod to expand its categories. Counts are visible to everyone.',
      { tier: 'pro', text: 'Actually opening a linked item from the pod requires this.' },
    ],
  },
  {
    q: 'What is Ask FlyRegs?',
    category: 'Search',
    a: [
      { tier: 'pro', text: 'A natural-language question box, separate from the regular search bar. Ask the way you\'d actually say it — "how much rest do I need before flying passengers?" — instead of guessing the regulatory wording, and it finds the passages on that subject across the whole library.' },
      'What it does that SmartSearch can\'t:\n• It matches MEANING, not words — so it can find the right passage even when your question shares no words at all with the regulation.\n• Ask "when do I have to file a NASA report" and it lands on the Aviation Safety Reporting Program. The FAA never calls it a "NASA report," so a word-based search structurally cannot find that; this does.\n• Full sentences help it rather than hurt it. Phrasing, context, and intent are all part of what it matches on.',
      'What it is not:\n• It finds passages — it doesn\'t write you an answer. You still read the reg and decide.\n• It can land in the right neighborhood but the wrong document. Ask about altitude over a house and it may surface drone rules alongside the manned-aircraft ones. Check the source on every result.\n• For a specific section or document number you already know, plain search is faster and exact.',
    ],
  },
  {
    q: 'What is Study Mode?',
    category: 'Study Mode, Duels & Coins',
    a: [
      { tier: 'pro', text: 'Flashcard practice pulled from P/CG terms, FAR sections, AIM (real content questions, not paragraph-number trivia), and AC descriptions. Filter by content type, knowledge level (student through CFI/mechanic), and category/class, and set how many cards a session pulls.' },
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
      'Each coin needs whatever tier its underlying activity needs — a Study Mode streak coin needs Pro, a Duel-win coin needs Premium.',
      'Tap any coin (My Account → Challenge Coins) to see exactly what unlocks it, whether you\'ve earned it yet or not. Coins get more ornamented the higher the tier — bronze, silver, and gold versions of the same coin are visually distinct, not just recolored.',
    ],
  },
  {
    q: 'What are Duels?',
    category: 'Study Mode, Duels & Coins',
    a: [
      { tier: 'premium', text: 'A multiple-choice quiz against up to 7 other FlyRegs users at once — a free-for-all, not just 1-on-1 — drawing questions from FAR, AIM, P/CG, and AC content. Challenge one or more people from The Wing, and you\'ll each get notified when it\'s your turn to answer.' },
      'Wins build toward Duel-specific Challenge Coins, and the Ready Room shows a leaderboard of top Duel performance (Ready Room itself just needs Pro to view).',
    ],
  },
  {
    q: 'Who can see my profile photo?',
    category: 'Study Mode, Duels & Coins',
    a: [
      'Only people you\'re actually connected with — someone who\'s joined a folder you\'ve shared, or a shared aircraft, in either direction. Everyone else, including anyone browsing the Ready Room leaderboard, sees your initials instead, never your real photo.',
      'This applies automatically, both directions, the moment an invite is accepted — nothing to turn on. Once you invite or accept a connection with someone, you\'ll see their real photo too, wherever their profile is shown.',
      'Duels opponents are a separate relationship for now (an invite to a match doesn\'t by itself unlock photo visibility) — something we may expand to later.',
    ],
  },
  {
    q: 'What is My Aircraft, and how do AD reminders work?',
    category: 'My Aircraft & RefPacks',
    a: [
      { tier: 'pro', text: 'Save the aircraft you fly by make and model (My Account → My Aircraft), so FlyRegs matches new and revised Airworthiness Directives (ADs) against just the ones that actually apply to you — not the full corpus of thousands. 1 saved aircraft, plus reminders you set yourself for recurring items (annuals, ELT battery, 100-hour, anything on your own schedule).' },
      'AD applicability text is written against the FAA\'s official type designator (e.g. "PA-28-181"), not always the marketing name you\'d know your plane by (e.g. "Warrior") — there\'s an optional Type Designator field for this, auto-suggested for common models, so matching stays accurate either way.',
      'Tap the icon on any Applicable AD to mark it complied, with an optional note — it stays visible with a green check and date instead of disappearing, so you keep a real record instead of a todo list that just empties out. (FlyRegs doesn\'t independently verify compliance — always keep your own maintenance records as the official source.)',
      { tier: 'premium', text: 'Unlimited saved aircraft (shown as My Fleet instead of My Aircraft). Adds equipment tags for specific parts, engines, or avionics — more precise AD matching than make/model alone — and sharing — see the next question.' },
      'Where the alerts go differs by plan:',
      '• Reminders you set yourself push to your device on Pro and Premium — it\'s your own schedule, so you get told.',
      '• AD alerts push on Premium only. On Pro, new and updated ADs still appear on your My Aircraft page whenever you open it — they just don\'t push to your phone.',
      'Saved aircraft live on our servers, which is why they need a paid plan:',
      '• Free and Plus — not included.',
      '• Pro — one saved aircraft.',
      '• Premium — unlimited, shown as My Fleet.',
      'Moving up from Pro to Premium brings your aircraft with you and lets you add more. Moving down from Premium to Pro, you pick which single aircraft comes with you — nothing is deleted until you choose, and the choice is yours to make on the My Aircraft screen.',
    ],
  },
  {
    q: 'Does FlyRegs replace my maintenance-tracking software?',
    category: 'My Aircraft & RefPacks',
    a: [
      'No. FlyRegs is a lightweight personal reference for owner/pilots — it\'s not a substitute for comprehensive, professional-grade maintenance and AD-tracking software used by maintenance shops and fleet operators.',
      'Use FlyRegs to stay informed and get reminders; keep your official maintenance records and compliance sign-offs wherever your mechanic or shop already tracks them.',
    ],
  },
  {
    q: 'Can I share an aircraft with someone else?',
    category: 'My Aircraft & RefPacks',
    a: [
      { tier: 'premium', text: 'Share an aircraft from its detail screen — pick Viewer (sees everything) or Editor (can also add equipment and reminders, and mark ADs complied) access, then send the real invite link that opens. Whoever taps it needs their own Premium account to actually join.' },
      'Collaborators show up on the aircraft with their role, so you always know who has access — useful for a flight school, maintenance shop, or any aircraft with more than one person tracking its compliance.',
      'AD alerts go to the whole team, not just the owner: when a new or updated AD matches a shared aircraft, everyone with access gets the push notification, the same one the owner would get on their own.',
    ],
  },
  {
    q: 'Can I search for a specific part — an engine, prop, or avionics box?',
    category: 'My Aircraft & RefPacks',
    a: [
      { tier: 'plus', text: 'Parts Lookup searches a catalog of parts actually named in real AD applicability text, independent of any aircraft you\'ve saved.' },
      'If a search for a common shop term comes back empty, that\'s because the catalog is bounded to what\'s genuinely named in an AD, not a universal parts database — it falls back to showing the closest matching category instead of a dead end.',
      { tier: 'premium', text: 'Tagging a specific part to one of your saved aircraft, so AD alerts catch part-keyed ADs too, not just airframe ones — see My Aircraft above.' },
    ],
  },
  {
    q: 'What are RefPacks?',
    category: 'My Aircraft & RefPacks',
    a: [
      { tier: 'plus', text: 'Certificate and rating study guides built directly from the FAA\'s own Airman Certification Standards (ACS) and Practical Test Standards (PTS) — the same documents your practical test is actually based on — broken into Areas of Operation, Tasks, and each Task\'s Knowledge, Risk Management, and Skill elements.' },
      'Every element is tappable: it runs a search across FAR, AIM, P/CG, and AC for that specific topic and shows the real regulatory text, instead of leaving you to go find it yourself. A Task\'s "Related Regulations" box also auto-searches on the Task\'s own title the moment you open it.',
      'Find RefPacks under The Wing → RefPacks, organized by aircraft category (Airplane, Rotorcraft, Powered-Lift) and, within each, by rating/certificate — Private, Commercial, ATP, Flight Instructor, Aviation Mechanic, and more.',
    ],
  },
  {
    q: 'How do notes and auto-linking work?',
    category: 'Notes, Folders & Highlights',
    a: [
      { tier: 'pro', text: 'Open the Notes tab and tap + New. When you type an AC number like "61-65" or "91-74B" in a note, it is detected automatically and turned into a tappable chip that opens the current version of that AC. No suffix required.' },
    ],
  },
  {
    q: 'What are folders, and how does sharing work?',
    category: 'Notes, Folders & Highlights',
    a: [
      { tier: 'pro', text: 'Folders let you organize bookmarks into your own custom collections instead of one flat Saved list — a folder per course, per aircraft, per certificate you\'re working on. Up to 3 folders.' },
      { tier: 'premium', text: 'Unlimited folders, plus sharing — giving everyone with access the same folder, kept in sync. Useful for a flight school, maintenance shop, or study group working from the same set of references. Recipients see a read-only copy that updates as the owner adds or removes items.' },
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
      'Plus is a one-time purchase, Pro and Premium are subscriptions — each one already includes everything the tier below it does, so you can subscribe straight to Pro or Premium and skip buying Plus first. See "Do I need an account?" above for exactly what each tier includes.',
      'The difference between Pro and Premium comes down to depth:',
      '• Pro is for actively using the library day to day — sync, alerts, MagicLink, Ask FlyRegs, Study Mode.',
      '• Premium is for managing more than just yourself — offline access, unlimited shared folders, Duels, and a full Fleet of aircraft instead of one.',
      'The practical dividing line is server cost on our end: anything where we store or share your data for you (backups, shared folders, a Fleet) sits at the tier that pays for that storage.',
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
    a: [{ tier: 'pro', text: 'A notification setting that pushes a notification when someone challenges you to a Duel — FlyRegs\' multiple-choice quiz against up to 7 other players across FAR, AIM, P/CG, and AC — or when a Duel you\'re in updates, so you don\'t have to keep checking The Wing to see if it\'s your turn.' }],
  },
  {
    q: 'How do I cancel?',
    category: 'Subscriptions & Sync',
    a: [
      'Subscriptions are managed by Apple or Google — there\'s no cancel toggle inside FlyRegs itself:',
      '• Open your App Store or Google Play account settings to view or cancel.',
      '• Your access continues until the end of the current billing period.',
      '• Plus is a one-time purchase, so there is nothing to cancel — it stays on your account.',
      'Deleting your FlyRegs account does NOT cancel an active subscription — Apple/Google will keep billing you until you cancel it directly through the store, even if the account itself is gone. Cancel the subscription first if you\'re also deleting your account.',
    ],
  },
]

export default function FAQScreen() {
  const { tokens } = useTheme()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()
  const fs = useFS()
  // RC: "leave everything closed by default. let the user open things."
  // This defaulted to index 0 (the first Getting Started question) open,
  // which meant a long answer was always the first thing on screen
  // whether the user asked for it or not.
  const [open, setOpen] = useState<number | null>(null)

  // Scroll the tapped question to the top of the viewport on expand -- RC,
  // live: clicking a question routinely landed with the viewport already
  // partway down the answer instead of at the question itself, since a long
  // answer expanding below a question that was only partly scrolled into
  // view left the reader looking at whatever was already on-screen (often
  // mid-answer), not the question that triggered it. Measuring in *page*
  // coordinates (item vs. the ScrollView itself) rather than summing layout
  // offsets works here because there's no keyboard in play to make the
  // ScrollView's own tracked offset go stale between the tap and the
  // measurement -- see ACBody.tsx's blockRelY comment for why that
  // simpler approach isn't safe everywhere, just why it's fine here.
  //
  // RC, round 2, still real: "the new one displays, but it's throwing the
  // new one way off the top of the screen, so you have to scroll way up
  // looking for it." Root cause wasn't the coordinate math above -- it was
  // WHEN it ran. .measure() fired synchronously right after setOpen(),
  // before this accordion's own LayoutAnimation had actually settled. If
  // the previously-open item sits ABOVE the one just tapped, its collapse
  // shifts everything below it upward once the animation finishes -- but
  // the measurement above raced that: it captured the tapped item's
  // position while the old item was still (visually) collapsing, i.e.
  // effectively its STILL-EXPANDED position, computing a scroll target
  // well past where the item actually ends up. The user lands scrolled too
  // far down, with the real (now higher-up) item off the TOP of the
  // viewport -- exactly the reported symptom. LayoutAnimation.configureNext
  // takes a completion callback specifically for this -- deferring the
  // whole measure+scroll into it guarantees both the collapse and the
  // expand have fully settled before anything gets measured, so the
  // coordinate math above (already correct) finally runs against the
  // REAL final layout instead of a mid-animation one.
  const scrollRef = useRef<ScrollView>(null)
  const itemRefs = useRef<Record<number, View | null>>({})
  const scrollOffsetRef = useRef(0)

  const toggle = (i: number) => {
    const opening = open !== i
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut, () => {
      if (!opening) return
      const item = itemRefs.current[i]
      // ScrollView's TS type doesn't expose the underlying host node's
      // .measure() (it's only declared on the ref's runtime NativeMethods,
      // same gap noted in ACBody.tsx's own measure()-based approach).
      const scrollNode = scrollRef.current as unknown as { measure: View['measure']; scrollTo: ScrollView['scrollTo'] } | null
      if (!item || !scrollNode) return
      item.measure((_x: number, _y: number, _w: number, _h: number, pageX: number, pageY: number) => {
        scrollNode.measure((_sx: number, _sy: number, _sw: number, _sh: number, _spageX: number, spageY: number) => {
          const targetY = scrollOffsetRef.current + (pageY - spageY) - 12
          scrollNode.scrollTo({ y: Math.max(0, targetY), animated: true })
        })
      })
    })
    setOpen((prev) => (prev === i ? null : i))
  }

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title="Help & FAQ" onBack={backToMenu} />
      <ScrollView
        ref={scrollRef}
        onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y }}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      >
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
                      ref={(r) => { itemRefs.current[i] = r }}
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
                              // Split "lead line\n• bullet\n• bullet" so
                              // each bullet gets its own hanging-indent row
                              // (matching top-level bullets below) instead
                              // of one Text block with raw \n characters --
                              // a wrapped bullet line used to fall flush
                              // left under the bullet glyph instead of
                              // lining up under the text above it.
                              const lines = para.text.split('\n')
                              const lead = lines[0]
                              const bullets = lines.slice(1).filter((l) => l.startsWith('• '))
                              return (
                                <View key={pi} style={spacing}>
                                  <View style={styles.badgeLine}>
                                    <TierChip tier={para.tier} />
                                    <Text style={[styles.a, { flex: 1, color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
                                      {inlineTierText(lead, tokens)}
                                    </Text>
                                  </View>
                                  {bullets.length > 0 && (
                                    <View style={styles.tierBulletList}>
                                      {bullets.map((b, bi) => (
                                        <View key={bi} style={styles.bulletLine}>
                                          <Text style={[styles.bulletDot, { color: tokens.t2, fontSize: fs(14) }]}>•</Text>
                                          <Text style={[styles.a, { flex: 1, color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
                                            {inlineTierText(b.slice(2), tokens)}
                                          </Text>
                                        </View>
                                      ))}
                                    </View>
                                  )}
                                </View>
                              )
                            }
                            // RC: "this still isn't bullet listed like i
                            // asked for." The interface comment above has
                            // promised "prefixed with '• ', its own bullet
                            // line" since this file was written, but
                            // nothing ever actually rendered that
                            // differently from a plain paragraph -- this is
                            // the first real implementation of it. Hanging
                            // indent (bullet in its own fixed-width column)
                            // so wrapped lines align under the text, not
                            // under the bullet glyph.
                            if (para.startsWith('• ')) {
                              return (
                                <View key={pi} style={[styles.bulletLine, spacing]}>
                                  <Text style={[styles.bulletDot, { color: tokens.t2, fontSize: fs(14) }]}>•</Text>
                                  <Text style={[styles.a, { flex: 1, color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>
                                    {inlineTierText(para.slice(2), tokens)}
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
                                {inlineTierText(para, tokens)}
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
  bulletLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bulletDot: { width: 10, lineHeight: 21 },
  tierBulletList: { marginTop: 6, marginLeft: 10, gap: 5 },
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
