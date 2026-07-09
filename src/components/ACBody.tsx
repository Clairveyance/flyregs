import React, { useMemo, useRef, useState, useEffect, useImperativeHandle, RefObject } from 'react'
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
  Platform,
} from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'
import { parseAC, cleanGlyphs, blockText, ACBlock } from '@/lib/acFormat'

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
  opts?: { base?: number; active?: number }
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
    result.push(
      <Text key={start} style={isActive ? styles.highlightActive : styles.highlight}>
        {text.slice(start, end)}
      </Text>
    )
    occ++
    pos = end
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
  }
>(function ACBody({ text, blocks: precomputed, scrollRef, highlightQuery, onMatchCount, activeMatch = -1, bodyLimit, changedIndices, highlightedBlockTexts, onToggleHighlight }, ref) {
  const changedSet = useMemo(() => new Set(changedIndices ?? []), [changedIndices])
  const { tokens } = useTheme()
  const fs = useFS()

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

  const [showToc, setShowToc] = useState(false)
  const headingRefs = useRef<Record<string, View | null>>({})
  const matchRefs = useRef<Record<number, View | null>>({})
  // Populated for any block a caller might need to imperatively scroll to
  // later (changed-in-revision blocks AND saved highlights) — see
  // scrollToBlockIndex above.
  const jumpRefs = useRef<Record<number, View | null>>({})

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

      // Native: scroll to the block containing the nth occurrence; the brighter
      // active highlight shows which occurrence within the block is current.
      const blockIndex = occurrences[n]
      if (blockIndex == null) return
      const node = matchRefs.current[blockIndex]
      if (!node) return
      const scroller = scrollRef?.current
      if (!scroller) return
      node.measureLayout(
        scroller as any,
        (_x, y) => scroller.scrollTo({ y: Math.max(0, y - 80), animated: true }),
        () => {}
      )
    },
    scrollToBlockIndex(blockIndex: number) {
      const node = jumpRefs.current[blockIndex]
      if (!node) return
      if (Platform.OS === 'web') {
        const el = node as unknown as HTMLElement
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
        return
      }
      const scroller = scrollRef?.current
      if (!scroller) return
      node.measureLayout(
        scroller as any,
        (_x, y) => scroller.scrollTo({ y: Math.max(0, y - 80), animated: true }),
        () => {}
      )
    },
  }), [occurrences, scrollRef, hq])

  const jumpTo = (id: string) => {
    const scroller = scrollRef?.current
    if (!scroller) return
    setShowToc(false)

    setTimeout(() => {
      const node = headingRefs.current[id]
      if (!node) return

      if (Platform.OS === 'web') {
        const el = node as unknown as HTMLElement
        el?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
        return
      }

      node.measureLayout(
        scroller as any,
        (_x, y) => scroller.scrollTo({ y: Math.max(0, y - 10), animated: true }),
        () => {}
      )
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
            <Text style={[styles.tocCount, { color: tokens.t3 }]}>{toc.length}</Text>
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
        const hOpts = (segBase: number) => ({ base: segBase, active: activeMatch })
        switch (b.kind) {
          case 'chapter':
            return (
              <View
                key={i}
                ref={(el) => {
                  headingRefs.current[b.id] = el
                  if (isMatch) matchRefs.current[i] = el
                  if (isChanged) jumpRefs.current[i] = el
                  if (isHighlighted) jumpRefs.current[i] = el
                }}
                style={changedStyle}
              >
                {UpdatedTag}
                <Text style={[styles.chapter, { color: tokens.t1, fontSize: fs(14.5) }]}>
                  {activeHq ? highlightSpans(b.text, activeHq, hOpts(base)) : b.text}
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
            return (
              <Pressable
                key={i}
                ref={(el) => {
                  headingRefs.current[b.id] = el as any
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
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
                  <Text selectable style={[styles.sectionBody, { color: tokens.t2, fontSize: fs(13.5) }]}>
                    {activeHq ? highlightSpans(rawBody, activeHq, hOpts(bodyBase)) : rawBody}
                  </Text>
                ) : null}
              </Pressable>
            )
          }
          case 'item': {
            const labelText = `${b.label}${b.title ? ` ${b.title}` : ''}`
            const bodyBase = base + (phrase ? countOcc(labelText, phrase) : 0)
            return (
              <Pressable
                key={i}
                ref={(el) => {
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                <Text selectable style={[styles.item, { color: tokens.t2, paddingLeft: 6 + b.level * 14, fontSize: fs(13) }]}>
                  <Text style={{ color: tokens.t1, fontWeight: '600' }}>
                    {activeHq ? highlightSpans(labelText, activeHq, hOpts(base)) : labelText}{' '}
                  </Text>
                  {activeHq ? highlightSpans(b.body, activeHq, hOpts(bodyBase)) : b.body}
                </Text>
              </Pressable>
            )
          }
          default:
            return (
              <Pressable
                key={i}
                ref={(el) => {
                  if (isMatch) matchRefs.current[i] = el as any
                  if (isChanged) jumpRefs.current[i] = el as any
                  if (isHighlighted) jumpRefs.current[i] = el as any
                }}
                onLongPress={longPress}
                delayLongPress={450}
                style={[changedStyle, highlightStyle]}
              >
                {UpdatedTag}
                {HighlightTag}
                <Text selectable style={[styles.para, { color: tokens.t2, fontSize: fs(13.5) }]}>
                  {activeHq ? highlightSpans(b.text, activeHq, hOpts(base)) : b.text}
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
