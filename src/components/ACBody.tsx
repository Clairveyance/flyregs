import React, { useMemo, useRef, useState, useEffect, useImperativeHandle, RefObject } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
  InteractionManager,
  useWindowDimensions,
} from 'react-native'
import { router } from 'expo-router'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { parseAC, cleanGlyphs, blockText, ACBlock } from '@/lib/acFormat'
import type { AcFigure, FormulaRef } from '@/types'
import { softWrapParagraph } from '@/lib/softWrap'
import { linkifyText } from '@/lib/crossRefLinks'
import { setPendingBreadcrumb } from '@/lib/navBreadcrumb'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

type Heading = Extract<ACBlock, { id: string }>

export type ACBodyHandle = {
  scrollToMatch(n: number): void
  scrollToBlockIndex(blockIndex: number): void
}

// Normalizes a search query into the phrase we match: trimmed, lowercased, with
// internal whitespace collapsed to single spaces (block text is already single-
// spaced). Multi-word queries match as a contiguous in-order phrase — "dynamic
// test" hits only "dynamic test", never a stray "dynamic" or "test" on its own.
// Outer double-quotes are stripped so a user can type "exact phrase" naturally.
function searchPhrase(query: string): string {
  const t = query.trim()
  const unwrapped = t.startsWith('"') && t.endsWith('"') && t.length > 2 ? t.slice(1, -1) : t
  return unwrapped.replace(/\s+/g, ' ').toLowerCase()
}

// Counts non-overlapping occurrences of the phrase in text (for ordinal math).
function countOcc(text: string, phrase: string): number {
  if (!text || !phrase) return 0
  // See highlightSpans' own comment below -- a literal "\n" in `text` is
  // never equal to the " " searchPhrase collapsed a multi-line query to.
  const lower = text.toLowerCase().replace(/\n/g, ' ')
  let c = 0
  let pos = 0
  let idx = lower.indexOf(phrase, pos)
  while (idx !== -1) { c++; pos = idx + phrase.length; idx = lower.indexOf(phrase, pos) }
  return c
}

// Returns inline React nodes (string + highlighted <Text> spans) for placement
// directly inside a parent <Text> element. Highlights each occurrence of the
// query as a literal phrase. `opts.base` is the global ordinal of the first match
// in this text; the occurrence whose global ordinal equals `opts.active` is
// rendered in the brighter "current match" style so navigation is visible even
// when matches cluster together on one screen.
function highlightSpans(
  text: string,
  query: string,
  opts?: { base?: number; active?: number; redShift?: boolean; onOccRef?: (globalOrdinal: number, node: any) => void }
): React.ReactNode {
  const phrase = searchPhrase(query)
  if (phrase.length < 2 || !text) return text
  // `phrase` collapsed internal whitespace to single spaces (see
  // searchPhrase above) -- match against the same shape here, but slice/
  // highlight the ORIGINAL `text` below (indices stay valid since "\n" ->
  // " " never changes string length).
  const lower = text.toLowerCase().replace(/\n/g, ' ')

  // Collect every occurrence of the full phrase
  const matches: Array<{ start: number; end: number }> = []
  let scan = 0
  let idx = lower.indexOf(phrase, scan)
  while (idx !== -1) {
    matches.push({ start: idx, end: idx + phrase.length })
    scan = idx + phrase.length
    idx = lower.indexOf(phrase, scan)
  }
  if (!matches.length) return text

  const base = opts?.base ?? 0
  const active = opts?.active ?? -1
  const result: React.ReactNode[] = []
  let pos = 0
  let occ = 0 // local occurrence ordinal within this text segment
  for (const { start, end } of matches) {
    if (start > pos) result.push(text.slice(pos, start))
    const isActive = base + occ === active
    const globalOrdinal = base + occ
    result.push(
      <Text
        key={start}
        ref={opts?.onOccRef ? ((node: any) => opts.onOccRef!(globalOrdinal, node)) as any : undefined}
        style={isActive ? (opts?.redShift ? styles.highlightActiveRedshift : styles.highlightActive) : (opts?.redShift ? styles.highlightRedshift : styles.highlight)}
      >
        {text.slice(start, end)}
      </Text>
    )
    occ++
    pos = end
  }
  if (pos < text.length) result.push(text.slice(pos))
  return <>{result}</>
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Builds a match pattern that tolerates a stray space around a label's "-"/"."
// separator (e.g. matches "Table 5 -1" as well as "Table 5-1"). This is a real,
// pre-existing quirk of the pypdf-based body-text extraction (confirmed via a
// direct pypdf vs. PyMuPDF comparison on the same PDF page — pypdf sometimes
// inserts a space at a hyphen glyph boundary that PyMuPDF doesn't), not
// something introduced by this feature. Labels themselves (from
// extract_figures.py, which uses PyMuPDF) are always clean, so this only
// needs to widen matching against body text, never the stored label itself.
function toTolerantLabelPattern(label: string): string {
  return escapeRegExp(label)
    .replace(/-/g, '\\s*-\\s*')
    .replace(/\\\./g, '\\s*\\.\\s*')
}

// Undoes the whitespace tolerance above so a match like "Table 5 -1" still
// looks up the canonical "Table 5-1" entry in figuresByLabel. Also
// lowercases — older/scanned ACs frequently caption figures in ALL-CAPS
// ("FIGURE 2-1. STANDARD HIGH...") even though extract_figures.py stores the
// canonical label in Title Case ("Figure 2-1"); confirmed on AC 00-31A,
// where every ALL-CAPS caption occurrence silently failed to link (0 exact-
// case matches) even though the label itself was correct — figuresByLabel is
// keyed by this same lowercased form so the two sides always agree.
function normalizeMatchedLabel(matched: string): string {
  return matched.replace(/\s*-\s*/g, '-').replace(/\s*\.\s*/g, '.').toLowerCase()
}

// Auto-links inline mentions of a known Figure/Table label ("...as shown in
// Figure 3-1 below") to open that figure's rendered page. Only labels we
// actually have image data for are linked — this is deliberately a plain
// substring match against the AC's own extracted labels, not a general
// "Figure \d+" regex, so it can never link to a figure that doesn't exist.
function linkifyFigures(
  text: string,
  labelRe: RegExp | null,
  figuresByLabel: Map<string, AcFigure>,
  onOpenFigure: (f: AcFigure) => void,
  tokens: ThemeTokens
): React.ReactNode {
  if (!labelRe || !text) return text
  labelRe.lastIndex = 0
  const result: React.ReactNode[] = []
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = labelRe.exec(text))) {
    if (m.index > pos) result.push(text.slice(pos, m.index))
    const label = m[0]
    const figure = figuresByLabel.get(normalizeMatchedLabel(label))
    if (figure) {
      result.push(
        <Text
          key={m.index}
          style={{ color: tokens.blu, textDecorationLine: 'underline' }}
          onPress={() => onOpenFigure(figure)}
        >
          {label}
        </Text>
      )
    } else {
      result.push(label)
    }
    pos = m.index + label.length
  }
  if (pos < text.length) result.push(text.slice(pos))
  return <>{result}</>
}

// Renders the plain (non-figure) leftover text from linkifyBody's figure pass
// through crossRefLinks' citation linkifier -- FAR/AIM/P-CG/AD/other-AC
// mentions become tappable, in place, exactly like PlainTextBody already does
// for FAR/AIM/AD body text. Confirmed a real, total gap before this existed:
// ACBody never called linkifyText at all, only linkifyFigures -- so AC body
// text (the app's original core content type) never got a single tappable
// cross-reference, no matter how many real citations document_citations had
// for it.
function linkifyCitations(
  text: string,
  tokens: ThemeTokens,
  currentLabel: string | undefined,
  hasProAccess: boolean,
): React.ReactNode {
  if (!text) return text
  const segments = linkifyText(text)
  if (segments.length === 1 && !segments[0].route) return text
  return (
    <>
      {segments.map((seg, j) =>
        // isFigure segments here are a real, confirmed-live bug source, not
        // just a theoretical risk: this function only ever sees text that
        // linkifyBody's OWN figuresByLabel pass already checked and did NOT
        // recognize as one of this AC's real captioned figures/tables — so
        // a "TBL 10-1-2B"-shaped match reaching here is guaranteed to not
        // be this AC's own content. crossRefLinks.ts's shared isFigure
        // pattern still confidently routes it to /aim/10-1-2B on the
        // assumption that ANY "TBL/FIG X-X-X" mention means AIM -- true
        // often enough in AIM's own prose (where PlainTextBody uses this
        // same shared pattern correctly), but AC prose regularly cites a
        // completely different source's own internal table numbering that
        // just happens to share the X-X-X shape (an FAA Order, an MSG-3
        // maintenance doc, etc). Confirmed live: AC 120-49B's "Table
        // 10-1-2B, Master List of Functions" and AC 120-17B's "Table
        // 2-3-7.1" both silently routed to real, but topically unrelated,
        // AIM paragraphs. Rendering these as plain text instead of a
        // link -- an honest non-answer beats a confident wrong one, same
        // posture as PlainTextBody's own "not available" dead-end dialog
        // for a citation it can't verify.
        seg.route && !seg.isFigure ? (
          <Text
            key={j}
            onPress={() => {
              if (!hasProAccess) { router.push('/paywall?tier=pro' as any); return }
              if (currentLabel) setPendingBreadcrumb(currentLabel)
              router.push(seg.route as any)
            }}
            style={{ color: tokens.blu, fontWeight: '600' }}
          >
            {seg.text}
          </Text>
        ) : (
          seg.text
        ),
      )}
    </>
  )
}

