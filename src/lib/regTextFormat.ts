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
