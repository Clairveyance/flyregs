import { softWrapParagraph } from '@/lib/softWrap'

// Makes scraped regulation text readable by humans.
//
// The source documents are Federal Register / eCFR plain text, and they carry
// typesetting artifacts from a fixed-width print era. Measured across the
// whole corpus (not sampled):
//
//                        AD      LOI     FAR     AIM
//   stray "0" markers    95%      1%      0%      0%
//   hard-wrapped lines   99%     99%     48%      2%
//   4+ space indents    100%      6%      0%      0%
//   double spaces       100%     25%      0%      0%
//   [[Page NNNN]]        81%      0%      0%      0%
//   trailing space+NL   100%     82%      0%      0%
//
// So this is overwhelmingly an AD problem, meaningfully an LOI one, partly a
// FAR one, and a non-issue for AIM — but it runs on all of them because the
// transforms are no-ops on already-clean text, and one shared path means
// there is no per-type behaviour to drift.
//
// The worst offender is the hard wrap: the source breaks lines at ~70 columns
// mid-sentence, so "Amendment 39-22171 \n(87 FR 68891, November 17, 2022)"
// rendered as two ragged lines. Rejoining those is what turns the body from a
// column of fragments back into paragraphs.
//
// Applied at RENDER time in PlainTextBody (used by all five reg detail
// screens), not by rewriting the database: the original text stays intact as
// the system of record, every document is covered including ones scraped next
// week, and there is no backfill to run or get half-finished.

/** Federal Register page markers, which land mid-sentence. */
const PAGE_MARK = /\[\[Page\s+[^\]]*\]\]/gi

/** A line that is just "0" — a mangled list bullet from the FR source. It
 * appears immediately before real numbered items ("0\n1. The authority
 * citation..."), so it is noise, not content. */
const STRAY_MARKER = /^\s*0\s*$/

/** Lines that must always begin their own line: lettered/numbered items and
 * section headings. Without this, "(2) This AD affects..." would get glued
 * onto the end of item (1). */
const STRUCTURAL_START =
  /^\s*(\((?:[a-z]{1,3}|[0-9]{1,3}|[ivxl]{1,5})\)|[0-9]{1,3}\.|[a-z]\.|PART\s|Sec\.|Authority:|SUMMARY:|DATES:|ADDRESSES:)/i

/** True when a line ends a sentence/clause, so the next line is a new thought
 * rather than a continuation of this one. */
