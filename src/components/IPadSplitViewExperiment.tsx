import { useState } from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SplitView } from 'expo-router/unstable-split-view'
import { ThemeProvider, useTheme } from '@/context/theme'

// Phase-1 proof-of-mechanism only, per flyregs_ipad_plan.md's own phased
// recommendation: does react-native-screens' native UISplitViewController
// wrapper actually mount and render three real columns on THIS app's exact
// dependency versions, before any real data or navigation integration.
// Deliberately NOT wired to real FAR data yet -- that's premature if the
// library itself doesn't mount cleanly. Gated at the root in _layout.tsx
// behind EXPO_PUBLIC_IPAD_SPLITVIEW_EXPERIMENT, defaulting off; this file
// is otherwise dead code with zero effect on the real app.
const DEMO_PARTS = [
  { id: '1', title: 'Part 1 — Definitions and Abbreviations' },
  { id: '61', title: 'Part 61 — Certification: Pilots' },
  { id: '91', title: 'Part 91 — General Operating and Flight Rules' },
  { id: '121', title: 'Part 121 — Air Carriers' },
]
const DEMO_SECTIONS: Record<string, Array<{ id: string; title: string }>> = {
  '1': [{ id: '1.1', title: 'General definitions' }, { id: '1.2', title: 'Abbreviations and symbols' }],
  '61': [{ id: '61.3', title: 'Requirement for certificates' }, { id: '61.23', title: 'Medical certificates' }],
  '91': [{ id: '91.3', title: 'Responsibility and authority of the PIC' }, { id: '91.103', title: 'Preflight action' }],
  '121': [{ id: '121.1', title: 'Applicability' }, { id: '121.391', title: 'Flight attendants' }],
}

function ExperimentInner() {
  const { tokens } = useTheme()
  const [partId, setPartId] = useState(DEMO_PARTS[0].id)
  const [sectionId, setSectionId] = useState<string | null>(null)
  const sections = DEMO_SECTIONS[partId] ?? []
  const section = sections.find((s) => s.id === sectionId)

  return (
    <SplitView style={{ flex: 1 }}>
      <SplitView.Column>
        <View style={[styles.col, { backgroundColor: tokens.bg2 }]}>
          <Text style={[styles.heading, { color: tokens.t1 }]}>FAR Parts</Text>
          {DEMO_PARTS.map((p) => (
            <Pressable
              key={p.id}
              style={[styles.row, p.id === partId && { backgroundColor: tokens.bdim }]}
              onPress={() => { setPartId(p.id); setSectionId(null) }}
            >
              <Text style={{ color: p.id === partId ? tokens.blu : tokens.t2 }}>{p.title}</Text>
            </Pressable>
          ))}
        </View>
      </SplitView.Column>
      <SplitView.Column>
        <View style={[styles.col, { backgroundColor: tokens.bg }]}>
          <Text style={[styles.heading, { color: tokens.t1 }]}>Sections</Text>
          {sections.map((s) => (
            <Pressable
              key={s.id}
              style={[styles.row, s.id === sectionId && { backgroundColor: tokens.bdim }]}
              onPress={() => setSectionId(s.id)}
            >
              <Text style={{ color: s.id === sectionId ? tokens.blu : tokens.t2 }}>§ {s.id} {s.title}</Text>
            </Pressable>
          ))}
        </View>
      </SplitView.Column>
      <SplitView.Column>
        <View style={[styles.col, styles.detail, { backgroundColor: tokens.bg }]}>
          {section ? (
            <>
              <Text style={[styles.heading, { color: tokens.t1 }]}>§ {section.id}</Text>
              <Text style={{ color: tokens.t2, fontSize: 15, marginTop: 8 }}>{section.title}</Text>
              <Text style={{ color: tokens.t4, fontSize: 12, marginTop: 16 }}>
                (Placeholder detail column — proves 3-way SplitView navigation, not real FAR content yet.)
              </Text>
            </>
          ) : (
            <Text style={{ color: tokens.t4 }}>Select a section</Text>
          )}
        </View>
      </SplitView.Column>
    </SplitView>
  )
}

export function IPadSplitViewExperiment() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ExperimentInner />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  col: { flex: 1, padding: 16 },
  detail: { justifyContent: 'flex-start' },
  heading: { fontSize: 17, fontWeight: '700', marginBottom: 12 },
  row: { paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8 },
})
