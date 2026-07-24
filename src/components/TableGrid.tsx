import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// Renders a table block (extracted by aim_scraper.py's _render_table()
// from a real HTML <table> — pipe-delimited text stored in body_text,
// e.g. "Facility at Airport | Frequency Use | Outbound | Inbound") as an
// actual visual grid instead of raw "cell | cell | cell" text lines.
// Confirmed live as a real, direct complaint: "look how crappy that looks
// - text paragraphs aren't broken up well, numbering isn't contrasted,
// it's hard to read" — a wall of pipe-separated text is technically
// faithful to the source data but reads far worse than the source
// document itself, which is exactly the "should look BETTER than the
// regs, not worse" bar this app is held to.
//
// No text-measurement layout here (RN has no native <table>) — every
// column in a given table gets one fixed width based on column count, and
// the whole grid scrolls horizontally on narrow screens rather than
// squeezing cells illegibly thin. Not pixel-perfect fit-to-content, but a
// real, readable, aligned grid instead of flat text.

interface TableGridProps {
  captionLines: string[]
  // null means the source table genuinely has no header row (confirmed
  // live: some AIM tables have zero header text anywhere, not even
  // hidden) — render every row as plain data, do NOT guess. See
  // PlainTextBody.tsx's parseTableBlock for how this is determined.
  headerCells: string[] | null
  rows: string[][]
  // Opens the real PDF page image for this table when its own caption is
  // tapped — undefined when the caller couldn't match this table to a
  // figure (e.g. no figures prop passed to PlainTextBody at all), in which
  // case the caption stays plain, non-interactive text as before.
  onPress?: () => void
}

function colWidth(colCount: number): number {
  if (colCount <= 2) return 170
  if (colCount <= 3) return 150
  if (colCount <= 4) return 130
  return 112
}

export function TableGrid({ captionLines, headerCells, rows, onPress }: TableGridProps) {
  const { tokens } = useTheme()
  const fs = useFS()
  const colCount = Math.max(headerCells?.length ?? 0, ...rows.map((r) => r.length), 1)
  const width = colWidth(colCount)

  const caption = (
    <>
      {captionLines.map((line, i) => (
        <Text
          key={i}
          style={[
            i === 0 ? styles.caption : styles.subcaption,
            { color: onPress && i === 0 ? tokens.blu : tokens.t1, fontSize: fs(i === 0 ? 13.5 : 12.5) },
          ]}
        >
          {line}
        </Text>
      ))}
    </>
  )

  return (
    <View style={styles.wrap}>
      {onPress ? <Pressable onPress={onPress}>{caption}</Pressable> : caption}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
        <View style={[styles.grid, { borderColor: tokens.bdr }]}>
          {headerCells && headerCells.length > 0 && (
            <View style={[styles.row, { backgroundColor: tokens.bg3, borderBottomColor: tokens.bdr }]}>
              {headerCells.map((cell, ci) => (
                <Text
                  key={ci}
                  style={[
                    styles.cell,
                    { width, color: tokens.t1, fontSize: fs(12), borderRightColor: tokens.bdr },
                    ci === headerCells.length - 1 && { borderRightWidth: 0 },
                  ]}
                >
                  {cell}
                </Text>
              ))}
            </View>
          )}
          {rows.map((row, ri) => (
            <View
              key={ri}
              style={[
                styles.row,
                { borderBottomColor: tokens.bdr },
                ri % 2 === 1 && { backgroundColor: tokens.bg2 },
              ]}
            >
              {row.map((cell, ci) => (
                <Text
                  key={ci}
                  style={[
                    styles.cell,
                    { width, fontSize: fs(12.5), borderRightColor: tokens.bdr },
                    ci === row.length - 1 && { borderRightWidth: 0 },
                    // First column is almost always the row's own identifier
                    // (a number, a device/facility name) — contrasting it
                    // gives the grid a real visual anchor to scan down,
                    // directly addressing "numbering isn't contrasted."
                    ci === 0 ? { color: tokens.blu, fontWeight: '700' } : { color: tokens.t2 },
                  ]}
                >
                  {cell}
                </Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  caption: { fontWeight: '700', marginBottom: 4 },
  subcaption: { fontWeight: '600', marginBottom: 8 },
  scrollContent: { paddingBottom: 2 },
  grid: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 10, paddingVertical: 8, borderRightWidth: StyleSheet.hairlineWidth, lineHeight: 17 },
})