function endsThought(line: string): boolean {
  // ";" is deliberately NOT terminal. The FR source wraps long citations
  // across a semicolon ("Docket No. FAA-2024-0770; \n Project Identifier
  // MCAI-2024-00039-T."), and treating it as an ending left those split.
  // Semicolon-separated LIST items are still safe, because the next item
  // starts with "(2)"/"b." and is caught by STRUCTURAL_START instead.
  return /[.!?:]["')\]]?$/.test(line.trimEnd())
}

/** Table paragraphs are pipe-delimited and their line structure IS the data —
 * joining them would destroy the table. \ue000 is PlainTextBody's own
 * private-use header sentinel (TABLE_HEADER_MARK); a paragraph carrying it is
 * a table even if the pipes appear only on later lines. Exported -- also the
 * canonical source for whatsChanged.ts's own stripping, which previously had
 * no marker-handling at all and rendered this raw, invisible-in-most-fonts
 * character straight to the screen (confirmed live 2026-08-02, RC-reported
 * glyph artifact in a What's Changed diff row). */
export const TABLE_HEADER_MARK = '\ue000'
/** A bare "----...----" rule line (10+ dashes, nothing else) -- the
 * Federal Register/eCFR plain-text convention for a table's row/section
 * divider (see PlainTextBody.tsx's parseADFigureTable). Needs the same
 * newline-preserving treatment as the pipe check below: a bare dash line
 * doesn't end in terminal punctuation, so by this file's own hard-wrap
 * rule it reads as just another wrapped fragment and gets silently glued
 * onto the caption line above it -- confirmed live, AD 2018-02-04's
 * Figure 1/2 tables rendered raw dashes because of exactly this, despite
 * an existing stripping regex downstream that assumed the rule would
 * still be alone on its own line by the time it ran. */
const TABLE_RULE_LINE = /^[ \t]*-{10,}[ \t]*$/m

/** How large a paragraph can be and still let a bare TABLE_RULE_LINE alone
 * flip it to tabular. Calibrated against the whole AD corpus, not guessed:
 * a scan of every AD paragraph corpus-wide that contains a rule line but
 * ISN'T one of the 59 documents scripts/audit_reg_formatting.mjs flags as
 * having a pathological oversized paragraph found every GENUINE rule-line-
 * bounded table paragraph tops out at 5,996 chars -- the SMALLEST of the 59
 * flagged paragraphs is 6,042 chars. A real, if narrow, gap between the two
 * populations, not an arbitrary round number picked out of a continuum.
 *
 * Why this exists at all: a bare rule line is a much weaker, more ambiguous
 * signal than ' | ' or TABLE_HEADER_MARK below -- it also marks ordinary
 * Federal-Register SECTION boundaries (a "PART 39--AIRWORTHINESS
 * DIRECTIVES" header rule, or the divider before the next amendment further
 * down the same body_text blob), not just a table's own fence. Confirmed
 * live, AD 2015-19-04: a single rule line sitting at line 148 of 149
 * (essentially the very last line -- a section-end divider) was enough to
 * flag the ENTIRE preceding 16,078-char numbered checklist as "tabular,"
 * which skipped line-joining/space-collapsing for all of it and rendered
 * the FAA's hard-wrapped source as raw ragged fragments with huge
 * leading-whitespace runs on every continuation line -- completely
 * unreadable. A genuine table's rule lines bound a compact region (header
 * rule, rows, footer rule); they don't legitimately span 15,000+ characters
 * of otherwise ordinary checklist prose.
 *
 * Tried and rejected: gating on rule lines sitting close TOGETHER instead
 * of on overall paragraph size (protect only when two rule-line matches are
 * near each other, wherever in the paragraph they fall -- the intuition
 * being a real table's header/footer rules should be close together no
 * matter how long the surrounding paragraph is). Checked against the real
 * 55 broken paragraphs this fix targets and it does NOT hold: 49 of the 55
 * have their own rule lines only ~140-900 chars apart -- they're incidental
 * FR boilerplate rules bracketing a short docket/agency block near the top
 * of the body, not a table's fence, so "close together" fired anyway and
 * would have left 49 of 55 unfixed. Plain paragraph SIZE is what actually,
 * cleanly separates genuine tables from this bug in the real corpus. */
const TABLE_RULE_MAX_CHARS = 6000

function isTabular(para: string): boolean {
  // ' | ' and TABLE_HEADER_MARK are unambiguous, deliberately-emitted table
  // signals (see their own comments) -- genuine large pipe-tables exist
  // (FAR 171.311, FAR 61.313) and must stay protected regardless of size,
  // so only the weaker rule-line signal above gets a size cutoff.
  if (para.includes(' | ') || para.includes(TABLE_HEADER_MARK)) return true
  return TABLE_RULE_LINE.test(para) && para.length <= TABLE_RULE_MAX_CHARS
}

function normalizeParagraph(para: string): string {
  if (isTabular(para)) return para

  const lines = para
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/^\s+/, ''))
    .filter((l) => !STRAY_MARKER.test(l))

  if (lines.length === 0) return ''

  const out: string[] = []
  for (const line of lines) {
    const prev = out[out.length - 1]
    const canJoin =
      prev !== undefined &&
      prev.length > 0 &&
      !endsThought(prev) &&
      !STRUCTURAL_START.test(line)
    if (canJoin) {
      out[out.length - 1] = `${prev} ${line}`
    } else {
      out.push(line)
    }
  }
  return out.join('\n')
}

/**
 * Normalizes a whole document body. Paragraph breaks (blank lines) are
 * preserved; everything inside a paragraph is de-wrapped and cleaned.
 */
export function normalizeRegBody(raw: string | null | undefined): string {
  if (!raw) return ''
  const cleaned = raw
    .replace(PAGE_MARK, ' ')
    // Non-breaking spaces come through the scrape and defeat the space
    // collapsing below if left alone.
    .replace(/ /g, ' ')

  return cleaned
    .split(/\n\s*\n+/)
    .map(normalizeParagraph)
    .filter((p) => p.trim().length > 0)
    // Collapse runs of spaces LAST, after joins have introduced their own —
    // but never inside tabular paragraphs, whose alignment is meaningful.
    .map((p) => (isTabular(p) ? p : p.replace(/ {2,}/g, ' ')))
    .flatMap((p) => (isTabular(p) ? [p] : splitIntoParagraphs(p)))
    .join('\n\n')
}

/** Matches the boundary right after a sentence ends and right before an
 * inline enumerated sub-item begins. Two distinct marker styles seen in the
 * corpus, both handled:
 *  - "...several causes. (1) Constructive interference." -- parenthesized,
 *    space after. Deliberately narrower than STRUCTURAL_START (which only
 *    ever looks at true line starts): here there may be no line to start
 *    from, so this only fires directly after terminal punctuation, never
 *    on parentheses used for a citation or an aside ("(or as amended)")
 *    that merely happens to contain a short token.
 *  - "...to an AD. b.This AC includes..." -- bare letter+period, AND (the
 *    load-bearing part) glued directly to the next word with no space at
 *    all. That "glued" shape is what makes this safe to detect: "e.g."/
 *    "i.e." are always followed by a space before the next word, so they
 *    never match, but a scraped list letter that lost its following space
 *    always does.
 * Lookahead only (no lookbehind) -- keeps this safe on every JS engine
 * this app ships on, native Hermes included. */
const INLINE_ENUM_BREAK = /([.!?])\s+(?=\((?:[0-9]{1,2}|[a-z])\)\s|[a-z]\.(?=[A-Z]))/g

