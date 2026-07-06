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

if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true)
}

interface QA {
  q: string
  a: string
}

const FAQ: QA[] = [
  {
    q: 'What is an Advisory Circular?',
    a: 'Advisory Circulars (ACs) are documents the FAA publishes to provide guidance and accepted means of compliance with the federal aviation regulations. They are not regulations themselves, but they explain how to meet them.',
  },
  {
    q: 'Are the documents official?',
    a: `${APP_NAME} presents the FAA's published AC text and PDFs, which are in the public domain. We organize and index them for fast reference, but we do not alter the official content. Always confirm currency against faa.gov before relying on any AC operationally.`,
  },
  {
    q: 'How often is the library updated?',
    a: 'The library syncs regularly so new and revised ACs appear automatically. The "What\'s New" feed on the Home screen shows everything issued or updated in the last 90 days.',
  },
  {
    q: 'What do the NEW and UPD badges mean?',
    a: 'NEW marks an AC issued recently; UPD marks one that supersedes or revises an earlier circular. You can control how long these badges stay visible under Badge Lifespan in the menu.',
  },
  {
    q: 'How does search work?',
    a: 'Search runs across AC numbers, titles, and document text. Type an AC number like "91-74" or a topic like "icing" or "fatigue" — results rank by relevance.',
  },
  {
    q: 'Do I need an account?',
    a: 'No — browsing the entire library and searching to find an AC are both free, with no account needed, and no limit on how many you can look up. Every AC\'s detail page shows its full Table of Contents plus the beginning of its text for free. Pro unlocks the complete text of every AC, in-document search, bookmarks, notes, and folders. Premium adds cloud sync, sharing, offline downloads, and update alerts. An account is only required when you start a subscription — creating one is free and doesn\'t unlock anything by itself.',
  },
  {
    q: 'How do notes and auto-linking work?',
    a: 'Open the Notes tab and tap + New. When you type an AC number like "61-65" or "91-74B" in a note, it is detected automatically and turned into a tappable chip that opens the current version of that AC. No suffix required.',
  },
  {
    q: 'What does a subscription unlock?',
    a: 'Pro unlocks full text access for every AC, in-document search, bookmarks, personal notes, and custom folders. Premium adds cloud backup and sync across devices, shared folders for teams and flight schools, offline downloads, and alerts when ACs are published or updated.',
  },
  {
    q: 'How do I cancel?',
    a: 'Subscriptions are managed by Apple or Google. Open your App Store or Google Play account settings to view or cancel. Your access continues until the end of the current billing period.',
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
                {expanded && <Text style={[styles.a, { color: tokens.t2, fontSize: fs(14), lineHeight: fs(14) * 1.5 }]}>{item.a}</Text>}
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
  a: { fontSize: 14, lineHeight: 21, paddingBottom: 14, paddingRight: 8 },
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
