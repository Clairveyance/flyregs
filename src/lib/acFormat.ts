// Reformats raw FAA Advisory Circular PDF text into structured, mobile-readable
// blocks. FAA ACs follow a consistent grammar — CHAPTER/APPENDIX headings,
// "N-N." section numbers with ALL-CAPS titles, lettered/numbered sub-items, a
// dotted-leader table of contents, hard line-wraps, and page header/footer
// artifacts. We detect that structure, drop the noise, and rejoin wrapped lines
// into real paragraphs so the document reads like an article instead of one
// long run-on block.

import { needsOcrArtifactRepair } from './ocrScannedACs'

export type ACBlock =
  | { kind: 'chapter'; id: string; text: string }
  | { kind: 'section'; id: string; label: string; title: string; body: string; isChangeNotice?: boolean }
  | { kind: 'item'; level: number; label: string; title: string; body: string }
  | { kind: 'para'; text: string }

// Symbol/Wingdings glyphs survive PDF text extraction as private-use-area code
// points (the original font byte + 0xF000). With no glyph in the UI font they
// render as "tofu" boxes — most visibly U+F0B7 (a Symbol bullet) which looks
// like a small striped burger-menu square before list items. Map the common
// readable ones back to real Unicode and strip the rest (decorative Wingdings
// boxes, matrix-bracket fragments) so no tofu reaches the screen.
const PUA_GLYPHS: Record<string, string> = {
  "\uF0B7": "\u2022", "\uF0A7": "\u2022", // Symbol / Wingdings bullets -> bullet
  "\uF0FC": "\u2713",                      // Wingdings check mark -> check
  "\uF0B0": "\u00B0",                      // degree
  "\uF0B1": "\u00B1",                      // plus-minus
  "\uF0B4": "\u00D7",                      // multiply
  "\uF0A3": "\u2264",                      // less-or-equal
  "\uF0B3": "\u2265",                      // greater-or-equal
  "\uF03D": "=", "\uF02B": "+", "\uF02D": "\u2212", // = + minus
  "\uF028": "(", "\uF029": ")", "\uF05B": "[", "\uF05D": "]",
}

// Replace Symbol/Wingdings PUA glyphs with real Unicode; strip any other
// unmapped PUA code point so leftover tofu boxes never render.
export function cleanGlyphs(s: string): string {
  if (!s || !/[\uE000-\uF8FF]/.test(s)) return s
  return s
    .replace(/[\uE000-\uF8FF]/g, (ch) => PUA_GLYPHS[ch] ?? "")
    .replace(/ {2,}/g, " ")
    .trim()
}

// Schema version for precomputed pdf_blocks — bump when the parser output shape
// changes so a backfill can tell which rows need reprocessing.
export const AC_FORMAT_VERSION = 45

// Free-tier body preview: just enough to show how the app is organized, not
// a real read of the content. Was a 20%-floored-at-3 formula (let short ACs
// show 20-50% of the whole document), then an 8%-scaled, 2-5 range -- RC,
// 2026-08-03: "free tier can preview 2 sections of an AC, not 5." Flat 2
// now, no scaling with document length. Shared by every screen that renders
// an AC's pdf_blocks (ac/[id].tsx, notes.tsx's AC pane) so the free-preview
// depth can't drift between them.
export function previewBlockCount(_totalBlocks: number): number {
  return 2
}

// Comparable text for a block, regardless of kind — content-based identity used
// both server-side (scripts/backfill-blocks.mjs's diff computation, which keeps
// its own copy of this exact logic since it runs outside the RN bundler) and
// client-side (matching a saved highlight to its block after a re-parse). Block
// `id`s are just sequential counters re-minted on every parse, never stable
// across revisions, so identity has to be content-based, not index/id-based.
export function blockText(b: ACBlock): string {
  switch (b.kind) {
    case 'chapter':
    case 'para':
      return (b.text || '').trim()
    case 'section':
    case 'item':
      return `${b.label || ''} ${b.title || ''} ${b.body || ''}`.trim()
    default:
      return ''
  }
}

// FAA AC TOC lines have a long "leader" run immediately before the page number.
// The leader is most often periods ("........1") but many ACs use middle-dots (·)
// or bullets (•) instead. A 5+ run of dot-like chars (each optionally followed by
// one space, covering both solid "...." and spaced ". . . ." leaders) placed
// right before the page number is the signal. The leader MUST be adjacent to the
// page number — decoupling them matches chart-axis/OCR noise in scanned docs and
// over-strips real body sections. Stray OCR chars mid-leader ("··~····· 3") are
// tolerated because the regex anchors on the final dot-run before the number.
// Requiring 5+ excludes prose ellipsis ("..."). Page numbers may be arabic ("12"),
// appendix-style ("A3-1"), or roman ("iv"). cleanGlyphs runs first (see parseAC)
// so PUA bullets are normalised to • before this matches.
const TOC = /(?:[.·•] ?){5,}\.?\s*(([A-Z]\d{0,3}-)?\d{1,4}(-\d{1,3})?|[ivxlc]{1,7})\s*$/i

// Region-clustering signal: a long dot-like leader run ANYWHERE on the line, page
// number optional. Some TOCs wrap the page number onto its own line ("1.1 Purpose
// ......" then "....... 1-1"), so those entries have a leader but no trailing
// number and would be missed by TOC. A 6+ run is a strong TOC signal on its own;
// it is used only to find dense TOC clusters (>=6 lines), never to drop a single
// line, so the occasional stray dotted line cannot remove real content.
const TOC_LEADER = /(?:[.·•] ?){6,}/

const isTOC = (l: string) => TOC.test(l)

// Accept ALL-CAPS ("CHAPTER 1.") and title-case ("Chapter 1.") but NOT
// all-lowercase ("chapter 4, paragraph…") which signals a mid-sentence
// reference rather than a real heading. Alternation is more precise than /i.
// Require a period after the chapter/appendix number — all real FAA headings
// have it ("Chapter 1. Title") while prose references don't ("chapter 4 of…").
const CH = /^(?:CHAPTER|Chapter)\s+[0-9IVXLC]+\.\s*.*$/
const APPX = /^(?:APPENDIX|Appendix)\s+[0-9A-Z]+\.\s*.*$/

// FAA old-style "N-N. Title" section numbering. Restricted to max 3 digits
// per side to prevent false positives on phone numbers like "776-0790.".
// NOTE: this shape is IDENTICAL to an AC document number ("120-118", "20-1").
// A modern AC that uses decimal (SECDOT) numbering never has genuine dash-
// style headings of its own — so once decimal numbering is established, a
// dash-number match is almost always a cross-reference to a DIFFERENT AC that
// happened to wrap onto the start of a line ("...criteria contained in AC
// 120-118.\nThe basic airworthiness criteria rely on..."), not a real
// section. See the classifier below — SEC is gated the same way NUMSEC is.
const SEC = /^(\d{1,3}-\d{1,3}\.)\s+(.+)$/

// Multi-level dotted section numbers (1.1 through 1.1.1.1.1). Restricts:
//   • First digit must be 1-9 (excludes 0.x chart axis labels like "0.9")
//   • Each subsection segment max 2 digits (excludes CFR refs like "29.853")
//   • Title must start with an UPPERCASE letter — a real heading always does
//     ("2.1 General Aviation..."). Requiring uppercase (not any letter) is
//     what excludes a decimal number that starts a wrapped line mid-sentence
//     ("...within +10/-5 knots of 1.3 times the stalling speed...") — those
//     continuations start lowercase and would otherwise be misread as a new
//     subsection heading, duplicating stray "1.3" entries into the Contents.
//   • Title must NOT be a short ALL-CAPS abbreviation followed by a lowercase
//     word ("NM of", "PD is") — real headings are Title Case ("General
//     Aviation"), but a measurement value wrapped mid-sentence onto a new line
//     ("...within 2.5\nNM of the target; or...") still starts with an
//     uppercase letter (the unit abbreviation) and would otherwise slip past
//     the check above.
const SECDOT = /^([1-9]\d*(?:\.\d{1,2}){1,4}\.?)\s+(?!(?:[A-Z]{1,6})\s[a-z])([A-Z](?=.*[a-z]).+)$/

// "1. PURPOSE." — digit+period then a genuinely ALL-CAPS title (legacy
// style), or a short modern title-case heading ending in a period/question
// mark ("3. Background.", "2. Who is this AC for?").
//   • ALL-CAPS branch: the character class excludes lowercase letters
//     entirely, so it can be open-ended (no length/punctuation cap) without
//     reopening the old bug — real prose always contains lowercase within a
//     few words, so a numbered list item like "2. FAA handbooks:" or
//     "1. GA pilots should become aware..." stops matching the instant it
//     hits its first lowercase word and the line fails to match overall.
//     Being open-ended (not requiring a same-line terminal period) matters
//     for old scanned ACs where the heading itself wraps across two physical
//     lines ("3. INTERFERENCE" / "WITH AERONAUTICAL SERVICES. ...") — the
//     rejoin happens naturally via the section-continuation logic afterward.
//   • ALL-CAPS-with-inline-body branch: a second, separate alternative for
//     "1. PURPOSE. This advisory circular describes..." — the heading and the
//     first sentence of body sharing one physical PDF line (common when the
//     heading is short). The plain ALL-CAPS branch above can't match this
//     (it requires reaching end-of-line with no lowercase at all), so without
//     this the entire line — heading included — silently fell through to
//     ordinary body prose, dropping the section from Contents entirely
//     (confirmed on AC 117-1's "1. PURPOSE."/"2. PRINCIPAL CHANGES.", found
//     via a corpus-wide section-number-sequence-gap scan). Requires a literal
//     terminal period AND at least one more word after it — a bare heading
//     alone on its line (no period, or no trailing text) is already covered
//     by the branch above, so this one only ever matches genuinely new cases.
//     Both the bare and with-body ALL-CAPS alternatives also tolerate ONE
//     embedded "(annotation)" — e.g. "RELATED READING MATERIAL (current
//     editions)." or "RELATED REGULATIONS (Title 14 of the Code of Federal
//     Regulations)." — a recurring boilerplate phrase across many ACs (117-2,
//     120-88A, 120-103A, 120-51E, ...) that otherwise breaks the "no
//     lowercase anywhere" rule the same way a numeral or internal period
//     would. Accepts either case for the first letter (proper nouns like
//     "Title 14" are common) and digits within (e.g. "Title 14"), up to 60
//     chars — long enough for "(Title 14 of the Code of Federal
//     Regulations)" (44 chars), the longest real case found in the corpus.
//     The with-body alternative's terminal position explicitly allows this
//     parenthetical to be what sits right before the period, since greedily
//     matching it as part of the repeated middle group leaves nothing there
//     otherwise (confirmed necessary by testing against real corpus text).
//     Both ALL-CAPS alternatives also allow an internal or trailing ":" —
//     either as a clause separator before more ALL-CAPS text on the same
//     heading line ("DATA ANALYSIS BY THE FAA: SIT DOWN AND BUCKLE UP. The
//     data...") or as the terminator of a bare heading with nothing after it
//     ("RELATED MATERIAL (current editions):", "RELATED REGULATION
//     REFERENCES:") — both recurring FAA boilerplate patterns. An en/em dash
//     ("–"/"—") is tolerated the same way as the internal colon, for
//     headings like "FITNESS FOR DUTY–A JOINT RESPONSIBILITY." (117-3) and
//     "TIRE ENVIRONMENT—OPERATORS." (20-97B).
//   • Acronym branch: glossary-style "TERM Expansion." entries where the term
//     itself is a short acronym ("AC Advisory Circular.", "CFR Code of
//     Federal Regulations.") — the acronym prefix isn't pure ALL-CAPS-only
//     content (the expansion has lowercase), but isn't Title-Case-from-the-
//     start either (first word is a 2-6 letter acronym). Requires the word
//     immediately after the acronym to itself start uppercase, which is what
//     keeps "GA pilots should become..." and "FAA handbooks:" excluded —
//     their following word starts lowercase.
//   • Title-Case branch: still length-capped and must end in "." or "?" on
//     the same line — this is the one that needs the cap, since a numbered
//     list item phrased as a short title-case sentence ("2. Lack of airport
//     familiarity.") is otherwise indistinguishable from a real heading by
//     shape alone. (The isNextFlatNum() sequence check in the classifier
//     below is the actual backstop for that ambiguity.) Tried raising this
//     cap to fit longer FAQ-style question headings (121-33B's "5. When is
//     an emergency medical kit and an AED required..."), but corpus
//     validation showed the sequence gate isn't a strong enough backstop —
//     it also started promoting numbered bibliography/reference-list entries
//     into individual headings across 129 ACs (e.g. 120-72A's citation list),
//     reversing an earlier, deliberate call that those should stay list
//     items, not sections. Reverted; the FAQ-heading gap is left unfixed.
const NUMSEC = /^(\d+\.)\s+([A-Z](?:[A-Z0-9: ,./&''()–—-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))+|[A-Z](?:[A-Z0-9: ,./&''()–—-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))*(?:[A-Z0-9)]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))\.\s+.+|[A-Z]{2,6}\s+[A-Z][a-zA-Z ,/&()'-]{1,58}[.?](?:\s+.+)?|[A-Z][a-z][a-zA-Z ,/&()'-]{1,58}[.?](?:\s+.+)?)$/

