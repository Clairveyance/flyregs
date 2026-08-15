import { useState, useRef, useCallback, useEffect, RefObject } from 'react'
import { Keyboard } from 'react-native'

export interface InDocSearchTarget {
  scrollToMatch: (idx: number) => void
}

// Shared state/handlers behind every "IN DOC" search box -- originally
// duplicated inline in ac/[id].tsx; extracted so FAR/AIM/PCG/AD/LOI can each
// wire this up in a few lines instead of re-deriving the debounce/prev-next/
// auto-scroll-to-first-match logic per screen.
export function useInDocSearch(bodyRef: RefObject<InDocSearchTarget | null>) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [matchIdx, setMatchIdx] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onQueryChange = useCallback((text: string) => {
    setQuery(text)
    setMatchIdx(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebounced(text.trim()), 300)
  }, [])

  const onClear = useCallback(() => {
    setQuery('')
    setDebounced('')
    setMatchCount(0)
    setMatchIdx(0)
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  // Keyboard.dismiss() before jumping -- ac/[id].tsx's own original (pre-
  // extraction) version of this hook had this; it got dropped when this
  // logic was pulled out into a shared hook for FAR/AIM/PCG/AD/LOI, a real
  // regression RC caught live ("tap to dismiss stopped working... when
  // using indoc search"). Without it, a "centered" match can land behind
  // the still-open keyboard, which covers the bottom of the screen while
  // the search TextInput still has focus.
  const goToPrev = useCallback(() => {
    if (matchCount === 0) return
    Keyboard.dismiss()
    const next = (matchIdx - 1 + matchCount) % matchCount
    setMatchIdx(next)
    setTimeout(() => bodyRef.current?.scrollToMatch(next), 50)
  }, [matchIdx, matchCount, bodyRef])

  const goToNext = useCallback(() => {
    if (matchCount === 0) return
    Keyboard.dismiss()
    const next = (matchIdx + 1) % matchCount
    setMatchIdx(next)
    setTimeout(() => bodyRef.current?.scrollToMatch(next), 50)
  }, [matchIdx, matchCount, bodyRef])

  // Auto-jump to the first match as soon as a fresh query resolves, so
  // results are visible immediately instead of just the counter -- same
  // pattern ac/[id].tsx already uses. Keyed on matchCount (not matchIdx),
  // so navigating prev/next doesn't re-trigger this.
  useEffect(() => {
    if (matchCount === 0) return
    const t = setTimeout(() => bodyRef.current?.scrollToMatch(0), 200)
    return () => clearTimeout(t)
  }, [matchCount, bodyRef])

  return { query, debounced, matchCount, setMatchCount, matchIdx, onQueryChange, onClear, goToPrev, goToNext }
}
