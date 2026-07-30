import React from 'react'
import { Text, StyleSheet } from 'react-native'

// Shared in-doc-search matching/highlighting logic -- originally built only
// for ACBody.tsx (AC's "IN DOC" search box). Extracted here so FAR/AIM/PCG/
// AD/LOI can get the identical feature via PlainTextBody instead of a second,
// slightly-different reimplementation. Behavior is unchanged from the
// original: multi-word queries match as a contiguous in-order phrase
// ("dynamic test" hits only "dynamic test", never a stray "dynamic" or
// "test" alone), outer double-quotes are stripped so a user can type "exact
// phrase" naturally, and matching is case/whitespace-tolerant.

export function searchPhrase(query: string): string {
  const t = query.trim()
  const unwrapped = t.startsWith('"') && t.endsWith('"') && t.length > 2 ? t.slice(1, -1) : t
  return unwrapped.replace(/\s+/g, ' ').toLowerCase()
}

// Counts non-overlapping occurrences of the phrase in text (for ordinal math
// across multiple paragraphs/blocks in the same document).
export function countOcc(text: string, phrase: string): number {
  if (!text || !phrase) return 0
  const lower = text.toLowerCase()
  let c = 0
  let pos = 0
  let idx = lower.indexOf(phrase, pos)
  while (idx !== -1) { c++; pos = idx + phrase.length; idx = lower.indexOf(phrase, pos) }
  return c
}

// Returns inline React nodes (string + highlighted <Text> spans) for
// placement directly inside a parent <Text> element. `opts.base` is the
// global ordinal of the first match in this text segment; the occurrence
// whose global ordinal equals `opts.active` renders in the brighter
// "current match" style so navigation is visible even when matches cluster
// together on one screen.
export function highlightSpans(
  text: string,
  query: string,
  opts?: { base?: number; active?: number; onOccRef?: (globalOrdinal: number, node: any) => void }
): React.ReactNode {
  const phrase = searchPhrase(query)
  if (phrase.length < 2 || !text) return text
  const lower = text.toLowerCase()

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
  let occ = 0
  for (const { start, end } of matches) {
    if (start > pos) result.push(text.slice(pos, start))
    const isActive = base + occ === active
    const globalOrdinal = base + occ
    result.push(
      React.createElement(Text, {
        key: start,
        ref: opts?.onOccRef ? ((node: any) => opts.onOccRef!(globalOrdinal, node)) : undefined,
        style: isActive ? searchHighlightStyles.highlightActive : searchHighlightStyles.highlight,
      }, text.slice(start, end))
    )
    occ++
    pos = end
  }
  if (pos < text.length) result.push(text.slice(pos))
  return React.createElement(React.Fragment, null, result)
}

export const searchHighlightStyles = StyleSheet.create({
  highlight: { backgroundColor: 'rgba(255, 213, 0, 0.45)', borderRadius: 2 },
  highlightActive: { backgroundColor: 'rgba(255, 138, 0, 0.95)', color: '#1a1400', borderRadius: 2 },
})