// Composes figure/table linkification (AC-specific labels, e.g. "Figure
// 3-1") with citation linkification (FAR/AIM/P-CG/AD/other-AC mentions) over
// the SAME text without either pass stepping on the other's matches. The two
// match vocabularies don't overlap in practice (a figure label never looks
// like a FAR section or an AD number), so this runs the figure scan first to
// find its spans, then re-runs the citation linkifier over just the plain-
// text gaps left behind -- rather than trying to merge two independent
// absolute-position regex scans, which would be far more error-prone.
function linkifyBody(
  text: string,
  labelRe: RegExp | null,
  figuresByLabel: Map<string, AcFigure>,
  onOpenFigure: ((f: AcFigure) => void) | undefined,
  tokens: ThemeTokens,
  currentLabel: string | undefined,
  hasProAccess: boolean,
): React.ReactNode {
  if (!text) return text
  if (!onOpenFigure || !labelRe) return linkifyCitations(text, tokens, currentLabel, hasProAccess)

  labelRe.lastIndex = 0
  const result: React.ReactNode[] = []
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = labelRe.exec(text))) {
    if (m.index > pos) result.push(<React.Fragment key={`c-${pos}`}>{linkifyCitations(text.slice(pos, m.index), tokens, currentLabel, hasProAccess)}</React.Fragment>)
    const label = m[0]
    const figure = figuresByLabel.get(normalizeMatchedLabel(label))
    if (figure) {
      result.push(
        <Text
          key={m.index}
          style={{ color: tokens.blu, textDecorationLine: 'underline' }}
          onPress={() => onOpenFigure(figure)}
        >
          {label}
        </Text>
      )
    } else {
      result.push(label)
    }
    pos = m.index + label.length
    if (label.length === 0) labelRe.lastIndex++
  }
  if (pos < text.length) result.push(<React.Fragment key={`c-${pos}`}>{linkifyCitations(text.slice(pos), tokens, currentLabel, hasProAccess)}</React.Fragment>)
  return <>{result}</>
}

// Detects the FAA's own revision-notice convention -- confirmed on AC
// 61-67C's "Change 3" notice, "This change to the AC incorporates new
// language into subparagraphs 301a and 301b..." -- of naming a numbered
// section's own lettered sub-item by concatenating the section number and
// item letter with no separator ("301a" = item "a." under section "301.").
// Walks the already-parsed blocks once, tracking the most recent bare-number
// section label, and records every level-1 lettered item that immediately
// follows it (deeper-nested items, e.g. "(1)"/"(a)", are skipped without
// resetting the tracked section -- "301a" only ever names a top-level
// lettered subparagraph, never something nested further). Also indexes the
// bare section number on its own, for a reference with no trailing letter.
// Keyed on the exact "301a"/"301" string so a render-time lookup is a single
// Map.get with no per-reference re-parsing -- and, just as importantly, a
// reference that DOESN'T resolve (RC's own example: "...and removes
// subparagraph 301c" -- 301c no longer exists in the current revision) is
// distinguishable from one that does, so removed subparagraphs correctly
// stay plain text instead of becoming a dangling link.
function buildParagraphRefIndex(blocks: ACBlock[]): Map<string, number> {
  const index = new Map<string, number>()
  let curNum: string | null = null
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.kind === 'section') {
      const bare = /^(\d{1,4})\.?$/.exec(b.label)
      curNum = bare ? bare[1] : null
      if (curNum) index.set(curNum, i)
      continue
    }
    if (b.kind === 'chapter') {
      curNum = null
      continue
    }
    if (b.kind === 'item' && curNum && b.level === 1) {
      const letter = /^([a-z])\.?$/.exec(b.label)
      if (letter) index.set(curNum + letter[1], i)
    }
  }
  return index
}

// Matches a bare "301a"-shaped in-prose reference: 1-4 digits immediately
// followed by a single lowercase letter, no space. Deliberately loose on its
// own (no attempt to also require e.g. a preceding "subparagraph" word,
// since the FAA's own phrasing isn't consistent enough to anchor on) --
// safe regardless, because a match only ever becomes a link when it resolves
// against THIS document's own paragraphRefIndex (built above from the same
// document's real block structure), and this only ever runs over the
// leftover plain-text gaps AFTER linkifyText's own citation scan has already
// claimed FAR/AC/AD/etc mentions -- so a dotted citation like "61.167" (already
// linked as its own FAR citation) is never re-touched or double-matched here.
const PARA_REF_RE = /\b(\d{1,4})([a-z])\b/g

// Renders a Change Notice's own body text: same citation linkification as
// every other AC body (linkifyCitations), plus this AC-Change-Notice-
// specific pass that turns a resolved "301a"/"301b" reference into a
// same-document jump (via the same scrollToBlockIndex mechanism the
// "changed paragraphs" nav already uses) instead of a router navigation --
// this is the reader jumping back up to a section already open in front of
// them, not a cross-document citation, so no route push, no Pro-gate.
function linkifyChangeNoticeText(
  text: string,
  paragraphRefIndex: Map<string, number>,
  tokens: ThemeTokens,
  onJump: (blockIndex: number) => void,
  currentLabel: string | undefined,
  hasProAccess: boolean,
): React.ReactNode {
  if (!text) return text
  const segments = linkifyText(text)
  return (
    <>
      {segments.map((seg, j) => {
        if (seg.route) {
          return (
            <Text
              key={j}
              onPress={() => {
                if (!hasProAccess) { router.push('/paywall?tier=pro' as any); return }
                if (currentLabel) setPendingBreadcrumb(currentLabel)
                router.push(seg.route as any)
              }}
              style={{ color: tokens.blu, fontWeight: '600' }}
            >
              {seg.text}
            </Text>
          )
        }
        if (!paragraphRefIndex.size) return seg.text
        PARA_REF_RE.lastIndex = 0
        const parts: React.ReactNode[] = []
        let pos = 0
        let m: RegExpExecArray | null
        while ((m = PARA_REF_RE.exec(seg.text))) {
          const blockIndex = paragraphRefIndex.get(m[1] + m[2])
          if (blockIndex == null) continue
          if (m.index > pos) parts.push(seg.text.slice(pos, m.index))
          parts.push(
            <Text key={m.index} onPress={() => onJump(blockIndex)} style={{ color: tokens.blu, fontWeight: '600' }}>
              {m[0]}
            </Text>
          )
          pos = m.index + m[0].length
        }
        if (!parts.length) return seg.text
        if (pos < seg.text.length) parts.push(seg.text.slice(pos))
        return <React.Fragment key={j}>{parts}</React.Fragment>
      })}
    </>
  )
}

// Repairs a PDF line-break mid-word split stored in block data.
// Pattern: title is a bare ALL-CAPS fragment (e.g. "CO"), body begins with
// more ALL-CAPS letters + punctuation completing the word (e.g. "NDITIONS.").
// Returns the corrected { title, body } pair.
function repairSplitTitle(title: string, body: string): { title: string; body: string } {
  // Only merge when title is a short ALL-CAPS fragment (2–8 chars, no punctuation)
  // and body begins with 2+ uppercase letters + period — the telltale PDF line-break
  // mid-word pattern. Keeps long complete words (e.g. "COMMUNICATIONS") and
  // single-letter noise ("I") from being incorrectly merged.
  if (/^[A-Z]{2,8}$/.test(title) && /^[A-Z]{2,}\./.test(body)) {
    const m = body.match(/^([A-Z]+\.)\s*(.*)$/)
    if (m) return { title: title + m[1], body: m[2].trim() }
  }
  return { title, body }
}

// Detects a run-on numbered list embedded inside a single body string instead
// of being split into real list items — e.g. "The basic philosophy of a CPCP
// should consist of: 1. Personnel adequately trained...; 2. Thorough
// knowledge...; 3. Proper emphasis...". The parser's ITEM_A/ITEM_N/ITEM_L
// rules only fire when a marker starts its own physical PDF line; when the
// source PDF doesn't wrap between list items, the whole list stays glued into
// one run-on line and is parsed as ordinary body prose. This is purely a
// display-time reformat — the underlying block/body text is untouched, so
// search, highlighting, and diffing all keep operating on the original string.
// A marker is "N. " preceded by a line-internal boundary (start of string, or
// ";"/":"/"." + whitespace — i.e. the previous item just ended) and followed
// by an uppercase letter. Requires 3+ strictly ascending items starting at 1
// or 2 to be confident it's a real list, not a stray reference number
// (validated against a corpus-wide scan — scripts/detect_inline_lists.py).
// The separator before a marker tolerates a trailing "and "/"or " connector
// ("...design deficiencies; and 13. Use of appropriate materials...") — a
// common way FAA prose closes out the last item of a list.
const LIST_MARKER_RE = /(^|[;:.]\s+(?:and|or)\s+|[;:.]\s+)(\d{1,2})\.\s+(?=[A-Z])/g
const LIST_MIN_RUN = 3

type ListItemSpan = { num: number; start: number; contentStart: number }
type ListRun = { introEnd: number; items: ListItemSpan[] }

