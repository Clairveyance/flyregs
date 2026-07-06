// Reformats raw FAA Advisory Circular PDF text into structured, mobile-readable
// blocks. FAA ACs follow a consistent grammar — CHAPTER/APPENDIX headings,
// "N-N." section numbers with ALL-CAPS titles, lettered/numbered sub-items, a
// dotted-leader table of contents, hard line-wraps, and page header/footer
// artifacts. We detect that structure, drop the noise, and rejoin wrapped lines
// into real paragraphs so the document reads like an article instead of one
// long run-on block.

export type ACBlock =
  | { kind: 'chapter'; id: string; text: string }
  | { kind: 'section'; id: string; label: string; title: string; body: string }
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
export const AC_FORMAT_VERSION = 16

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
//     below is the actual backstop for that ambiguity.)
const NUMSEC = /^(\d+\.)\s+([A-Z][A-Z0-9 ,./&''()-]+|[A-Z]{2,6}\s+[A-Z][a-zA-Z ,/&()'-]{1,58}[.?](?:\s+.+)?|[A-Z][a-z][a-zA-Z ,/&()'-]{1,58}[.?](?:\s+.+)?)$/

// "1 PURPOSE OF THIS AC." — number (no period), then ALL-CAPS title ending in
// a period, optionally followed by body on the same line.
const NUMSEC2 = /^(\d{1,2})\s+([A-Z][A-Z0-9 ,/&''()-]*[A-Z)]\.)\s*(.*)$/