// "1. PURPOSE: This advisory circular sets forth..." — an old (pre-1990s) FAA
// heading style: an ALL-CAPS title terminated by a COLON, with body text
// inline on the same line. Distinct from NUMSEC's with-body ALL-CAPS branch,
// which requires a literal period before the body; distinct from its
// bare-heading branch, whose internal-colon tolerance only covers a colon
// followed by MORE all-caps text, not lowercase prose.
// Deliberately kept OUT of NUMSEC's own alternation: unlike NUMSEC's other
// ALL-CAPS branches (a safe signal on their own — ordinary prose never
// produces a run of pure uppercase text), a short bare acronym before a
// colon ("VSI:", "GPS:") is NOT safe on its own — it's indistinguishable
// from a numbered reference-list or checklist item using the same shape. Two
// extra gates beyond NUMSEC's other branches, both added after corpus-wide
// checks caught real false positives:
//   1. Always run through isNextFlatNum() (see NUMSEC_COLON's use in the
//      classifier below) — a numbered list nested inside an already-decimal-
//      or-appendix-numbered document won't continue that document's own flat
//      top-level sequence.
//   2. Blocked once any lettered appendix has been seen (`appxSeen` in the
//      classifier) — lastFlatNum is one GLOBAL counter with no scoping
//      between the document's real top-level sequence and a numbered list
//      nested inside an appendix subsection, so a local list restarting at
//      "1." inside an appendix can still coincidentally fall within the
//      top-level counter's "+10" tolerance window even after gate #1.
// Confirmed false positives caught by an early, less-gated version: AC
// 61-136B's Appendix B.3.4.3 instrument-tolerance list ("6. VSI:", "8.
// VOR/ILS:", "9. ADF:", "10. GPS:") and AC 91-92's numbered resource-link
// list ("15. NWS:", sitting between "14. From the Flight Deck Videos:" and
// "16. NWS Glossary (NOAA):", neither of which matches any branch — a
// genuine top-level document heading is never followed immediately by
// another one sharing the exact same visual list-item shape with no other
// content between). Confirmed genuine, real top-level document structure —
// not list items — on AC 20-40 (1965), AC 150/5020-2 (2004, "1.  PURPOSE:",
// "2.  APPLICABILITY", "3.  BACKGROUND", "4.  DOCUMENT AVAILABILITY:"), and
// AC 20-119 ("1. PURPOSE:" — its siblings "2. BACKGROUND." and "3.
// GUIDANCE." already use a period, matching NUMSEC's own with-body ALL-CAPS
// branch independently of this one).
const NUMSEC_COLON =
  /^(\d+\.)\s+([A-Z](?:[A-Z0-9 ,./&''()–—-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))*(?:[A-Z0-9)]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\)):\s+.+)$/

// "1 PURPOSE OF THIS AC." — number (no period), then ALL-CAPS title ending in
// a period, optionally followed by body on the same line. Tolerates ONE
// embedded "(lowercase annotation)" the same way NUMSEC's ALL-CAPS branches
// do — e.g. AC 89-3's "4 RELATED READING MATERIAL (current editions):" — via
// an alternation that also allows the FINAL required unit before the
// terminator to itself be a full parenthetical (not just one bare char),
// since a title ending in ")" would otherwise have nothing left to satisfy a
// separate single-character requirement.
// The parenthetical requires >=2 chars inside ("{1,60}" after the first
// char), not >=1 — a first attempt allowing a single char matched legal-
// citation parens like "(b)" too, and a real corpus case turned that into a
// serious regression: AC 150/5050-4A's footnote "49 USC 47106(b)(2). Also
// see..." got misread as a heading numbered "49", which poisoned the
// flat-number sequence tracker (lastFlatNum) for the rest of the document —
// the real Appendix B glossary's "7. Community Involvement." and "8.
// Environmental Justice." entries then failed the "must continue the
// sequence" check (7/8 aren't greater than 49) and vanished entirely, with
// nothing recovering them. Caught by the standard full-corpus content-diff
// validation before shipping; requiring 2+ chars excludes "(b)"/"(2)"-style
// single-character legal citations while still allowing real annotations
// like "(current editions)".
const NUMSEC2 =
  /^(\d{1,2})\s+([A-Z](?:[A-Z0-9 ,/&''()-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))*(?:[A-Z0-9)]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))\.)\s*(.*)$/

// Same bare-number ALL-CAPS heading shape as NUMSEC2, but the title is
// separated from the body by a colon instead of a period — confirmed on AC
// 89-1's "1 PURPOSE OF THIS ADVISORY CIRCULAR (AC): This AC provides guidance
// on..." and "2 AUDIENCE: This AC is of interest...". Without this, NUMSEC2
// never matches (no period on the line at all), so the whole line falls
// through to ordinary body/para text — which is exactly what silently
// dropped both entire sections: the "drop preamble before the first real
// heading" step (see below) then discarded them, along with everything else
// before the parser's first successfully-recognized heading, since that
// heading was much further into the document (120-28D-style: a genuine
// section number gets classified only later).
const NUMSEC2_COLON =
  /^(\d{1,2})\s+([A-Z](?:[A-Z0-9 ,/&''()-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))*(?:[A-Z0-9)]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\)):)\s*(.*)$/