function findListRuns(text: string): ListRun[] {
  const matches: { idx: number; sepLen: number; num: number; fullLen: number }[] = []
  LIST_MARKER_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LIST_MARKER_RE.exec(text))) {
    matches.push({ idx: m.index, sepLen: m[1].length, num: parseInt(m[2], 10), fullLen: m[0].length })
  }
  const runs: ListRun[] = []
  let i = 0
  while (i < matches.length) {
    const run = [matches[i]]
    let j = i + 1
    while (j < matches.length && matches[j].num === run[run.length - 1].num + 1) {
      run.push(matches[j])
      j++
    }
    if (run.length >= LIST_MIN_RUN && (run[0].num === 1 || run[0].num === 2)) {
      runs.push({
        introEnd: run[0].idx,
        items: run.map((r) => ({ num: r.num, start: r.idx + r.sepLen, contentStart: r.idx + r.fullLen })),
      })
    }
    i = j > i + 1 ? j : i + 1
  }
  return runs
}

// Renders a body string as plain linkified text, or — when it contains one or
// more embedded numbered lists — as an intro paragraph followed by real,
// separately-lined list rows. Only used on the non-search render path; while
// searching, callers keep rendering the flat original string so match
// counting/highlighting ordinals never have to account for this reformat.
function renderBodyContent(
  text: string,
  linkify: (t: string) => React.ReactNode,
  tokens: ThemeTokens,
  fs: (n: number) => number
): React.ReactNode {
  const runs = findListRuns(text)
  if (!runs.length) return linkify(text)

  const nodes: React.ReactNode[] = []
  const intro = text.slice(0, runs[0].introEnd).trim()
  // Confirmed live as a real, corpus-wide bug: unlike every other Text
  // element in this file, this one carried no style prop at all -- no
  // color, nothing -- so it fell back to the browser/RN-Web default black
  // text color instead of the theme's body color, rendering as an
  // unreadable dark block against the dark background wherever an AC's
  // body has an intro paragraph immediately before an auto-detected
  // numbered list (e.g. AC 120-49B's "2.2.1 Definitions" section).
  if (intro) nodes.push(
    <Text key="intro" style={[styles.para, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }]}>{linkify(intro)}</Text>
  )

  runs.forEach((run, r) => {
    run.items.forEach((item, k) => {
      const contentEnd =
        k + 1 < run.items.length ? run.items[k + 1].start : r + 1 < runs.length ? runs[r + 1].introEnd : text.length
      const content = text.slice(item.contentStart, contentEnd).trim()
      nodes.push(
        <View key={`${r}-${item.num}`} style={styles.autoListRow}>
          <Text style={[styles.autoListNum, { color: tokens.t1, fontSize: fs(13), lineHeight: fs(13) * 1.62 }]}>{item.num}.</Text>
          <Text style={[styles.autoListBody, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }]}>{linkify(content)}</Text>
        </View>
      )
    })
  })

  return <View>{nodes}</View>
}

// Returns a block's text as the SAME segments that get rendered (and highlighted)
// in the block map. Phrase counting runs per-segment so the match count and the
// on-screen highlights never diverge — and a phrase is only matched within a
// single rendered run, never across the heading/body boundary where it could
// never be highlighted as one span.
function blockSegments(b: ACBlock): string[] {
  switch (b.kind) {
    case 'chapter': return [b.text ?? '']
    case 'section': {
      const { title, body } = repairSplitTitle(b.title ?? '', b.body ?? '')
      const heading = `${b.label ?? ''}${title ? ` ${title}` : ''}`
      return body ? [heading, body] : [heading]
    }
    case 'item':
      return [`${b.label ?? ''}${b.title ? ` ${b.title}` : ''}`, b.body ?? '']
    default:
      return [(b as any).text ?? (b as any).body ?? '']
  }
}

export const ACBody = React.forwardRef<
  ACBodyHandle,
  {
    text?: string | null
    blocks?: ACBlock[] | null
    scrollRef?: RefObject<ScrollView | null>
    /** The scrollRef ScrollView's own rendered height (from its onLayout),
     * used to center a jumped-to match/block within what's ACTUALLY visible
     * -- not the full device window, which is usually taller than the
     * ScrollView's own viewport once header/search-bar chrome above it and
     * a tab bar below it are accounted for. Without this, "centering" using
     * the window height overshoots wherever the true viewport is shorter,
     * landing the target too low (sometimes below the visible area) instead
     * of centered. Falls back to window height if not measured yet. */
    viewportHeight?: number
    /** How far down ACBody's own root view sits within the ScrollView's
     * content -- i.e. the combined height of everything the parent screen
     * renders ABOVE this component (badge row, title, description, action
     * buttons, etc). A ref, kept live by the parent's own onLayout on its
     * containing section. Needed because plain onLayout only gives a
     * node's position relative to its IMMEDIATE parent, and ACBody isn't a
     * direct child of the ScrollView -- without this, each block's cached
     * position would only be correct relative to ACBody's own wrapper, not
     * the actual scrollable content. See blockRelY below for why this
     * (pure layout-tree arithmetic, no scroll or keyboard state involved at
     * all) replaced an earlier version that read the ScrollView's live
     * scroll offset -- interactive keyboard dismiss (which the search bar
     * triggers when its Done/arrow buttons are tapped) ties into the exact
     * same native scrolling machinery, so that offset could be transiently
     * wrong at precisely the moment a jump was triggered. */
    outerOffsetYRef?: RefObject<number>
    highlightQuery?: string
    onMatchCount?: (n: number) => void
    activeMatch?: number
    /** When set, only the first N blocks are rendered in the body — used for
     * the free-tier preview. The Contents card above still reflects the FULL
     * document structure (computed from all blocks), so a free reader sees
     * everything that's in the AC even though the body itself is capped. */
    bodyLimit?: number
    /** Indices (into the same blocks array, matching what's stored in the DB's
     * changed_block_indices column) that changed in the AC's most recent
     * revision — rendered with a left accent bar + "Updated" tag so a reader
     * can see exactly what changed, not just that the document was updated. */
    changedIndices?: number[] | null
    /** Content-keys (acFormat.ts's blockText()) of blocks the reader has saved
     * as a highlight — rendered with a yellow accent, distinct from the blue
     * "Updated" accent above so the two features are never visually confused. */
    highlightedBlockTexts?: Set<string>
    /** Long-press a section/item/paragraph block to toggle a highlight on it.
     * Not offered on chapter headings — those aren't "content" to save. */
    onToggleHighlight?: (block: ACBlock, index: number) => void
    /** Figures/Tables extracted from this AC's source PDF (see
     * scripts/extract_figures.py) — rendered as a "Figures & Tables" list
     * (mirroring the Contents card) and auto-linked inline wherever their
     * exact label ("Figure 3-1", "Table C-5") appears in the body text. */
    figures?: AcFigure[]
    onOpenFigure?: (figure: AcFigure) => void
    /** Pages flagged as containing a formula too complex for our OCR/parser
     * pipeline to reliably reproduce (see scripts/add_formula_ref.py) —
     * rendered as its own sub-section inside the same Figures & Tables card
     * for a consistent look, but entirely separate data/logic from `figures`
     * above so this can never affect the T&F extraction/display pipeline. */
    formulaRefs?: FormulaRef[]
    onOpenFormulaRef?: (formulaRef: FormulaRef) => void
    /** This AC's own display label -- set as the "back to X" breadcrumb right
     * before an in-body cross-reference link (FAR/AIM/P-CG/AD/other-AC
     * mention) jumps elsewhere, same mechanism as MagicLinkPod/PlainTextBody's
     * currentLabel prop. */
    currentLabel?: string
    /** Required -- see PlainTextBody's identically-named, identically-
     * required prop for the full reasoning. Gates linkifyCitations' onPress
     * the same way. */
    hasProAccess: boolean
  }
