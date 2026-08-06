import { useEffect, useRef, useState } from 'react'
import { View, StyleSheet, Platform } from 'react-native'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTheme } from '@/context/theme'

// Master-detail split: a resizable rail (left on landscape, top on
// portrait) with a draggable divider, and a detail pane filling the rest.
// RC: "that center vertical line splitting the screen should be
// adjustable" (landscape), then separately: portrait needs the same
// adjustable-divider feel but split top/bottom instead of left/right, since
// portrait's 768pt width doesn't have room for a side rail without
// squeezing the reading column back to phone width. Same Gesture.Pan()/
// runOnJS pattern already proven live in FolderListView's drag-to-reorder
// handle, generalized over an axis instead of duplicated per orientation.
//
// Deliberately NOT used on phone -- callers decide when to render this at
// all (see useIsTabletLandscape/useIsTabletPortrait in context/responsive)
// rather than this component guessing from its own width.
const HANDLE_HIT_SIZE = 14

interface SplitPaneProps {
  /** Persists the chosen rail size across sessions, keyed per screen +
   * orientation (e.g. "far", "far-portrait") so resizing one split doesn't
   * affect another. */
  storageKey: string
  /** 'horizontal' = left rail / vertical divider (landscape). 'vertical' =
   * top rail / horizontal divider (portrait). Default 'horizontal' keeps
   * every existing landscape call site's behavior unchanged. */
  orientation?: 'horizontal' | 'vertical'
  defaultRailWidth?: number
  min?: number
  max?: number
  rail: React.ReactNode
  detail: React.ReactNode
}

export function SplitPane({
  storageKey,
  orientation = 'horizontal',
  defaultRailWidth,
  min,
  max,
  rail,
  detail,
}: SplitPaneProps) {
  const { tokens } = useTheme()
  const isVertical = orientation === 'vertical'
  const MIN = min ?? (isVertical ? 160 : 240)
  const MAX = max ?? (isVertical ? 520 : 520)
  const defaultSize = defaultRailWidth ?? (isVertical ? 280 : 320)

  // Key name kept as "rail_width" even for the vertical/portrait case --
  // renaming it would silently forget every already-persisted landscape
  // rail width on next load for no functional reason.
  const persistKey = `splitpane_rail_width:${storageKey}`
  const [railSize, setRailSize] = useState(defaultSize)
  // Read on mount only, not re-applied if defaultSize changes later -- a
  // persisted user choice should always win over a new default.
  const startSize = useRef(defaultSize)
  // Gesture.Pan() is rebuilt every render, but the ACTIVE gesture instance
  // for an in-flight drag keeps whichever JS closures were bound when it
  // started -- confirmed live: onFinalize's handler kept persisting the
  // PRE-drag size, since its closure over the `railSize` state variable
  // never saw the onUpdate-driven re-renders that happened after the
  // gesture began. A ref sidesteps this entirely: reading `.current`
  // always returns the truly-latest value regardless of which render's
  // closure is doing the reading, since the ref object itself (not its
  // contents) is what got captured.
  const latestSize = useRef(defaultSize)

  useEffect(() => {
    AsyncStorage.getItem(persistKey).then((v) => {
      const n = v ? parseInt(v, 10) : NaN
      if (!isNaN(n) && n >= MIN && n <= MAX) {
        setRailSize(n)
        startSize.current = n
        latestSize.current = n
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey])

  const handleDragStart = () => {
    startSize.current = railSize
  }
  const handleDragUpdate = (translation: number) => {
    const next = Math.min(MAX, Math.max(MIN, startSize.current + translation))
    latestSize.current = next
    setRailSize(next)
  }
  const handleDragEnd = () => {
    AsyncStorage.setItem(persistKey, String(Math.round(latestSize.current)))
  }

  const panGesture = Gesture.Pan()
    .onStart(() => {
      runOnJS(handleDragStart)()
    })
    .onUpdate((e) => {
      runOnJS(handleDragUpdate)(isVertical ? e.translationY : e.translationX)
    })
    // onFinalize (not onEnd) -- fires on a cancelled gesture too (e.g. the
    // pointer leaving the window mid-drag), not just a clean release.
    // Persisting on every finalize rather than only a clean end means a
    // resize never silently fails to save just because the drag ended
    // awkwardly.
    .onFinalize(() => {
      runOnJS(handleDragEnd)()
    })

  return (
    <View style={isVertical ? styles.column : styles.row}>
      <View style={isVertical ? { height: railSize } : { width: railSize }}>{rail}</View>
      <GestureDetector gesture={panGesture}>
        <View style={isVertical ? styles.handleHitH : styles.handleHitV}>
          <View
            style={[
              isVertical ? styles.handleLineH : styles.handleLineV,
              { backgroundColor: tokens.bdr2 },
            ]}
          />
        </View>
      </GestureDetector>
      <View style={styles.detail}>{detail}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  column: { flex: 1, flexDirection: 'column' },
  handleHitV: {
    width: HANDLE_HIT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'col-resize' as any } : null),
  },
  handleHitH: {
    height: HANDLE_HIT_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'row-resize' as any } : null),
  },
  handleLineV: { width: 1, height: '100%' },
  handleLineH: { height: 1, width: '100%' },
  detail: { flex: 1, minWidth: 0 },
})
