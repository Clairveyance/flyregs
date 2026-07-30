import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { useFS } from '@/context/fontScale'
import { useTheme } from '@/context/theme'
import { Icon } from '@/components/Icon'

// Extracted from ac/[id].tsx, which had this exact meta-chip-row +
// summary-section + Open PDF/Download action-row pattern -- AD and LOI had
// their own differently-styled, differently-positioned versions (a plain
// vertical label:value card instead of chips, a dim link-style PDF button
// with no Download counterpart at all, sitting AFTER MagicLink instead of
// before it). Confirmed live as a real inconsistency the user flagged
// directly. Sharing one component set is what makes "symmetry and
// uniformity across the app" an actual guarantee instead of three screens
// that have to be kept in sync by hand.

export function MetaChip({ label, value, tokens }: {
  label: string
  value: string
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <View style={[styles.chip, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
      <Text style={[styles.chipLabel, { color: tokens.t3, fontSize: fs(10) }]}>{label}</Text>
      <Text style={[styles.chipValue, { color: tokens.t1, fontSize: fs(13) }]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

export function MetaChipRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.metaRow}>{children}</View>
}

export function DetailSection({ title, tokens, children }: {
  title: string
  tokens: ReturnType<typeof useTheme>['tokens']
  children: React.ReactNode
}) {
  const fs = useFS()
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: tokens.t3, fontSize: fs(11) }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

// Open PDF (primary) + Download (secondary, toggles to "Saved offline")
// side by side -- the same visual weight/position everywhere a detail
// screen has a real underlying PDF (AC, AD, LOI). FAR/AIM/PCG have no PDF
// of their own and simply don't render this row at all.
export function DetailActionRow({
  onOpenPdf,
  onDownload,
  downloaded,
  downloadBusy,
  tokens,
}: {
  onOpenPdf: () => void
  onDownload: () => void
  downloaded: boolean
  downloadBusy: boolean
  tokens: ReturnType<typeof useTheme>['tokens']
}) {
  const fs = useFS()
  return (
    <View style={styles.actionRow}>
      <Pressable style={[styles.pdfBtn, { backgroundColor: tokens.blu, flex: 1 }]} onPress={onOpenPdf}>
        <Icon name="doc.text" size={17} color="#fff" />
        <Text style={[styles.pdfBtnText, { color: '#fff', fontSize: fs(15) }]}>Open PDF</Text>
      </Pressable>
      <Pressable
        style={[
          styles.downloadBtn,
          downloaded ? { backgroundColor: tokens.gdim, borderColor: tokens.gbdr } : { backgroundColor: tokens.bg2, borderColor: tokens.bdr2 },
        ]}
        onPress={onDownload}
        disabled={downloadBusy}
      >
        {downloadBusy ? (
          <ActivityIndicator size="small" color={tokens.t2} />
        ) : (
          <Icon name={downloaded ? 'checkmark.circle' : 'arrow.down.circle'} size={17} color={downloaded ? tokens.grn : tokens.t2} />
        )}
        <Text style={[styles.downloadBtnText, { color: downloaded ? tokens.grn : tokens.t1, fontSize: fs(14) }]}>
          {downloadBusy ? 'Saving…' : downloaded ? 'Saved offline' : 'Download'}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  chip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8, gap: 2, maxWidth: 180 },
  chipLabel: { fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  chipValue: { fontWeight: '500' },

  section: { gap: 6, marginTop: 14 },
  sectionTitle: { fontWeight: '600', letterSpacing: 0.7, marginBottom: 2 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  pdfBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, paddingVertical: 14 },
  pdfBtnText: { fontWeight: '600' },
  downloadBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: 14, borderWidth: 1, paddingVertical: 14, paddingHorizontal: 16 },
  downloadBtnText: { fontWeight: '600' },
})
