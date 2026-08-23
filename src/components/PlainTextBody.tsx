import React, { useMemo, useRef, useEffect, useImperativeHandle, RefObject } from 'react'
import { Text, View, ScrollView, Pressable, Platform, StyleSheet, useWindowDimensions, Keyboard } from 'react-native'
import { router } from 'expo-router'
import { useTheme } from '@/context/theme'
import { normalizeRegBody } from '@/lib/regTextFormat'
import { useFS } from '@/context/fontScale'
import { linkifyText, SelfType } from '@/lib/crossRefLinks'
import { TableGrid } from '@/components/TableGrid'
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

// Bare-word markers this regex catches that are real ordinary English
// words, not list letters -- found via a full corpus scan for every
// bare-word marker shape (RC: "these blocks throughout all regs... need
// to have super accurate formatting... check them all"). Corpus-wide,
// this is a single confirmed case (FAR 61.421's entire body is the
// literal text "No. If you hold a flight instructor certificate..." --
// several Part 61 Subpart K sections are titled as a question with the
// answer's own body starting "Yes."/"No."), but a real, visible bug:
// "No." rendered bold as if it were a genuine list marker like "a." or
// "1.", with no actual list to belong to. Every OTHER bare-word marker
// this same scan found (MIL., ANG., USN., PAX., Sea., GLS., LPV., LP.,
// MWA., IFR., VFR.) is a real FAA-source abbreviation-as-list-marker and
// correctly stays bolded -- so this is a small, explicit exclusion, not
// a blanket "no bare words" rule that would break those.
const NON_MARKER_WORDS = new Set(['yes', 'no'])

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

