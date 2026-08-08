import React, { useMemo, useRef, useEffect, useImperativeHandle, RefObject } from 'react'
import { Text, View, ScrollView, Pressable, Platform, StyleSheet, useWindowDimensions } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { normalizeRegBody } from '@/lib/regTextFormat'
import { useFS } from '@/context/fontScale'
import { linkifyText } from '@/lib/crossRefLinks'
import { TableGrid } from '@/components/TableGrid'
import { Icon } from '@/components/Icon'
import { softWrapParagraph } from '@/lib/softWrap'
import { setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { searchPhrase, highlightSpans } from '@/lib/searchHighlight'
import { splitMnemonicSpans, MnemonicAnchor } from '@/lib/regMnemonics'
import { useConfirm } from '@/components/ConfirmDialog'

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

/** A short (<=44 char) declarative/imperative lead phrase at the very
 * start of a paragraph, immediately followed by more prose in the SAME
 * paragraph -- the FAA's own informal way of breaking a long passage into
 * sub-topics ("Understand Mountain Obscuration. The term..."; "File a
 * Flight Plan. Plan your route..."). Bolding it in a stand-out color lets
 * a reader separate the different "thoughts" running through a passage at
 * a glance, matching how a printed page would set a run-in heading.
 * Confirmed live as a real readability request: these currently blend
 * into the surrounding gray body text with nothing marking the topic
 * shift. Deliberately SHORT-only -- a normal topic sentence ("The ILS is
 * designed to provide an approach path...") must NOT match, or every
 * paragraph's first sentence would bold and nothing would stand out
 * anymore. Length is what separates a label from an ordinary sentence.
 */
// Real single-word abbreviations that could otherwise false-positive as a
// header ("Mr. Smith" bolding "Mr."). Bounded and explicit rather than
// "any single word" -- a corpus-wide scan of every paragraph-leading
// "Word." across FAR+AIM found the single-word population is overwhelmingly
// genuine procedure/topic labels (General., Background., Route., Altitude.,
// Wind., Visibility., ...), not abbreviations, so blanket-rejecting every
// one-word match was throwing out real headers along with a risk that
// barely exists in this corpus. Confirmed live: AIM 6-4-1's lost-comms
// procedure steps ("Route.", "Altitude.") weren't bolding at all -- RC:
// "those steps should stand out amongst the other text."
const ABBREVIATION_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'jr', 'sr', 'vs', 'etc', 'inc', 'co', 'no',
  'st', 'ave', 'rd', 'approx', 'dept', 'est', 'fig', 'ed', 'pg', 'pp',
])

