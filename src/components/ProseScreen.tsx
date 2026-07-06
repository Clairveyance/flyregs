import React from 'react'
import { View, Text, ScrollView, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useReturnToMenu } from '@/context/drawer'
import { OverlayHeader } from '@/components/ScreenHeader'

export interface ProseSection {
  heading?: string
  /** Each string is rendered as its own paragraph. */
  body: string[]
}

export function ProseScreen({
  title,
  intro,
  updated,
  sections,
}: {
  title: string
  intro?: string
  updated?: string
  sections: ProseSection[]
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const backToMenu = useReturnToMenu()

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg }]}>
      <OverlayHeader title={title} onBack={backToMenu} />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}>
        {updated && (
          <Text style={[styles.updated, { color: tokens.t3, fontSize: fs(12) }]}>Last updated · {updated}</Text>
        )}
        {intro && <Text style={[styles.intro, { color: tokens.t2, fontSize: fs(14.5) }]}>{intro}</Text>}

        {sections.map((section, i) => (
          <View key={i} style={styles.section}>
            {section.heading && (
              <Text style={[styles.heading, { color: tokens.t1, fontSize: fs(15.5) }]}>{section.heading}</Text>
            )}
            {section.body.map((para, j) => (
              <Text key={j} style={[styles.para, { color: tokens.t2, fontSize: fs(14) }]}>
                {para}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 20, gap: 4 },
  updated: { fontSize: 12, fontWeight: '500', marginBottom: 8 },
  intro: { fontSize: 14.5, lineHeight: 22, marginBottom: 12 },
  section: { marginTop: 18, gap: 8 },
  heading: { fontSize: 15.5, fontWeight: '700' },
  para: { fontSize: 14, lineHeight: 22 },
})