/**
 * Some source text -- dictionary/handbook glossary definitions especially,
 * but also the occasional reg paragraph -- arrives as a single flat run
 * with NO embedded newlines at all, even when it plainly contains an
 * enumerated list ("...several possible causes. (1) Constructive
 * interference. ... (2) Focusing of wave energy. ..."). Confirmed live
 * (NOAA glossary "Rogue Wave" entry, verbatim in the DB): RC, "everything
 * needs to be broken up... this exists many places corpus wide."
 *
 * Splits such text into real paragraphs without changing a single word --
 * the FAA/NOAA/etc source stays byte-for-byte intact as the system of
 * record (same non-negotiable as normalizeRegBody above); this only ever
 * decides WHERE to break, never what the words say. If real paragraph
 * breaks already exist, those are respected as-is and the inline heuristic
 * is skipped entirely, so already-well-formed text is never double-broken.
 */
export function splitIntoParagraphs(raw: string | null | undefined): string[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (/\n\s*\n/.test(trimmed)) {
    return trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean)
  }
  return trimmed
    .replace(INLINE_ENUM_BREAK, '$1\n\n')
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * splitIntoParagraphs only breaks at a REAL structural signal (an existing
 * blank line, or an inline enumerated marker like "(1)"/"b."). A definition
 * that's one long run of ordinary sentences with neither -- confirmed live,
 * P/CG "CRUISE" (RC, 2026-08-06: "ALL big chunky paragraphs, ANYWHERE in
 * this entire app corpus, must be spaced and formatted well") -- comes back
 * as a single untouched block and still reads as a wall of text. This adds
 * softWrapParagraph's purely-visual sentence-boundary chunking (already
 * used by PlainTextBody/ACBody for FAR/AIM/AC body text) on top, so every
 * screen that renders a short, standalone text field this way gets the
 * same readability treatment for free. Deliberately a SEPARATE export, not
 * baked into splitIntoParagraphs itself -- normalizeRegBody below calls the
 * plain version internally as part of FAR/AIM/AC's table-detection
 * pipeline, where extra visual breaks could split a table block's own
 * \n-joined rows apart before parseTableBlock ever sees it; this wrapper is
 * only for call sites rendering a single flat text field with no table
 * structure to protect (P/CG/AC-description/AD-summary/LOI-summary/
 * DailyReg/dictionary definitions -- see each screen's own call site).
 */
export function splitIntoDisplayParagraphs(raw: string | null | undefined): string[] {
  return splitIntoParagraphs(raw).flatMap((p) => softWrapParagraph(p))
}

// ---------------------------------------------------------------------------
// Table-block parsing. Moved here from PlainTextBody.tsx (which still does
// all the on-screen TableGrid rendering) so printReg.ts's export path can
// build a real <table> from the EXACT same row/header/footnote parsing the
// screen uses, instead of re-deriving its own approximation that could
// quietly drift from it. Pure string logic -- no React/RN dependency either
// way -- so it belongs alongside isTabular/TABLE_HEADER_MARK above, the
// other half of "how a table paragraph is recognized and read."

/** Matches a leading list marker: "(a)", "(1)", "a.", "1." -- also used
 * below by parseTableBlock to tell a genuine row-continuation fragment (a
 * wrapped lettered sub-item) apart from a bare label/group-header line. */
export const LEADING_MARKER_RE = /^(\([a-zA-Z0-9]{1,4}\)|[a-zA-Z0-9]{1,3}\.)\s+/

/** One parsed pipe/dash-delimited table -- the shared shape both the
 * on-screen TableGrid renderer and printReg.ts's HTML export build from. */
export interface ParsedTable {
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
 * rule (see each render call site's own comment) was throwing that real
 * caption away right alongside genuinely-leftover prose. The distinguishing
 * signal: leftover prose is always the TAIL of some other sentence, so it
 * ends in sentence-ending punctuation (a period, colon, or comma) or runs
 * long; a real standalone caption doesn't. */
export function looksLikeRealCaption(line: string | undefined): boolean {
  if (!line) return false
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.length > 60) return false
  return !/[.:,;]$/.test(trimmed)
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
export function parseTableBlock(para: string): ParsedTable | null {
  // A single-cell <thead> that spans every column (e.g. one <th colspan=4>
  // "Meaning"</th> sitting over 4 real columns) has no " | " of its own —
  // it's one cell, nothing to join — so it doesn't land in pipedLines
  // below, but it's still marked and must not leak the marker character
  // into the caption text it ends up rendered as. Strip on every line up
  // front rather than only the ones this function treats as piped.
  const lines = para.split('\n').map((l) => l.split(TABLE_HEADER_MARK).join('').trim()).filter(Boolean)
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
      // numbered marker PlainTextBody also bolds at a real paragraph's own
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
 * plain-text table divider -- see TABLE_RULE_LINE above, which protects
 * this paragraph's newlines so the rule survives to reach here intact). */
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
 * real signal for where it is -- see this file's own "Data Is King"
 * framing; a wrong table is worse than a plain one. */
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
 * ordinary paragraph path (each render call site's own fallback), which
 * still strips the bare dash rules (isTabular's fix above means they now
 * survive as isolated lines that reach that strip) -- so even the decline
 * path is a strict improvement over the prior raw-dashes rendering, never
 * a regression. */
export function parseADFigureTable(para: string): ParsedTable | null {
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
