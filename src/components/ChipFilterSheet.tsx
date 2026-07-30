import { ReactNode } from 'react'
import { View, Text, Pressable, ScrollView, Modal, StyleSheet, ActivityIndicator } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// Generic ad hoc filter sheet -- the chrome (modal, header, sticky
// clear-all/show-results footer, live result count) is shared; each screen
// composes its own dimension sections as children using <ChipFilterSection>
// (or custom content, e.g. a date-range row or a type-ahead doc picker,
// for dimensions that aren't a flat option list). Built for Home's 7-
// dimension catalog filter, but generic enough for any other filtering
// surface -- same idea as Study Mode/Duels' content-type chip rows, just
// with the bottom-sheet chrome factored out so those don't have to
// hand-roll it again.
export function ChipFilterSheet({
  visible,
  onClose,
  title,
  resultCount,
  countLoading,
  onClearAll,
  onApply,
  applyLabel = 'Show results',
  children,
}: {
  visible: boolean
  onClose: () => void
  title: string
  resultCount: number | null
  countLoading?: boolean
  onClearAll: () => void
  onApply: () => void
  applyLabel?: string
  children: ReactNode
}) {
  const { tokens } = useTheme()
  const fs = useFS()

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <View style={[styles.card, { backgroundColor: tokens.bg, borderColor: tokens.bdr }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(16) }]}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={10}>
              <Icon name="xmark" size={18} color={tokens.t3} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>

          <View style={[styles.footer, { borderTopColor: tokens.bdr }]}>
            <Pressable style={[styles.clearBtn, { borderColor: tokens.bdr }]} onPress={onClearAll}>
              <Text style={[styles.clearBtnText, { color: tokens.t2, fontSize: fs(13.5) }]}>Clear all</Text>
            </Pressable>
            <Pressable style={[styles.applyBtn, { backgroundColor: tokens.blu }]} onPress={onApply}>
              {countLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[styles.applyBtnText, { fontSize: fs(14) }]}>
                  {applyLabel}{resultCount != null ? ` · ${resultCount}` : ''}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// One labeled section of tappable chips. `multiSelect` (default true) lets
// several options be active at once (e.g. content type); set it false for
// dependent single-pick dimensions like FAR Part or AC series.
export function ChipFilterSection({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string
  options: { value: string; label: string }[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  if (options.length === 0) return null

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>{title}</Text>
      <View style={styles.chipWrap}>
        {options.map((o) => {
          const active = selected.includes(o.value)
          return (
            <Pressable
              key={o.value}
              style={[
                styles.chip,
                { backgroundColor: active ? tokens.goldlt : tokens.bg2, borderColor: active ? tokens.goldbdr : tokens.bdr },
              ]}
              onPress={() => onToggle(o.value)}
            >
              <Text style={[styles.chipText, { color: active ? tokens.gold : tokens.t2, fontSize: fs(12.5) }]}>{o.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  card: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: 1, maxHeight: '85%' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 18, paddingBottom: 12,
  },
  title: { fontWeight: '700' },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 18, paddingBottom: 12, gap: 16 },

  section: { gap: 8 },
  sectionTitle: { fontWeight: '700', letterSpacing: 0.5 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 7 },
  chipText: { fontWeight: '600' },

  footer: {
    flexDirection: 'row', gap: 10, padding: 16, borderTopWidth: StyleSheet.hairlineWidth,
  },
  clearBtn: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 12 },
  clearBtnText: { fontWeight: '700' },
  applyBtn: { flex: 1, borderRadius: 20, alignItems: 'center', paddingVertical: 12 },
  applyBtnText: { color: '#fff', fontWeight: '700' },
})
