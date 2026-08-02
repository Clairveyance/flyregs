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
  // Footnote definitions trailing the table's last row (e.g. "1 On
  // runways used, or intended to be used, by international commercial
  // transports.", referenced by a cell elsewhere reading "X 1") -- see
  // parseTableBlock's own FOOTNOTE_LINE_RE comment for how these are told
  // apart from a genuine row-continuation fragment. Rendered as their own
  // legend below the grid, never appended into a cell.
  footnotes: string[]
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

// A single uniform width for every column in a table reads fine when
// every column genuinely holds short values -- it breaks down for a table
// that mixes a short label/number column with one genuinely long-prose
// column (e.g. AIM TBL 5-6-1 Intercepting Signals' "Meaning" column, TBL
// 7-1-2's SPECI Issuance "Remarks" column) -- confirmed corpus-wide via a
// scripted sweep for outlier cell lengths (25 hits across AIM/FAR), not
// just spotted from one screenshot: forcing that column into the SAME
// ~112-150px width as its short "Series"/"Item #" neighbor produces a
// tall, hard-to-scan wrapped column. Real per-column text measurement
// isn't available (RN has no layout-before-paint text metrics here), so
// this widens ONLY the specific column(s) whose own longest cell crosses
// a real prose threshold, leaving every short column at its normal width
// -- the asymmetry a real printed table has, not a uniform grid forcing
// every column to compromise for the widest one.
const PROSE_COL_LEN = 24
const PROSE_COL_WIDTH = 240

function computeColWidths(headerCells: string[] | null, rows: string[][], colCount: number): number[] {
  const base = colWidth(colCount)
  const widths: number[] = []
  for (let ci = 0; ci < colCount; ci++) {
    let maxLen = headerCells?.[ci]?.length ?? 0
    for (const row of rows) maxLen = Math.max(maxLen, (row[ci] ?? '').length)
    widths.push(maxLen > PROSE_COL_LEN ? Math.max(base, PROSE_COL_WIDTH) : base)
  }
  return widths
}

// A 2-column table where the second column holds full sentences (a
// definitions/terms table, e.g. AIM 5-4-16's "Offset Course DA" / "Visual
// Segment Angle" SOIA definitions) crams that prose into the same fixed
// 170px cell every other table uses for short numeric/label values --
// illegible wrapped text, confirmed live as the literal "messy and
// unattractive" complaint. Detected by length rather than column count
// alone (plenty of real 2-column tables hold short values on both sides
// and read fine as a grid) -- one row with a long second cell is enough to
// know this is prose, not tabular data.
const DEFINITION_PROSE_LEN = 60

function isDefinitionStyle(colCount: number, rows: string[][]): boolean {
  return colCount === 2 && rows.some((r) => (r[1]?.length ?? 0) > DEFINITION_PROSE_LEN)
}

export function TableGrid({ captionLines, headerCells, rows, footnotes, onPress }: TableGridProps) {
  const { tokens } = useTheme()
  const fs = useFS()
  const colCount = Math.max(headerCells?.length ?? 0, ...rows.map((r) => r.length), 1)
  const widths = computeColWidths(headerCells, rows, colCount)

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

  const footnoteBlock = footnotes.length > 0 && (
    <View style={styles.footnotes}>
      {footnotes.map((f, i) => (
        <Text key={i} style={[styles.footnoteText, { color: tokens.t3, fontSize: fs(11.5) }]}>{f}</Text>
      ))}
    </View>
  )

  if (isDefinitionStyle(colCount, rows)) {
    return (
      <View style={styles.wrap}>
        {onPress ? <Pressable onPress={onPress}>{caption}</Pressable> : caption}
        <View style={[styles.defList, { borderColor: tokens.bdr }]}>
          {rows.map((row, ri) => (
            <View
              key={ri}
              style={[
                styles.defRow,
                ri > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: tokens.bdr },
                ri % 2 === 1 && { backgroundColor: tokens.bg2 },
              ]}
            >
              <Text style={[styles.defTerm, { color: tokens.blu, fontSize: fs(13) }]}>{row[0]}</Text>
              <Text style={[styles.defBody, { color: tokens.t2, fontSize: fs(13) }]}>{row[1]}</Text>
            </View>
          ))}
        </View>
        {footnoteBlock}
      </View>
    )
  }

  return (
    <View style={styles.wrap}>
      {onPress ? <Pressable onPress={onPress}>{caption}</Pressable> : caption}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scrollContent}>
        <View style={[styles.grid, { borderColor: tokens.bdr }]}>
          {headerCells && headerCells.length > 0 && (
            <View style={[styles.row, { backgroundColor: tokens.bg3, borderBottomColor: tokens.bdr }]}>
              {headerCells.map((cell, ci) => (
                <View
                  key={ci}
                  style={[
                    styles.cellWrap,
                    { width: widths[ci], borderRightColor: tokens.bdr },
                    ci === headerCells.length - 1 && { borderRightWidth: 0 },
                  ]}
                >
                  <Text style={[styles.cellText, { color: tokens.t1, fontSize: fs(12) }]}>{cell}</Text>
                </View>
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
                <View
                  key={ci}
                  style={[
                    styles.cellWrap,
                    { width: widths[ci], borderRightColor: tokens.bdr },
                    ci === row.length - 1 && { borderRightWidth: 0 },
                  ]}
                >
                  <Text
                    style={[
                      styles.cellText,
                      { fontSize: fs(12.5) },
                      // First column is almost always the row's own identifier
                      // (a number, a device/facility name) — contrasting it
                      // gives the grid a real visual anchor to scan down,
                      // directly addressing "numbering isn't contrasted."
                      ci === 0 ? { color: tokens.blu, fontWeight: '700' } : { color: tokens.t2 },
                    ]}
                  >
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {footnoteBlock}
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
  // Split from a single Text-only `cell` style into a wrapping View +
  // inner Text -- confirmed live as a real complaint (RC, annotated
  // screenshot, circling near-empty space in short cells): when one
  // column in a row holds long prose (the very case the per-column-width
  // fix above exists for), that row's OTHER cells stretch to match its
  // height (RN's default `alignItems: 'stretch'` on a flex row), but a
  // bare Text child doesn't center its own content within that taller
  // box -- it just renders top-aligned, leaving a large dead gap below a
  // short 1-2 line value. `justifyContent: 'center'` on the wrapping View
  // is what actually centers the Text within the row's real height.
  cellWrap: { paddingHorizontal: 10, paddingVertical: 8, borderRightWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  cellText: { lineHeight: 17 },
  defList: { borderWidth: 1, borderRadius: 8, overflow: 'hidden' },
  defRow: { paddingHorizontal: 12, paddingVertical: 10, gap: 4 },
  defTerm: { fontWeight: '700' },
  defBody: { lineHeight: 19 },
  footnotes: { marginTop: 6, gap: 3 },
  footnoteText: { lineHeight: 15 },
})
