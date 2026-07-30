import React, { useMemo, useRef, useEffect, useImperativeHandle, RefObject } from 'react'
import { Text, View, ScrollView, Platform, StyleSheet } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { linkifyText } from '@/lib/crossRefLinks'
import { TableGrid } from '@/components/TableGrid'
import { softWrapParagraph } from '@/lib/softWrap'
import { setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { searchPhrase, countOcc, highlightSpans } from '@/lib/searchHighlight'

// Renders \n\n-delimited body text (FAR/AIM/P-CG's plain-text content, as
// opposed to the AC pipeline's parsed ACBlock[] structure) as real, visually
// separated paragraphs instead of one flat run-on Text node. A first version
// of the FAR/AIM detail screens did exactly that — a single <Text> holding
// the whole body string — which technically preserves \n\n as RN line
// breaks but reads as a wall of text with no real visual rhythm. Caught in
// live use, not code review: "we can't have formatting that is hard to
// read... things need to be broken up by paragraphs."
//
// Also bolds a leading list marker — "(a)", "(1)", "a.", "b." — when a
// paragraph starts with one, matching the visual hierarchy ACBody.tsx
// already gives ACs' lettered/numbered sub-items, without needing this
// content's full block-parse treatment (FAR/AIM source text is already
// clean, not OCR'd, so a light regex is enough — no parser needed).
// Two real marker shapes, confirmed live: FAR uses "(a) General." — a
// parenthesized marker with NO trailing period, just a space — while AIM
// uses "a. ADM builds..." — a bare letter/number WITH a trailing period.
// The original pattern only matched the second shape (required a period
// right after an optional close-paren), so FAR's "(a)"/"(1)"/"(i)" markers
// — far more common in FAR body text than the period style — never bolded.
const LEADING_MARKER_RE = /^(\([a-zA-Z0-9]{1,4}\)|[a-zA-Z0-9]{1,3}\.)\s+/

interface ParsedTable {
  captionLines: string[]
  headerCells: string[] | null
  rows: string[][]
}

// Prefixes a genuine <thead> row's rendered line — see aim_scraper.py's
// and far_scraper.py's _render_table() for why this exists: a table with
// no real <thead> at all (confirmed live on AIM's "Runways With/Without
// Approach Lights" tables — every header <td> is empty, no header text
// anywhere in the source) must NOT have its first data row guessed at and
// styled as if it were column labels. That happened for real, shipped,
// and was confirmed wrong against the actual printed AIM page — "your
// analysis of it is that you did it right" was the direct correction.
// Marking real headers explicitly, rather than assuming "first piped line
// = header," is what makes "no real header" render as an honest plain
// grid instead of a confidently mislabeled one.
const TABLE_HEADER_MARK = ''
const TABLE_HEADER_MARK_RE = //g

// A block is table-shaped when it has at least one real data row using
// " | " (aim_scraper.py's _render_table() delimiter) — a single piped
// line alone is too weak a signal (a long sentence could coincidentally
// contain " | " from other punctuation) to abandon normal paragraph
// rendering for it, UNLESS that one line is itself a marked header (a
// table with a header but zero body rows is rare but real, e.g. a fully
// empty template row — still worth grid treatment).
function parseTableBlock(para: string): ParsedTable | null {
  // A single-cell <thead> that spans every column (e.g. one <th colspan=4>
  // "Meaning"</th> sitting over 4 real columns) has no " | " of its own —
  // it's one cell, nothing to join — so it doesn't land in pipedLines
  // below, but it's still marked and must not leak the marker character
  // into the caption text it ends up rendered as. Strip on every line up
  // front rather than only the ones this function treats as piped.
  const lines = para.split('\n').map((l) => l.replace(TABLE_HEADER_MARK_RE, '').trim()).filter(Boolean)
  const wasHeaderLine = para.split('\n').map((l) => l.trim().startsWith(TABLE_HEADER_MARK))
  const pipedIdx = lines.findIndex((l) => l.includes(' | '))
  if (pipedIdx === -1) return null
  const pipedLineIdxs = lines.map((l, idx) => (idx >= pipedIdx && l.includes(' | ') ? idx : -1)).filter((idx) => idx >= 0)
  const headerIdxs = pipedLineIdxs.filter((idx) => wasHeaderLine[idx])
  const dataIdxs = pipedLineIdxs.filter((idx) => !wasHeaderLine[idx])
  if (pipedLineIdxs.length < 2 && headerIdxs.length === 0) return null
  return {
    captionLines: lines.slice(0, pipedIdx),
    headerCells: headerIdxs.length > 0 ? lines[headerIdxs[0]].split(' | ').map((c) => c.trim()) : null,
    rows: dataIdxs.map((idx) => lines[idx].split(' | ').map((c) => c.trim())),
  }
}

interface CurrentFigure {
  id: string
  label: string | null
  caption: string | null
  image_url: string
}

export interface PlainTextBodyHandle {
  scrollToMatch(n: number): void
}

export const PlainTextBody = React.forwardRef<PlainTextBodyHandle, {
  text: string
  // The CURRENT paragraph's own figures (already fetched by the parent
  // screen for its Figures & Tables strip) — used to resolve a TBL/FIG
  // mention directly rather than trusting its embedded number as a route.
  // See crossRefLinks.ts's PATTERNS comment for why that number is
  // unreliable (AIM's own prose sometimes cites the "real" AIM number,
  // which doesn't match the HTML-generated caption number the scraper
  // stored). Optional — screens that don't pass it just get the old
  // route-based fallback behavior.
  figures?: CurrentFigure[]
  onOpenFigure?: (figure: CurrentFigure) => void
  /** This screen's own display label -- set as the "back to X" breadcrumb
   * right before an in-doc hyperlink jumps elsewhere, same mechanism as
   * MagicLinkPod's currentLabel prop. */
  currentLabel?: string
  /** IN DOC search -- see InDocSearchBar/useInDocSearch. Mirrors ACBody's
   * own highlightQuery/activeMatch/onMatchCount contract exactly, so every
   * content type's detail screen wires this up the same way. */
  highlightQuery?: string
  activeMatch?: number
  onMatchCount?: (n: number) => void
  /** Needed only for native scrollToMatch (web uses DOM scrollIntoView
   * instead, same as ACBody) -- the parent screen's own ScrollView ref. */
  scrollRef?: RefObject<ScrollView | null>
}>(function PlainTextBody({ text, figures, onOpenFigure, currentLabel, highlightQuery, activeMatch, onMatchCount, scrollRef }, ref) {
  const { tokens } = useTheme()
  const fs = useFS()
  // NOT stripped here — parseTableBlock() below needs the raw marker
  // intact to tell a real <thead> row apart from a data row. It strips
  // it once done reading it; the non-table fallback path further down
  // strips it again defensively — confirmed live as a real bug: a block
  // with a marked header line but no " | " at all (a single spanning
  // header cell repeating its own table's title, e.g. AIM's "Coast Guard
  // Rescue Coordination Centers") never reaches parseTableBlock()'s own
  // stripping and rendered the raw marker as a stray tofu-box glyph right
  // before the text.
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim())

  const hq = highlightQuery && highlightQuery.length >= 2 ? highlightQuery : null
  const phrase = hq ? searchPhrase(hq) : null

  // One entry per phrase occurrence, in paragraph order -- same idea as
  // ACBody's own `occurrences`, just simpler (paragraph-granularity, not
  // block+fraction) since PlainTextBody's content is flat prose, not
  // ACBody's parsed block tree.
  const occurrences = useMemo(() => {
    if (!phrase || phrase.length < 2) return []
    const result: { paraIndex: number }[] = []
    paragraphs.forEach((para, i) => {
      const n = countOcc(para, phrase)
      for (let k = 0; k < n; k++) result.push({ paraIndex: i })
    })
    return result
  }, [paragraphs, phrase])

  const paraBase = useMemo(() => {
    const m = new Map<number, number>()
    for (let k = 0; k < occurrences.length; k++) {
      if (!m.has(occurrences[k].paraIndex)) m.set(occurrences[k].paraIndex, k)
    }
    return m
  }, [occurrences])

  useEffect(() => {
    onMatchCount?.(occurrences.length)
  }, [occurrences, onMatchCount])

  const paraRefs = useRef<Record<number, View | null>>({})
  const paraRelY = useRef<Record<number, number>>({})

  useImperativeHandle(ref, () => ({
    scrollToMatch(n: number) {
      if (Platform.OS === 'web') {
        // Same approach as ACBody: each phrase occurrence is one
        // highlighted <span> (RN Web renders Text -> span). Scroll to the
        // nth, retrying across a few frames in case the highlight hasn't
        // painted yet on a cold mount.
        const tryScroll = (attempt: number) => {
          const spans = Array.from((document as any).querySelectorAll('span') as HTMLSpanElement[])
          const hl = spans.filter((s) => {
            const bg = (window as any).getComputedStyle(s).backgroundColor as string
            return bg.includes('255, 213, 0') || bg.includes('255,213,0') ||
                   bg.includes('255, 138, 0') || bg.includes('255,138,0')
          })
          const target = hl[n]
          if (!target) {
            if (attempt < 6) requestAnimationFrame(() => tryScroll(attempt + 1))
            return
          }
          target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        requestAnimationFrame(() => tryScroll(0))
        return
      }
      const scroller = scrollRef?.current
      if (!scroller) return
      const occ = occurrences[n]
      if (!occ) return
      const y = paraRelY.current[occ.paraIndex]
      if (y == null) return
      scroller.scrollTo({ y: Math.max(0, y - 100), animated: true })
    },
  }), [occurrences, scrollRef])

  const handlePress = (seg: { text: string; route: string | null; isFigure?: boolean }) => {
    if (seg.isFigure) {
      // A "(See FIG 4-3-8.)" mention is overwhelmingly a self-reference to
      // a table/figure already shown on THIS page, not a pointer elsewhere
      // — confirmed live. First choice: match the mention's exact text
      // ("FIG 4-3-8") against this page's own figures by label -- reliable
      // even with several figures on the page (AIM 4-3-11 has 6; its own
      // FIG 4-3-8/4-3-9/4-3-10 mentions all match real labels here). Only
      // when that also fails to resolve to a single figure does the old
      // "just one figure on the page" fallback apply, before finally
      // giving up and trying the (unreliable, see this file's own header
      // comment) route guess -- confirmed live as a real bug: with 6
      // figures on the page, the old code always skipped straight past
      // this and routed to the wrong AIM paragraph number instead.
      if (onOpenFigure && figures) {
        const exact = figures.find((f) => f.label === seg.text)
        if (exact) { onOpenFigure(exact); return }
        if (figures.length === 1) { onOpenFigure(figures[0]); return }
      }
    }
    if (seg.route) {
      if (currentLabel) setPendingBreadcrumb(currentLabel)
      router.push(seg.route as any)
    }
  }

  return (
    <>
      {paragraphs.map((para, i) => {
        // While actively searching, render the whole paragraph as one
        // highlighted plain-text block -- same simplification ACBody
        // already makes (see its own render switch): skip table/marker/
        // softWrap-chunk handling and crossRefLinks hyperlinking, since
        // stacking search highlighting on top of them isn't worth the
        // complexity for what's a temporary interaction mode.
        if (hq) {
          return (
            <View
              key={i}
              ref={(el) => { paraRefs.current[i] = el }}
              onLayout={(e) => { paraRelY.current[i] = e.nativeEvent.layout.y }}
            >
              <Text style={[styles.para, { color: tokens.t2, fontSize: fs(14.5) }]}>
                {highlightSpans(para, hq, { base: paraBase.get(i) ?? 0, active: activeMatch })}
              </Text>
            </View>
          )
        }
        const table = parseTableBlock(para)
        if (table) {
          // Match this table's own embedded label ("TBL 6-2-6b Air Force
          // Rescue...") against the paragraph's figures so its caption can
          // open the real PDF page image — the standing design decision
          // for in-text tables: keep the vetted grid AND make it tappable
          // to the real page, never just a static readout. Only reliable
          // now that aim_scraper.py/backfill_aim_pdf_images.py keep every
          // table's embedded label in sync with its actual aim_figures row
          // (previously multiple tables in one paragraph could share the
          // same bare label, e.g. three tables all captioned "TBL 6-2-6" —
          // confirmed live, made this kind of match ambiguous/impossible).
          const labelMatch = table.captionLines[0]?.match(/^(TBL|FIG)\s+[\d-]+[a-z]?/)
          const tableFigure = labelMatch
            ? figures?.find((f) => f.label === labelMatch[0])
            : undefined
          return (
            <TableGrid
              key={i}
              {...table}
              onPress={tableFigure && onOpenFigure ? () => onOpenFigure(tableFigure) : undefined}
            />
          )
        }
        const cleaned = para
          .replace(TABLE_HEADER_MARK_RE, '')
          // Strips Federal-Register-style plain-text table border rules
          // (long dash runs used as row/section separators in AD
          // applicability text, e.g. "----...----") -- pure visual noise
          // carried over verbatim from the raw source, never real content.
          // Confirmed live: AD 2018-02-04's Figure 1/2 applicability
          // tables render with 3+ of these per figure. Safe to strip
          // broadly (FAR/AIM/AC never produce a line of bare dashes in
          // their own body text) without needing a full table-grid
          // reconstruction -- body_text (unlike the flattened
          // `applicability` field) already keeps its real newlines, so
          // the surrounding data already renders as separate, readable
          // lines; only the rule-line noise needed removing.
          .replace(/^[ \t]*-{10,}[ \t]*$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        const m = cleaned.match(LEADING_MARKER_RE)
        const marker = m ? m[1] : null
        const rest = m ? cleaned.slice(m[0].length) : cleaned
        // Purely a display split — see softWrap.ts. A source paragraph
        // with no real internal break (one long run of prose) gets broken
        // into a few shorter visual chunks so it doesn't read as one dense
        // wall on a narrow phone screen; short paragraphs are returned
        // unchanged.
        const chunks = softWrapParagraph(rest)
        return chunks.map((chunk, ci) => {
          const segments = linkifyText(chunk)
          return (
            <Text key={`${i}-${ci}`} style={[styles.para, { color: tokens.t2, fontSize: fs(14.5) }]}>
              {ci === 0 && marker && <Text style={{ fontWeight: '700', color: tokens.t1 }}>{marker} </Text>}
              {segments.map((seg, j) =>
                seg.route ? (
                  <Text
                    key={j}
                    onPress={() => handlePress(seg)}
                    style={{ color: tokens.blu, fontWeight: '600' }}
                  >
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={j}>{seg.text}</Text>
                ),
              )}
            </Text>
          )
        })
      })}
    </>
  )
})

const styles = StyleSheet.create({
  para: { lineHeight: 22, marginBottom: 14 },
})