>(function ACBody({ text, blocks: precomputed, scrollRef, viewportHeight, outerOffsetYRef, highlightQuery, onMatchCount, activeMatch = -1, bodyLimit, changedIndices, highlightedBlockTexts, onToggleHighlight, figures, onOpenFigure, formulaRefs, onOpenFormulaRef, currentLabel, hasProAccess }, ref) {
  const changedSet = useMemo(() => new Set(changedIndices ?? []), [changedIndices])
  const { tokens, redShift } = useTheme()
  const fs = useFS()
  // Native has no scrollIntoView({block: 'center'}) like web does -- this
  // approximates it so a jumped-to search/highlight result lands mid-screen
  // instead of a flat 80px below the top, which on a short viewport (or a
  // match deep in a tall block) could leave the actual highlighted text
  // sitting right at the bottom edge or just off-screen. Prefer the
  // ScrollView's OWN measured height (`viewportHeight`, from its onLayout in
  // the parent screen) over the full device window height -- the window is
  // always taller than the ScrollView's real visible area once header/search
  // chrome above it and a tab bar below it are subtracted, so centering
  // against window height overshoots and can still land the target below
  // the ScrollView's actual visible bottom edge. Falls back to window height
  // (better than nothing) if the parent hasn't measured yet/doesn't pass it.
  const { height: windowHeight } = useWindowDimensions()
  const centerOffset = (viewportHeight ?? windowHeight) / 2

  const blocks = useMemo(() => {
    const raw = precomputed && precomputed.length ? precomputed : parseAC(text ?? '')
    // Strip Symbol/Wingdings PUA "tofu" glyphs from every displayed string.
    // Precomputed blocks are stored pre-sanitization, so clean at render time
    // — this also keeps search/highlight operating on the same clean text.
    return raw.map((b): ACBlock => {
      switch (b.kind) {
        case 'chapter': return { ...b, text: cleanGlyphs(b.text) }
        case 'para':    return { ...b, text: cleanGlyphs(b.text) }
        case 'section': return { ...b, label: cleanGlyphs(b.label), title: cleanGlyphs(b.title), body: cleanGlyphs(b.body) }
        case 'item':    return { ...b, label: cleanGlyphs(b.label), title: cleanGlyphs(b.title), body: cleanGlyphs(b.body) }
        default:        return b
      }
    })
  }, [precomputed, text])

  const toc = useMemo(
    () =>
      blocks.filter(
        (b): b is Heading =>
          b.kind === 'chapter' ||
          (b.kind === 'section' && (
            !/^\d+\.\d+/.test(b.label) ||   // legacy: "1.", "1-1.", "A.1" etc.
            /^\d+\.\d+\.?$/.test(b.label)   // modern flat: "1.1", "2.3" (no deeper nesting)
          ))
      ),
    [blocks]
  )

  // Index of the first "Change N" revision-notice block (see acFormat.ts's
  // extractChangeNotices) -- these are appended after the real document
  // body, so a one-time "Amendment History" divider right before the first
  // one marks the transition. Without it, the FIRST change notice's own card
  // styling is the only signal a reader gets that they've left the current
  // regulatory text and moved into revision history -- easy to miss on a
  // fast scroll.
  const firstChangeNoticeIdx = useMemo(
    () => blocks.findIndex((b) => b.kind === 'section' && b.isChangeNotice),
    [blocks]
  )

  // Longest-label-first so "Figure C-10" matches before "Figure C-1" would
  // otherwise grab its first few characters.
  const figuresByLabel = useMemo(() => {
    const m = new Map<string, AcFigure>()
    for (const f of figures ?? []) m.set(f.label.toLowerCase(), f)
    return m
  }, [figures])
  const figureLabelRe = useMemo(() => {
    if (!figures || !figures.length) return null
    const labels = [...new Set(figures.map((f) => f.label))].sort((a, b) => b.length - a.length)
    return new RegExp(labels.map(toTolerantLabelPattern).join('|'), 'gi')
  }, [figures])

  // For Change Notice bodies' "301a"/"301b"-style references -- see
  // buildParagraphRefIndex's own comment.
  const paragraphRefIndex = useMemo(() => buildParagraphRefIndex(blocks), [blocks])

  // PROGRESSIVE REVEAL. Every block is a host View carrying a ref and an
  // onLayout, plus its own Text children, and they were ALL mounted in one
  // pass into a plain ScrollView with no virtualisation. Measured: AC 36-3H
  // is 4,291 blocks -> ~8,650 host views and 4,291 onLayout events on mount,
  // and 16 ACs already exceed 1,000 blocks. That is the real source of the
  // WatchdogTermination kills -- not the downloads JSON the old comments
  // blamed, which measures ~4ms.
  //
  // This is what makes it safe to stop truncating ACs at 500K characters
  // (see MAX_PDF_TEXT_CHARS in sync/faa_scraper.py): AC 43.13-1B's full text
  // is ~1.37MB and 29-2C's ~3.28MB, so lifting that cap without this would
  // have turned a truncation bug into a guaranteed crash.
  //
  // Deliberately NOT a FlatList. This component's scroll-to-block,
  // scroll-to-match and table-scrollspy APIs are all built on one ScrollView's
  // onLayout-derived offsets, which a FlatList would invalidate -- that is a
  // rewrite, not a fix. Chunked mounting keeps every one of those APIs intact
  // and costs one extra frame per chunk.
  //
  // `blocks`, `toc`, `occurrences` and onMatchCount are all still computed
  // from the FULL array, so the contents list and in-document search counts
  // stay correct while the tail is still mounting.
  const BODY_CHUNK = 400
  const [revealed, setRevealed] = useState(BODY_CHUNK)
  // Mirror of `revealed` that a STALE CLOSURE can read. goToBlockIndex,
  // scrollToMatch and jumpTo all re-enter themselves across
  // requestAnimationFrame, so they re-read the `revealed` captured by the
  // render that created them -- which never changes. Guarding on that state
  // value turned "reveal, then jump" into an unbounded rAF loop that also
  // never scrolled: setRevealed was called with an identical value each pass,
  // React bailed out, no new closure was ever created.
  const revealedRef = useRef(BODY_CHUNK)
  useEffect(() => {
    revealedRef.current = BODY_CHUNK
    setRevealed(BODY_CHUNK)
  }, [blocks])
  useEffect(() => {
    if (revealed >= blocks.length) return
    // requestAnimationFrame, NOT InteractionManager.runAfterInteractions.
    // That API is a deprecated STUB in React Native 0.85 -- its entire body is
    // setImmediate (see Libraries/Interaction/InteractionManager.js:87), it
    // does not wait for touches or animations, and merely touching it logs a
    // deprecation warning. rAF actually yields a frame, which is what this
    // needs: let the already-mounted blocks paint before mounting more.
    const raf = requestAnimationFrame(() => {
      setRevealed((cur) => {
        const next = Math.min(cur + BODY_CHUNK, blocks.length)
        revealedRef.current = Math.max(revealedRef.current, next)
        return next
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [revealed, blocks.length])

  /** Mount everything up to `index`. No-op if already mounted. Writes the ref
   *  synchronously so a caller that immediately re-enters itself sees it. */
  const ensureRevealed = (index: number) => {
    if (index < revealedRef.current) return
    const next = Math.min(index + BODY_CHUNK, blocks.length)
    revealedRef.current = next
    setRevealed((cur) => Math.max(cur, next))
  }

  const [showToc, setShowToc] = useState(false)
  const [showFigures, setShowFigures] = useState(false)
  const [showFormulaRefs, setShowFormulaRefs] = useState(false)
  // TOC/Figures/Formula-ref entry titles can run long and get cut off the
  // same way FAR Part titles do -- same hook/card pair as far/index.tsx's
  // own long-press preview. Distinct from onToggleHighlight's own
  // long-press-on-body-blocks feature above -- these rows are the
  // Contents/Figures & Tables jump-lists, not body content.
  const { preview: tocPreview, previewHeight: tocPreviewHeight, setPreviewHeight: setTocPreviewHeight, showPreview: showTocPreview, hidePreview: hideTocPreview, consumeLongPress: consumeTocLongPress } = useLongPressPreview()
  const headingRefs = useRef<Record<string, View | null>>({})
  // Populated for EVERY block (web only reads this on demand in
  // scrollToBlockIndex, so capturing it for all blocks costs nothing extra)
  // -- mirrors absoluteBlockY's unconditional onLayout capture on native.
  // Previously only captured when isChanged/isHighlighted was already true
  // at render time, which raced the async highlightedBlockTexts fetch
  // (ac/[id].tsx's getHighlightsForAC): a same-render-cycle jump (?hlId=,
  // ?hlText=, or the changed-blocks nav) fired via scrollToBlockIndex before
  // that fetch resolved found nothing in jumpRefs and silently no-opped on
  // web, landing at the top of the doc with no scroll and no highlight --
  // confirmed live (tapping a saved highlight bookmark from Saved always
  // landed at section 1.1, never at the saved passage). Capturing the ref
  // for every block up front removes that race entirely.
  const jumpRefs = useRef<Record<number, View | null>>({})
  // Web-only: each highlighted match <span>, keyed by its GLOBAL ordinal --
  // the same ordinal `occurrences` (below) assigns, so this stays correct
  // even when Change-notice matches are reordered to the front (see
  // `occurrences`'s own comment). Populated via highlightSpans' onOccRef.
  // Without this, scrollToMatch's web path (below) had no way to target a
  // specific occurrence and fell back to querying the DOM for every
  // highlighted <span> in raw visual top-to-bottom order -- which silently
  // ignored `occurrences`' order entirely. Confirmed live: reordering
  // `occurrences` alone changed which match got the "active" highlight
  // color, but pressing search still auto-scrolled to the first match in
  // DOCUMENT order (e.g. AC 61-67C's "3. BACKGROUND." prose), never the
  // prioritized Change-notice card -- this ref map is what actually makes
  // the jump go to the right place.
  const occRefs = useRef<Record<number, HTMLElement | null>>({})
  //
  // blockRelY / headingRelY: each block's Y position relative to ACBody's
  // OWN root view (from its own onLayout) -- keyed by block index and, for
  // headings, also by heading id (for the Table of Contents jump).
  //
  // This replaced FIVE separate attempts to compute a block's position,
  // each of which failed differently on-device:
  //   1) measureLayout(scrollViewRef, ...) -- measures relative to whatever
  //      is CURRENTLY VISIBLE, not true content position, so it drifted
  //      further off-screen with every successive jump.
  //   2) measureLayout(scrollViewRef.getInnerViewNode(), ...) -- the
  //      textbook fix for #1, but getInnerViewNode() is "Undocumented" in
  //      RN's own types and doesn't reliably work under Expo SDK 56's New
  //      Architecture (Fabric) -- every jump silently failed instead.
  //   3) .measure() (page-absolute coordinates) + the ScrollView's current
  //      scroll offset -- mathematically sound, but reading the live scroll
  //      offset at jump time is fragile: tapping the search bar's arrow
  //      buttons blurs its TextInput, which (with keyboardDismissMode=
  //      "interactive" on this ScrollView) ties keyboard dismissal into the
  //      SAME native scrolling machinery -- so that offset could be
  //      transiently wrong at exactly the moment a jump was triggered.
  //   4) Same .measure() calculation, but cached once via onLayout instead
  //      of read live at jump time -- removed the jump-time race, but still
  //      depended on the scroll offset being correct at ANY layout event.
  //   5) onLayout-only arithmetic, but summing the FULL chain (ScrollView ->
  //      fullTextSection -> ACBody's root -> block) INSIDE each block's own
  //      onLayout -- correct in principle, but React Native doesn't
  //      guarantee a parent's onLayout fires before its children's (in
  //      practice children tend to fire FIRST, bottom-up as Yoga finishes
  //      laying out each subtree), so a block could cache its position
  //      before its ancestors had reported theirs, silently summing in
  //      stale/zero ancestor offsets. Not a scroll or keyboard problem this
  //      time -- an ordering race between onLayout callbacks at different
  //      tree depths during the initial layout pass.
  // The fix: each level of the tree still reports its own onLayout position
  // via a ref (untouched, still ordering-independent on its own), but the
  // SUM across levels now happens at JUMP TIME instead of at each block's
  // own onLayout time. By the time a jump is actually triggered (a real user
  // tap), the initial layout pass -- and every onLayout callback in it,
  // regardless of ordering -- is long finished, so reading all the refs
  // together at that point is safe.
  const blockRelY = useRef<Record<number, number>>({})
  // Each block's own rendered height, from the same onLayout event as blockRelY
  // -- used to place a specific occurrence PROPORTIONALLY within its block (see
  // absoluteOccurrenceY) instead of always landing on the block's top edge.
  const blockHeight = useRef<Record<number, number>>({})
  const headingRelY = useRef<Record<string, number>>({})
  // ACBody's own root <View> isn't a direct child of the ScrollView (see
  // outerOffsetYRef) -- this is ACBody's OWN contribution to the chain: how
  // far its root view sits within its immediate parent (fullTextSection in
  // ac/[id].tsx). Combined with outerOffsetYRef, gives each block's true
  // position within the ScrollView's actual content.
  const rootOffsetYRef = useRef(0)

  const cacheBlockLayout = (i: number, blockY: number, height: number, headingId?: string) => {
    blockRelY.current[i] = blockY
    blockHeight.current[i] = height
    if (headingId) headingRelY.current[headingId] = blockY
  }

  // Sums the chain (ScrollView -> ... -> block) at the moment it's actually
  // needed -- see the comment above blockRelY for why summing at jump time
  // (not at each block's own onLayout) is what makes this immune to
  // onLayout ordering between tree levels.
  const absoluteBlockY = (i: number): number | undefined => {
    const rel = blockRelY.current[i]
    if (rel == null) return undefined
    return (outerOffsetYRef?.current ?? 0) + rootOffsetYRef.current + rel
  }
  // Like absoluteBlockY, but offsets further down within the block by
  // `fraction` of its rendered height -- see the occurrences useMemo above for
  // why this is a meaningfully better estimate of a specific occurrence's
  // actual position than always targeting the block's top edge.
  const absoluteOccurrenceY = (i: number, fraction: number): number | undefined => {
    const rel = blockRelY.current[i]
    if (rel == null) return undefined
    const h = blockHeight.current[i] ?? 0
    return (outerOffsetYRef?.current ?? 0) + rootOffsetYRef.current + rel + fraction * h
  }
  const absoluteHeadingY = (id: string): number | undefined => {
    const rel = headingRelY.current[id]
    if (rel == null) return undefined
    return (outerOffsetYRef?.current ?? 0) + rootOffsetYRef.current + rel
  }

  const hq = highlightQuery && highlightQuery.length >= 2 ? highlightQuery : null
  const searching = hq !== null
  // The query as a literal phrase. Single- and multi-word searches both navigate
  // per-occurrence of this exact phrase ("dynamic test" → only "dynamic test").
  const phrase = hq ? searchPhrase(hq) : null

  // One entry per phrase occurrence, in document order, for per-occurrence nav.
  // `fraction` is how far into the block's own concatenated text (0 = the very
  // start, 1 = the very end) this occurrence starts — computed from character
  // offsets, which are exact and available immediately, unlike a rendered pixel
  // position. Combined with the block's own onLayout height at jump time (see
  // absoluteOccurrenceY below), this approximates the occurrence's actual line
  // within the block instead of always landing on the block's top edge — the
  // latter was fine for a short block but left later occurrences in a long
  // block, or a second/third occurrence sharing one block, looking like the
  // jump barely moved (or missed the visible area) since they all shared the
  // exact same target y. This can't be pixel-perfect (it assumes roughly even
  // line-wrapping across a block's text, which holds for normal prose but not
  // for a block containing an embedded list), but it's far closer than "always
  // top of block", and avoids the well-known iOS limitation of a ref nested
  // inside a <Text> node not reliably resolving via measureLayout (see
  // blockRelY's comment below for that history) since it's pure arithmetic on
  // data we already have, not another native measurement attempt.
  const occurrences = useMemo(() => {
    if (!phrase || phrase.length < 2) return []
    // Searching "change" is how a reader looks for the AMENDMENT HISTORY
    // cards specifically (see acFormat.ts's extractChangeNotices) -- but in
    // document order those matches sit dead last, behind every incidental
    // "change"/"changes"/"changed" in the AC's own prose. Confirmed how bad
    // this was before promoting them: on AC 20-138D "change" matches 274
    // times total, with the real Change-notice card not reached until the
    // 271st occurrence -- 20-138D also happens to be the doc whose Change
    // notices sit at the very end because of this session's earlier reorder
    // fix (RC: "the original text is listed, then the Changes are placed in
    // seq after"), which made this specific search problem worse, not
    // better. Scoped to queries starting with "change" (covers "change",
    // "changes", "changed", "change 1", "change 2") so an unrelated search
    // that happens to also match text inside a Change-notice card's body
    // keeps its normal document-order behavior -- this only reorders when
    // the reader is plausibly looking for the cards themselves.
    const prioritizeChangeNotices = phrase.startsWith('change')
    const primary: { blockIndex: number; fraction: number }[] = []
    const rest: { blockIndex: number; fraction: number }[] = []
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const bucket = prioritizeChangeNotices && b.kind === 'section' && b.isChangeNotice ? primary : rest
      const segs = blockSegments(b)
      const totalLen = segs.reduce((s, seg) => s + seg.length, 0) || 1
      let consumed = 0
      for (const seg of segs) {
        // Same whitespace-collapse reasoning as countOcc/highlightSpans above.
        const lower = seg.toLowerCase().replace(/\n/g, ' ')
        let pos = 0
        let idx = lower.indexOf(phrase, pos)
        while (idx !== -1) {
          bucket.push({ blockIndex: i, fraction: (consumed + idx) / totalLen })
          pos = idx + phrase.length
          idx = lower.indexOf(phrase, pos)
        }
        consumed += seg.length
      }
    }
    return prioritizeChangeNotices ? [...primary, ...rest] : rest
  }, [blocks, phrase])

  // Global ordinal of each block's FIRST occurrence (occurrences are grouped by
  // block in document order). Lets the renderer map the active match index to the
  // right occurrence within a block so it can be styled as the current match.
  const blockBase = useMemo(() => {
    const m = new Map<number, number>()
    for (let k = 0; k < occurrences.length; k++) {
      if (!m.has(occurrences[k].blockIndex)) m.set(occurrences[k].blockIndex, k)
    }
    return m
  }, [occurrences])

  // Fire whenever occurrences reference changes (query or blocks changed), even if
  // the total count is the same as before — avoids the stale-length dep bug.
  useEffect(() => {
    onMatchCount?.(occurrences.length)
  }, [occurrences, onMatchCount])

  // Factored out of the imperative handle's scrollToBlockIndex below so an
  // in-body tap (a resolved "301a" reference inside a Change Notice, see
  // linkifyChangeNoticeText) can jump the SAME way as an external caller
  // (ac/[id].tsx's changed-paragraphs nav) -- both are "land on this exact
  // block", just triggered from different places.
  const goToBlockIndex = (blockIndex: number, attempt = 0) => {
    // A jump target past the progressive-reveal frontier has not mounted yet,
    // so it has no ref and no measured offset and the jump would silently do
    // nothing. Mount everything up to it first, then jump on the next frame
    // once layout has run. Only reached for a deep jump into a very long AC
    // in the first moments after opening it -- by design the tail is usually
    // already revealed by the time anyone taps a contents entry.
    ensureRevealed(blockIndex)
    // Wait for the block to actually be MEASURABLE, not for a state value this
    // closure can never observe. Bounded, so a block that never materialises
    // gives up instead of spinning at 60fps for the life of the app.
    const ready = Platform.OS === 'web'
      ? jumpRefs.current[blockIndex] != null
      : blockRelY.current[blockIndex] != null
    if (!ready) {
      if (attempt < 12) requestAnimationFrame(() => requestAnimationFrame(() => goToBlockIndex(blockIndex, attempt + 1)))
      return
    }
    const node = jumpRefs.current[blockIndex]
    if (Platform.OS === 'web') {
      const el = node as unknown as HTMLElement
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      return
    }
    const scroller = scrollRef?.current
    if (!scroller) return
    const y = absoluteBlockY(blockIndex)
    if (y == null) return
    scroller.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
  }

  useImperativeHandle(ref, () => ({
    scrollToMatch(n: number) {
      if (Platform.OS === 'web') {
        // Each phrase occurrence is one highlighted <span>; scroll to the nth.
        // React Native Web converts Text → span. Use scrollIntoView — Expo renders
        // ScrollView as an overflow:auto div, so window.scrollTo has no effect.
        // Retry across a few frames: on a cold mount the highlight spans may not be
        // painted yet when an auto-scroll-to-first-match fires.
        //
        // Prefer occRefs (populated by highlightSpans' onOccRef, keyed by the
        // SAME global ordinal `occurrences` assigns) over a raw DOM query --
        // confirmed as a real, live bug without this: reordering `occurrences`
        // to put Change-notice matches first (see its own comment) correctly
        // changed which occurrence got the "active" highlight color, but the
        // OLD DOM-query approach below re-derives its own order from
        // `document.querySelectorAll('span')`, i.e. raw top-to-bottom visual
        // position -- completely independent of `occurrences`' order. Search
        // still auto-scrolled to the first "change" match in plain body prose
        // on AC 61-67C instead of the prioritized Change-notice card. Falls
        // back to the old DOM-query approach if a ref isn't populated yet
        // (e.g. a cold-mount race before that occurrence's block has laid
        // out) so this never regresses into a silent no-op.
        const tryScroll = (attempt: number) => {
          const refTarget = occRefs.current[n] as unknown as HTMLElement | undefined
          if (refTarget) {
            refTarget.scrollIntoView({ behavior: 'smooth', block: 'center' })
            return
          }
          const spans = Array.from(
            (document as any).querySelectorAll('span') as HTMLSpanElement[]
          )
          const hl = spans.filter((s: HTMLSpanElement) => {
            const bg = (window as any).getComputedStyle(s).backgroundColor as string
            // Matches both the normal (255,213,0) and active (255,138,0) highlight
            // backgrounds so the nth DOM highlight still maps to the nth occurrence.
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

      // Native: jump to the occurrence's estimated position, summed fresh
      // from the cached per-level onLayout refs right now (see blockRelY's
      // comment above for why summing at jump time -- not at each block's
      // own onLayout -- is what makes this immune to onLayout ordering
      // between tree levels). Uses the occurrence's fractional offset within
      // its block (see the occurrences useMemo above) rather than always the
      // block's top edge -- fixes two concrete symptoms of the old
      // top-of-block-only approach: multiple occurrences sharing one block
      // used to all resolve to the identical y (looked like the jump "didn't
      // move" between them), and an occurrence late in a long block used to
      // land far below center (sometimes off the bottom of the screen)
      // because only the block's top was ever centered, never the occurrence
      // itself.
      const scroller = scrollRef?.current
      if (!scroller) return
      const occ = occurrences[n]
      if (!occ) return
      // `occurrences` is computed over the FULL block array so the "1 of 37"
      // count stays honest -- but absoluteOccurrenceY reads blockRelY, which
      // only fills from onLayout for MOUNTED blocks. Without revealing first
      // this returned undefined and silently did nothing, so on a long AC the
      // counter advanced and the page never moved. Reads as totally broken.
      const tryNative = (attempt: number) => {
        ensureRevealed(occ.blockIndex)
        const y = absoluteOccurrenceY(occ.blockIndex, occ.fraction)
        if (y == null) {
          if (attempt < 12) requestAnimationFrame(() => requestAnimationFrame(() => tryNative(attempt + 1)))
          return
        }
        scroller.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
      }
      tryNative(0)
    },
    scrollToBlockIndex(blockIndex: number) {
      goToBlockIndex(blockIndex)
    },
  }), [occurrences, scrollRef, hq, centerOffset, revealed, blocks.length])

  // The Contents list is built from the FULL block array, so every heading in
  // the document is listed and tappable -- including ones past the reveal
  // frontier, which previously resolved to a null offset and silently did
  // nothing. 150/5200-31C has ~84% of its headings past the first chunk.
  const headingIndexById = useMemo(() => {
    const m = new Map<string, number>()
    blocks.forEach((b, i) => {
      const id = (b as { id?: string }).id
      if (id) m.set(id, i)
    })
    return m
  }, [blocks])

  const jumpTo = (id: string) => {
    const scroller = scrollRef?.current
    if (!scroller) return
    setShowToc(false)

    // The 60ms delay (unchanged from before) lets the TOC panel's collapse
    // finish laying out first -- everything below it shifts up once it
    // closes, and onLayout re-fires with each block's new relative position
    // by the time this timeout runs, so absoluteHeadingY reads current
    // values when called below.
    const idx = headingIndexById.get(id)
    if (idx != null) ensureRevealed(idx)

    const attemptJump = (attempt: number) => {
      if (Platform.OS === 'web') {
        const node = headingRefs.current[id]
        const el = node as unknown as HTMLElement
        if (!el) {
          if (attempt < 12) requestAnimationFrame(() => attemptJump(attempt + 1))
          return
        }
        el.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        return
      }

      const y = absoluteHeadingY(id)
      if (y == null) {
        if (attempt < 12) requestAnimationFrame(() => requestAnimationFrame(() => attemptJump(attempt + 1)))
        return
      }
      scroller.scrollTo({ y: Math.max(0, y - 10), animated: true })
    }
    setTimeout(() => attemptJump(0), 60)
  }

  if (!blocks.length) {
    if (!text && !(precomputed && precomputed.length)) return null
    return <Text style={[styles.para, { color: tokens.t3, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }]}>No readable text available.</Text>
  }

  return (
    <View onLayout={(e) => { rootOffsetYRef.current = e.nativeEvent.layout.y }}>
      {/* Table of contents — hidden while searching */}
      {toc.length >= 3 && scrollRef && !searching && (
        <View style={[styles.tocCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Pressable style={styles.tocHead} onPress={() => setShowToc((s) => !s)}>
            <Icon name="list.bullet" size={fs(14)} color={tokens.blu} />
            <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Contents</Text>
            <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{toc.length}</Text>
            <Icon name={showToc ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
          </Pressable>
          {showToc && (
            <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
              {toc.map((h) => {
                const entryText = h.kind === 'chapter' ? h.text : `${h.label} ${repairSplitTitle(h.title, h.body).title}`.trim()
                return (
                  <Pressable
                    key={h.id}
                    style={styles.tocRow}
                    onPress={() => {
                      if (consumeTocLongPress()) return
                      jumpTo(h.id)
                    }}
                    onLongPress={(e) => showTocPreview(entryText, e)}
                    onPressOut={hideTocPreview}
                    delayLongPress={350}
                  >
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.tocEntry,
                        { fontSize: fs(13), lineHeight: fs(13) * 1.38 },
                        h.kind === 'chapter'
                          ? { color: tokens.t1, fontWeight: '700' }
                          : { color: tokens.t2, paddingLeft: 14 },
                      ]}
                    >
                      {entryText}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          )}
        </View>
      )}

      {/* A handful of ACs parse with fewer than 3 headings -- usually a short
          circular that's really just one flowing document (no chapters or
          numbered sections to speak of) rather than a parsing gap. Without
          this, jumping straight into body text with no Contents card and no
          title/header above it (see build-bug reports for AC 20-18B and
          similar) reads as broken. A one-line note instead sets the right
          expectation: nothing is missing, this AC just doesn't have separate
          sections to jump between. */}
      {toc.length < 3 && scrollRef && !searching && (
        <Text style={[styles.noTocNote, { color: tokens.t4, fontSize: fs(12) }]}>
          This AC reads as a single continuous document — no separate sections to jump between.
        </Text>
      )}

      {/* Figures & Tables — extracted page images, hidden while searching.
          Always shown once loaded (even at 0) so an AC with none doesn't
          look like the feature is broken/missing data. */}
      {(figures || (formulaRefs && formulaRefs.length > 0)) && !searching && (
        <View style={[styles.tocCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          {figures && (
            <>
              <Pressable
                style={styles.tocHead}
                onPress={figures.length > 0 ? () => setShowFigures((s) => !s) : undefined}
              >
                <Icon name="photo" size={fs(14)} color={tokens.blu} />
                <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Figures & Tables</Text>
                <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{figures.length}</Text>
                {figures.length > 0 && (
                  <Icon name={showFigures ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
                )}
              </Pressable>
              {showFigures && (
                <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
                  {figures.map((f) => (
                    <Pressable
                      key={f.id}
                      style={styles.tocRow}
                      onPress={() => {
                        if (consumeTocLongPress()) return
                        onOpenFigure?.(f)
                      }}
                      onLongPress={(e) => showTocPreview(f.caption ? `${f.label} ${f.caption}` : f.label, e)}
                      onPressOut={hideTocPreview}
                      delayLongPress={350}
                    >
                      <Text numberOfLines={1} style={[styles.tocEntry, { color: tokens.t2, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                        <Text style={{ color: tokens.t1, fontWeight: '700' }}>{f.label}</Text>
                        {f.caption ? (
                          ` ${f.caption}`
                        ) : (
                          <Text style={{ fontStyle: 'italic', color: tokens.t4 }}> (caption unavailable — view page image)</Text>
                        )}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}

          {/* Formulas to Verify — a visually-nested sub-section of the same
              card, but entirely independent state/data/handler from the
              Figures & Tables block above (see FormulaRef type comment for
              why this must never touch the T&F pipeline). Only rendered when
              there's actually something flagged — unlike Figures & Tables,
              this is a rare, manually-curated list, not an always-on
              corpus-wide feature, so an empty "(0)" row would just be noise
              on the vast majority of ACs that have nothing flagged. */}
          {formulaRefs && formulaRefs.length > 0 && (
            <>
              <Pressable
                style={[styles.tocHead, figures && { borderTopWidth: 1, borderTopColor: tokens.bdr }]}
                onPress={() => setShowFormulaRefs((s) => !s)}
              >
                <Icon name="exclamationmark.triangle" size={fs(14)} color={tokens.blu} />
                <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Formulas to Verify</Text>
                <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{formulaRefs.length}</Text>
                <Icon name={showFormulaRefs ? 'chevron.up' : 'chevron.down'} size={fs(13)} color={tokens.t3} />
              </Pressable>
              {showFormulaRefs && (
                <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
                  {formulaRefs.map((r) => (
                    <Pressable
                      key={r.id}
                      style={styles.tocRow}
                      onPress={() => {
                        if (consumeTocLongPress()) return
                        onOpenFormulaRef?.(r)
                      }}
                      onLongPress={(e) => showTocPreview(r.note ? `${r.label} — ${r.note}` : r.label, e)}
                      onPressOut={hideTocPreview}
                      delayLongPress={350}
                    >
                      <Text numberOfLines={2} style={[styles.tocEntry, { color: tokens.t2, fontSize: fs(13), lineHeight: fs(13) * 1.38 }]}>
                        <Text style={{ color: tokens.t1, fontWeight: '700' }}>{r.label}</Text>
                        {r.note ? ` — ${r.note}` : ''}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              )}
            </>
          )}
        </View>
      )}

      {/* Document body — capped to bodyLimit blocks for the free-tier preview */}
      {(bodyLimit != null ? blocks.slice(0, bodyLimit) : blocks.slice(0, revealed)).map((b, i) => {
        const isChanged = changedSet.has(i)
        const changedStyle = isChanged
          ? { borderLeftWidth: 3, borderLeftColor: tokens.blu, paddingLeft: 8 }
          : null
        const UpdatedTag = isChanged ? (
          <Text style={[styles.updatedTag, { color: tokens.blu, backgroundColor: tokens.bdim, fontSize: fs(10.5) }]}> UPDATED </Text>
        ) : null
        const isHighlighted = !!highlightedBlockTexts?.has(blockText(b))
        // RedShift override -- a fixed #FFD500 block destroys dark adaptation,
        // the one thing RedShift exists to protect. This file already renders
        // search-term spans through redShift-aware styles (highlightRedshift),
        // so the bookmark highlight being the only fixed-yellow element was an
        // oversight, not a decision. Light and dark are unchanged; the night
        // case uses the theme's own gold tokens, not a colour invented here.
        const highlightStyle = isHighlighted
          ? redShift
            ? { backgroundColor: tokens.goldlt, borderLeftWidth: 3, borderLeftColor: tokens.gold, paddingLeft: 8 }
            : { backgroundColor: 'rgba(255, 213, 0, 0.10)', borderLeftWidth: 3, borderLeftColor: '#FFD500', paddingLeft: 8 }
          : null
        const HighlightTag = isHighlighted ? (
          <Text style={[styles.updatedTag, redShift
            ? { color: tokens.gold, backgroundColor: tokens.goldbdr, fontSize: fs(10.5) }
            : { color: '#8a6d00', backgroundColor: 'rgba(255, 213, 0, 0.35)', fontSize: fs(10.5) }]}> HIGHLIGHTED </Text>
        ) : null
        const longPress = onToggleHighlight ? () => onToggleHighlight(b, i) : undefined
        // Highlight every phrase occurrence; the one whose global ordinal ==
        // activeMatch renders as the current match. `base` is this block's first
        // occurrence ordinal and advances across the heading/body segments so it
        // stays continuous with the occurrences[] array.
        const activeHq = hq
        const base = phrase ? blockBase.get(i) ?? 0 : 0
        const hOpts = (segBase: number) => ({
          base: segBase,
          active: activeMatch,
          redShift,
          onOccRef: Platform.OS === 'web'
            ? (globalOrdinal: number, node: any) => { occRefs.current[globalOrdinal] = node }
            : undefined,
        })
        // Only auto-link body prose (not headings/labels) — a caption never
        // legitimately appears inside a section/item label.
        const linkify = (t: string) =>
          linkifyBody(t, figureLabelRe, figuresByLabel, onOpenFigure, tokens, currentLabel, hasProAccess)
        // Change Notice bodies specifically (see linkifyChangeNoticeText) also
        // get "301a"/"301b"-style same-document jump links — scoped to just
        // this block kind since that's the FAA's own convention for revision
        // notices, not general AC prose (a bare "N + letter" elsewhere in a
        // document's real body isn't reliably a paragraph reference).
        const linkifyChange = (t: string) =>
          linkifyChangeNoticeText(t, paragraphRefIndex, tokens, goToBlockIndex, currentLabel, hasProAccess)
        switch (b.kind) {
          case 'chapter':
            return (
              <View
                key={i}
                ref={(el) => {
                  headingRefs.current[b.id] = el
                  jumpRefs.current[i] = el
                }}
                onLayout={(e) => cacheBlockLayout(i, e.nativeEvent.layout.y, e.nativeEvent.layout.height, b.id)}
                style={changedStyle}
              >
                {UpdatedTag}
                <Text style={[styles.chapter, { color: tokens.t1, fontSize: fs(14.5) }]}>
                  {activeHq ? highlightSpans(b.text, activeHq, hOpts(base)) : linkify(b.text)}
                </Text>
              </View>
            )
          case 'section': {
            // "Change N" revision notices (see acFormat.ts's extractChangeNotices)
            // render as their own visually distinct card instead of falling
            // through to the generic numbered-section styling below, which
            // would make them indistinguishable from real body content while
            // scrolling. RC: "these Change sections need to be treated like
            // another document, inside the original... emboldened and
            // clearly show... so as a user scrolls through the body of a
            // reg, these areas stand out clearly."
            if (b.isChangeNotice) {
              const { title: rawTitle, body: rawBody } = repairSplitTitle(b.title, b.body)
              const headingText = `${b.label}${rawTitle ? ` ${rawTitle}` : ''}`
              const bodyBase = base + (phrase ? countOcc(headingText, phrase) : 0)
              return (
                <React.Fragment key={i}>
                  {i === firstChangeNoticeIdx && (
                    <View style={styles.amendmentDivider}>
                      <View style={[styles.amendmentDividerLine, { backgroundColor: tokens.bdr }]} />
                      <Text style={[styles.amendmentDividerText, { color: tokens.t3, fontSize: fs(11) }]}>
                        AMENDMENT HISTORY
                      </Text>
                      <View style={[styles.amendmentDividerLine, { backgroundColor: tokens.bdr }]} />
                    </View>
                  )}
                  <Pressable
                    ref={(el) => {
                      headingRefs.current[b.id] = el as any
                      jumpRefs.current[i] = el as any
                    }}
                    onLayout={(e) => cacheBlockLayout(i, e.nativeEvent.layout.y, e.nativeEvent.layout.height, b.id)}
                    onLongPress={longPress}
                    delayLongPress={450}
                    style={[styles.changeCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }, highlightStyle]}
                  >
                    {HighlightTag}
                    {activeHq ? (
                      <Text style={[styles.sectionLabel, { color: tokens.t1, fontWeight: '700', fontSize: fs(13.5), lineHeight: fs(13.5) * 1.48 }]}>
                        {highlightSpans(headingText, activeHq, hOpts(base))}
                      </Text>
                    ) : (
                      <View style={styles.changeCardHead}>
                        <Text style={[styles.changeChip, { backgroundColor: tokens.blu, fontSize: fs(11) }]}>
                          {b.label.toUpperCase()}
                        </Text>
                        {rawTitle ? (
                          <Text style={[styles.changeDate, { color: tokens.t3, fontSize: fs(11.5) }]}>{rawTitle}</Text>
                        ) : null}
                      </View>
                    )}
                    {rawBody ? (
                      activeHq ? (
                        <Text selectable style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13), lineHeight: fs(13) * 1.62 }]}>
                          {highlightSpans(rawBody, activeHq, hOpts(bodyBase))}
                        </Text>
                      ) : (
                        softWrapParagraph(rawBody).map((chunk, ci) => (
                          <Text
                            key={ci}
                            selectable
                            style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13), lineHeight: fs(13) * 1.62 }, ci > 0 && { marginTop: 8 }]}
                          >
                            {linkifyChange(chunk)}
                          </Text>
                        ))
                      )
                    ) : null}
                  </Pressable>
                </React.Fragment>
              )
            }
            const depth = (b.label.replace(/\.$/, '').match(/\./g) || []).length
            const paddingLeft = Math.max(0, depth - 1) * 16
            const fontSize = fs(depth >= 3 ? 12.5 : depth >= 2 ? 13 : 13.5)
            const fontWeight: '700' | '600' = depth >= 2 ? '600' : '700'
            const marginTop = depth >= 2 ? 8 : 14
            const { title: rawTitle, body: rawBody } = repairSplitTitle(b.title, b.body)
            const headingText = `${b.label}${rawTitle ? ` ${rawTitle}` : ''}`
            const bodyBase = base + (phrase ? countOcc(headingText, phrase) : 0)
            // Only break the body out of its normal single-paragraph <Text>
            // when it actually contains an embedded list to reformat.
            const sectionListRuns = !activeHq ? findListRuns(rawBody ?? '') : []
            return (
              <Pressable
                key={i}
                ref={(el) => {
                  headingRefs.current[b.id] = el as any
                  jumpRefs.current[i] = el as any
                }}
                onLayout={(e) => cacheBlockLayout(i, e.nativeEvent.layout.y, e.nativeEvent.layout.height, b.id)}
                onLongPress={longPress}
                delayLongPress={450}
                style={[
                  { paddingLeft },
                  isChanged && { borderLeftWidth: 3, borderLeftColor: tokens.blu, paddingLeft: paddingLeft + 8 },
                  highlightStyle,
                ]}
              >
                {UpdatedTag}
                {HighlightTag}
                <Text style={[styles.sectionLabel, { color: tokens.t1, fontWeight, fontSize, marginTop, lineHeight: fontSize * 1.48 }]}>
                  {activeHq ? highlightSpans(headingText, activeHq, hOpts(base)) : headingText}
                </Text>
                {rawBody ? (
                  activeHq ? (
                    <Text selectable style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }]}>
                      {highlightSpans(rawBody, activeHq, hOpts(bodyBase))}
                    </Text>
                  ) : sectionListRuns.length ? (
                    <View style={styles.sectionBody}>{renderBodyContent(rawBody, linkify, tokens, fs)}</View>
                  ) : (
                    // Purely a display split — see softWrap.ts. Long AC
                    // section bodies with no real internal break read as one
                    // dense wall on a narrow phone screen; confirmed live,
                    // directly requested ("create a bit of breathing room in
                    // long chunks of text... finding the natural breaks at
                    // the end of some of the sentences").
                    softWrapParagraph(rawBody).map((chunk, ci) => (
                      <Text
                        key={ci}
                        selectable
                        style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }, ci > 0 && { marginTop: 8 }]}
                      >
                        {linkify(chunk)}
                      </Text>
                    ))
                  )
                ) : null}
              </Pressable>
            )
          }
          case 'item': {
            const labelText = `${b.label}${b.title ? ` ${b.title}` : ''}`
            const bodyBase = base + (phrase ? countOcc(labelText, phrase) : 0)
            // Only break the label onto its own line when the body actually
            // contains an embedded list to reformat — the vast majority of
            // items have no list and keep their normal inline "a. Body text…"
            // flow (label + body in one wrapping paragraph).
            const itemListRuns = !activeHq ? findListRuns(b.body ?? '') : []
            return (
              <Pressable
                key={i}
                ref={(el) => { jumpRefs.current[i] = el as any }}
                onLayout={(e) => cacheBlockLayout(i, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                {activeHq ? (
                  <Text selectable style={[styles.item, { color: tokens.t2, paddingLeft: 6 + b.level * 14, fontSize: fs(13), lineHeight: fs(13) * 1.54 }]}>
                    <Text style={{ color: tokens.t1, fontWeight: '600' }}>
                      {highlightSpans(labelText, activeHq, hOpts(base))}{' '}
                    </Text>
                    {highlightSpans(b.body, activeHq, hOpts(bodyBase))}
                  </Text>
                ) : itemListRuns.length ? (
                  <View style={[styles.item, { paddingLeft: 6 + b.level * 14 }]}>
                    <Text style={{ color: tokens.t1, fontWeight: '600', fontSize: fs(13) }}>{labelText}</Text>
                    <View>{renderBodyContent(b.body, linkify, tokens, fs)}</View>
                  </View>
                ) : (
                  // Same soft-wrap treatment as section bodies above — the
                  // label stays attached to the first chunk (matches the
                  // normal inline "a. Body text…" flow), later chunks get
                  // their own line.
                  softWrapParagraph(b.body).map((chunk, ci) => (
                    <Text
                      key={ci}
                      selectable
                      style={[styles.item, { color: tokens.t2, paddingLeft: 6 + b.level * 14, fontSize: fs(13), lineHeight: fs(13) * 1.54 }, ci > 0 && { marginTop: 6 }]}
                    >
                      {ci === 0 && <Text style={{ color: tokens.t1, fontWeight: '600' }}>{labelText}{' '}</Text>}
                      {linkify(chunk)}
                    </Text>
                  ))
                )}
              </Pressable>
            )
          }
          default:
            return (
              <Pressable
                key={i}
                ref={(el) => { jumpRefs.current[i] = el as any }}
                onLayout={(e) => cacheBlockLayout(i, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                {activeHq ? (
                  <Text selectable style={[styles.para, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }]}>
                    {highlightSpans(b.text, activeHq, hOpts(base))}
                  </Text>
                ) : (
                  softWrapParagraph(b.text).map((chunk, ci) => (
                    <Text
                      key={ci}
                      selectable
                      style={[styles.para, { color: tokens.t2, fontSize: fs(13.5), lineHeight: fs(13.5) * 1.56 }, ci > 0 && { marginTop: 8 }]}
                    >
                      {linkify(chunk)}
                    </Text>
                  ))
                )}
              </Pressable>
            )
        }
      })}
      <LongPressPreviewCard
        preview={tocPreview}
        previewHeight={tocPreviewHeight}
        onLayoutHeight={setTocPreviewHeight}
        onDismiss={hideTocPreview}
      />
    </View>
  )
})

const styles = StyleSheet.create({
  tocCard: { borderRadius: 12, borderWidth: 1, marginTop: 4, marginBottom: 6, overflow: 'hidden' },
  noTocNote: { fontStyle: 'italic', marginTop: 4, marginBottom: 10 },
  tocHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 11 },
  tocHeadText: { fontSize: 13.5, fontWeight: '700', flex: 1 },
  tocCount: { fontSize: 12, fontWeight: '600' },
  tocList: { borderTopWidth: 1, paddingVertical: 4 },
  tocRow: { paddingHorizontal: 14, paddingVertical: 7 },
  // lineHeight NOT set here -- always overridden inline with fs(13) * 1.38
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  tocEntry: { fontSize: 13 },

  chapter: { fontSize: 14.5, fontWeight: '800', letterSpacing: 0.3, marginTop: 20, marginBottom: 8 },
  // lineHeight NOT set here -- always overridden inline with fs(size) * 1.48
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  sectionLabel: {},
  amendmentDivider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 26, marginBottom: 10 },
  amendmentDividerLine: { flex: 1, height: StyleSheet.hairlineWidth },
  amendmentDividerText: { fontWeight: '700', letterSpacing: 1.2 },
  changeCard: { borderWidth: 1, borderRadius: 10, padding: 12, marginTop: 10 },
  changeCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  changeChip: { color: '#fff', fontWeight: '800', letterSpacing: 0.4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 5, overflow: 'hidden' },
  changeDate: { fontWeight: '500' },
  sectionBody: { fontSize: 13.5, lineHeight: 21, marginTop: 4 },
  // lineHeight NOT set here -- always overridden inline with fs(13) * 1.54
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  item: { fontSize: 13, marginTop: 8 },
  autoListRow: { flexDirection: 'row', marginTop: 6, paddingLeft: 4 },
  // lineHeight NOT set here -- always overridden inline with fs(13) * 1.62
  // (StyleSheet.create is module-scope, fs() is a hook), same
  // fixed-lineHeight-vs-scaled-fontSize fix as the rest of today's sweep.
  autoListNum: { fontWeight: '700', width: 22 },
  autoListBody: { flex: 1, lineHeight: 21 },
  para: { fontSize: 13.5, lineHeight: 21, marginTop: 10 },
  highlight: { backgroundColor: 'rgba(255, 213, 0, 0.45)', borderRadius: 2 },
  // Current match — brighter/solid orange so it stands out from the other matches.
  highlightActive: { backgroundColor: 'rgba(255, 138, 0, 0.95)', color: '#1a1400', borderRadius: 2 },
  // Red Shift: same two-tier passive/active shape, recolored off yellow and
  // bright orange (both real night-vision offenders at this size, used on
  // every doc's in-doc search) into the app's shared redshift language.
  highlightRedshift: { backgroundColor: 'rgba(224, 86, 46, 0.45)', borderRadius: 2 },
  highlightActiveRedshift: { backgroundColor: 'rgba(255, 45, 18, 0.95)', color: '#2A0800', borderRadius: 2 },
  updatedTag: {
    alignSelf: 'flex-start',
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.4,
    borderRadius: 4,
    marginBottom: 3,
    overflow: 'hidden',
  },
})