function leadHeaderMatch(s: string, hasMarker: boolean): string | null {
  // Two shapes: "Header. Body text follows..." (lookahead requires more
  // text after it), OR a paragraph that IS just the header with nothing
  // else -- confirmed live: AIM 6-4-1's lost-comms procedure has "Route."
  // and "Altitude." as their OWN standalone paragraphs (the explanatory
  // bullets that follow are separate paragraphs entirely, not more text in
  // the same string), so the lookahead-based pattern can never match --
  // there's nothing after the period to look ahead AT. RC: "those steps
  // should stand out amongst the other text."
  //
  // The whole-paragraph fallback is gated on `!hasMarker` -- confirmed live
  // (robinleabman, real beta tester, FAR 61.107/61.127/61.65): a genuine
  // lettered/numbered list item whose text happens to be short and end in
  // one period ("(xii) Postflight procedures.") matches this fallback's
  // shape just as well as a real standalone label like "Route." does, and
  // was getting bolded as if it were a heading for the NEXT list rather
  // than rendered as an ordinary final item of the list it's actually
  // part of. Every real standalone header in this corpus (Route.,
  // Altitude., General., ...) has no leading marker of its own -- a marked
  // item's remaining text, however short, is that item's own content, not
  // a label for something else, so the fallback never applies once a
  // marker was already stripped off this paragraph.
  const m = s.match(/^([A-Z][^.]{1,42}\.)\s+(?=[A-Z"“])/) ?? (hasMarker ? null : s.match(/^([A-Z][^.]{1,42}\.)$/))
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
/** 49 CFR's own footnote-intro convention -- "Note 1 to § 175.75(f):" on its
 * own line, followed by the footnote's body text -- a different shape from
 * FOOTNOTE_LINE_RE above (confirmed: zero far_sections rows match this
 * pattern, so it's genuinely cfr49-specific, not a FAR/AIM convention this
 * should already have covered). Without this, § 175.75's real table (2
 * footnotes, 7 lettered sub-items) fell through to the row-continuation
 * branch below -- "a. Class 3, PG III..." etc. all matched LEADING_MARKER_RE
 * and got glued onto the table's LAST data row's last cell as one giant
 * run-on block, rendering as a mostly-blank oversized cell. */
const NOTE_TO_SECTION_RE = /^Note\s+\d+\s+to\s+§/

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
      if (FOOTNOTE_LINE_RE.test(raw) || NOTE_TO_SECTION_RE.test(raw)) {
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

/** A bare rule line: 10+ dashes, nothing else (Federal Register/eCFR
 * plain-text table divider -- see regTextFormat.ts's TABLE_RULE_LINE,
 * which protects this paragraph's newlines so the rule survives to reach
 * here intact). */
const AD_RULE_RE = /^-{10,}$/
/** A table data row: a short label, a run of 4+ dots (the fixed-width
 * era's "leader" convention for a value about to appear far to the
 * right), then the value's own first physical line. 4+ specifically --
 * shorter dot runs show up inside ordinary prose ("a partial list...
 * etc.") and would false-positive on a normal paragraph that merely
 * trails off. */
const AD_ROW_RE = /^(\S.*?)\.{4,}\s*(.*)$/
/** A SECOND run of 4+ spaces or 4+ dots inside what looks like a row's own
 * value is the signature of a THIRD (or later) column this parser doesn't
 * model -- confirmed live, AD 2008-15-06's real "Model | Serial Nos. |
 * Year manufactured" table: blindly capturing "everything after the first
 * dot-leader" as ONE value silently welds column 3's data onto column
 * 2's. Bailing out (falls back to plain-paragraph rendering, where the
 * dash rules still get stripped) beats guessing at a boundary with no
 * real signal for where it is -- see regTextFormat.ts's own "Data Is
 * King" framing; a wrong table is worse than a plain one. */
const AD_HIDDEN_COLUMN_RE = /( {4,}|\.{4,})/
/** No legitimate wrapped cell in the validated corpus sample came close to
 * this -- the longest real one (a muffler's serial-number range list) was
 * ~150 chars. A cell this long is a sign the row-continuation heuristic
 * swallowed unrelated prose that followed the table in the source, not
 * real tabular data -- confirmed live, AD 2015-19-02's 5-column
 * maintenance-task table (a shape this parser doesn't attempt) produced a
 * single "row" whose value ran thousands of characters before this guard
 * was added. */
const AD_MAX_CELL_LEN = 500

/** Reconstructs a 2-column header from its own physical lines. Lines can
 * be INTERLEAVED across columns -- confirmed live, AD 2018-02-04's Figure
 * 2: column 1's entire header ("Muffler part No.") sits on the MIDDLE of
 * 3 physical lines, sandwiched inside column 2's own 3-line-wrapped
 * header ("Textron Aviation Inc. (type / certificate previously held by
 * Cessna / Aircraft Company) airplanes") -- joining fragments by LINE
 * order instead of by COLUMN produces a garbled read ("Muffler part No.
 * Textron Aviation Inc...."). Splits each line at the real word-gap (2+
 * spaces) nearest col2Offset rather than a blind character cut, because a
 * header routinely does NOT start at the same column as its own data (a
 * short numeric value vs. a longer text header) -- cutting at the data's
 * exact offset can land mid-word: confirmed live, AD 2002-22-13's real
 * "Affected FMC Collins part No." header split into "...Coll" / "ins..."
 * before this search-for-a-gap approach replaced a blind offset cut. When
 * a line can't be confidently assigned to one side (content spans the
 * search window with no clean gap), the WHOLE header is dropped (returns
 * null) rather than risk a wrong or word-mangled label -- TableGrid
 * already renders a real, supported "no header" grid for exactly this,
 * and losing a header is a smaller loss than shipping a wrong one. */
function buildADHeader(headerLines: string[], col2Offset: number): string[] | null {
  if (headerLines.length === 0) return null
  if (headerLines.length === 1) {
    const parts = headerLines[0].split(/ {2,}/).map((s) => s.trim()).filter(Boolean)
    return parts.length === 2 ? parts : null
  }
  const col1Parts: string[] = []
  const col2Parts: string[] = []
  const window = 25
  for (const hl of headerLines) {
    let left: string
    let right: string
    let best: { start: number; end: number } | null = null
    for (const g of hl.matchAll(/ {2,}/g)) {
      const start = g.index!
      const end = start + g[0].length
      const mid = (start + end) / 2
      if (mid < col2Offset - window || mid > col2Offset + window) continue
      if (!best || Math.abs(mid - col2Offset) < Math.abs((best.start + best.end) / 2 - col2Offset)) {
        best = { start, end }
      }
    }
    if (best) {
      left = hl.slice(0, best.start).trim()
      right = hl.slice(best.end).trim()
    } else if (hl.length <= col2Offset) {
      left = hl.trim()
      right = ''
    } else if (!hl.slice(0, col2Offset).trim()) {
      left = ''
      right = hl.trim()
    } else {
      return null
    }
    if (left) col1Parts.push(left)
    if (right) col2Parts.push(right)
  }
  return col1Parts.length > 0 || col2Parts.length > 0 ? [col1Parts.join(' '), col2Parts.join(' ')] : null
}

/** Parses the Federal-Register/eCFR fixed-width table shape AD
 * applicability/compliance text uses (dash rules + dot-leader columns) --
 * a completely different source convention from AIM/FAR's HTML-table-
 * derived pipe format parseTableBlock (above) handles, so this is a
 * separate function rather than a branch inside it. Deliberately scoped
 * to clean 2-column tables ONLY, the dominant real shape -- validated
 * against the full corpus of 518 AD documents carrying this pattern
 * before shipping (210 parsed cleanly with real, sensible headers and
 * data; every rejected case was independently confirmed to be a genuinely
 * harder shape -- a 3+ column table, or a headerless token grid -- not a
 * false rejection). A table this doesn't recognize falls through to the
 * ordinary paragraph path below, which still strips the bare dash rules
 * (regTextFormat.ts's isTabular fix means they now survive as isolated
 * lines that reach that strip) -- so even the decline path is a strict
 * improvement over the prior raw-dashes rendering, never a regression. */
function parseADFigureTable(para: string): ParsedTable | null {
  const lines = para.split('\n')
  const ruleIdxs = lines.map((l, i) => (AD_RULE_RE.test(l.trim()) ? i : -1)).filter((i) => i >= 0)
  if (ruleIdxs.length < 3) return null
  const [r0, r1] = ruleIdxs
  const rLast = ruleIdxs[ruleIdxs.length - 1]

  const captionLines = lines.slice(0, r0).map((l) => l.trim()).filter(Boolean)
  const headerLines = lines.slice(r0 + 1, r1).filter((l) => l.trim())
  const bodyLines = lines.slice(r1 + 1, rLast)

  const rows: string[][] = []
  let col2Offset: number | null = null
  for (const raw of bodyLines) {
    if (!raw.trim()) continue
    const m = raw.match(AD_ROW_RE)
    if (m) {
      const value = m[2]
      if (AD_HIDDEN_COLUMN_RE.test(value)) return null
      if (col2Offset === null) col2Offset = raw.length - value.length
      rows.push([m[1].trim(), value.trim()])
    } else if (rows.length > 0 && /^\s/.test(raw)) {
      const lastRow = rows[rows.length - 1]
      lastRow[lastRow.length - 1] = `${lastRow[lastRow.length - 1]} ${raw.trim()}`
    } else {
      return null
    }
  }
  if (rows.length === 0 || col2Offset === null) return null
  if (rows.some((r) => r.length !== 2 || r[0].length > AD_MAX_CELL_LEN || r[1].length > AD_MAX_CELL_LEN)) return null

  return {
    captionLines: captionLines.length > 0 ? captionLines : ['Table'],
    headerCells: buildADHeader(headerLines, col2Offset),
    rows,
    footnotes: [],
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
  /** Required, not optional -- gates seg.route taps (inline cross-reference
   * links matched by crossRefLinks.ts, e.g. "14 CFR section 91.123" inside
   * ordinary AIM body text) the same way MagicLinkPod's own expand/tap
   * already is. Confirmed live as a real gap: this is a completely
   * separate mechanism from MagicLinkPod, reachable on every screen that
   * renders body text at all -- even the FREE-tier FAR/AIM/PCG screens,
   * since any of THEIR body text can contain a citation to a Plus/Pro-
   * gated AC/AD/LOI. The convenience of a tappable cross-reference is the
   * paywalled thing, not the destination's own tier -- required (not
   * optional-defaulting-to-allowed) so a future caller can't add a new
   * PlainTextBody render site and silently skip this gate by omission. */
  hasProAccess: boolean
  /** This screen's own display label -- set as the "back to X" breadcrumb
   * right before an in-doc hyperlink jumps elsewhere, same mechanism as
   * MagicLinkPod's currentLabel prop. */
  currentLabel?: string
  /** Which title this body text's own bare "§ N.N" citations belong to --
   * see crossRefLinks.ts's SelfType comment. Omit for every content type
   * except cfr49/[id].tsx, which passes 'cfr49' so a 49 CFR section's own
   * bare-§ self-citations route to /cfr49/N.N instead of /far/N.N. */
  selfType?: SelfType
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
  /** The parent screen's own tracked ScrollView scroll offset (it already
   * reads this via onScroll for its "return to top" button) -- used to
   * figure out which table/figure the reader has actually scrolled to, so
   * onActiveTableChange can report a stable "current" one instead of every
   * table on the page at once. */
  scrollY?: number
  /** Fires whenever the "currently viewed" table changes (including to
   * null, when the reader hasn't scrolled to any table yet, or scrolls
   * back above the first one) -- lets the PARENT screen render a single
   * Prev/Next-Table control near the bottom of the page, stacked above its
   * own doc-level Prev/Next footer, instead of this component rendering
   * one inline after every table. RC, real device: "those Prev/Next T&F
   * buttons... right now they're in the middle of the screen. Place them
   * down near the bottom... they would only show when a T&F has already
   * been selected to view." Omit both this and scrollY to get the old
   * behavior of simply never surfacing a table nav at all (no screen
   * should do that today, but keeps the prop optional/backward-safe). */
  onActiveTableChange?: (info: { ord: number; total: number; prevIndex: number | null; nextIndex: number | null } | null) => void
}>(function PlainTextBody({ text, figures, onOpenFigure, resolveFigureGlobally, onNavigate, hasProAccess, currentLabel, selfType, highlightQuery, activeMatch, onMatchCount, scrollRef, viewportHeight, changedIndices, mnemonicAnchors, highlightedBlockTexts, onToggleHighlight, pendingBlockText, scrollY, onActiveTableChange }, ref) {
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
  // Memoized on `text` alone -- this used to recompute (a new array, same
  // content) on EVERY render, which was harmless while nothing depended on
  // its IDENTITY. Once tableParaIndices' own useMemo below started keying
  // off this array, that constant identity-churn defeated ITS memoization
  // too, and the onActiveTableChange effect further down (which depends on
  // tableParaIndices) fired every single render -- calling the parent's
  // setState, which re-renders this component, which recomputes a new
  // `paragraphs` array again. Real bug, caught live: React's "Maximum
  // update depth exceeded" in the browser preview the moment a table
  // scrolled into view and the bar first tried to appear.
  const paragraphs = useMemo(
    () => normalizeRegBody(text).split(/\n\n+/).filter((p) => p.trim()),
    [text],
  )

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
    () => paragraphs.map((p, i) => ({ p, i })).filter(({ p }) => parseTableBlock(p) !== null || parseADFigureTable(p) !== null).map(({ i }) => i),
    [paragraphs],
  )

  // Which table counts as "currently viewed" for the parent's bottom nav
  // bar -- the LAST table whose top edge the reader has scrolled to or
  // past, i.e. classic scrollspy logic. Recomputed on every scroll tick
  // (paraRelY is a ref, so this reads whatever's most current each time,
  // not stale values from when the effect was created) using the same
  // paraRelY layout measurements scrollToParaIndex already relies on.
  // Deliberately reports null (hides the bar) until the reader has
  // actually scrolled to the first table -- RC: "they would only show
  // when a T&F has already been selected to view."
  const lastReportedTableRef = useRef<string | null>('unset')
  useEffect(() => {
    if (!onActiveTableChange) return
    if (tableParaIndices.length <= 1) {
      if (lastReportedTableRef.current !== null) { lastReportedTableRef.current = null; onActiveTableChange(null) }
      return
    }
    const y = scrollY ?? 0
    let activeOrd: number | null = null
    for (let k = 0; k < tableParaIndices.length; k++) {
      const relY = paraRelY.current[tableParaIndices[k]]
      if (relY != null && relY <= y + 60) activeOrd = k
    }
    if (activeOrd == null) {
      if (lastReportedTableRef.current !== null) { lastReportedTableRef.current = null; onActiveTableChange(null) }
      return
    }
    const info = {
      ord: activeOrd,
      total: tableParaIndices.length,
      prevIndex: activeOrd > 0 ? tableParaIndices[activeOrd - 1] : null,
      nextIndex: activeOrd < tableParaIndices.length - 1 ? tableParaIndices[activeOrd + 1] : null,
    }
    // Belt-and-suspenders against re-triggering: even with `paragraphs` now
    // properly memoized above, this guard means a future caller passing a
    // fresh onActiveTableChange closure each render (e.g. an inline arrow
    // fn instead of a stable setState) still can't loop -- the callback
    // only ever fires when the reported VALUE actually changes.
    const key = `${info.ord}|${info.total}|${info.prevIndex}|${info.nextIndex}`
    if (lastReportedTableRef.current === key) return
    lastReportedTableRef.current = key
    onActiveTableChange(info)
  }, [scrollY, tableParaIndices, onActiveTableChange])

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
      // FIG 4-3-8/4-3-9/4-3-10 mentions all match real labels here).
      //
      // Match on the NUMBER only, not the raw label text -- confirmed live
      // as a real bug on AIM 4-3-3: its own prose spells this out as
      // "Figure 4-3-4" while the figure's actual stored label is "FIG
      // 4-3-4" (the AIM source is inconsistent about which word form it
      // uses, paragraph to paragraph, sometimes sentence to sentence). A
      // literal string match ("Figure 4-3-4" !== "FIG 4-3-4") failed even
      // though the figure genuinely belongs to this exact paragraph and
      // was sitting right there in `figures`.
      //
      // RC, live, AIM 2-1-6: this paragraph's own prose cites FIG 2-1-9,
      // FIG 2-1-10, AND FIG 2-1-11, but `figures` (this paragraph's own
      // aim_figures rows) only has FIG 2-1-9 -- 2-1-10 and 2-1-11 are real
      // rows, just filed under paragraph 2-1-8 instead. The `length===1`
      // fallback used to run BEFORE the global lookup, so it fired the
      // instant the exact match failed and silently routed BOTH "FIG
      // 2-1-9" and "FIG 2-1-10" to the same lone 2-1-9 figure. Global
      // lookup now runs first -- it matches on the cited NUMBER across the
      // whole corpus regardless of which paragraph a figure is filed
      // under, so "FIG 2-1-10" correctly finds the real 2-1-10 row instead
      // of getting steamrolled by "well there's only one figure on this
      // page." `length===1` is now a true last resort, for citations whose
      // number genuinely doesn't resolve anywhere (a phrasing/OCR mismatch
      // rather than a different-paragraph filing) but the page unambiguously
      // has exactly one figure to fall back on.
      if (onOpenFigure && figures) {
        const segNum = normalizeFigureLabel(seg.text)
        const exact = figures.find((f) => normalizeFigureLabel(f.label ?? '') === segNum)
        if (exact) { onOpenFigure(exact); return }
        // Corpus-wide audit found this ISN'T rare: 47 of 393 FIG/TBL
        // mentions across the AIM point at a figure filed under a
        // DIFFERENT paragraph than the one mentioning it. (A further 3
        // mentions reference figures missing from aim_figures entirely --
        // a real scraping gap, not a resolution bug -- the route guess
        // below is the honest best-effort for those.)
        if (resolveFigureGlobally) {
          const global = await resolveFigureGlobally(seg.text)
          if (global) { onOpenFigure(global); return }
        }
        if (figures.length === 1) { onOpenFigure(figures[0]); return }
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
      if (!hasProAccess) { router.push('/paywall?tier=pro' as any); return }
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
        // Checked BEFORE the search-mode bypass below, deliberately -- RC,
        // real device, FAR 91.175: "when i tap the T&F in 91.175, it brings
        // up a well-formatted RVR table. BUT, when i do an in doc search...
        // the table is very poorly formatted." Root cause: the search
        // bypass used to run unconditionally, so ANY visible table in the
        // document collapsed to raw "1,600 | ¼"-style pipe-delimited plain
        // text the instant in-doc search had ANY query typed anywhere --
        // not just when the match was inside that table. Computing `table`
        // first and routing table paragraphs around the bypass keeps every
        // table rendering as a real TableGrid throughout a search session;
        // the only real loss is that a match landing INSIDE a table's own
        // text won't get its own inline highlight (search can still find
        // and scroll to it) -- a reasonable trade against destroying the
        // table's actual structure. Corpus-wide: this affects every
        // FAR/AIM/AD/P-CG/LOI/49-CFR page with a real table (ACBody has no
        // equivalent bug -- confirmed live, it never calls parseTableBlock/
        // TableGrid at all; its own AC tables come from pre-parsed
        // pdf_blocks, a structurally different mechanism this doesn't touch).
        const table = parseTableBlock(para) ?? parseADFigureTable(para)
        // While actively searching, render the whole paragraph as one
        // highlighted plain-text block -- same simplification ACBody
        // already makes (see its own render switch): skip marker/
        // softWrap-chunk handling and crossRefLinks hyperlinking, since
        // stacking search highlighting on top of them isn't worth the
        // complexity for what's a temporary interaction mode. Tables are
        // excluded from this simplification (see the comment above).
        if (hq && !table) {
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
              // This branch only renders while in-doc search is active (hq
              // set, see this render's own `hq` derivation above) -- RC,
              // real device: "tap to dismiss stopped working... when using
              // indoc search." Root cause: this Pressable's onLongPress
              // alone was enough to make the ScrollView's own
              // keyboardShouldPersistTaps="handled" treat every tap here as
              // "a Touchable handled this," which correctly lets the
              // search bar's own prev/next buttons keep working with the
              // keyboard up -- but a PLAIN tap on ordinary body text used
              // to do nothing at all, silently eating the tap instead of
              // ever reaching the native "tap outside dismisses keyboard"
              // behavior it used to fall through to before this Pressable
              // wrapper existed. An explicit onPress restores that.
              onPress={() => Keyboard.dismiss()}
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
            </View>
          )
        }
        const cleaned = para
          .replace(TABLE_HEADER_MARK_RE, '')
          // Strips Federal-Register-style plain-text table border rules
          // (long dash runs used as row/section separators in AD
          // applicability text, e.g. "----...----") -- pure visual noise
          // carried over verbatim from the raw source, never real content.
          // By the time a table paragraph reaches HERE, parseADFigureTable
          // above has already tried and declined it (a real table renders
          // as a TableGrid instead, never reaching this branch) -- this is
          // just the backstop for the harder shapes that parser doesn't
          // attempt (3+ columns, headerless token grids), so at minimum
          // the reader gets clean prose instead of raw dashes. Safe to
          // strip broadly -- FAR/AIM/AC never produce a line of bare
          // dashes in their own body text.
          .replace(/^[ \t]*-{10,}[ \t]*$/gm, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        const m = cleaned.match(LEADING_MARKER_RE)
        // NON_MARKER_WORDS guard: a bare-word match ("No.", not "(a)") whose
        // word is really ordinary English, not a list letter -- see that
        // constant's own comment. Real markers ("(a)", "1.", "MIL.") pass
        // through unaffected; only this small excluded set falls through to
        // "no marker found" and keeps its original text intact.
        const isRealMarker = !!m && (m[1].startsWith('(') || !NON_MARKER_WORDS.has(m[1].slice(0, -1).toLowerCase()))
        const marker = isRealMarker ? m![1] : null
        const rest = isRealMarker ? cleaned.slice(m![0].length) : cleaned
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
        const headerText = leadHeaderMatch(rest, marker !== null)
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
          const segments = linkifyText(chunk, selfType)
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
})
