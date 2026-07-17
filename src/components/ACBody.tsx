import React, { useMemo, useRef, useState, useEffect, useImperativeHandle, RefObject } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
  useWindowDimensions,
} from 'react-native'
import { useTheme, ThemeTokens } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { parseAC, cleanGlyphs, blockText, ACBlock } from '@/lib/acFormat'
import type { AcFigure, FormulaRef } from '@/types'

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
  const lower = text.toLowerCase()
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
  opts?: { base?: number; active?: number; onOccRef?: (globalOrdinal: number, node: any) => void }
): React.ReactNode {
  const phrase = searchPhrase(query)
  if (phrase.length < 2 || !text) return text
  const lower = text.toLowerCase()

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
        style={isActive ? styles.highlightActive : styles.highlight}
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
// looks up the canonical "Table 5-1" entry in figuresByLabel.
function normalizeMatchedLabel(matched: string): string {
  return matched.replace(/\s*-\s*/g, '-').replace(/\s*\.\s*/g, '.')
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
  if (intro) nodes.push(<Text key="intro">{linkify(intro)}</Text>)

  runs.forEach((run, r) => {
    run.items.forEach((item, k) => {
      const contentEnd =
        k + 1 < run.items.length ? run.items[k + 1].start : r + 1 < runs.length ? runs[r + 1].introEnd : text.length
      const content = text.slice(item.contentStart, contentEnd).trim()
      nodes.push(
        <View key={`${r}-${item.num}`} style={styles.autoListRow}>
          <Text style={[styles.autoListNum, { color: tokens.t1, fontSize: fs(13) }]}>{item.num}.</Text>
          <Text style={[styles.autoListBody, { color: tokens.t2, fontSize: fs(13.5) }]}>{linkify(content)}</Text>
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
    /** The scrollRef ScrollView's current contentOffset.y, kept live by the
     * parent screen's own onScroll handler (a ref, not state, so scrolling
     * doesn't re-render this whole body on every frame). Only read inside
     * each block's onLayout (see blockLayoutY below) -- NOT at jump time --
     * so it's always sampled at a stable, just-settled moment rather than
     * possibly mid-animation from a rapid successive tap. */
    scrollYRef?: RefObject<number>
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
  }
>(function ACBody({ text, blocks: precomputed, scrollRef, viewportHeight, scrollYRef, highlightQuery, onMatchCount, activeMatch = -1, bodyLimit, changedIndices, highlightedBlockTexts, onToggleHighlight, figures, onOpenFigure, formulaRefs, onOpenFormulaRef }, ref) {
  const changedSet = useMemo(() => new Set(changedIndices ?? []), [changedIndices])
  const { tokens } = useTheme()
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

  // Longest-label-first so "Figure C-10" matches before "Figure C-1" would
  // otherwise grab its first few characters.
  const figuresByLabel = useMemo(() => {
    const m = new Map<string, AcFigure>()
    for (const f of figures ?? []) m.set(f.label, f)
    return m
  }, [figures])
  const figureLabelRe = useMemo(() => {
    if (!figures || !figures.length) return null
    const labels = [...figuresByLabel.keys()].sort((a, b) => b.length - a.length)
    return new RegExp(labels.map(toTolerantLabelPattern).join('|'), 'g')
  }, [figures, figuresByLabel])

  const [showToc, setShowToc] = useState(false)
  const [showFigures, setShowFigures] = useState(false)
  const [showFormulaRefs, setShowFormulaRefs] = useState(false)
  const headingRefs = useRef<Record<string, View | null>>({})
  const matchRefs = useRef<Record<number, View | null>>({})
  // Per-occurrence (not per-block) refs to the actual highlighted <Text> span
  // -- kept for potential future use but no longer read by native scrolling
  // (see blockLayoutY below); only web's scrollToMatch still uses per-span
  // DOM lookup, which is unrelated to this.
  const occurrenceRefs = useRef<Record<number, any>>({})
  // Populated for any block a caller might need to imperatively scroll to
  // later (changed-in-revision blocks AND saved highlights) — see
  // scrollToBlockIndex above. Still used on web (DOM scrollIntoView).
  const jumpRefs = useRef<Record<number, View | null>>({})
  // Unconditional ref to EVERY block (unlike matchRefs/jumpRefs, which are
  // only set for blocks currently matched/changed/highlighted) -- needed so
  // every block can be measured up front regardless of whether it's a
  // "target" yet, since which blocks match can change as the user types.
  const blockNodeRefs = useRef<Record<number, any>>({})
  //
  // blockLayoutY / headingLayoutY: each block's absolute Y position within
  // the ScrollView's scrollable content, cached once per genuine layout
  // change (see cacheBlockLayout below) -- keyed by block index and, for
  // headings, also by heading id (for the Table of Contents jump). Reading
  // these at jump time is a pure JS lookup: no native measurement call
  // happens at the moment of a tap.
  //
  // This replaced THREE separate attempts to scroll by measuring live at
  // jump time, each of which failed differently on-device:
  //   1) measureLayout(scrollViewRef, ...) -- measures relative to whatever
  //      is CURRENTLY VISIBLE, not true content position, so it drifted
  //      further off-screen with every successive jump.
  //   2) measureLayout(scrollViewRef.getInnerViewNode(), ...) -- the
  //      textbook fix for #1, but getInnerViewNode() is "Undocumented" in
  //      RN's own types and doesn't reliably work under Expo SDK 56's New
  //      Architecture (Fabric) -- every jump silently failed instead.
  //   3) .measure() (page-absolute coordinates) + the ScrollView's current
  //      scroll offset, both read AT THE MOMENT OF THE TAP -- mathematically
  //      correct, but reading live native state at the exact instant of a
  //      rapid successive tap (possibly mid-animation from the PREVIOUS
  //      jump's own scrollTo, or mid-keyboard-dismiss from the search bar
  //      losing focus) could read a transient, not-yet-settled position,
  //      producing an inconsistent or even backwards result.
  // The fix: do the SAME `.measure()`-based calculation as #3, but only
  // ever inside onLayout -- which by definition only fires once a layout
  // has just freshly committed, i.e. a moment guaranteed to be settled, not
  // mid-animation. Jump time itself is then just arithmetic on an already-
  // cached number, with no native call and nothing that can race.
  const blockLayoutY = useRef<Record<number, number>>({})
  const headingLayoutY = useRef<Record<string, number>>({})

  // Measures `node` (a block) relative to `scroller` via `.measure()` (page-
  // absolute coordinates -- standard, documented, Fabric-safe), combines it
  // with the ScrollView's current scroll offset, and caches the result as
  // this block's absolute content-Y. Called from onLayout, never from a
  // jump handler -- see the comment above blockLayoutY for why that timing
  // is what makes this reliable where three live-measurement attempts at
  // jump time were not.
  const cacheBlockLayout = (i: number, headingId?: string) => {
    if (Platform.OS === 'web') return // web scrolling uses DOM APIs, not these caches
    const node = blockNodeRefs.current[i]
    const scroller = scrollRef?.current
    if (!node || !scroller || typeof node.measure !== 'function' || typeof (scroller as any).measure !== 'function') return
    node.measure((_x: number, _y: number, _w: number, _h: number, _pageX: number, pageY: number) => {
      ;(scroller as any).measure((_x2: number, _y2: number, _w2: number, _h2: number, _pageX2: number, scrollerPageY: number) => {
        const current = scrollYRef?.current ?? 0
        const y = current + (pageY - scrollerPageY)
        blockLayoutY.current[i] = y
        if (headingId) headingLayoutY.current[headingId] = y
      })
    })
  }

  const hq = highlightQuery && highlightQuery.length >= 2 ? highlightQuery : null
  const searching = hq !== null
  // The query as a literal phrase. Single- and multi-word searches both navigate
  // per-occurrence of this exact phrase ("dynamic test" → only "dynamic test").
  const phrase = hq ? searchPhrase(hq) : null

  // One entry per phrase occurrence, in document order, for per-occurrence nav.
  const occurrences = useMemo(() => {
    if (!phrase || phrase.length < 2) return []
    const result: number[] = []
    for (let i = 0; i < blocks.length; i++) {
      let cnt = 0
      for (const seg of blockSegments(blocks[i])) cnt += countOcc(seg, phrase)
      for (let k = 0; k < cnt; k++) result.push(i)
    }
    return result
  }, [blocks, phrase])

  // Set of block indices that contain at least one match — used for ref assignment.
  const matchingBlockSet = useMemo(() => new Set(occurrences), [occurrences])

  // Global ordinal of each block's FIRST occurrence (occurrences are grouped by
  // block in document order). Lets the renderer map the active match index to the
  // right occurrence within a block so it can be styled as the current match.
  const blockBase = useMemo(() => {
    const m = new Map<number, number>()
    for (let k = 0; k < occurrences.length; k++) {
      if (!m.has(occurrences[k])) m.set(occurrences[k], k)
    }
    return m
  }, [occurrences])

  // Fire whenever occurrences reference changes (query or blocks changed), even if
  // the total count is the same as before — avoids the stale-length dep bug.
  useEffect(() => {
    onMatchCount?.(occurrences.length)
  }, [occurrences, onMatchCount])

  useImperativeHandle(ref, () => ({
    scrollToMatch(n: number) {
      if (Platform.OS === 'web') {
        // Each phrase occurrence is one highlighted <span>; scroll to the nth.
        // React Native Web converts Text → span. Use scrollIntoView — Expo renders
        // ScrollView as an overflow:auto div, so window.scrollTo has no effect.
        // Retry across a few frames: on a cold mount the highlight spans may not be
        // painted yet when an auto-scroll-to-first-match fires.
        const tryScroll = (attempt: number) => {
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

      // Native: jump to the containing block using its cached absolute
      // position (see blockLayoutY's comment above for why this is measured
      // once at layout time via cacheBlockLayout, not live at jump time).
      // This lands at the top of the block rather than the exact word -- a
      // deliberate precision trade for reliability; the active occurrence
      // is still visually highlighted once its block is on screen.
      const scroller = scrollRef?.current
      if (!scroller) return
      const blockIndex = occurrences[n]
      const y = blockIndex != null ? blockLayoutY.current[blockIndex] : undefined
      if (y == null) return
      scroller.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
    },
    scrollToBlockIndex(blockIndex: number) {
      const node = jumpRefs.current[blockIndex]
      if (Platform.OS === 'web') {
        const el = node as unknown as HTMLElement
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        return
      }
      const scroller = scrollRef?.current
      if (!scroller) return
      const y = blockLayoutY.current[blockIndex]
      if (y == null) return
      scroller.scrollTo({ y: Math.max(0, y - centerOffset), animated: true })
    },
  }), [occurrences, scrollRef, hq, centerOffset])

  const jumpTo = (id: string) => {
    const scroller = scrollRef?.current
    if (!scroller) return
    setShowToc(false)

    // The 60ms delay (unchanged from before) lets the TOC panel's collapse
    // finish laying out first -- everything below it shifts up once it
    // closes, and onLayout re-fires with each block's new position by the
    // time this timeout runs, so blockLayoutY/headingLayoutY are current
    // when read below.
    setTimeout(() => {
      if (Platform.OS === 'web') {
        const node = headingRefs.current[id]
        const el = node as unknown as HTMLElement
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        return
      }

      const y = headingLayoutY.current[id]
      if (y == null) return
      scroller.scrollTo({ y: Math.max(0, y - 10), animated: true })
    }, 60)
  }

  if (!blocks.length) {
    if (!text && !(precomputed && precomputed.length)) return null
    return <Text style={[styles.para, { color: tokens.t3, fontSize: fs(13.5) }]}>No readable text available.</Text>
  }

  return (
    <View>
      {/* Table of contents — hidden while searching */}
      {toc.length >= 3 && scrollRef && !searching && (
        <View style={[styles.tocCard, { backgroundColor: tokens.bg2, borderColor: tokens.bdr }]}>
          <Pressable style={styles.tocHead} onPress={() => setShowToc((s) => !s)}>
            <Icon name="list.bullet" size={14} color={tokens.blu} />
            <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Contents</Text>
            <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{toc.length}</Text>
            <Icon name={showToc ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t3} />
          </Pressable>
          {showToc && (
            <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
              {toc.map((h) => (
                <Pressable key={h.id} style={styles.tocRow} onPress={() => jumpTo(h.id)}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.tocEntry,
                      { fontSize: fs(13) },
                      h.kind === 'chapter'
                        ? { color: tokens.t1, fontWeight: '700' }
                        : { color: tokens.t2, paddingLeft: 14 },
                    ]}
                  >
                    {h.kind === 'chapter' ? h.text : `${h.label} ${repairSplitTitle(h.title, h.body).title}`.trim()}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
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
                <Icon name="photo" size={14} color={tokens.blu} />
                <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Figures & Tables</Text>
                <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{figures.length}</Text>
                {figures.length > 0 && (
                  <Icon name={showFigures ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t3} />
                )}
              </Pressable>
              {showFigures && (
                <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
                  {figures.map((f) => (
                    <Pressable key={f.id} style={styles.tocRow} onPress={() => onOpenFigure?.(f)}>
                      <Text numberOfLines={1} style={[styles.tocEntry, { color: tokens.t2, fontSize: fs(13) }]}>
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
                <Icon name="exclamationmark.triangle" size={14} color={tokens.blu} />
                <Text style={[styles.tocHeadText, { color: tokens.t1, fontSize: fs(13.5) }]}>Formulas to Verify</Text>
                <Text style={[styles.tocCount, { color: tokens.t3, fontSize: fs(14) }]}>{formulaRefs.length}</Text>
                <Icon name={showFormulaRefs ? 'chevron.up' : 'chevron.down'} size={13} color={tokens.t3} />
              </Pressable>
              {showFormulaRefs && (
                <View style={[styles.tocList, { borderTopColor: tokens.bdr }]}>
                  {formulaRefs.map((r) => (
                    <Pressable key={r.id} style={styles.tocRow} onPress={() => onOpenFormulaRef?.(r)}>
                      <Text numberOfLines={2} style={[styles.tocEntry, { color: tokens.t2, fontSize: fs(13) }]}>
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
      {(bodyLimit != null ? blocks.slice(0, bodyLimit) : blocks).map((b, i) => {
        const isMatch = searching && matchingBlockSet.has(i)
        const isChanged = changedSet.has(i)
        const changedStyle = isChanged
          ? { borderLeftWidth: 3, borderLeftColor: tokens.blu, paddingLeft: 8 }
          : null
        const UpdatedTag = isChanged ? (
          <Text style={[styles.updatedTag, { color: tokens.blu, backgroundColor: tokens.bdim }]}> UPDATED </Text>
        ) : null
        const isHighlighted = !!highlightedBlockTexts?.has(blockText(b))
        const highlightStyle = isHighlighted
          ? { backgroundColor: 'rgba(255, 213, 0, 0.10)', borderLeftWidth: 3, borderLeftColor: '#FFD500', paddingLeft: 8 }
          : null
        const HighlightTag = isHighlighted ? (
          <Text style={[styles.updatedTag, { color: '#8a6d00', backgroundColor: 'rgba(255, 213, 0, 0.35)' }]}> HIGHLIGHTED </Text>
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
          onOccRef: (ordinal: number, node: any) => { occurrenceRefs.current[ordinal] = node },
        })
        // Only auto-link body prose (not headings/labels) — a caption never
        // legitimately appears inside a section/item label.
        const linkify = (t: string) =>
          onOpenFigure ? linkifyFigures(t, figureLabelRe, figuresByLabel, onOpenFigure, tokens) : t
        switch (b.kind) {
          case 'chapter':
            return (
              <View
                key={i}
                ref={(el) => {
                  headingRefs.current[b.id] = el
                  blockNodeRefs.current[i] = el
                  if (isMatch) matchRefs.current[i] = el
                  if (isChanged) jumpRefs.current[i] = el
                  if (isHighlighted) jumpRefs.current[i] = el
                }}
                onLayout={() => cacheBlockLayout(i, b.id)}
                style={changedStyle}
              >
                {UpdatedTag}
                <Text style={[styles.chapter, { color: tokens.t1, fontSize: fs(14.5) }]}>
                  {activeHq ? highlightSpans(b.text, activeHq, hOpts(base)) : linkify(b.text)}
                </Text>
              </View>
            )
          case 'section': {
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
                  blockNodeRefs.current[i] = el
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
                onLayout={() => cacheBlockLayout(i, b.id)}
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
                <Text style={[styles.sectionLabel, { color: tokens.t1, fontWeight, fontSize, marginTop }]}>
                  {activeHq ? highlightSpans(headingText, activeHq, hOpts(base)) : headingText}
                </Text>
                {rawBody ? (
                  activeHq ? (
                    <Text selectable style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13.5) }]}>
                      {highlightSpans(rawBody, activeHq, hOpts(bodyBase))}
                    </Text>
                  ) : sectionListRuns.length ? (
                    <View style={styles.sectionBody}>{renderBodyContent(rawBody, linkify, tokens, fs)}</View>
                  ) : (
                    <Text selectable style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13.5) }]}>
                      {linkify(rawBody)}
                    </Text>
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
                ref={(el) => {
                  blockNodeRefs.current[i] = el
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
                onLayout={() => cacheBlockLayout(i)}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                {activeHq ? (
                  <Text selectable style={[styles.item, { color: tokens.t2, paddingLeft: 6 + b.level * 14, fontSize: fs(13) }]}>
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
                  <Text selectable style={[styles.item, { color: tokens.t2, paddingLeft: 6 + b.level * 14, fontSize: fs(13) }]}>
                    <Text style={{ color: tokens.t1, fontWeight: '600' }}>{labelText}{' '}</Text>
                    {linkify(b.body)}
                  </Text>
                )}
              </Pressable>
            )
          }
          default:
            return (
              <Pressable
                key={i}
                ref={(el) => {
                  blockNodeRefs.current[i] = el
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
                onLayout={() => cacheBlockLayout(i)}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                <Text selectable style={[styles.para, { color: tokens.t2, fontSize: fs(13.5) }]}>
                  {activeHq ? highlightSpans(b.text, activeHq, hOpts(base)) : linkify(b.text)}
                </Text>
              </Pressable>
            )
        }
      })}
    </View>
  )
})

const styles = StyleSheet.create({
  tocCard: { borderRadius: 12, borderWidth: 1, marginTop: 4, marginBottom: 6, overflow: 'hidden' },
  tocHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 11 },
  tocHeadText: { fontSize: 13.5, fontWeight: '700', flex: 1 },
  tocCount: { fontSize: 12, fontWeight: '600' },
  tocList: { borderTopWidth: 1, paddingVertical: 4 },
  tocRow: { paddingHorizontal: 14, paddingVertical: 7 },
  tocEntry: { fontSize: 13, lineHeight: 18 },

  chapter: { fontSize: 14.5, fontWeight: '800', letterSpacing: 0.3, marginTop: 20, marginBottom: 8 },
  sectionLabel: { lineHeight: 20 },
  sectionBody: { fontSize: 13.5, lineHeight: 21, marginTop: 4 },
  item: { fontSize: 13, lineHeight: 20, marginTop: 8 },
  autoListRow: { flexDirection: 'row', marginTop: 6, paddingLeft: 4 },
  autoListNum: { fontWeight: '700', width: 22, lineHeight: 21 },
  autoListBody: { flex: 1, lineHeight: 21 },
  para: { fontSize: 13.5, lineHeight: 21, marginTop: 10 },
  highlight: { backgroundColor: 'rgba(255, 213, 0, 0.45)', borderRadius: 2 },
  // Current match — brighter/solid orange so it stands out from the other matches.
  highlightActive: { backgroundColor: 'rgba(255, 138, 0, 0.95)', color: '#1a1400', borderRadius: 2 },
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