function leadHeaderMatch(s: string): string | null {
  // Two shapes: "Header. Body text follows..." (lookahead requires more
  // text after it), OR a paragraph that IS just the header with nothing
  // else -- confirmed live: AIM 6-4-1's lost-comms procedure has "Route."
  // and "Altitude." as their OWN standalone paragraphs (the explanatory
  // bullets that follow are separate paragraphs entirely, not more text in
  // the same string), so the lookahead-based pattern can never match --
  // there's nothing after the period to look ahead AT. RC: "those steps
  // should stand out amongst the other text."
  const m = s.match(/^([A-Z][^.]{1,42}\.)\s+(?=[A-Z"“])/) ?? s.match(/^([A-Z][^.]{1,42}\.)$/)
  if (!m) return null
  const header = m[1]
  if (!header.includes(' ') && ABBREVIATION_WORDS.has(header.slice(0, -1).toLowerCase())) return null
  if (/\.[A-Z]\.$/.test(header)) return null // "...U.S." etc -- same abbreviation guard tidy() uses
  return header
}

interface ParsedTable {
  captionLines: string[]
  headerCells: string[] | null
  rows: string[][]
  footnotes: string[]
}

/** A table footnote definition ("1 On runways used, or intended to be
 * used, by international commercial transports.") -- referenced from a
 * cell elsewhere in the same table by a bare trailing digit ("X 2"). Shape
 * is a bare 1-2 digit number followed directly by a capitalized word, with
 * NO period/paren after the digit (that shape is LEADING_MARKER_RE's job,
 * a real numbered sub-list item, a different thing). Confirmed live and
 * corpus-wide (50 lines across 20 FAR/AIM documents, e.g. AIM 2-3-3's TBL
 * 2-3-1): these lines always trail the table's last real row, and without
 * this check parseTableBlock's own continuation-line scan (below) matched
 * them too -- they end in a period just like a genuine wrapped sentence
 * fragment does -- and glued the ENTIRE footnote block onto the last row's
 * last cell as run-on text. */
const FOOTNOTE_LINE_RE = /^\d{1,2}\s+[A-Z]/

/** True when a table's captionLines[0] reads like a genuine standalone
 * title ("SPECI Issuance Table", "Icing Types") rather than a fragment of
 * leftover prose the table happened to fall right after ("...The SAP is
 * not published on the IAP.", "...that may be reserved for the specified
 * classes of users for that airport:"). Confirmed live and corpus-wide:
 * NOT every table lacking a TBL/FIG number is caption-less -- AIM 7-1-2's
 * "SPECI Issuance Table" is a real, legible caption straight from the
 * source with no FAA figure number ever assigned to it, and the earlier
 * "no TBL/FIG match -> discard captionLines, use a synthetic fallback"
 * rule (see the render call site below) was throwing that real caption
 * away right alongside genuinely-leftover prose. The distinguishing
 * signal: leftover prose is always the TAIL of some other sentence, so it
 * ends in sentence-ending punctuation (a period, colon, or comma) or runs
 * long; a real standalone caption doesn't. */
function looksLikeRealCaption(line: string | undefined): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 60) return false
  return !/[.:,;]$/.test(trimmed)
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

/** Strips the "FIG"/"FIGURE"/"TBL"/"TABLE" word off a figure mention or
 * stored label, leaving just the number ("4-3-4") to compare on -- the AIM
 * source spells this out inconsistently even within one paragraph ("Figure
 * 4-3-4" in prose vs. the figure's own stored label "FIG 4-3-4"), so a
 * literal string match on the full label silently fails. See handlePress's
 * own comment for the live case this fixes. */
function normalizeFigureLabel(s: string): string {
  return s.trim().replace(/^(?:FIG(?:URE)?|TBL|TABLE)\s*/i, '').toUpperCase()
}

/** True when two phrases open with the same run of 3+ words -- used to spot
 * a table row whose own label restates a pending group sub-label rather
 * than needing it prepended. See parseTableBlock's data-row branch. */
function sharesLeadWords(a: string, b: string, minWords = 3): boolean {
  const aw = a.toLowerCase().split(/\s+/)
  const bw = b.toLowerCase().split(/\s+/)
  let n = 0
  while (n < aw.length && n < bw.length && aw[n] === bw[n]) n++
  return n >= minWords
}

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

  // Bare (non-piped) lines interspersed AMONG the data rows are one of TWO
  // very different things, and confusing them was a real live bug this
  // fix walks carefully around:
  //  1. A CONTINUATION of the previous row's own last cell -- e.g. Class
  //     C's "Distance from clouds" value wraps across three source lines
  //     ("500 feet below." on the piped line itself, then "1,000 feet
  //     above." and "2,000 feet horizontal." as bare follow-on lines).
  //     These always end in a period, matching every other short
  //     measurement fragment in that column.
  //  2. A genuine GROUP-ROW LABEL the FAA source uses instead of repeating
  //     a column value on every row -- e.g. FAR 91.155's VFR-minimums
  //     table writes "Class E:" once, then two unlabeled rows, "Class G:"
  //     once, then many more (some further sub-grouped by altitude band /
  //     aircraft type). These never end in a period (a colon, or nothing).
  // Both kinds used to be silently DROPPED. For (2) that's a real data
  // gap -- confirmed live, the rendered table showed altitude-band rows
  // with no indication they belonged to Class E or Class G at all, even
  // though the airspace class is the entire point of the table. An
  // earlier version of this fix treated EVERY bare line as case (2),
  // which wrongly turned case-(1) continuation fragments into bogus
  // labels prepended onto the WRONG (next) row -- confirmed live too,
  // "2,000 feet horizontal." ended up glued onto Class D's row instead of
  // staying part of Class C's own cell.
  let currentClass: string | null = null
  let subLabel: string | null = null
  const dataIdxSet = new Set(dataIdxs)
  const headerIdxSet = new Set(headerIdxs)
  const rows: string[][] = []
  const footnotes: string[] = []
  // True once a footnote line has started and no further real data row has
  // appeared since -- lets a footnote's OWN lettered sub-items ("3
  // Operations at O'Hare International Airport shall not— \n(a) Except as
  // provided...\n(b)...\n(c)...", confirmed live on FAR 93.123) continue
  // that footnote instead of falling into the row-continuation branch
  // below and gluing onto the table's actual last data row -- lettered
  // markers mean the same thing in both places (a wrapped sub-list), the
  // only question is which parent they belong to. Always false while
  // still inside the real table body (reset on every new data row), so
  // this can never fire before the genuine footnote block starts.
  let inFootnoteBlock = false
  for (let idx = pipedIdx + 1; idx < lines.length; idx++) {
    if (dataIdxSet.has(idx)) {
      inFootnoteBlock = false
      const cells = lines[idx].split(' | ').map((c) => c.trim())
      // A row can carry its OWN complete label in cell 1 with no bare line
      // of its own before it (91.155's final row: "More than 1,200 feet
      // above the surface and at or above 10,000 feet MSL | 5 statute
      // miles | ..." follows straight on from the "Day"/"Night" rows under
      // the PRECEDING altitude band, with nothing to signal a new one
      // started). Confirmed live -- without this check the stale subLabel
      // got glued on anyway: "...but less than 10,000 feet MSL — More than
      // 1,200 feet above the surface and at or above 10,000 feet MSL",
      // two different altitude bands stated in the same cell. Detected by
      // shared leading words with the pending subLabel -- a real
      // continuation ("Day", "Night, except...") shares none; a
      // self-contained sibling row restates the same opening clause.
      const redundant = subLabel != null && sharesLeadWords(subLabel, cells[0])
      const prefix = [currentClass, redundant ? null : subLabel].filter(Boolean).join(' — ')
      if (prefix) cells[0] = `${prefix} — ${cells[0]}`
      if (redundant) subLabel = null
      rows.push(cells)
    } else if (!headerIdxSet.has(idx)) {
      const raw = lines[idx]
      // A continuation line doesn't always end in a period -- confirmed
      // live corpus-wide (FAR 120.117/120.225's antidrug/alcohol-program
      // tables): a row's own last cell can be a lettered sub-list spanning
      // several bare lines, e.g. "(i) Have a Letter of Authorization,\n(ii)
      // Implement an FAA alcohol testing program no later than the date
      // you start operations, and\n(iii) Meet the requirements of this
      // subpart." -- item (ii) ends in "and", not a period. The period-only
      // check (right, for 91.155's plain measurement continuations) missed
      // this and misfired as a bogus NEW label glued onto the following
      // row's cell 1. Second signal: LEADING_MARKER_RE (the same lettered/
      // numbered marker this file already bolds at a real paragraph's own
      // start) reliably identifies a sub-list item regardless of its
      // closing punctuation.
      if (FOOTNOTE_LINE_RE.test(raw)) {
        footnotes.push(raw)
        inFootnoteBlock = true
      } else if (inFootnoteBlock) {
        // Once inside a footnote block there's nothing else a bare line
        // COULD be -- real data rows are already excluded above, and a
        // footnote block only ever starts after the table's last real
        // row -- so every following bare line (lettered sub-item or a
        // plain wrapped sentence) belongs to the most recent footnote,
        // unconditionally, not just the period/marker shapes the
        // row-continuation branch below has to guess between.
        footnotes[footnotes.length - 1] = `${footnotes[footnotes.length - 1]} ${raw}`
      } else if ((/\.$/.test(raw) || LEADING_MARKER_RE.test(raw)) && rows.length > 0) {
        const lastRow = rows[rows.length - 1]
        lastRow[lastRow.length - 1] = `${lastRow[lastRow.length - 1]} ${raw}`
      } else {
        const label = raw.replace(/:\s*$/, '')
        if (/^Class\s+[A-Za-z0-9]+$/.test(label)) {
          currentClass = label
          subLabel = null
        } else {
          subLabel = label
        }
      }
    }
  }
  return {
    captionLines: lines.slice(0, pipedIdx),
    headerCells: headerIdxs.length > 0 ? lines[headerIdxs[0]].split(' | ').map((c) => c.trim()) : null,
    rows,
    footnotes,
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
  scrollToParagraph(i: number): void
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
  /** Fallback when a FIG/TBL mention doesn't match anything in `figures` --
   * AIM's own captioning sometimes files a figure under a DIFFERENT
   * paragraph than the one(s) that mention it (confirmed live corpus-wide,
   * not a one-off: AIM 1-1-9 mentions "FIG 1-1-8" but that figure is
   * catalogued under paragraph 1-1-10). Tried only after the current
   * paragraph's own figures come up empty. See resolveAimFigureGlobally's
   * own comment in regPreview.ts. */
  resolveFigureGlobally?: (mentionText: string) => Promise<CurrentFigure | null>
  /** When set, a route-carrying citation tap calls this INSTEAD of
   * router.push -- lets RegPreviewPane redirect a tap on "§ 91.107" or
   * "AC 90-67B" into a nested preview of its own rather than navigating
   * the background screen away. Confirmed live as a real bug: without
   * this, tapping any non-figure citation inside a RefPack's already-open
   * preview kicked the whole app out of the pack to a full-screen page --
   * "this ENTIRE process MUST take place in and STAY inside the RP that
   * the user is in." Optional -- screens rendering PlainTextBody directly
   * (far/[id].tsx etc.) omit it and keep the normal router.push behavior. */
  onNavigate?: (route: string) => void
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
  /** The scrollRef ScrollView's own rendered height (from the parent
   * screen's onLayout) -- same purpose and same fallback-to-window-height
   * behavior as ACBody's identical prop. Without a real measured viewport,
   * centering overshoots wherever the header/tab-bar chrome makes the true
   * visible area shorter than the full device window. */
  viewportHeight?: number
  /** Indices of paragraphs changed in the most recent revision -- renders the
   * same blue left-rail + "UPDATED" tag ACBody already shows for AC, so
   * What's Changed reads identically across every content type instead of
   * being an AC-only affordance. */
  changedIndices?: number[]
  /** Curated per-paragraph memory-aid highlight spans (AVE-F, MEA's lost-
   * comm sense, etc.) -- fetched by the parent screen via
   * fetchMnemonicAnchors, same "parent fetches, PlainTextBody just renders"
   * pattern as `figures`. Optional; screens that don't pass it render
   * exactly as before. See src/lib/regMnemonics.ts. */
  mnemonicAnchors?: MnemonicAnchor[]
  /** Saved-highlight passage identities (each paragraph's own trimmed text,
   * matching bookmarks.ts's blockText snapshot) -- mirrors ACBody's
   * identically-named prop exactly, so FAR/AIM/AD/LOI get the same "tap and
   * hold a passage to save/remove a highlight" affordance AC already had.
   * Optional; omitting it (or onToggleHighlight) renders exactly as before
   * with no long-press wiring at all. */
  highlightedBlockTexts?: Set<string>
  /** Long-press a passage to toggle a highlight on it -- see
   * highlightedBlockTexts above. Passed the PASSAGE's own trimmed text (the
   * same value stored as blockText) and its paragraph index. Below the
   * search-mode branch, "passage" means one softWrap CHUNK, not the raw
   * pre-wrap paragraph -- see that render branch's own comment for why. */
  onToggleHighlight?: (paraText: string, index: number) => void
  /** The passage just long-pressed, while its Copy/Highlight/Cancel menu is
   * still open and unresolved -- shown with a distinct "SELECTED" preview
   * style (not yet the committed yellow) so the reader can see exactly what
   * will be affected before choosing. Set by the parent screen the instant
   * long-press fires and cleared once the menu closes, any path. */
  pendingBlockText?: string | null
}>(function PlainTextBody({ text, figures, onOpenFigure, resolveFigureGlobally, onNavigate, currentLabel, highlightQuery, activeMatch, onMatchCount, scrollRef, viewportHeight, changedIndices, mnemonicAnchors, highlightedBlockTexts, onToggleHighlight, pendingBlockText }, ref) {
  const { tokens, redShift } = useTheme()
  // useConfirm, not Alert.alert -- Alert.alert renders NOTHING on React
  // Native Web, so every dialog here was invisible in the Browser pane.
  // See components/ConfirmDialog.tsx.
  const confirm = useConfirm()
  const fs = useFS()
  // Same approximation of scrollIntoView({block:'center'}) as ACBody -- see
  // its own viewportHeight comment. Real device, real bug: matches landed
  // off-screen or didn't visibly move between Prev/Next taps, root-caused to
  // this file targeting only a paragraph's top edge with a flat, non-
  // proportional offset instead of the actual occurrence position -- ACBody
  // solved the identical problem (six iterations, see its own history) a
  // week before this file was built, and that fix was never ported over.
  const { height: windowHeight } = useWindowDimensions()
  const centerOffset = (viewportHeight ?? windowHeight) / 2
  // NOT stripped here — parseTableBlock() below needs the raw marker
  // intact to tell a real <thead> row apart from a data row. It strips
  // it once done reading it; the non-table fallback path further down
  // strips it again defensively — confirmed live as a real bug: a block
  // with a marked header line but no " | " at all (a single spanning
  // header cell repeating its own table's title, e.g. AIM's "Coast Guard
  // Rescue Coordination Centers") never reaches parseTableBlock()'s own
  // stripping and rendered the raw marker as a stray tofu-box glyph right
  // before the text.
  // Normalized before splitting, so every screen that renders regulation body
  // text gets the same cleanup in one place. The scraped source is
  // fixed-width Federal Register / eCFR plain text: measured corpus-wide, 99%
  // of ADs and LOIs are hard-wrapped mid-sentence, 95% of ADs carry stray "0"
  // list markers, and 81% contain [[Page NNNN]] breaks — all of which render
  // as ragged fragments. See regTextFormat.ts for the full measurements and
  // why this runs at render time instead of rewriting the database.
  const paragraphs = normalizeRegBody(text).split(/\n\n+/).filter((p) => p.trim())

  const hq = highlightQuery && highlightQuery.length >= 2 ? highlightQuery : null
  const phrase = hq ? searchPhrase(hq) : null

  // One entry per phrase occurrence, in paragraph order, now WITH a
  // fractional offset (0 = paragraph start, 1 = paragraph end) -- same
  // approach as ACBody's own occurrences/absoluteOccurrenceY, ported in to
  // fix a real bug: this used to store only `{ paraIndex }`, so every
  // occurrence in a paragraph collapsed to the same target position (the
  // paragraph's top edge) -- multiple matches sharing one paragraph looked
  // like Prev/Next "didn't move" between them, and a match deep in a long
  // paragraph could land off-screen since only the top was ever centered.
  const occurrences = useMemo(() => {
    if (!phrase || phrase.length < 2) return []
    const result: { paraIndex: number; fraction: number }[] = []
    paragraphs.forEach((para, i) => {
      // `phrase` already collapsed internal whitespace to single spaces (see
      // searchPhrase in searchHighlight.ts) -- a query spanning a lettered/
      // numbered sub-item boundary (normalizeRegBody keeps those on their
      // own line WITHIN a paragraph) would otherwise never match a literal
      // "\n" here. `.replace` preserves length, so `idx`/`len` math below
      // still lines up with the real `para`.
      const lower = para.toLowerCase().replace(/\n/g, ' ')
      const len = para.length || 1
      let pos = 0
      let idx = lower.indexOf(phrase, pos)
      while (idx !== -1) {
        result.push({ paraIndex: i, fraction: idx / len })
        pos = idx + phrase.length
        idx = lower.indexOf(phrase, pos)
      }
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
  // Each paragraph's own rendered height, from the same onLayout event as
  // paraRelY -- lets a specific occurrence be placed PROPORTIONALLY within
  // its paragraph (see absoluteOccurrenceY) instead of always the top edge.
  const paraHeight = useRef<Record<number, number>>({})

  // No offset-chain summing needed here (unlike ACBody's outerOffsetYRef/
  // rootOffsetYRef) -- every screen that renders PlainTextBody does so as a
  // DIRECT child of its own ScrollView with no wrapping container in
  // between, so each paragraph's own onLayout y is already relative to the
  // scrollable content.
  const absoluteOccurrenceY = (i: number, fraction: number): number | undefined => {
    const rel = paraRelY.current[i]
    if (rel == null) return undefined
    const h = paraHeight.current[i] ?? 0
    return rel + fraction * h
  }

  // Extracted so the inline Prev/Next-table row (below) can jump between
  // tables directly, without going through the imperative ref -- this
  // component already IS the thing that owns paraRefs/scrollRef.
  const scrollToParaIndex = (i: number) => {
    const el: any = paraRefs.current[i]
    if (!el) return
    if (Platform.OS === 'web') {
      const node = (el as any)?.scrollIntoView ? el : (el as any)?._nativeTag ? null : el
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return
      }
    }
    const y = paraRelY.current[i] ?? 0
    scrollRef?.current?.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
  }

  // All table-paragraph indices in this body, in document order -- lets
  // each rendered TableGrid show "Table 2 of 3" and jump directly to its
  // neighbors. RC: "even in FARs, find an easy way for users to quickly
  // jump between T&Fs inside a doc" -- AC/AIM already have this via
  // FigureViewer's Prev/Next Fig chevrons in their popup; FAR's tables
  // render inline (no popup), so the equivalent is right on the table
  // itself instead of in a modal footer.
  const tableParaIndices = useMemo(
    () => paragraphs.map((p, i) => ({ p, i })).filter(({ p }) => parseTableBlock(p) !== null).map(({ i }) => i),
    [paragraphs],
  )

  useImperativeHandle(ref, () => ({
    scrollToParagraph(i: number) {
      scrollToParaIndex(i)
    },
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
      const y = occ != null ? absoluteOccurrenceY(occ.paraIndex, occ.fraction) : undefined
      if (y == null) return
      scroller.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
    },
  }), [occurrences, scrollRef, centerOffset])

  const handlePress = async (seg: { text: string; route: string | null; isFigure?: boolean }) => {
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
      //
      // Match on the NUMBER only, not the raw label text -- confirmed live
      // as a second real bug on AIM 4-3-3: its own prose spells this out as
      // "Figure 4-3-4" while the figure's actual stored label is "FIG
      // 4-3-4" (the AIM source is inconsistent about which word form it
      // uses, paragraph to paragraph, sometimes sentence to sentence). A
      // literal string match ("Figure 4-3-4" !== "FIG 4-3-4") failed even
      // though the figure genuinely belongs to this exact paragraph and
      // was sitting right there in `figures` -- with 6 figures on the page
      // the length===1 fallback couldn't save it either, so it fell all
      // the way through to the unreliable route guess.
      if (onOpenFigure && figures) {
        const segNum = normalizeFigureLabel(seg.text)
        const exact = figures.find((f) => normalizeFigureLabel(f.label ?? '') === segNum)
        if (exact) { onOpenFigure(exact); return }
        if (figures.length === 1) { onOpenFigure(figures[0]); return }
        // Corpus-wide audit found this ISN'T rare: 47 of 393 FIG/TBL
        // mentions across the AIM point at a figure filed under a
        // DIFFERENT paragraph than the one mentioning it. Try a global
        // lookup before giving up and falling through to the route guess.
        // (A further 3 mentions reference figures missing from aim_figures
        // entirely -- a real scraping gap, not a resolution bug -- the
        // route guess is the honest best-effort for those.)
        if (resolveFigureGlobally) {
          const global = await resolveFigureGlobally(seg.text)
          if (global) { onOpenFigure(global); return }
        }
      }
      // None of the three resolution strategies found a real figure. This
      // used to silently fall through to the seg.route guess below, which
      // could land on an unrelated real paragraph that happens to share the
      // cited number (e.g. "FIG 5-4-16" landing on AIM paragraph 5-4-16,
      // a real but unrelated section) -- confirmed as genuinely misleading,
      // not a working fallback: the tap visibly "did something" with no
      // indication the actual figure was never found. Corpus-wide audit
      // confirmed this is a real, permanent gap for a small number of
      // citations (the FAA's own prose sometimes references a figure
      // number that was removed/renumbered in a later AIM revision and
      // no longer exists anywhere in the current edition -- see
      // PROJECT_NOTES). RC, live: "if a fig doesn't exist, we need a
      // disclaimer for it." An honest dead end beats a silent wrong turn.
      confirm({
        title: 'Not available per FAA',
        message: `${seg.text} isn't available in the FAA's current AIM. This isn't a FlyRegs error — the FAA's own text sometimes references a figure from an earlier revision that's since been removed or renumbered, and every one of these has been individually checked against the official AIM.`,
        cancelLabel: null,
      })
      return
    }
    if (seg.route) {
      if (onNavigate) { onNavigate(seg.route); return }
      if (currentLabel) setPendingBreadcrumb(currentLabel)
      router.push(seg.route as any)
    }
  }

  const changedSet = new Set(changedIndices ?? [])

  // Blue left rail + UPDATED tag, matching ACBody's own changed-block
  // treatment so What's Changed looks the same on every content type.
  const withChangedRail = (i: number, node: React.ReactNode) => {
    if (!changedSet.has(i)) return node
    return (
      <View style={[styles.changedWrap, { borderLeftColor: tokens.blu, backgroundColor: tokens.bdim }]}>
        <Text style={[styles.changedTag, { color: tokens.blu, fontSize: fs(9.5) }]}>UPDATED</Text>
        {node}
      </View>
    )
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
          const paraKey = para.trim()
          const isHl = !!highlightedBlockTexts?.has(paraKey)
          const isPending = !isHl && pendingBlockText === paraKey
          return (
            <Pressable
              key={i}
              ref={(el) => { paraRefs.current[i] = el as any }}
              onLayout={(e) => { paraRelY.current[i] = e.nativeEvent.layout.y; paraHeight.current[i] = e.nativeEvent.layout.height }}
              onLongPress={onToggleHighlight ? () => onToggleHighlight(paraKey, i) : undefined}
              delayLongPress={450}
              style={isHl ? styles.highlightWrap : isPending ? styles.pendingWrap : undefined}
            >
              {isHl && <Text style={[styles.highlightTag, { fontSize: fs(9.5) }]}> HIGHLIGHTED </Text>}
              {isPending && <Text style={[styles.pendingTag, { fontSize: fs(9.5) }]}> SELECTED </Text>}
              {withChangedRail(i,
                <Text style={[styles.para, { color: tokens.t2, fontSize: fs(14.5) }]}>
                  {highlightSpans(para, hq, { base: paraBase.get(i) ?? 0, active: activeMatch, redShift })}
                </Text>
              )}
            </Pressable>
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
          // No real FAA TBL/FIG number in the source for this table -- but
          // that does NOT automatically mean captionLines is leftover
          // prose (see looksLikeRealCaption's own comment: AIM 7-1-2's
          // "SPECI Issuance Table" is a real caption with no assigned
          // figure number at all). Only fall back to the synthetic
          // currentLabel identifier when the line actually looks like the
          // tail of some other sentence, e.g. AIM 5-4-16's SOIA table
          // rendering "...The SAP is not published on the IAP." as its
          // "caption" -- keep a genuine short caption as-is, just
          // non-tappable, same as it would be if it happened to start with
          // TBL/FIG but still had no matching figures row.
          const captionLines = labelMatch || looksLikeRealCaption(table.captionLines[0])
            ? table.captionLines
            : currentLabel
              ? [`Table — ${currentLabel}`]
              : ['Table']
          return (
            // RC, live on FAR 91.175: the Table bar showed a real count and
            // a chevron (firstTableParaIndex >= 0) but tapping it did
            // nothing -- this branch returned a bare TableGrid with no
            // ref-capturing wrapper, unlike every other paragraph type
            // below, so paraRefs.current[i] was never set for a table
            // paragraph and scrollToParagraph(i) found `el` undefined and
            // silently no-opped.
            <View
              key={i}
              ref={(el) => { paraRefs.current[i] = el }}
              onLayout={(e) => { paraRelY.current[i] = e.nativeEvent.layout.y; paraHeight.current[i] = e.nativeEvent.layout.height }}
            >
              <TableGrid
                {...table}
                captionLines={captionLines}
                onPress={tableFigure && onOpenFigure ? () => onOpenFigure(tableFigure) : undefined}
              />
              {tableParaIndices.length > 1 && (() => {
                const ord = tableParaIndices.indexOf(i)
                const prevIdx = ord > 0 ? tableParaIndices[ord - 1] : null
                const nextIdx = ord < tableParaIndices.length - 1 ? tableParaIndices[ord + 1] : null
                return (
                  <View style={styles.tableNavRow}>
                    <Pressable
                      style={[styles.tableNavBtn, prevIdx == null && styles.tableNavBtnDisabled]}
                      onPress={() => { if (prevIdx != null) scrollToParaIndex(prevIdx) }}
                      disabled={prevIdx == null}
                    >
                      <Icon name="chevron.left" size={fs(11)} color={prevIdx == null ? tokens.t4 : tokens.blu} />
                      <Text style={{ color: prevIdx == null ? tokens.t4 : tokens.blu, fontSize: fs(12), fontWeight: '600' }}>Prev Table</Text>
                    </Pressable>
                    <Text style={{ color: tokens.t4, fontSize: fs(11.5) }}>{ord + 1} of {tableParaIndices.length}</Text>
                    <Pressable
                      style={[styles.tableNavBtn, nextIdx == null && styles.tableNavBtnDisabled]}
                      onPress={() => { if (nextIdx != null) scrollToParaIndex(nextIdx) }}
                      disabled={nextIdx == null}
                    >
                      <Text style={{ color: nextIdx == null ? tokens.t4 : tokens.blu, fontSize: fs(12), fontWeight: '600' }}>Next Table</Text>
                      <Icon name="chevron.right" size={fs(11)} color={nextIdx == null ? tokens.t4 : tokens.blu} />
                    </Pressable>
                  </View>
                )
              })()}
            </View>
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
        // Detected against the FULL pre-wrap paragraph, not a post-softwrap
        // chunk -- confirmed live as a real bug: softWrapParagraph splits at
        // ~220 chars, and a short header sentence immediately followed by a
        // long one ("Understand Mountain Obscuration. The term Mountain
        // Obscuration (MTOS) is used to describe...") landed the header
        // ALONE in chunk[0] with nothing after it, so leadHeaderMatch's own
        // "must have more text following it" lookahead failed and it never
        // bolded. Stripping it here, before wrapping, means the wrap only
        // ever sees the body text -- header detection can't be split apart
        // by where softWrapParagraph happens to break the paragraph.
        const headerText = leadHeaderMatch(rest)
        const body = headerText ? rest.slice(headerText.length) : rest
        // Purely a display split — see softWrap.ts. A source paragraph
        // with no real internal break (one long run of prose) gets broken
        // into a few shorter visual chunks so it doesn't read as one dense
        // wall on a narrow phone screen; short paragraphs are returned
        // unchanged.
        const chunks = softWrapParagraph(body)
        // Highlighting is keyed per CHUNK, not per raw paragraph -- confirmed
        // live as a real bug (RC, LOI): a source paragraph with no real
        // \n\n break renders as several visually-separate softWrap chunks
        // (each its own <Text> with normal paragraph spacing, indistinguishable
        // on screen from a genuine separate paragraph), but the old long-press
        // wrapped the WHOLE raw paragraph -- so long-pressing one small
        // visual "paragraph" highlighted every chunk sharing its (much
        // bigger) unsplit source blob. Each chunk keeping its own Pressable
        // and its own blockText identity means the highlighted region always
        // matches exactly what the reader sees and pressed on. The paragraph
        // as a whole is still one logical unit for change-tracking (the
        // UPDATED rail below still wraps the group), just not for highlighting.
        const rendered = chunks.map((chunk, ci) => {
          const segments = linkifyText(chunk)
          const chunkKey = chunk.trim()
          const isHl = !!highlightedBlockTexts?.has(chunkKey)
          // Pending: this exact chunk was just long-pressed and the
          // Copy/Highlight menu is showing but not yet resolved -- lets the
          // reader SEE the precise passage about to be affected before
          // choosing, instead of finding out only after tapping Highlight.
          const isPending = !isHl && pendingBlockText === chunkKey
          return (
            <Pressable
              key={`${i}-${ci}`}
              onLongPress={onToggleHighlight ? () => onToggleHighlight(chunkKey, i) : undefined}
              delayLongPress={450}
              style={isHl ? styles.highlightWrap : isPending ? styles.pendingWrap : undefined}
            >
              {isHl && <Text style={[styles.highlightTag, { fontSize: fs(9.5) }]}> HIGHLIGHTED </Text>}
              {isPending && <Text style={[styles.pendingTag, { fontSize: fs(9.5) }]}> SELECTED </Text>}
              <Text style={[styles.para, { color: tokens.t2, fontSize: fs(14.5) }]}>
                {ci === 0 && marker && <Text style={{ fontWeight: '700', color: tokens.t1 }}>{marker} </Text>}
                {ci === 0 && headerText && <Text style={{ fontWeight: '700', color: tokens.t1 }}>{headerText} </Text>}
                {segments.map((seg, j) =>
                  seg.route ? (
                    <Text
                      key={j}
                      onPress={() => handlePress(seg)}
                      style={{ color: tokens.blu, fontWeight: '600' }}
                    >
                      {seg.text}
                    </Text>
                  ) : mnemonicAnchors && mnemonicAnchors.length > 0 ? (
                    splitMnemonicSpans(seg.text, mnemonicAnchors).map((mseg, k) =>
                      mseg.mnemonic ? (
                        <Text key={`${j}-${k}`} style={{ color: tokens.gold, fontWeight: '700' }}>
                          {mseg.text}
                        </Text>
                      ) : (
                        <Text key={`${j}-${k}`}>{mseg.text}</Text>
                      ),
                    )
                  ) : (
                    <Text key={j}>{seg.text}</Text>
                  ),
                )}
              </Text>
            </Pressable>
          )
        })
        return (
          <View
            key={i}
            ref={(el) => { paraRefs.current[i] = el }}
            onLayout={(e) => { paraRelY.current[i] = e.nativeEvent.layout.y; paraHeight.current[i] = e.nativeEvent.layout.height }}
          >
            {withChangedRail(i, <>{rendered}</>)}
          </View>
        )
      })}
    </>
  )
})

const styles = StyleSheet.create({
  changedWrap: { borderLeftWidth: 3, paddingLeft: 10, paddingVertical: 4, borderRadius: 4, marginBottom: 4 },
  changedTag: { fontWeight: '800', letterSpacing: 0.6, marginBottom: 2 },
  // Same yellow highlight treatment as ACBody's own isHighlighted styling --
  // kept as literal hex/rgba (not theme tokens) to match ACBody exactly and
  // stay visible identically in both light and dark mode, same reasoning as
  // ACBody's own comment on these colors.
  highlightWrap: { backgroundColor: 'rgba(255, 213, 0, 0.10)', borderLeftWidth: 3, borderLeftColor: '#FFD500', paddingLeft: 8 },
  highlightTag: { color: '#8a6d00', backgroundColor: 'rgba(255, 213, 0, 0.35)', fontWeight: '800', letterSpacing: 0.6, marginBottom: 2 },
  // Distinct blue (not yet-committed yellow) so a long-pressed passage
  // shows exactly what's about to be highlighted while its Copy/Highlight/
  // Cancel menu is still open -- see pendingBlockText's own comment above.
  pendingWrap: { backgroundColor: 'rgba(59, 130, 246, 0.12)', borderLeftWidth: 3, borderLeftColor: '#3B82F6', paddingLeft: 8 },
  pendingTag: { color: '#1d4ed8', backgroundColor: 'rgba(59, 130, 246, 0.22)', fontWeight: '800', letterSpacing: 0.6, marginBottom: 2 },
  para: { lineHeight: 22, marginBottom: 14 },
  tableNavRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, marginBottom: 14 },
  tableNavBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 4 },
  tableNavBtnDisabled: { opacity: 0.4 },
})