// Same bare-number ALL-CAPS heading shape again, but with NO terminator at
// all and the body starting as a wholly separate paragraph — confirmed on
// the same AC 89-1's "3 RELATED READING MATERIAL (CURRENT EDITIONS)", whose
// actual body text starts several lines later. Anchored to end-of-line (no
// trailing content allowed) so this can't swallow real body text that
// happens to share a physical PDF line with the heading.
const NUMSEC2_BARE =
  /^(\d{1,2})\s+([A-Z](?:[A-Z0-9 ,/&''()-]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\))*(?:[A-Z0-9)]|\([A-Za-z][a-zA-Z0-9 ,./&'-]{1,60}\)))$/

// "1 Purpose." — number (no period), then Title-Case phrase ending in a period,
// on its own line. Used in modern flat-numbered ACs (e.g. 150/5200-34B).
// Restricted to 1-2 digit numbers and second char must be lowercase to avoid
// matching prose fragments like "14 CFR part 25." that start lines after wraps.
const NUMSEC3 = /^(\d{1,2})\s+([A-Z][a-z][a-zA-Z ,/&()'-]{1,50}\.)$/

// Lettered appendix section numbers: "A.1 Title", "B.3 Title", "A.96 Title",
// and their multi-level sub-item form ("F.1.9 Title", "D.1.22 Title",
// "A.8.8.2 Title", even "F.3.12.3.2.2.1 Title" — deeply nested subsections
// inside a lettered appendix, the exact same "letter, then a chain of decimal
// segments" shape SECDOT already handles for un-lettered documents). Requires
// uppercase letter, period, 1–3 digit number, then zero or more additional
// ".N" segments (1–2 digits each, same per-segment width SECDOT uses), then
// content starting with an UPPERCASE letter — a real heading always does.
// Requiring uppercase (not any letter) is what excludes an internal
// cross-reference that wraps mid-sentence onto a new line ("...refer to
// section\nB.3 of this appendix. Velocity accuracy may be qualified...") --
// that continuation starts lowercase and would otherwise be misread as a new
// appendix subsection.
// Trailing period after the number is optional -- some ACs write "A.1 Title"
// (no period), others "A.1. Title" (period, e.g. 70-1B's 17 real sub-headings,
// which without this all collapsed into one 34K-char block since the regex
// only matched the no-period form). Corpus-wide scan before shipping: 9 ACs
// gain new real matches (150/5220-21C, 150/5300-18B, 70-1B, etc.), all
// genuine headings on spot-check, none false positives -- a materially safer
// change than the sibling "Appendix N:" colon idea also considered here,
// which a corpus scan caught producing a real false positive (20-73A's
// "Appendix C: The 14 CFR parts 25..." is a glossary DEFINITION using a
// colon, not a heading) and was deliberately NOT shipped as a general rule.
//
// Multi-level extension added 2026-08-18 during the oversized-block backlog
// pass: the single-level form above only ever matched the TOP of a lettered
// appendix's own numbering ("F.1 Definitions.") -- every deeper sub-item
// under it ("F.1.9 Enhanced Flight Visibility...", "D.1.22 Receiver
// Autonomous Integrity Monitoring...") shared no shape any classifier
// recognized, so it silently fell through as plain continuation text of
// whatever section was still open, gluing dozens of real, distinct
// definitions/subsections into one giant block (confirmed corpus-wide on
// 20-167B, 20-165B, 20-158B, 20-136C, 450.141-1A, 450.45-1, 20-185A,
// 90-113C, 90-106B, 25-25A, 25-11B, 33.70-5, 70-1B's own "A.14.4."-style
// sub-items, 150/5335-5D, 90-120, 91-70D, 91-85B, 25.981-1D, 25.933-1,
// 90-80C, 120-59B, 20-154A, 20-151C -- the deepest confirmed real case,
// 20-151C's "F.3.12.3.2.2.1", needs 6 segments after the leading letter).
// The extra segments are capped at 1–2 digits each (mirroring SECDOT's own
// per-segment width, which already excludes things like a CFR reference
// "29.853" from being misread as a subsection chain) and at 6 repetitions,
// comfortably covering every depth seen in the real corpus with margin to
// spare, while the "letter + a chain of `.digit` groups, immediately
// followed by an UPPERCASE-starting phrase" shape remains distinctive
// enough that it essentially never occurs by accident in ordinary prose --
// validated corpus-wide with scripts/diff-parser-version.mjs (every block's
// full text content re-concatenates identically old vs. new; the only
// change is where boundaries are drawn) before shipping.
const APPXSEC = /^([A-Z]\.\d{1,3}(?:\.\d{1,2}){0,6})\.?\s+([A-Z].+)$/

// FAA ACs often have numbered or titled tables: "TABLE 2-1. GAS LAWS...".
// The TABLE keyword with a digit catches these reliably without false positives
// on prose references like "see the table above" (lowercase) or section titles.
const TBL = /^TABLE\s+\d/

// FAA ACs also use a SECOND, distinct table-numbering scheme inside lettered
// appendices: "Table A-1. U.S. Air Force Specialty Codes", "TABLE D-1.
// EXAMPLE OF...", "Table A3-1-1. Boeing 737-900...". TBL above requires a
// DIGIT right after "TABLE", so it never matches -- table-mode never
// engages, and every data row of a lettered table glues into whatever
// section/item was still open (confirmed swallowing 65-30B's entire "U.S.
// Air Force/Army/Navy/Marine Corps/Coast Guard Specialty/Occupational Codes"
// appendix into one block). Corpus-measured before writing this regex (not
// guessed): 100 of 780 active ACs have a line matching a broad
// `^(TABLE|Table)\s+[A-Z]` net; manually classifying all 879 real hits found
// the genuine heading shape is "Table"/"TABLE" (both cases appear -- 25.1309-
// 1B, 33.28-3, 450.109-1 use uppercase "TABLE", same as the digit scheme;
// everyone else uses title-case "Table") + a letter, optionally 1-2 extra
// digits before the dash ("A3", "A6", "A1"), one or two dash-number groups
// (plain "A-1", or "A3-1-1"), tolerating stray OCR spacing around the dash
// ("A1 - 1") or before the terminal punctuation ("Table D-1 ." — seen twice
// in 120-92D).
//
// The real false-positive risk (same shape the reverted SECDOT attempt ran
// into): TBL only anchors at line-start, not sentence-start, and a PDF line
// break can coincidentally land right after an inline citation, producing a
// standalone line that opens exactly like a heading -- "Table A-2. New
// records must be entered within 30 days of creation" (120-68J, a genuine
// sentence, not a title), "Table A-3. Similarly, account for the static
// pressure measurement error in two" (91-85B, a sentence that merely ends
// with ". Similarly," -- i.e. the PREVIOUS sentence's own trailing "Table
// A-3." reference plus a new sentence starting right after). Two guards,
// corpus-validated by classifying all 879 real hits by hand before picking
// thresholds:
//   1. Punctuation-gated: only "." or ":" immediately (or after one stray
//      OCR space) after the table number counts. Corpus evidence: bare
//      "Table A-1 shows/provides/lists/below/on/when/in ..." (no punctuation
//      at all -- 87 real instances found, all prose citing a table
//      introduced elsewhere) and comma-punctuated "Table A-4, and Table A-5
//      to determine..." are both dominated by ordinary sentences, not
//      headings, so both are excluded entirely rather than risk them.
//   2. Noun-phrase check: real table titles are noun phrases and essentially
//      never contain a FINITE main verb ("must", "are", "shows", "requires"
//      ...) or open with a comma-led adverbial transition ("Similarly,",
//      "However,"). A relative clause modifying the title itself doesn't
//      count against it ("Organizations That Are Required", "Items to be
//      Evaluated" -- the verb follows "that"/"which"/"who"/"to", a
//      subordinate clause, not the line's own main clause). This cleanly
//      separated every real title from every real sentence found in the
//      corpus scan, including two that a cruder title-case-ratio heuristic
//      could NOT distinguish (120-68J's real sentence and 437.55-1's
//      genuine-but-sentence-case "Hazard example: leak in..." caption both
//      scored identically on a pure capitalization ratio).
// Deliberately asymmetric: a false NEGATIVE here just leaves that one table
// exactly as unfixed as it is today (no regression). A false POSITIVE
// corrupts real prose into a fake heading/table-row -- so every ambiguous
// case above is resolved toward rejecting, not matching.
const TBL_LETTER_SHAPE =
  /^(?:TABLE|Table)\s+([A-Z](?:\d{1,2})?(?:\s?-\s?\d{1,3}){0,2})\s?([.:])\s*(.*)$/
const TBL_LETTER_VERBS = new Set([
  'is', 'are', 'was', 'were', 'must', 'should', 'shall', 'will', 'would', 'can', 'could', 'may', 'might',
  'has', 'have', 'had', 'does', 'do', 'did',
  'shows', 'show', 'indicates', 'indicate', 'provides', 'provide',
  'identifies', 'identify', 'conveys', 'convey', 'relates', 'relate', 'requires', 'require',
  'describes', 'describe', 'explains', 'explain', 'illustrates', 'illustrate',
  'demonstrates', 'demonstrate', 'contains', 'contain', 'includes', 'include', 'account', 'accounts',
])
const TBL_LETTER_CLAUSE_GUARDS = new Set(['that', 'which', 'who', 'to'])
const TBL_LETTER_ADVERBIAL_OPENERS = new Set([
  'similarly', 'however', 'therefore', 'also', 'then', 'thus', 'furthermore', 'moreover',
  'consequently', 'first', 'second', 'third', 'note', 'additionally', 'finally', 'meanwhile',
  'otherwise', 'nevertheless', 'nonetheless', 'instead', 'indeed', 'hence', 'accordingly',
  'overall', 'specifically', 'generally', 'typically', 'importantly', 'notably',
])
function isLetterTableHeading(line: string): boolean {
  const m = line.match(TBL_LETTER_SHAPE)
  if (!m) return false
  // A bare "Table A-1" number with a letter but NO dash-number ("Table C.")
  // is still accepted -- some docs number their own tables "Table A",
  // "Table B", "Table C" with no per-section suffix (confirmed real: AC
  // 20-147A's "Table C. Inlet Lip and Runback Ice...").
  const rest = m[3].replace(/\.{3,}.*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim()
  if (rest === '') return true // bare label, title empty or wraps to the next line
  const words = rest.split(/\s+/).filter(Boolean)
  const firstBare = words[0].replace(/[^A-Za-z]/g, '').toLowerCase()
  if (/,$/.test(words[0]) && TBL_LETTER_ADVERBIAL_OPENERS.has(firstBare)) return false
  let guarded = false
  for (const w of words) {
    const bare = w.replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, '').toLowerCase()
    if (!bare) continue
    if (TBL_LETTER_CLAUSE_GUARDS.has(bare)) { guarded = true; continue }
    if (TBL_LETTER_VERBS.has(bare) && !guarded) return false
  }
  return true
}

const ITEM_A = /^([a-z]\.)\s+(.*)$/ // a. ...
const ITEM_N = /^(\(\d+\))\s+(.*)$/ // (1) ...
const ITEM_L = /^(\([a-z]\))\s+(.*)$/ // (a) ...

// Escapes regex metacharacters so a document's own number (which can contain
// "/" and "." — e.g. "150/5300-13B") is safe to embed literally in a pattern.
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isPageMarker(l: string, documentNumber?: string): boolean {
  if (l.length > 44) return false
  const hasDate = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(l)
  const hasAC = /\bAC\s+[\dA-Z][\dA-Z-]*/i.test(l)
  if (hasDate && hasAC) return true
  if (/^Page\s+[\divxlc]+\b/i.test(l)) return true
  // A bare self-citation of THIS document's own number, alone on its own
  // line, optionally with a "CHG N"/"Change N" revision suffix -- e.g. "AC
  // 00-31A" or "AC 20-146A CHG 1". Confirmed real and corpus-wide, not a
  // one-off: 49 ACs / 1187 occurrences carry this exact running
  // page-header/footer shape (found while checking the rest of the corpus
  // for footer patterns similar to the "Page N Par M" and "<ref> Change N"
  // bugs fixed earlier this session). PDF text extraction sometimes splits
  // what's really a single-line footer ("9/20/82    AC 00-31A", already
  // caught by hasDate && hasAC above) onto two separate lines depending on
  // the page's column layout -- this catches the split-off "AC ..." half.
  // Scoped to THIS document's own number specifically (not any bare "AC
  // ..." line) so a legitimate references list citing a DIFFERENT AC by
  // number, one per line, is never mistaken for a footer -- a real running
  // footer is always self-referential, so this loses no real matches.
  if (documentNumber) {
    const selfRE = new RegExp(
      `^AC\\s+${escapeRegExpLiteral(documentNumber)}(?:\\s*,?\\s*(?:CHG|Change)\\s*\\d*)?$`,
      'i'
    )
    if (selfRE.test(l)) return true
  }
  return false
}

function isNoise(l: string, documentNumber?: string): boolean {
  return (
    l === '' ||
    /^\d{1,4}$/.test(l) || // bare page number
    /^[ivxlc]{1,6}$/i.test(l) || // bare roman page number
    /^\d+\.\d+$/.test(l) || // standalone decimal (chart axis labels: 0.9, 1.3)
    /^[A-Z]\d{0,1}-\d{1,3}$/.test(l) || // appendix page numbers: "A-8", "A3-1"
    /^Appendix\s+[A-Z]$/.test(l) || // bare "Appendix A" page-header fragment (no period/title)
    /^Appendix\s+\d{1,3}$/.test(l) || // same, numbered appendices ("Appendix 1") -- confirmed corpus-wide: 44 ACs / 593 occurrences, same running-header shape as the lettered form just above, split across page columns the same way "AC <doc>" is (see isPageMarker's comment)
    /^Chap\s+\d{1,3}$/i.test(l) || // FAA footer "Chap 2" (paired with the already-handled "Par N" footer on the next line) -- 7 ACs / 176 occurrences
    /^Par\b/.test(l) || // FAA footer "Par 1-1"
    isPageMarker(l, documentNumber) ||
    /^(CONTENTS|TABLE OF CONTENTS|LIST OF (FIGURES|TABLES|EFFECTIVE PAGES))\s*$/i.test(l)
  )
}

// Capture each numbered "Change N" revision-notice cover page found in the
// document's preamble as its own clearly-labeled block, instead of silently
// discarding all of it (parseAC's Step 1 used to just slice the whole
// preamble away and drop it on the floor). RC: "make sure those 'Change 1'
// 'Change 2' etc are properly formatted and identified (this goes for all
// similar situations corpus wide)."
//
// These are APPENDED after the real document body (see the two return
// statements at the bottom of parseAC), not prepended -- even though the
// FAA prints these transmittal cover pages FIRST in the source PDF. RC's own
// mental model of how amendment history should read: "the original text is
// listed, then the Changes are placed in seq after that original body of
// text (almost like separate chapters)" -- a reader opening an AC wants the
// current regulatory content first, with amendment history available after,
// not 2-9 revision blurbs standing between them and "1. PURPOSE." Each is
// also flagged isChangeNotice: true so ACBody can render it as a visually
// distinct card instead of a plain section heading indistinguishable from
// real body content -- RC: "as a user scrolls through the body of a reg,
// these areas [need to] stand out clearly."
//
// `markers` reuses Step 1's own marker regex verbatim so the boundaries
// this function finds are guaranteed identical to the ones Step 1 uses to
// decide where the real body starts -- no risk of the two disagreeing.
// Every marker (numbered OR the undigited "Change:" baseline header) is
// tracked as a boundary; only the numbered ones get emitted as blocks. This
// matters for the LAST numbered marker specifically: its body must stop at
// the very next marker (which is usually the ORIGINAL document's own bare
// "Change:" header), not run all the way to the end of the preamble --
// otherwise the original document's own real "1. PURPOSE..." opening would
// get captured as if it were part of the last Change notice's body, then
// shown AGAIN when the main body parse renders the real section right
// after. Verified against multiple real multi-Change ACs (61-67C, 90-100A)
// before shipping, not just one example -- the letterhead/Subject/Date/
// Initiated-by shape is consistent across both despite different job
// titles, signers, and minor line-wrap differences in "U.S." itself.
// A bare "Change N" or "Change:" match (see markerRE below and chgRE further
// down) can ALSO be a running page-footer/header artifact repeated on every
// page of a long document -- e.g. "32 Change 2", "This page intentionally
// left blank. Change 1", "................ 85 Change 2" -- not a real
// transmittal-header marker at all. Confirmed real and corpus-wide, not
// hypothetical: AC 20-138D alone had 43 "matches" in its first 25% by the
// bare regex, but only 2 were genuine (the rest were a "<page-ref> Change 2"
// footer repeating throughout its long front matter) -- treating every
// footer occurrence as a real marker corrupted BOTH ends of the pipeline at
// once: Step 1 mis-located the preamble/body boundary on the LAST such
// "match" (a footer sitting deep in real Chapter 5 content), silently
// discarding everything before it -- including the actual PURPOSE,
// APPLICABILITY, and Chapters 1 through 5.2 -- and extractChangeNotices
// (below) chopped every genuine notice's body short at the very next footer
// occurrence instead of its real boundary.
//
// A genuine marker always follows "Initiated by:" (or "Initiated By:") --
// part of the FAA's standard transmittal-letterhead line ("Subject: ...
// Date: ... AC No: ... Initiated by: ... Change: N") -- within a short
// distance. Verified corpus-wide before relying on this: across 528 markers
// confirmed genuine by manual inspection, the max observed distance was 116
// characters; footer-artifact occurrences have no such text nearby at all.
// 250 chars (2x+ that margin) is used for the lookback.
//
// Proximity alone isn't sufficient, though -- caught live on AC 20-138D: its
// real "Change 2" notice's own PURPOSE paragraph reads "...adds additional
// information and clarifications to AC 20-138D, Change 1" -- a mid-sentence
// CITATION to the prior version, ending in a real PDF line-wrap, which
// satisfies the marker shape AND sits within 250 chars of the SAME
// "Initiated by:" that precedes the genuine "Change: 2" marker just before
// it. Accepting it as its own marker silently stole the rest of Change 2's
// real body (truncating it right at that citation) and shadowed the actual
// "Change: 1" transmittal marker further down (which then computed an empty
// body against this bogus one and silently dropped). Fixed by requiring
// this be the FIRST "Change" occurrence after the nearest preceding
// "Initiated by:" -- a genuine letterhead has exactly one; anything after a
// second is downstream prose, not a marker. Confirmed this still accepts
// the multi-line letterhead layout (a lone "AC No: ..." line often sits
// between "Initiated by:" and "Change:") since that gap never itself
// contains the word "Change".
function hasNearbyInitiatedBy(text: string, matchIndex: number): boolean {
  const before = text.slice(Math.max(0, matchIndex - 250), matchIndex)
  const idx = before.toLowerCase().lastIndexOf('initiated by')
  if (idx === -1) return false
  return !/change/i.test(before.slice(idx + 'initiated by'.length))
}

function extractChangeNotices(preamble: string): ACBlock[] {
  const markerRE = /\bChange(?:\s*:\s*(\d*)|\s+(\d+))\s*[\r\n]/g
  const markers: { start: number; end: number; num: string }[] = []
  let mm
  while ((mm = markerRE.exec(preamble)) !== null) {
    if (!hasNearbyInitiatedBy(preamble, mm.index)) continue
    markers.push({ start: mm.index, end: mm.index + mm[0].length, num: mm[1] || mm[2] || '' })
  }
  const notices: ACBlock[] = []
  let cid = 0
  for (let i = 0; i < markers.length; i++) {
    if (!markers[i].num) continue // undigited "Change:" baseline header -- boundary only, not a notice
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].start : preamble.length
    let body = preamble.slice(markers[i].end, bodyEnd)
    // Cut the PAGE CONTROL CHART table + signature block that follows the
    // real PURPOSE/PRINCIPAL CHANGES summary on every notice that has one —
    // it's real content, not an extraction artifact, but it's the exact
    // shape of "clutter at the end" RC separately flagged (task 145): a raw
    // remove/insert page-swap table plus a signature name, neither
    // meaningful once split out of its original page-layout context. Cut
    // BEFORE the letterhead/header strip below, since the table always sits
    // after the real summary text and before the NEXT notice's letterhead —
    // stripping it first keeps the two cleanup passes independent instead
    // of one needing to know the other already ran. Confirmed present in
    // 63 of 77 ACs with real revision history; when absent, this is a
    // harmless no-op (nothing to cut) rather than a required marker.
    const pcc = body.search(/PAGE CONTROL CHART/i)
    if (pcc >= 0) body = body.slice(0, pcc)
    // Strip the FAA letterhead block (its exact line-wrap position varies —
    // "U.S." itself is sometimes split mid-word — so this matches on the
    // words themselves, not fixed line boundaries) and the Subject/Date/AC
    // No/Initiated-by/Change header line that precedes the NEXT notice (or
    // the original doc's own baseline header), which would otherwise bleed
    // onto the tail of THIS notice's body.
    body = body
      .replace(/U\.?\s*S\.?\s*\.?\s*Department\s+of\s+Transportation\s+Federal\s+Aviation\s+Administration\s+(Advisory\s+Circular|Circular\s+Advisory|Circular|Advisory)/gi, ' ')
      .replace(/Subject:.*?Date:\s*\d{1,2}\/\d{1,2}\/\d{2,4}.*?(?:AC No:[^\n]*?)?Initiated by:[^\n]*?(?:Change\s*:?\s*\d*)?\s*/gis, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) continue
    // The date for THIS marker's own notice always sits on the line just
    // before it ("Date: MM/DD/YY ... Initiated by: ... Change: N") --
    // search a bounded window backward rather than forward, since forward
    // text belongs to the NEXT notice.
    const before = preamble.slice(Math.max(0, markers[i].start - 400), markers[i].start)
    const dateM = before.match(/Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/)
    notices.push({
      kind: 'section',
      id: `chg${cid++}`,
      label: `Change ${markers[i].num}`,
      title: dateM ? `(${dateM[1]})` : '',
      body,
      isChangeNotice: true,
    })
  }
  return notices
}

// Pull a short leading "heading term" (e.g. "PURPOSE." / "Adiabatic Cooling.")
// off the front of a section/item so it can be rendered bold.
// When the entire rest string IS the title (standalone heading line, no inline
// body), return it as the title rather than leaving title empty and stuffing it
// into body — which caused the audit to see duplicate labels for appendix
// sections (both label+title keys collapsed to just the label).
function splitHeading(rest: string, forItem = false): { title: string; body: string } {
  const m = rest.match(/^([A-Z][A-Za-z0-9 ,/&''()-]{1,55}?\.)\s+(.+)$/)
  if (m) return { title: m[1], body: m[2] }
  // Same extraction for a COLON-terminated title ("NOTE: something…") —
  // without this, a colon-terminated heading falls through to the
  // standalone-heading case below and the entire sentence renders bold as
  // one giant "title" instead of a short bold term + normal body. Doesn't
  // create new headings itself (that decision already happened upstream in
  // the classifier) — just improves the title/body split for text a
  // classifier already accepted (e.g. APPXSEC) that happens to use a colon.
  const mc = rest.match(/^([A-Z][A-Za-z0-9 ,/&''()-]{1,55}?:)\s+(.+)$/)
  if (mc) return { title: mc[1], body: mc[2] }
  // Standalone heading: the entire rest is the title text (no body on this line).
  // ITEM-only exception: if this "standalone" text is a single bare word/token
  // with no space AND no terminal punctuation, it's a PDF line-wrap accident,
  // not a deliberate bold term — a real FAA item title is always a genuine
  // multi-word phrase or ends in "."/"?"/ ":" (both already handled above).
  // Confirmed on AC 20-166A: item "a."'s opening line was JUST "a. The", with
  // "Federal Aviation Administration (FAA) uses IPs..." continuing on the next
  // line — bolding "The" as if it were a real term, then showing the rest as
  // unrelated body text, reads as visibly broken. Returning body here (not
  // title) lets the ordinary continuation-append below rejoin it into one
  // normal sentence: "The Federal Aviation Administration...". Scoped to
  // items only (not sections) via `forItem` — sections rely on this same
  // "entire rest is title" fallback for genuine bare ALL-CAPS headings whose
  // continuation is handled by a separate, already-vetted mid-word repair
  // that specifically needs `cur.title` non-empty to detect and merge (e.g.
  // "CO" + "NDITIONS." — see that repair's own comments) — zeroing the title
  // here for sections would break it.
  if (/^[A-Z]/.test(rest)) {
    if (forItem && !/\s/.test(rest)) return { title: '', body: rest }
    // ITEM-only: a genuine standalone title always ends in terminal
    // punctuation (".", "?", ":", or a closing quote/paren after one) —
    // when it doesn't, `rest` is just the PDF's first line of a longer
    // sentence cut off mid-clause, the same shape as the bare-word case
    // above, just multi-word. Confirmed on AC 27-1B: item "b."'s first line
    // was "Requests from the rotorcraft industry to make the document
    // easier to use resulted in" (no terminal punctuation), with "renumbering
    // the AC paragraphs..." as the very next block's body — the sentence
    // was being split at the PDF line-wrap instead of its real end, so a
    // punctuation-less fragment rendered bold followed by its own plain-text
    // continuation. Scoped to items only, same reasoning as the bare-word
    // case (sections need the unconditional fallback for their own
    // mid-word-split repair — see comment above).
    if (forItem && !/[.!?:]["'’”)\]]?$/.test(rest)) return { title: '', body: rest }
    return { title: rest, body: '' }
  }
  return { title: '', body: rest }
}

export function parseAC(raw: string, documentNumber?: string): ACBlock[] {
  if (!raw) return []
  const ocrScanned = documentNumber ? needsOcrArtifactRepair(documentNumber) : false

  // 0. Cut the standardized FAA "Advisory Circular Feedback Form" boilerplate
  //    that trails many ACs — a blank comment/suggestion template (checkbox
  //    or fill-in-blank fields, underscore rule-lines for handwritten
  //    responses, "Submitted by: Date: ______") with zero regulatory
  //    content. RC: "check all the clutter, and dashes and spacing at the
  //    end of the doc." Corpus-wide scope: 250 of 779 active ACs carry this
  //    exact heading (a broader "I would like to discuss the above"/
  //    "Submitted by:...Date:" body-content check found 334 -- ~84 ACs use
  //    the same form with a differently-worded heading this pass doesn't
  //    catch; flagged, not chased further this round).
  //    A REAL false positive was caught testing this against the live
  //    corpus, not assumed safe from one example: AC 450.169-1's body has
  //    an earlier, casual, lowercase, mid-sentence reference ("...you may
  //    use the Advisory Circular Feedback form at the end of this AC.") in
  //    ADDITION to the real heading later — taking the FIRST occurrence
  //    (as an initial version of this fix did) truncated the document at
  //    2.6% through, destroying all 70 of its real content blocks down to
  //    1. Fixed to take the LAST occurrence instead, with a positional
  //    safety guard (must land in the final 20% of the document) so a
  //    document that references the form more than once even near the end
  //    fails safe (skips the cut) rather than guessing. Verified corpus-
  //    wide before shipping: 11 of the 250 ACs have multiple occurrences
  //    (450.169-1 among them); in all 11, the LAST occurrence already
  //    lands at 80%+ through the document, so the guard never actually
  //    triggers a skip on real data -- it's there for documents not yet in
  //    the corpus, not a currently-active code path.
  {
    const feedbackRE = /Advisory\s+Circular\s+Feedback\s+Form/gi
    let lastFeedbackMatch: RegExpExecArray | null = null
    let fbm
    while ((fbm = feedbackRE.exec(raw)) !== null) lastFeedbackMatch = fbm
    if (lastFeedbackMatch && lastFeedbackMatch.index > raw.length * 0.8) {
      raw = raw.slice(0, lastFeedbackMatch.index)
    }
  }

  // 1. Strip all change-revision preamble blocks. FAA ACs with multiple
  //    revisions embed older change notices before the original body. Find the
  //    LAST "Change:" or "Change N" header in the first 25% of the document
  //    and slice past it so we start at the original body text.
  //    "Change:" (colon) = original doc header; "Change N" (space+digit) =
  //    revision notice header. Both forms are searched so ACs that open with a
  //    "Change 1" or "Change 2" revision packet followed by the original AC
  //    (which itself has "Change:") are handled by the later occurrence winning.
  //    Require the "Change" line to end immediately after the marker (optional
  //    whitespace then line-break) so table rows like "Change 1 Mar. 24, 1996
  //    SN 050-007-01144-0 $1.50" — which are FAR price-list data, not revision
  //    headers — are not mistaken for preamble boundaries.
  const preambleLimit = raw.length * 0.25
  let lastChgEnd = -1
  const chgRE = /\bChange(?:\s*:\s*\d*|\s+\d+)\s*[\r\n]/g
  let cm
  while ((cm = chgRE.exec(raw)) !== null && cm.index < preambleLimit) {
    if (!hasNearbyInitiatedBy(raw, cm.index)) continue
    lastChgEnd = cm.index + cm[0].length
  }
  // Capture the preamble BEFORE discarding it -- see extractChangeNotices'
  // own header for why this now becomes labeled blocks instead of silently
  // vanishing.
  const changeNotices = lastChgEnd > -1 ? extractChangeNotices(raw.slice(0, lastChgEnd)) : []
  if (lastChgEnd > -1) raw = raw.slice(lastChgEnd)

  // 1b. Strip an inline running-footer artifact ("Page 4 Par 102", "Page 2
  //      Par 1-2") that the PDF extraction sometimes glues DIRECTLY onto real
  //      body text at a page-break boundary, with no newline separating the
  //      two. A standalone footer that lands on its OWN line is already
  //      caught by isPageMarker/isNoise below -- this is specifically the
  //      case where it doesn't, because it isn't its own line at all.
  //      Confirmed real, live, on AC 61-67C: "...decreasing the angle of
  //      bank. \nPage 4 Par 102 104. TYPES OF STALLS. Stalls can be..." --
  //      the glued footer sat directly in front of a real section header
  //      ("104. TYPES OF STALLS."), which broke every classifier below (all
  //      of them anchor on the line literally STARTING with the section
  //      number), silently merging that entire section's content into the
  //      PRECEDING section (103) instead of giving it its own heading.
  //      Corpus-wide scope check before shipping: 33 ACs, 157 instances of
  //      this exact inline-glued shape (distinct from 61 ACs that have the
  //      pattern only in the already-handled standalone-line form). "Page N
  //      Par M" is a distinctive machine-generated footer signature -- real
  //      AC prose never writes a page/paragraph cross-reference in this
  //      exact terse, punctuation-free shape -- so a global strip is safe.
  //      Replaced with a single space (not deleted outright) so the words
  //      on either side of the artifact don't get glued to each other.
  raw = raw.replace(/\bPage\s+\d{1,4}\s+Par\s+[\d-]{1,10}\b\s*/g, ' ')

  // 2. Normalize whitespace; one trimmed line per source line. cleanGlyphs maps
  //    Symbol/Wingdings PUA glyphs to real Unicode first so bullet TOC leaders
  //    (U+F0B7) become • and are caught by isTOC, and stored blocks are tofu-free.
  let lines = raw
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .split('\n')
    .map((l) => cleanGlyphs(l.replace(/\s+/g, ' ').trim()))
    // Some ACs' extracted pdf_text carries literal Markdown bold markers
    // ("**1. PURPOSE.**", "1. **Purpose**.", "**a.**") from a source pipeline
    // that renders emphasis as raw asterisks instead of real formatting. Every
    // classifier below anchors on the line's literal first character(s) (the
    // digit itself, or the letter right after "N. ") — a leading/embedded "**"
    // breaks all of them, silently demoting every heading and lettered item in
    // the document to plain body text (confirmed on 00-44II, 20-171, 21-48,
    // 35.16-1). NOT a blanket strip — "**" is also a genuine, common FOOTNOTE
    // MARKER convention throughout this corpus ("** Note: RVR values are
    // shown...", "TDZ RVR (ft)** Mid RVR (ft)**", "+/-0.03 nm (**)"), and a
    // first version that stripped every "**" unconditionally silently
    // destroyed those references corpus-wide (685 lines across dozens of
    // ACs, caught in a follow-up regression pass — see flyregs_parser.md).
    // This regex only matches a genuine PAIRED bold-wrap: opening "**" must
    // be immediately followed by a letter/digit (no space — excludes "** "
    // and "*** "/"**** " footnote prefixes, which always have a space or a
    // third asterisk right after), and closing "**" must be immediately
    // preceded by a letter/digit/period (no space or ")" — excludes
    // "(ft)**"/"(**)"-style trailing footnote references). Verified against
    // all known real cases (task #84's 7 ACs) and all known footnote-marker
    // shapes in the corpus before shipping.
    .map((l) => l.replace(/\*\*([A-Za-z0-9][^*\n]{0,98}?[A-Za-z0-9.])\*\*/g, '$1'))
    // A section number occasionally has a stray space before its period
    // ("3 . REFERENCE DOCUMENT." instead of "3. REFERENCE DOCUMENT.") — a
    // kerning/OCR artifact on old scanned ACs (confirmed on AC 00-41B) that
    // silently drops the heading from every classifier below, since none of
    // them tolerate a space between the digits and the period. Anchored to
    // the START of the line only, so this can't touch a number that
    // legitimately has a space after it elsewhere in running prose.
    .map((l) => l.replace(/^(\d{1,4})\s+\.\s*/, '$1. '))
    // A heading's own first word occasionally has a stray inserted space
    // right after its first letter ("1. P urpose . This advisory circular…",
    // confirmed on AC 20-18B) — a PDF-extraction kerning glitch distinct from
    // the OCR_SCANNED_ACS artifact repair below (which is deliberately gated
    // to only the 68 flagged old scans, since applying it universally
    // corrupts modern text — see v31). Scoped narrowly to right after a "N. "
    // heading-number prefix (never fires in ordinary body prose) so it's
    // mostly safe to run unconditionally — EXCEPT the single letter must
    // exclude A/I/O, which are real standalone English words ("1. A file
    // containing…", "3. A backslash…" are genuine list items, not "Afile"/
    // "Abackslash" kerning splits). A corpus-wide check after first shipping
    // this without the exclusion found 595 false-positive merges across 129
    // ACs — exactly the mistake the OCR_SCANNED_ACS artifact-repair regex
    // below already learned to avoid via the same [B-HJ-NP-Z] class; this
    // mirrors it.
    .map((l) => l.replace(/^(\d{1,4}\.)\s+([B-HJ-NP-Z]) ([a-z]{2,15})(?=[\s.?:]|$)/, '$1 $2$3'))
    // Collapse a stray space directly before a heading title's own terminal
    // period ("Purpose . This…" → "Purpose. This…"), a side effect of the
    // same kerning glitch above. Only after a letter (not a digit) so this
    // can't touch a decimal number or version string elsewhere in the text.
    .map((l) => l.replace(/([A-Za-z]) \.(?=\s|$)/g, '$1.'))

  // 2b. Rejoin a section number split from its title by a PDF line break — a line
  //     that is just "102." with the title ("LIMIT OF VALIDITY. …") on the next
  //     non-empty line. A bare "N." is never meaningful alone, so merge it forward
  //     so the classifier sees a complete "102. LIMIT OF VALIDITY." heading line.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\d{1,3}\.$/.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && lines[j] === '') j++
    if (j < lines.length && /^[A-Z]/.test(lines[j])) {
      lines[i] = `${lines[i]} ${lines[j]}`
      lines[j] = ''
    }
  }

  // 2c. Same rejoin, one level down: a lettered/numbered sub-item marker
  //     ("a.", "(1)", "(a)") split from its own body by a PDF line break —
  //     confirmed on AC 23-13A's "a." sitting alone on its line with "The
  //     historical guidance..." starting on the next line. ITEM_A/ITEM_N/
  //     ITEM_L (below) all require body text on the SAME line as the marker,
  //     so a bare marker with nothing else on its line is invisible to them
  //     and silently falls into the PRECEDING block's body instead of
  //     starting its own item — which is exactly what happened here: "a."
  //     never became its own item (missing the bold-letter + indent
  //     treatment "b." right after it correctly got), and its body just
  //     extended section 3-3's own body text instead.
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^(?:[a-z]\.|\(\d{1,3}\)|\([a-z]\))$/.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && lines[j] === '') j++
    if (j < lines.length && /^[A-Za-z]/.test(lines[j])) {
      lines[i] = `${lines[i]} ${lines[j]}`
      lines[j] = ''
    }
  }

  // NOTE: a "2d" step was tried here (rejoin a heading's own first word when
  // split mid-word by a PDF line break, e.g. "1. Pur" + "pose." on the next
  // line, confirmed on AC 33-11) and reverted after a corpus-wide check. It
  // can't reliably distinguish a genuine truncated fragment ("Pur", "Comple")
  // from an ordinary COMPLETE word that's followed by an unrelated new line
  // ("Capability" + "to meet schedules...", "Security" + "a. Do security
  // systems..." — a sub-item marker, not a continuation) — length alone
  // doesn't separate them (bad merges ranged 3-10 chars, same range as good
  // ones), and there's no dictionary check available. 595 false-positive
  // merges was one thing (the A/I/O bug above, fixed); this one's false
  // positives silently glue real, unrelated words together with no space, no
  // way to distinguish "fixed" from "corrupted" by eyeballing the output.
  // Same class of shape-alone undecidability already documented for AC
  // 89-3's "7." list item (flyregs_parser.md v29) — accepted as a residual
  // limitation rather than risked corpus-wide. AC 33-11 is fixed via a
  // manual `ac_block_overrides` entry instead (see flyregs_parser.md).

  // 3. Remove table-of-contents regions (dotted-leader lines and everything
  //    between them — duplicate chapter listings, page markers, etc.). A real TOC
  //    is a DENSE cluster of dotted lines; large docs have several (a main TOC plus
  //    per-chapter contents). Group matches into clusters split by gaps > 30 non-
  //    TOC lines, then strip EVERY cluster of >= 6 entries. The size threshold
  //    ignores isolated false matches (e.g. a flowchart caption with a bullet
  //    sequence "• • • •4") that would otherwise extend a strip into the body.
  const tocIdx = lines.map((l, i) => (TOC_LEADER.test(l) ? i : -1)).filter((i) => i >= 0)
  if (tocIdx.length >= 6) {
    const groups: number[][] = [[tocIdx[0]]]
    for (let k = 1; k < tocIdx.length; k++) {
      if (tocIdx[k] - tocIdx[k - 1] <= 30) groups[groups.length - 1].push(tocIdx[k])
      else groups.push([tocIdx[k]])
    }
    const strip = new Set<number>()
    for (const g of groups) {
      if (g.length < 6) continue // too small to be a TOC — leave it for the body
      for (let i = g[0]; i <= g[g.length - 1]; i++) strip.add(i)
    }
    if (strip.size) lines = lines.filter((_, i) => !strip.has(i))
  }

  // 3a. Leaderless table of contents. Some ACs right-align page numbers with
  //     whitespace that collapses on extraction, so each TOC entry ends in a bare
  //     page number with no dotted leader (e.g. "100. GENERAL INFORMATION... 3",
  //     "CHAPTER 2—... 6", OCR-split "...SECTION 1 2"). Anchor on a "TABLE OF
  //     CONTENTS"/"CONTENTS" header and drop the contiguous run of page-number-
  //     terminated heading lines after it. The body repeats those headings but
  //     ends them with a period + body text, so real content is never matched.
  const tocHdr = lines.findIndex((l) => /^(TABLE OF CONTENTS|CONTENTS)\b/i.test(l))
  if (tocHdr >= 0 && tocHdr < lines.length * 0.6) {
    const endsInPage = /\s(\d{1,3}|\d \d|\d \d \d|[IVXLC]{1,6})\s*$/
    // Tolerates OCR letter-spacing ("P U R P O S E") — the header anchor and the
    // trailing-page-number requirement keep body text from matching.
    const looksTocEntry = (l: string) =>
      l.length > 6 && /[A-Za-z]/.test(l) && /^[\dA-Z]/.test(l) && endsInPage.test(l)
    let last = -1
    let count = 0
    for (let i = tocHdr + 1; i < lines.length; i++) {
      if (lines[i] === '' || isNoise(lines[i], documentNumber)) continue // skip blanks + page markers
      if (looksTocEntry(lines[i])) { last = i; count++ } else break // body starts
    }
    if (count >= 4) for (let i = tocHdr; i <= last; i++) lines[i] = ''
  }

  // 3b. Leaderless TOC with the page number lost entirely (not just collapsed
  //     to a bare trailing number — gone, e.g. 120-28D). Each entry is JUST
  //     "N[.N...] Title", textually identical in shape to a real heading whose
  //     body happens to start on the next PDF line. Only safe because it's
  //     anchored to run immediately after the "TABLE OF CONTENTS" header with
  //     zero interruption — a real body always has prose between headings, so
  //     a long unbroken run of bare heading-shaped lines right there can only
  //     be the contents listing itself. A wrapped second line of a long TOC
  //     title (no leading number, e.g. "...Airborne System" / "Demonstrations")
  //     is tolerated as a continuation rather than breaking the run.
  {
    const tocHdr2 = lines.findIndex((l) => /^(TABLE OF CONTENTS|CONTENTS)\b/i.test(l))
    if (tocHdr2 >= 0 && tocHdr2 < lines.length * 0.6) {
      const bareHeadingLine = /^\d{1,3}(?:\.\d{1,3}){0,4}\.?\s+[A-Z][A-Za-z0-9 ,.()&'"/-]{1,90}$/
      const looksLikeWrap = (l: string) => l.length > 0 && l.length <= 60 && /^[A-Z]/.test(l) && !/[.!?]$/.test(l)
      // A column-header caption line before the listing proper starts (e.g.
      // "SEC # SECTION TITLES", "PARAGRAPH TITLE PAGE") — all-caps/numeric,
      // no lowercase prose, short. Only tolerated before the first real match.
      const looksLikeCaption = (l: string) => l.length <= 40 && /^[A-Z0-9 #.,-]+$/.test(l)
      let last = -1
      let count = 0
      let prevWasHeadingOrWrap = false
      let sawFirstHeading = false
      for (let i = tocHdr2 + 1; i < lines.length; i++) {
        if (lines[i] === '' || isNoise(lines[i], documentNumber)) continue
        if (bareHeadingLine.test(lines[i])) {
          last = i
          count++
          prevWasHeadingOrWrap = true
          sawFirstHeading = true
        } else if (prevWasHeadingOrWrap && looksLikeWrap(lines[i])) {
          last = i
        } else if (!sawFirstHeading && looksLikeCaption(lines[i])) {
          last = i
        } else break
      }
      if (count >= 8) for (let i = tocHdr2; i <= last; i++) lines[i] = ''
    }
  }

  // 3b. Pre-classify pass: blank out the first line of multi-line TOC entries
  //     that match the APPXSEC format (e.g. "A.2 Review of deficiencies…").
  //     Appendix TOCs split long entries across 2–3 lines — only the LAST line
  //     has dotted leaders and a page number (caught by isTOC), but the first
  //     line has no dots and would otherwise be classified as a real section.
  //     Look ahead up to 4 non-empty lines; if any is a TOC line, this line is
  //     a TOC header and should be skipped.
  //     Kept in sync with APPXSEC's own multi-level shape (same "letter, then
  //     a chain of .N segments" pattern) -- when APPXSEC gained multi-level
  //     support (2026-08-18), a deep TOC entry like "A.2.1 Some Long Title"
  //     stopped being recognized as a TOC line here (this regex was still
  //     single-level only) and started leaking through Step 4's classifier as
  //     a spurious real heading, corrupting block order on a handful of docs
  //     (caught by scripts/diff-parser-version.mjs-style corpus validation --
  //     word-for-word content reordering on 120-117, 45-2E, 450.141-1A before
  //     this fix).
  const APPXSEC_TOC_RE = /^[A-Z]\.\d{1,3}(?:\.\d{1,2}){0,6}\.?\s+[A-Za-z]/
  for (let k = 0; k < lines.length; k++) {
    if (!APPXSEC_TOC_RE.test(lines[k])) continue
    let nonEmpty = 0
    for (let j = k + 1; j < lines.length && nonEmpty < 6; j++) {
      const lj = lines[j]
      // Skip blank lines, recognized noise, and short header/page-marker lines
      // (like "Appendix A" or "A-6") that appear in mid-TOC page breaks and
      // would otherwise exhaust the look-ahead before reaching a dotted line.
      if (lj === '' || isNoise(lj, documentNumber) || lj.length < 15) continue
      nonEmpty++
      if (isTOC(lj)) { lines[k] = ''; break }
    }
  }

  // 4. Classify lines into blocks.
  const blocks: ACBlock[] = []
  let cur: ACBlock | null = null
  let bodyStarted = false
  let hid = 0 // navigable-heading id counter
  const nextId = () => `h${hid++}`
  const flush = () => {
    if (cur) {
      blocks.push(cur)
      cur = null
    }
  }

  // Table-mode state: set when we enter a TABLE block. Column headers (all-caps
  // lines at the top of a table) are rendered as a para; once the first data row
  // with mixed-case content appears, subsequent all-caps lines are row identifiers
  // and become bullet items. Exits when a real section or chapter is detected.
  let inTable = false
  let tableHeaderDone = false

  // Many FAA ACs mix a FLAT top-level numbering scheme ("1. PURPOSE.", "2.
  // AUDIENCE.", ... "7. BACKGROUND.") with decimal SUBsections nested under
  // each ("6.1 IATA IOSA.", "7.1 Internal Evaluation..."). In that structure
  // the flat numbers are strictly ascending — each real top-level heading
  // continues the sequence, decimal subsections in between don't interrupt it.
  // A numbered list item embedded in body prose ("1. Category A is..., 2.
  // Category B is...") shares NUMSEC's exact "digit. Capitalized text" shape
  // but does NOT continue that sequence — it typically restarts at 1 (or some
  // unrelated number) wherever it happens to appear in the document, long
  // after the real top-level counter has moved past it. Tracking the last
  // accepted flat number and requiring the next one to actually continue the
  // sequence is what tells a real "7. BACKGROUND." (7 follows 6) apart from a
  // stray "1. Category A..." (1 doesn't follow whatever came before it) —
  // catching the false positives regex shape alone can't distinguish, without
  // breaking documents that legitimately keep numbering flat sections after
  // decimal subsections have already appeared.
  let lastFlatNum: number | null = null
  const isNextFlatNum = (raw: string): boolean => {
    const n = parseInt(raw, 10)
    if (isNaN(n)) return false
    // Bootstrap case: no flat heading accepted yet. A genuine document that
    // legitimately opens with flat numbering starts at "1." before any
    // decimal (SECDOT) heading has appeared. If decimal numbering is ALREADY
    // established by this point, the document's real structure is decimal —
    // a bare "1." Title-Case candidate here is virtually always a numbered
    // list item ("1. The records should be in the English language...")
    // nested inside a decimal section's body, not a genuine document restart.
    if (lastFlatNum === null) return n === 1 && secDotCount < 2
    return n > lastFlatNum && n <= lastFlatNum + 10
  }
  // Stricter sibling used ONLY by NUMSEC_COLON — requires an exact +1
  // continuation instead of the "+10" window above. A corpus-wide check
  // found the wider tolerance let a handful of numbered reference-list items
  // slip through as spurious headings purely by landing within 10 of
  // whatever the document's real last section number happened to be (AC
  // 91-92's "8. AVCAM..."/"15. NWS:", both list items inside section 5.1's
  // own reading list, with the document's real last section only at "5" by
  // that point; AC 00-31A's "120. NOTE:", an inline annotation referencing
  // "paragraphs 113 through 120" that isn't itself paragraph 120). Every
  // confirmed-genuine NUMSEC_COLON case (AC 20-40, 150/5020-2, 20-119, and
  // others) continues its document's real sequence exactly by 1, so the
  // tighter check costs nothing there while closing off the ambiguous cases
  // the wider "+10" tolerance was designed for Title-Case headings, not
  // this narrower, riskier branch.
  const isNextFlatNumStrict = (raw: string): boolean => {
    const n = parseInt(raw, 10)
    if (isNaN(n)) return false
    if (lastFlatNum === null) return n === 1 && secDotCount < 2
    return n === lastFlatNum + 1
  }
  // Tried narrowing the "+10" tolerance to "+3" (2026-07-11) to fix AC 89-3's
  // "7. Aeronautical Information Manual (AIM)." — a numbered-reading-list item
  // that shares Title-Case shape with real headings and gets mistaken for one
  // because it falls within the jump window from the last real section (4).
  // Full-corpus validation caught it losing real content elsewhere: AC
  // 21-29D's genuine form-field instructions "13.", "14.", "15." jump by more
  // than 3 from whatever came before and were silently dropped with nothing
  // recovering them. Reverted to +10. The 89-3 case is left as a known,
  // accepted residual ambiguity — a numbered sub-list using the exact same
  // "digit. Title Case" shape as the document's own top-level sections is
  // fundamentally indistinguishable from a real heading by shape and
  // proximity alone; fixing it would need a genuinely different signal (e.g.
  // tracking whether a document's established heading case-style is ALL-CAPS
  // vs Title-Case and gating new candidates against that), not attempted.
  // The sequence check above only needs to gate NUMSEC's ambiguous Title-Case
  // branch (second character lowercase, e.g. "Background.") — that's the shape
  // a numbered list item can also take. The ALL-CAPS/acronym branches are
  // already a safe signal on their own (ordinary prose never produces a run of
  // pure uppercase text), and gating them too broke very old, heavily
  // OCR-garbled ACs whose numbering doesn't strictly ascend but whose headings
  // are still genuinely ALL-CAPS.
  const needsSequenceGate = (title: string): boolean => /^[A-Z][a-z]/.test(title)

  // SEC ("N-N. Title", old dash-style numbering) shares its exact shape with a
  // plain AC document number ("120-118", "20-1"). A modern AC using decimal
  // (SECDOT) numbering never has genuine dash-style headings of its own, so a
  // dash-number match found AFTER decimal numbering is already established is
  // almost always a cross-reference to a DIFFERENT AC that wrapped onto the
  // start of a line, not a real section. Gate SEC the same way NUMSEC is
  // gated against decimal numbering.
  let secDotCount = 0

  // Second gate for NUMSEC_COLON (see its own comment above) — true once any
  // lettered appendix heading (APPXSEC) has been seen.
  let appxSeen = false

  for (let line of lines) {
    // Blank lines break paragraph continuations — they are meaningful paragraph
    // separators in PDF text. Only PAR blocks split on blank lines; section and
    // item bodies continue to absorb continuation lines across blank lines so
    // multi-paragraph body text stays in the correct section.
    if (line === '') {
      if (cur?.kind === 'para') flush()
      continue
    }
    if (isNoise(line, documentNumber) || isTOC(line)) continue

    // OCR artifact repair: old scanned PDFs (pre-~2005) sometimes have spaces
    // inserted within words at extraction time. Fix the two most common patterns:
    //   (1) Single uppercase letter split from its word: "A UTHORITY" → "AUTHORITY"
    //       "E XPLANATION" → "EXPLANATION". Lookbehind prevents merging words in
    //       multi-word ALL-CAPS phrases like "FAA AUTHORITY" (the A in FAA is
    //       preceded by another letter and won't match).
    //   (2) Isolated single uppercase letter between two isolated uppercase letters
    //       (e.g. "O F" within "EXPLANATION O F CHANGES") → "OF".
    //   (3) Single non-article letter split from a lowercase word: "E xcessive" →
    //       "Excessive", "p articularly" → "particularly". Excludes 'a', 'i', 'o'
    //       (standalone English words) to avoid false merges.
    // Gated to ONLY the documents already flagged as genuine old scans
    // (OCR_SCANNED_ACS) -- this heuristic can't tell a real split-word artifact
    // apart from an ordinary standalone single-letter designator followed by a
    // real word (a subpart/class/appendix letter: "subpart C contains" was
    // getting squished into "subpart Ccontains"). A corpus-wide scan found this
    // shape matches in 594 of 777 ACs -- the overwhelming majority never had
    // this OCR-scan problem in the first place, so applying it universally was
    // actively corrupting modern digitally-native text. Confirmed via
    // isOcrScanned() rather than a blanket regex heuristic, since that's an
    // already-vetted, human-confirmed list of which documents are actually
    // scans (see ocrScannedACs.ts).
    if (ocrScanned) {
      line = line.replace(/(?<![A-Za-z''’])([B-HJ-NP-Z]) ([A-Z]{2,})/g, '$1$2')
      line = line.replace(/(?<![A-Za-z''’])([A-Z]) ([A-Z])(?![A-Za-z])/g, '$1$2')
      line = line.replace(/(?<![A-Za-z''’])([B-HJ-NP-Zb-hj-np-z]) ([a-z]{3,})/g, '$1$2')
    }

    // TABLE headers ("TABLE 2-1. GAS LAWS…", or the lettered-appendix scheme
    // "Table A-1. U.S. Air Force Specialty Codes") become chapter blocks for
    // navigation and trigger table-mode so subsequent content is formatted
    // as bullet items.
    if (TBL.test(line) || isLetterTableHeading(line)) {
      flush()
      blocks.push({ kind: 'chapter', id: nextId(), text: line })
      bodyStarted = true
      inTable = true
      tableHeaderDone = false
      continue
    }

    if (CH.test(line) || APPX.test(line)) {
      flush()
      inTable = false
      const prev = blocks[blocks.length - 1]
      // Skip a duplicate heading left over from the table of contents.
      if (!(prev && prev.kind === 'chapter' && prev.text === line)) {
        blocks.push({ kind: 'chapter', id: nextId(), text: line })
      }
      bodyStarted = true
      continue
    }

    let m
    if ((m = line.match(NUMSEC2)) && (!needsSequenceGate(m[2]) || isNextFlatNum(m[1]))) {
      flush()
      inTable = false
      if (/^\d+$/.test(m[1])) lastFlatNum = parseInt(m[1], 10)
      cur = { kind: 'section', id: nextId(), label: m[1] + '.', title: m[2], body: m[3] }
      bodyStarted = true
      continue
    }
    if ((m = line.match(NUMSEC2_COLON)) && (!needsSequenceGate(m[2]) || isNextFlatNum(m[1]))) {
      flush()
      inTable = false
      if (/^\d+$/.test(m[1])) lastFlatNum = parseInt(m[1], 10)
      cur = { kind: 'section', id: nextId(), label: m[1] + '.', title: m[2], body: m[3] }
      bodyStarted = true
      continue
    }
    if ((m = line.match(NUMSEC2_BARE)) && (!needsSequenceGate(m[2]) || isNextFlatNum(m[1]))) {
      flush()
      inTable = false
      if (/^\d+$/.test(m[1])) lastFlatNum = parseInt(m[1], 10)
      cur = { kind: 'section', id: nextId(), label: m[1] + '.', title: m[2], body: '' }
      bodyStarted = true
      continue
    }
    if (secDotCount < 2 && (m = line.match(SEC))) {
      flush()
      inTable = false
      const { title, body } = splitHeading(m[2])
      cur = { kind: 'section', id: nextId(), label: m[1], title, body }
      bodyStarted = true
      continue
    }
    if ((m = line.match(SECDOT))) {
      flush()
      inTable = false
      secDotCount++
      const { title, body } = splitHeading(m[2])
      cur = { kind: 'section', id: nextId(), label: m[1], title, body }
      bodyStarted = true
      continue
    }
    if (APPXSEC.test(line)) appxSeen = true
    if (
      (m = line.match(APPXSEC)) ||
      ((m = line.match(NUMSEC)) && (!needsSequenceGate(m[2]) || isNextFlatNum(m[1]))) ||
      ((m = line.match(NUMSEC_COLON)) && !appxSeen && isNextFlatNumStrict(m[1])) ||
      ((m = line.match(NUMSEC3)) && isNextFlatNum(m[1]))
    ) {
      flush()
      inTable = false
      if (m[1] && /^\d+\.?$/.test(m[1])) lastFlatNum = parseInt(m[1], 10)
      const { title, body } = splitHeading(m[2])
      cur = { kind: 'section', id: nextId(), label: m[1], title, body }
      bodyStarted = true
      continue
    }

    if ((m = line.match(ITEM_A)) || (m = line.match(ITEM_N)) || (m = line.match(ITEM_L))) {
      flush()
      inTable = false
      const level = ITEM_A.test(line) ? 1 : ITEM_N.test(line) ? 2 : 3
      const { title, body } = splitHeading(m[2], true)
      cur = { kind: 'item', level, label: m[1], title, body }
      bodyStarted = true
      continue
    }

    // Standalone ALL-CAPS headings without a number prefix (e.g. "STUDENT PILOT
    // ENDORSEMENTS" as category dividers in Appendix A). Must be 15+ chars to
    // exclude short acronyms, and only letters/spaces/common-punctuation so that
    // lines with digits (CFR refs, section numbers) are not matched here.
    // Guard: skip inside table regions — column header rows like "AILMENT SYMPTOMS
    // TREATMENT" look identical and must NOT become false chapter headings.
    if (!inTable && /^[A-Z][A-Z (),/-]{14,}[A-Z)]$/.test(line)) {
      flush()
      blocks.push({ kind: 'chapter', id: nextId(), text: line })
      bodyStarted = true
      continue
    }

    // Table-mode content: column headers (all-caps lines before the first data
    // row) render as a para; data rows become bullet items. Three patterns
    // trigger a new bullet once we're past the column headers:
    //   isAllCaps       — line is entirely uppercase ("SINUSES DESCENT") →
    //                     pure row id
    //   isRowStart      — line begins with 2+ consecutive 2+-char ALL-CAPS
    //                     words then switches to mixed case on the same line
    //                     ("TEETH ASCENT A tooth block…") — the PDF squeezed
    //                     the row identifier and its description onto one
    //                     line; treat that whole line as a new bullet rather
    //                     than a continuation.
    //   isMatrixRowStart — a "N-M Title" row-label prefix used by multi-
    //                     column compliance-matrix tables (mixed-case title,
    //                     so neither pattern above matches it). Confirmed
    //                     real against raw pdf_text: AC 33-8's Appendix 2/3
    //                     risk-mitigation matrix uses a "Section/Number" +
    //                     "Characteristic" column pair — real rows read
    //                     "3-3 Mechanical /metallurgical properties",
    //                     "3-4 Cast structure", "4-1 Casting cleanliness".
    //                     Without this, table-mode's continuation fallback
    //                     had no way to recognize a new row here and kept
    //                     absorbing dozens of real rows into one runaway
    //                     item (confirmed corpus-wide before adding this:
    //                     also present in 33-8's own multiple 15K-45K-char
    //                     blocks — the OTHER remaining oversized-block docs
    //                     use visibly different row shapes, e.g. pipe-
    //                     delimited tables in 38-1/33.70-3 (see
    //                     isPipeRowStart below, added separately).
    //   isPipeRowStart  — a literal PDF-extracted markdown-style pipe row
    //                     ("| Correction | Paragraph... |"), confirmed real
    //                     against raw pdf_text in both 38-1 (Appendix 3's
    //                     "Table A3-1. Corrections to reference
    //                     specifications") and 33.70-3 (Appendix C's
    //                     "Table C-2. Tabular Data") -- same shared root
    //                     cause, same fix. Neither of the other two row
    //                     patterns match a line starting with "|", so this
    //                     content had no row boundary at all and glued into
    //                     one runaway item exactly like the "N-M Title"
    //                     case above. A leading "|" essentially never
    //                     starts an ordinary prose line, so this is a safe,
    //                     unambiguous signal once already inside table-mode.
    //                     Deliberately not filtering the header/separator
    //                     row that repeats after a PDF page break (e.g.
    //                     "|---|---|---|" or the column-header row again) --
    //                     it becomes its own small, harmless extra item
    //                     rather than corrupting anything, and guessing at
    //                     which repeated row is "real" vs. a page-break
    //                     artifact is exactly the kind of fragile heuristic
    //                     this fix is trying to avoid.
    if (inTable) {
      const isAllCaps = /^[A-Z][A-Z0-9 (),-]*$/.test(line)
      const isRowStart = !isAllCaps && /^[A-Z]{2,}(?:\s+[A-Z]{2,})+/.test(line)
      const isMatrixRowStart = !isAllCaps && !isRowStart && /^\d{1,2}-\d{1,3}\s+[A-Z]/.test(line)
      const isPipeRowStart = /^\|/.test(line)
      // isSectionCiteRowStart — a "§ N.NN, Title" regulation-citation row
      // label, confirmed real against raw pdf_text in 120-92D's Appendix G
      // implementation-strategy table (real rows: "§ 5.21, Safety policy.",
      // "§ 5.23, Safety accountability and authority." -- the latter wraps
      // its own title across multiple PDF lines, so this only needs to
      // match the "§ N.NN," lead-in on the row's first line, same as the
      // other row-start patterns above). The section-symbol prefix is
      // essentially unambiguous inside table-mode -- ordinary prose never
      // starts a line with "§".
      const isSectionCiteRowStart =
        !isAllCaps && !isRowStart && !isMatrixRowStart && /^§\s*\d+(\.\d+)?,/.test(line)

      if (!tableHeaderDone) {
        if (isAllCaps) {
          // Still in the column-header zone — collect into one para
          if (cur?.kind === 'para') {
            cur.text = cur.text + ' ' + line
          } else {
            flush()
            cur = { kind: 'para', text: line }
          }
        } else {
          // First non-all-caps line = end of column headers; switch to bullet mode
          flush()
          tableHeaderDone = true
          cur = { kind: 'item', level: 1, label: '•', title: '', body: line }
          bodyStarted = true
        }
      } else if (isAllCaps || isRowStart || isMatrixRowStart || isPipeRowStart || isSectionCiteRowStart) {
        // New data row — pure all-caps id, inline "ID text description"
        // pattern, a "N-M Title" compliance-matrix row label, a literal
        // "| ... |" pipe-delimited row, or a "§ N.NN," regulation-citation
        // row label
        flush()
        cur = { kind: 'item', level: 1, label: '•', title: '', body: line }
        bodyStarted = true
      } else {
        // Continuation of the current row
        if (cur?.kind === 'item') {
          cur.body = cur.body ? cur.body + ' ' + line : line
        } else if (cur?.kind === 'para') {
          cur.text = cur.text + ' ' + line
        } else {
          flush()
          cur = { kind: 'item', level: 1, label: '•', title: '', body: line }
          bodyStarted = true
        }
      }
      continue
    }

    // Continuation of the current block.
    if (cur && cur.kind === 'para') {
      cur.text = cur.text + ' ' + line
    } else if (cur && (cur.kind === 'section' || cur.kind === 'item')) {
      // Detect a PDF line-break mid-word in the heading — the title is a bare
      // fragment with no closing punctuation, and the next line continues that
      // exact word. Two shapes seen in the wild:
      //   ALL-CAPS split:    "CO" + "NDITIONS." → "CONDITIONS."
      //   Title-case split:  "Glid" + "epath. The airplane…" → "Glidepath."
      // Both require the title so far to be word-shaped with no terminal
      // punctuation (a real complete heading always ends in one) — that's what
      // signals "this was cut off mid-word", not "this is a genuinely short
      // heading with no period." Requires at least 2 characters so far — a
      // single bare letter ("1. T" + "he temporary or permanent loss...") is
      // indistinguishable from the ordinary start of a ordinary word ("The")
      // in body prose and isn't strong enough evidence of a real truncated
      // heading to merge.
      // Section-only: an ITEM_A/ITEM_N/ITEM_L item's "title" is just whatever
      // text happened to precede the first period on its opening line (see
      // splitHeading) — for ordinary list-item prose that's a random clause
      // fragment, not a heading, so a short trailing word there ("toxic",
      // "the", "mount", "under" — all real, complete words <=5 chars) is
      // indistinguishable from a genuine glyph-split fragment ("Glid") by
      // shape alone. Confirmed on AC 33-8's table: "(2) Concentration of
      // toxic" + "products in the engine..." was merging into
      // "toxicproducts" because the heuristic (designed for section heading
      // repairs like "CO"+"NDITIONS.") misfired on this item body. Sections'
      // titles are deliberately bold/short/label-like, which is why the
      // heuristic is safe to keep for them but not for item bodies.
      if (cur.kind === 'section' && !cur.body && cur.title && cur.title.length >= 2 && !/[.?!:]$/.test(cur.title)) {
        if (/^[A-Z]{2,8}$/.test(cur.title) && /^[A-Z]{2,}\./.test(line)) {
          const wordEnd = line.match(/^([A-Z]+\.)\s*(.*)$/)
          if (wordEnd) {
            cur.title = cur.title + wordEnd[1]
            cur.body = wordEnd[2].trim()
            continue
          }
        } else if (/^[a-z]{2,}/.test(line)) {
          // The trailing word of the title-so-far decides which shape this is.
          // A SHORT trailing fragment ("Glid") is almost certainly a genuine
          // mid-word glyph split and gets no space. A trailing word of
          // ordinary length ("fatigue") is a COMPLETE word that just happens
          // to sit at the end of a wrapped PDF line — that's a normal
          // sentence continuing onto the next line, and needs a real space
          // (confirmed on AC 23-13A's "...in my fatigue" / "evaluation?...",
          // which the old no-space merge turned into "fatigueevaluation").
          // Also excludes common short FUNCTION words ("an", "of", "the",
          // "with"...) from the no-space branch even though they're <=5
          // chars -- a real glyph-split fragment is a truncated CONTENT
          // word (part of "Glidepath", "toxic", "CONDITIONS"), essentially
          // never a complete grammatical function word, whereas a genuine
          // sentence very commonly wraps right after one. Confirmed on AC
          // 450.141-1A during the 2026-08-18 APPXSEC widening's corpus
          // validation: "...as a result of an" / "intermittent power
          // transient..." was merging into "anintermittent" -- this is a
          // pre-existing gap in this heuristic (not new to that change) that
          // simply had no section-title long/wrapped enough to expose it
          // before APPXSEC started recognizing sections whose title is a
          // full unterminated sentence fragment rather than a short bold
          // label.
          const SHORT_FUNCTION_WORDS = new Set([
            'a', 'an', 'as', 'at', 'be', 'by', 'do', 'he', 'if', 'in', 'is', 'it', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
            'all', 'and', 'any', 'are', 'but', 'can', 'did', 'for', 'had', 'has', 'her', 'him', 'his', 'how', 'its', 'may', 'nor',
            'not', 'now', 'off', 'one', 'our', 'out', 'per', 'she', 'the', 'too', 'use', 'was', 'who', 'why', 'you',
            'also', 'been', 'both', 'each', 'from', 'into', 'more', 'most', 'must', 'none', 'only', 'over', 'same', 'some',
            'such', 'than', 'that', 'them', 'then', 'they', 'this', 'thus', 'upon', 'were', 'what', 'when', 'whom', 'will', 'with',
          ])
          // A trailing letter run immediately preceded by a DIGIT with no
          // space ("Pad 17B") is a complete alphanumeric designator/code,
          // not a truncated word -- a real glyph split never produces a
          // letter fragment stuck directly to a number this way. Without
          // this, the trailing "B" of "17B" (length 1, not a function word)
          // still passed the check and merged the next word straight onto
          // it ("17Bat" -- confirmed on AC 450.141-1A's "Pad 17B" / "at Cape
          // Canaveral..." during the same 2026-08-18 corpus validation as
          // the SHORT_FUNCTION_WORDS fix above).
          const trailingWordIsAlphanumericTail = /\d[A-Za-z]{1,5}$/.test(cur.title)
          const trailingWord = cur.title.match(/([A-Za-z]+)$/)?.[1] ?? ''
          // Belt-and-suspenders on top of the two exclusions above: this
          // repair's whole premise ("Sections' titles are deliberately
          // bold/short/label-like") only actually holds for titles that ARE
          // short -- every genuine confirmed case ("CO", "Glid") is under 10
          // chars. The SHORT_FUNCTION_WORDS list only excludes grammatical
          // function words; it can't catch an ordinary CONTENT word ("data",
          // "error", "after", "role", "code") also legitimately ending a
          // wrapped sentence -- confirmed on the same AC 450.141-1A corpus
          // validation: "...to prevent error" / "propagation across..." and
          // "...validate data" / "transfer. Operations..." both still
          // merged into "errorpropagation"/"datatransfer." even after the
          // function-word fix, because APPXSEC's multi-level widening lets
          // splitHeading's unconditional "entire rest is title" fallback
          // (see its own comment -- deliberately NOT scoped to short titles,
          // since sections need it for real bare ALL-CAPS headings too) hand
          // this repair a full 40+ char sentence fragment as "cur.title"
          // instead of the short bold label it was designed for. Capping to
          // titles this repair is actually meant to see restores the
          // original safety argument instead of chasing individual words.
          const titleLooksLikeShortLabel = cur.title.length <= 20
          if (
            trailingWord.length > 0 &&
            trailingWord.length <= 5 &&
            !SHORT_FUNCTION_WORDS.has(trailingWord.toLowerCase()) &&
            !trailingWordIsAlphanumericTail &&
            titleLooksLikeShortLabel
          ) {
            const wordEnd = line.match(/^([a-z]+[.,]?)\s*(.*)$/)
            if (wordEnd) {
              cur.title = cur.title + wordEnd[1]
              cur.body = wordEnd[2].trim()
              continue
            }
          } else {
            // Natural word-wrap: only the part of this line up through the
            // title's own terminating punctuation belongs to the title
            // (e.g. "evaluation?"); anything after that is body. Capped at
            // 90 chars so a continuation line with no early "."/"?"/"!"
            // (i.e. this isn't really a short title continuation at all)
            // falls through to the plain body-append below instead of
            // greedily swallowing unrelated prose into the title.
            const titleEnd = line.match(/^(.{1,90}?[.?!])\s*(.*)$/)
            if (titleEnd) {
              cur.title = cur.title + ' ' + titleEnd[1]
              cur.body = titleEnd[2].trim()
              continue
            }
          }
        }
      }
      // Narrow item-only case: splitHeading() (with forItem=true) returns an
      // empty title and puts a lone SINGLE LETTER straight into cur.body when
      // an item's opening line was just that one letter ("c. F", confirmed on
      // AC 20-166A — the rest of the word "For" continues on the next line).
      // A single bare letter is a genuine mid-word glyph split (same signal
      // already trusted for the section-only repair above), so join with NO
      // space here specifically — unlike a multi-letter fragment ("The",
      // "IPs"), which IS a complete real word and needs the normal spaced
      // join below (confirmed: "IPs" + "provide" must stay two words, not
      // merge into "IPsprovide").
      if (cur.kind === 'item' && cur.title === '' && /^[A-Za-z]$/.test(cur.body) && /^[a-z]/.test(line)) {
        cur.body = cur.body + line
        continue
      }
      cur.body = cur.body ? cur.body + ' ' + line : line
    } else {
      // New stray paragraph. Before the body proper, drop short fragments that
      // are almost always leftover TOC noise (page-number + partial title).
      if (!bodyStarted && line.length < 60) continue
      flush()
      cur = { kind: 'para', text: line }
    }
  }
  flush()

  // 6. Strip duplicate TOC-stub headings. Some ACs (e.g. 120-28D) have a table
  //    of contents with neither a dotted leader (step 3) nor a trailing page
  //    number (step 3a) — just a bare "N[.N...] Title" line, textually
  //    identical to the real heading that appears later with actual body
  //    text. Those slip through as real "section"/"chapter" blocks with an
  //    empty body. Drop any such block whose LABEL AND TITLE both recur later
  //    on a block that DOES have body content — that later copy is the real
  //    heading, this one is the TOC ghost. A genuinely bodyless heading with
  //    no later duplicate (e.g. one immediately followed by a bullet list) is
  //    left untouched since nothing else in the document repeats it.
  //    Requiring the TITLE to match too (not just the label) is what makes
  //    this safe without a run-length gate: FAA ACs routinely restart
  //    numbering per-appendix (Appendix 2's "6.1" is unrelated to the main
  //    body's "6.1"), so label-only matching mistakenly linked 120-29A's real
  //    "2.1 Related References" to an unrelated "APPENDIX 5" subsection also
  //    numbered 2.1 — but their titles differ, so the title check correctly
  //    tells them apart. (An earlier version gated on a run of >=6 consecutive
  //    empty headings instead of the title match; that caught only ~half of
  //    real TOC ghosts, since many TOCs interleave with real content in runs
  //    shorter than 6. Verified corpus-wide that title-matching is the
  //    stronger, more precise signal — see 2026-07-10 gap-investigation.)
  const dropIdx = new Set<number>()
  {
    const isEmptyHeading = (b: ACBlock) => b.kind === 'chapter' || (b.kind === 'section' && !b.body.trim())
    // Labels are compared with a trailing period stripped — the TOC copy and
    // the real heading are often lexed with one occurrence bare ("4.1") and
    // the other period-terminated ("4.1."), which is the same section number.
    const bareLabel = (l: string) => l.replace(/\.$/, '')
    // Titles are compared case/punctuation-insensitively — OCR noise and
    // trailing-period differences between the TOC copy and the real heading
    // ("Related References" vs "Related References.") shouldn't block a match.
    const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
    // A chapter is only a genuine leftover TOC "ghost" if NOTHING with real
    // content sits between it and the next chapter (or the end of the
    // document) -- a bare heading-shaped line with nothing of its own.
    // Needed once the lettered-table fix (2026-08-18) started producing
    // MANY chapter pushes sharing byte-identical text: a table that spans
    // several printed pages reprints its own heading verbatim as a running
    // "(continued)" page header every time (confirmed real, e.g. AC
    // 21.101-1B's "Table A-2. Examples of Significant Changes for Small
    // Airplanes (Part 23) (continued)" appears 10 times). Every one of
    // those 10 has a real table row directly under it -- none is an empty
    // ghost -- but the ORIGINAL text-equality check alone couldn't tell a
    // true ghost from a genuine repeated-but-content-bearing table-page
    // marker, so it collapsed 9 of the 10 down to just the last, discarding
    // 8 legitimate navigation points (row content itself was never lost,
    // only the heading text of the dropped duplicates -- confirmed via
    // scripts/diff-parser-version.mjs-style corpus validation, which is
    // what surfaced this). This guard restores the mechanism to its
    // original, narrower intent.
    const chapterIsGhost = (i: number): boolean => {
      for (let j = i + 1; j < blocks.length; j++) {
        const b2 = blocks[j]
        if (b2.kind === 'chapter') return true // next heading, nothing in between
        if (b2.kind === 'para' && b2.text.trim()) return false
        if ((b2.kind === 'section' || b2.kind === 'item') && (b2.body.trim() || b2.title.trim())) return false
      }
      return true // reached the end of the document with nothing in between
    }
    const recursWithContent = (i: number) => {
      const b = blocks[i]
      for (let j = i + 1; j < blocks.length; j++) {
        const b2 = blocks[j]
        if (
          b.kind === 'section' &&
          b2.kind === 'section' &&
          bareLabel(b2.label) === bareLabel(b.label) &&
          normTitle(b2.title) === normTitle(b.title)
        ) {
          if (b2.body.trim()) return true
        } else if (b.kind === 'chapter' && b2.kind === 'chapter' && b2.text === b.text && chapterIsGhost(i)) {
          return true
        }
      }
      return false
    }
    for (let i = 0; i < blocks.length; i++) {
      if (isEmptyHeading(blocks[i]) && recursWithContent(i)) dropIdx.add(i)
    }
  }
  const deduped = dropIdx.size ? blocks.filter((_, i) => !dropIdx.has(i)) : blocks

  // 7. Fold citation lists to an EXTERNAL document's own section numbering
  //    back into plain body text. Some ACs (e.g. 20-184) introduce a list
  //    like "...including but not limited to the following RTCA DO-347
  //    document design and test sections:" followed by a bare run of THAT
  //    other document's own "N.N Title" lines — textually identical in
  //    shape to a real heading, but never this AC's own structure, so
  //    (unlike a real duplicate) no later occurrence anywhere ever supplies
  //    real body content for them. Detect a run of >=4 consecutive
  //    empty-body chapter/section blocks, immediately preceded by a
  //    block whose trailing text ends in ":" (a paragraph, OR — as seen on
  //    20-184 — the last sentence of a real section's body, since the
  //    citation-introducing sentence is often the final line of prose
  //    before the list rather than its own paragraph), where NONE of the
  //    run's entries recurs later with real content. Merge the whole run's
  //    label+title text back into that preceding block (it's still real,
  //    useful information, just not this document's own navigable
  //    structure) and drop the fake heading blocks.
  //
  //    Guard added 2026-08-18 alongside APPXSEC's multi-level widening: a
  //    genuine same-document numbered checklist nested under a lettered
  //    appendix (e.g. Appendix A's own "A.1. General Information." / "A.1.1.
  //    Date of written report." / "A.1.2." / "A.1.3." — each a real,
  //    intentionally bodyless single-line item, confirmed on AC 120-117)
  //    can ALSO land 4+ consecutive empty-body sections right after an
  //    intro sentence ending in ":" — the exact shape this step was built
  //    to catch for an EXTERNAL document's citation list. The two are told
  //    apart by which appendix letter the run's own labels use: a genuine
  //    external citation cites some OTHER document's numbering (never
  //    sharing this document's current lettered-appendix prefix), while
  //    120-117's run is entirely "A."-labeled while still inside "Appendix
  //    A." itself. Skip the fold when every block in the run is a section
  //    labeled under the SAME letter as the nearest preceding "Appendix X"
  //    chapter — that combination only happens for this document's own
  //    nested structure, never a foreign citation, so the original 20-184
  //    case (flat, unlettered "N.N" RTCA section numbers) is unaffected.
  const citationDropIdx = new Set<number>()
  const citationMergeText = new Map<number, string>()
  {
    const isEmptyHeading = (b: ACBlock) => b.kind === 'chapter' || (b.kind === 'section' && !b.body.trim())
    const bareLabel = (l: string) => l.replace(/\.$/, '')
    // Nearest preceding "Appendix X" chapter's own letter, scanning backward
    // from just before the run -- null if the nearest preceding chapter
    // isn't a lettered appendix (e.g. a numbered "CHAPTER N" instead), which
    // means we're not inside a lettered appendix's own scope at all.
    const nearestAppxLetter = (idx: number): string | null => {
      for (let j = idx - 1; j >= 0; j--) {
        const b = deduped[j]
        if (b.kind === 'chapter') {
          const m = b.text.match(/^(?:APPENDIX|Appendix)\s+([A-Z])\b/)
          return m ? m[1] : null
        }
      }
      return null
    }
    const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
    const recursWithContent = (i: number) => {
      const b = deduped[i]
      for (let j = 0; j < deduped.length; j++) {
        if (j === i) continue
        const b2 = deduped[j]
        if (
          b.kind === 'section' &&
          b2.kind === 'section' &&
          bareLabel(b2.label) === bareLabel(b.label) &&
          normTitle(b2.title) === normTitle(b.title) &&
          b2.body.trim()
        ) {
          return true
        } else if (b.kind === 'chapter' && b2.kind === 'chapter' && b2.text === b.text && j !== i) {
          return true
        }
      }
      return false
    }
    const labelText = (b: ACBlock) => (b.kind === 'chapter' ? b.text : b.kind === 'section' ? `${b.label} ${b.title}` : '')
    // The trailing prose of a block, whatever kind it is — a paragraph's
    // text, or a section/item's body (the citation-introducing sentence is
    // often just the tail end of an ordinary section's body copy).
    const trailingText = (b: ACBlock): string | null =>
      b.kind === 'para' ? b.text : b.kind === 'section' || b.kind === 'item' ? b.body : null
    let runStart = -1
    const closeRun = (end: number) => {
      if (runStart >= 1 && end - runStart >= 4) {
        const introIdx = runStart - 1
        const introText = trailingText(deduped[introIdx])
        if (introText && /:\s*$/.test(introText)) {
          const allNoRecur = Array.from({ length: end - runStart }, (_, k) => runStart + k).every(
            (i) => !recursWithContent(i)
          )
          const runLetter = nearestAppxLetter(runStart)
          const isOwnAppendixStructure =
            runLetter !== null &&
            Array.from({ length: end - runStart }, (_, k) => deduped[runStart + k]).every(
              (b) => b.kind === 'section' && b.label.startsWith(`${runLetter}.`)
            )
          if (allNoRecur && !isOwnAppendixStructure) {
            const merged = [
              introText,
              ...Array.from({ length: end - runStart }, (_, k) => labelText(deduped[runStart + k])),
            ].join(' ')
            citationMergeText.set(introIdx, merged)
            for (let i = runStart; i < end; i++) citationDropIdx.add(i)
          }
        }
      }
      runStart = -1
    }
    for (let i = 0; i < deduped.length; i++) {
      if (isEmptyHeading(deduped[i])) {
        if (runStart < 0) runStart = i
      } else closeRun(i)
    }
    closeRun(deduped.length)
  }
  const citationsFixed = citationDropIdx.size
    ? deduped
        .map((b, i) => {
          if (!citationMergeText.has(i)) return b
          const merged = citationMergeText.get(i)!
          if (b.kind === 'para') return { ...b, text: merged }
          if (b.kind === 'section' || b.kind === 'item') return { ...b, body: merged }
          return b
        })
        .filter((_, i) => !citationDropIdx.has(i))
    : deduped

  // Drop any preamble before the first real heading. For FAA ACs everything
  // before the first chapter/section is cover letterhead, the signature block,
  // and (for dot-less TOCs) leftover contents text — all noise, and the intro
  // summary is already shown separately as the AC description.
  const firstStruct = citationsFixed.findIndex(
    (b) => b.kind === 'chapter' || b.kind === 'section' || b.kind === 'item'
  )
  const trimmed = firstStruct > 0 ? citationsFixed.slice(firstStruct) : citationsFixed

  // Drop PAR blocks in the preamble zone between an APPENDIX chapter and the
  // first A.x section that follows it. Appendix A internal TOCs (too deep to be
  // region-stripped) leave behind category headers and page-reference fragments
  // as PAR blocks in this zone — they're pure noise before the endorsements start.
  const appxAIdx = trimmed.findIndex(
    (b) => b.kind === 'chapter' && /^(?:APPENDIX|Appendix)\s+A[.\s]/.test(b.text)
  )
  if (appxAIdx >= 0) {
    const firstAppxSec = trimmed.findIndex(
      (b, i) => i > appxAIdx && b.kind === 'section' && /^[A-Z]\.\d/.test((b as Extract<ACBlock, { label: string }>).label)
    )
    if (firstAppxSec > appxAIdx + 1) {
      return [
        ...trimmed.slice(0, appxAIdx + 1),
        ...trimmed.slice(appxAIdx + 1, firstAppxSec).filter((b) => b.kind !== 'para'),
        ...trimmed.slice(firstAppxSec),
        ...changeNotices,
      ]
    }
  }
  return [...trimmed, ...changeNotices]
}