// "1 Purpose." — number (no period), then Title-Case phrase ending in a period,
// on its own line. Used in modern flat-numbered ACs (e.g. 150/5200-34B).
// Restricted to 1-2 digit numbers and second char must be lowercase to avoid
// matching prose fragments like "14 CFR part 25." that start lines after wraps.
const NUMSEC3 = /^(\d{1,2})\s+([A-Z][a-z][a-zA-Z ,/&()'-]{1,50}\.)$/

// Lettered appendix section numbers: "A.1 Title", "B.3 Title", "A.96 Title".
// Appendices in FAA ACs use this scheme (A.1–A.N) for numbered sub-items.
// Requires uppercase letter, period, 1–3 digit number, then content starting
// with an UPPERCASE letter — a real heading always does. Requiring uppercase
// (not any letter) is what excludes an internal cross-reference that wraps
// mid-sentence onto a new line ("...refer to section\nB.3 of this appendix.
// Velocity accuracy may be qualified...") — that continuation starts
// lowercase and would otherwise be misread as a new appendix subsection.
const APPXSEC = /^([A-Z]\.\d{1,3})\s+([A-Z].+)$/

// FAA ACs often have numbered or titled tables: "TABLE 2-1. GAS LAWS...".
// The TABLE keyword with a digit catches these reliably without false positives
// on prose references like "see the table above" (lowercase) or section titles.
const TBL = /^TABLE\s+\d/

const ITEM_A = /^([a-z]\.)\s+(.*)$/ // a. ...
const ITEM_N = /^(\(\d+\))\s+(.*)$/ // (1) ...
const ITEM_L = /^(\([a-z]\))\s+(.*)$/ // (a) ...

function isPageMarker(l: string): boolean {
  if (l.length > 44) return false
  const hasDate = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(l)
  const hasAC = /\bAC\s+[\dA-Z][\dA-Z-]*/i.test(l)
  if (hasDate && hasAC) return true
  if (/^Page\s+[\divxlc]+\b/i.test(l)) return true
  return false
}

function isNoise(l: string): boolean {
  return (
    l === '' ||
    /^\d{1,4}$/.test(l) || // bare page number
    /^[ivxlc]{1,6}$/i.test(l) || // bare roman page number
    /^\d+\.\d+$/.test(l) || // standalone decimal (chart axis labels: 0.9, 1.3)
    /^[A-Z]\d{0,1}-\d{1,3}$/.test(l) || // appendix page numbers: "A-8", "A3-1"
    /^Appendix\s+[A-Z]$/.test(l) || // bare "Appendix A" page-header fragment (no period/title)
    /^Par\b/.test(l) || // FAA footer "Par 1-1"
    isPageMarker(l) ||
    /^(CONTENTS|TABLE OF CONTENTS|LIST OF (FIGURES|TABLES|EFFECTIVE PAGES))\s*$/i.test(l)
  )
}

// Pull a short leading "heading term" (e.g. "PURPOSE." / "Adiabatic Cooling.")
// off the front of a section/item so it can be rendered bold.
// When the entire rest string IS the title (standalone heading line, no inline
// body), return it as the title rather than leaving title empty and stuffing it
// into body — which caused the audit to see duplicate labels for appendix
// sections (both label+title keys collapsed to just the label).
function splitHeading(rest: string): { title: string; body: string } {
  const m = rest.match(/^([A-Z][A-Za-z0-9 ,/&''()-]{1,55}?\.)\s+(.+)$/)
  if (m) return { title: m[1], body: m[2] }
  // Standalone heading: the entire rest is the title text (no body on this line)
  if (/^[A-Z]/.test(rest)) return { title: rest, body: '' }
  return { title: '', body: rest }
}

export function parseAC(raw: string): ACBlock[] {
  if (!raw) return []

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
    lastChgEnd = cm.index + cm[0].length
  }
  if (lastChgEnd > -1) raw = raw.slice(lastChgEnd)

  // 2. Normalize whitespace; one trimmed line per source line. cleanGlyphs maps
  //    Symbol/Wingdings PUA glyphs to real Unicode first so bullet TOC leaders
  //    (U+F0B7) become • and are caught by isTOC, and stored blocks are tofu-free.
  let lines = raw
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .split('\n')
    .map((l) => cleanGlyphs(l.replace(/\s+/g, ' ').trim()))

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
      if (lines[i] === '' || isNoise(lines[i])) continue // skip blanks + page markers
      if (looksTocEntry(lines[i])) { last = i; count++ } else break // body starts
    }
    if (count >= 4) for (let i = tocHdr; i <= last; i++) lines[i] = ''
  }

  // 3b. Pre-classify pass: blank out the first line of multi-line TOC entries
  //     that match the APPXSEC format (e.g. "A.2 Review of deficiencies…").
  //     Appendix TOCs split long entries across 2–3 lines — only the LAST line
  //     has dotted leaders and a page number (caught by isTOC), but the first
  //     line has no dots and would otherwise be classified as a real section.
  //     Look ahead up to 4 non-empty lines; if any is a TOC line, this line is
  //     a TOC header and should be skipped.
  const APPXSEC_TOC_RE = /^[A-Z]\.\d{1,3}\s+[A-Za-z]/
  for (let k = 0; k < lines.length; k++) {
    if (!APPXSEC_TOC_RE.test(lines[k])) continue
    let nonEmpty = 0
    for (let j = k + 1; j < lines.length && nonEmpty < 6; j++) {
      const lj = lines[j]
      // Skip blank lines, recognized noise, and short header/page-marker lines
      // (like "Appendix A" or "A-6") that appear in mid-TOC page breaks and
      // would otherwise exhaust the look-ahead before reaching a dotted line.
      if (lj === '' || isNoise(lj) || lj.length < 15) continue
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

  for (let line of lines) {
    // Blank lines break paragraph continuations — they are meaningful paragraph
    // separators in PDF text. Only PAR blocks split on blank lines; section and
    // item bodies continue to absorb continuation lines across blank lines so
    // multi-paragraph body text stays in the correct section.
    if (line === '') {
      if (cur?.kind === 'para') flush()
      continue
    }
    if (isNoise(line) || isTOC(line)) continue

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
    line = line.replace(/(?<![A-Za-z''’])([B-HJ-NP-Z]) ([A-Z]{2,})/g, '$1$2')
    line = line.replace(/(?<![A-Za-z''’])([A-Z]) ([A-Z])(?![A-Za-z])/g, '$1$2')
    line = line.replace(/(?<![A-Za-z''’])([B-HJ-NP-Zb-hj-np-z]) ([a-z]{3,})/g, '$1$2')

    // TABLE headers ("TABLE 2-1. GAS LAWS…") become chapter blocks for navigation
    // and trigger table-mode so subsequent content is formatted as bullet items.
    if (TBL.test(line)) {
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
    if (
      (m = line.match(APPXSEC)) ||
      ((m = line.match(NUMSEC)) && (!needsSequenceGate(m[2]) || isNextFlatNum(m[1]))) ||
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
      const { title, body } = splitHeading(m[2])
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
    // row) render as a para; data rows become bullet items. Two patterns trigger
    // a new bullet once we're past the column headers:
    //   isAllCaps  — line is entirely uppercase ("SINUSES DESCENT") → pure row id
    //   isRowStart — line begins with 2+ consecutive 2+-char ALL-CAPS words then
    //                switches to mixed case on the same line ("TEETH ASCENT A
    //                tooth block…") — the PDF squeezed the row identifier and
    //                its description onto one line; treat that whole line as a
    //                new bullet rather than a continuation.
    if (inTable) {
      const isAllCaps = /^[A-Z][A-Z0-9 (),-]*$/.test(line)
      const isRowStart = !isAllCaps && /^[A-Z]{2,}(?:\s+[A-Z]{2,})+/.test(line)

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
      } else if (isAllCaps || isRowStart) {
        // New data row — pure all-caps id OR inline "ID text description" pattern
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
      if (!cur.body && cur.title && cur.title.length >= 2 && !/[.?!:]$/.test(cur.title)) {
        if (/^[A-Z]{2,8}$/.test(cur.title) && /^[A-Z]{2,}\./.test(line)) {
          const wordEnd = line.match(/^([A-Z]+\.)\s*(.*)$/)
          if (wordEnd) {
            cur.title = cur.title + wordEnd[1]
            cur.body = wordEnd[2].trim()
            continue
          }
        } else if (/^[a-z]{2,}/.test(line)) {
          const wordEnd = line.match(/^([a-z]+[.,]?)\s*(.*)$/)
          if (wordEnd) {
            cur.title = cur.title + wordEnd[1]
            cur.body = wordEnd[2].trim()
            continue
          }
        }
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

  // Drop any preamble before the first real heading. For FAA ACs everything
  // before the first chapter/section is cover letterhead, the signature block,
  // and (for dot-less TOCs) leftover contents text — all noise, and the intro
  // summary is already shown separately as the AC description.
  const firstStruct = blocks.findIndex(
    (b) => b.kind === 'chapter' || b.kind === 'section' || b.kind === 'item'
  )
  const trimmed = firstStruct > 0 ? blocks.slice(firstStruct) : blocks

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
      ]
    }
  }
  return trimmed
}
