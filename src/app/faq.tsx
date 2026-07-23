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

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

interface QA {
  q: string
  /** Each entry renders as its own paragraph (or, prefixed with "• ", its
   * own bullet line) — long-format answers used to be a single dense string
   * with no visual breaks at all. A `{ badge, text }` entry renders the
   * actual colored NEW/UPD/VER pill (matching getBadgeStyle exactly) instead
   * of just spelling the word out, for the badges question specifically. */
  a: (string | { badge: BadgeKind; text: string })[]
}

const FAQ: QA[] = [
  {
    q: 'What is an Advisory Circular?',
    a: ['Advisory Circulars (ACs) are documents the FAA publishes to provide guidance and accepted means of compliance with the federal aviation regulations. They are not regulations themselves, but they explain how to meet them.'],
  },
  {
    q: 'Are the documents official?',
    a: [
      `${APP_NAME} presents the FAA's published AC text and PDFs, which are in the public domain. We organize and index them for fast reference, but we do not alter the official content.`,
      'Always confirm currency against faa.gov before relying on any AC operationally.',
    ],
  },
  {
    q: 'How often is the library updated?',
    a: [
      'We check the FAA for new and revised ACs every week, so the library stays current automatically — no need to manually refresh or check faa.gov yourself.',
      'The "What\'s New" feed on the Home screen shows everything issued or updated in the last 90 days by default (adjustable — see the next question).',
    ],
  },
  {
    q: 'What do the NEW, UPD, and VER badges mean?',
    a: [
      { badge: 'new', text: 'an AC issued recently.' },
      { badge: 'upd', text: 'the same AC number revised in place, with real changes you can jump between inside the document.' },
      { badge: 'ver', text: 'an AC that moved to a new letter version (for example 20-136B → 20-136C), replacing the prior version rather than editing it in place.' },
      'All three roll off automatically after 90 days by default — set Badge Duration in the menu to 14, 30, 90, or 180 days instead if you want them (and the Home "What\'s New" feed) to move faster or slower.',
    ],
  },
  {
    q: 'How does search work?',
    a: ['Search runs across AC numbers, titles, and document text. Type an AC number like "91-74" or a topic like "icing" or "fatigue" — results rank by relevance.'],
  },
  {
    q: 'Do I need an account?',
    a: [
      'No — browsing the entire library and searching to find an AC are both free, with no account needed, and no limit on how many you can look up. Every AC\'s detail page shows its full Table of Contents plus the beginning of its text for free.',
      '• Pro — the complete text of every AC, in-document search, bookmarks, notes, and folders.',
      '• Premium — everything in Pro, plus cloud sync, sharing, offline downloads, and update alerts.',
      'An account is only required when you start a subscription — creating one is free and doesn\'t unlock anything by itself.',
    ],
  },
  {
    q: 'How do notes and auto-linking work?',
    a: ['Open the Notes tab and tap + New. When you type an AC number like "61-65" or "91-74B" in a note, it is detected automatically and turned into a tappable chip that opens the current version of that AC. No suffix required.'],
  },
  {
    q: 'What does a subscription unlock?',
    a: [
      '• Pro — full text access for every AC, in-document search, bookmarks, personal notes, custom folders, and highlighting key sections.',
      '• Premium — everything in Pro, plus cloud backup and sync across devices, shared folders for teams, flight schools, and maintenance shops, offline downloads, and alerts when ACs are published or updated.',
    ],
  },
  {
    q: 'How does highlighting work?',
    a: [
      'Long-press any paragraph or section (Pro required) to highlight it in yellow — it\'s saved instantly to your Saved list, no extra confirmation needed. Long-press the same spot again to remove it.',
      'Tap a highlight from Saved and the AC opens scrolled straight to that spot instead of the top of the document.',
    ],
  },
  {
    q: 'What happens to a highlight if the AC is later updated?',
    a: [
      'Your highlight stays in Saved either way, but if the FAA revises the exact section you highlighted, the highlight can no longer point to a specific spot in the new text — opening it from Saved will land you at the top of the document instead of jumping to that section.',
      'Saved rows affected by this show a "Section changed" note. Nothing is deleted; you can always remove the highlight yourself if it\'s no longer useful.',
    ],
  },
  {
    q: 'What\'s the difference between Back up & sync and Offline?',
    a: [
      'These are two separate Premium features that solve different problems:',
      '• Back up & sync — mirrors your bookmarks, folders, and notes to the cloud, so they follow your account to a new phone, a second device (like a tablet), or survive a reinstall instead of living only on this one device. It\'s off by default; turn it on in Saved.',
      '• Offline — downloads the actual AC content to your device so you can open and read it with no internet connection at all (a flight, a hangar with no signal). This works independent of Back up & sync — offline downloads stay on your device either way.',
      'Sharing a folder doesn\'t require Back up & sync to be on — a shared folder reaches your collaborators on its own, while the rest of your library stays exactly as local-only as you\'ve set it.',
    ],
  },
  {
    q: 'How do I cancel?',
    a: ['Subscriptions are managed by Apple or Google. Open your App Store or Google Play account settings to view or cancel. Your access continues until the end of the current billing period.'],
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

        <View style={[styles.card, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {FAQ.map((item, i) => {
            const expanded = open === i
            return (
              <View
                key={i}
                style={[
                  styles.item,
                  i < FAQ.length - 1 && { borderBottomWidth: 1, borderBottomColor: tokens.bdr },
                ]}
              >
                <Pressable style={styles.qRow} onPress={() => toggle(i)}>
                  <Text style={[styles.q, { color: tokens.t1, fontSize: fs(14.5) }]}>{item.q}</Text>
                  <Icon
                    name={expanded ? 'chevron.up' : 'chevron.down'}
                    size={15}
                    color={tokens.t3}
                  />
                </Pressable>
                {expanded && (
                  <View style={styles.aWrap}>
                    {item.a.map((para, pi) => {
                      const spacing = pi < item.a.length - 1 ? styles.aSpacing : undefined
                      if (typeof para === 'object') {
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

        {/* Contact CTA */}
        <Pressable
          style={[styles.contactBtn, { backgroundColor: tokens.bdim, borderColor: tokens.bbdr }]}
          onPress={() =>
            Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} Support`)}`)
          }
        >
          <Icon name="envelope" size={17} color={tokens.blu} />
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
