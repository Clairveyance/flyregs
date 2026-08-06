import { useEffect, useRef, useState } from 'react'
import { View, StyleSheet, Platform } from 'react-native'
import { GestureDetector, Gesture } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useTheme } from '@/context/theme'

// iPad-landscape master-detail split: a resizable rail on the left, a
// draggable divider, and a detail pane filling the rest. RC: "that center
// vertical line splitting the screen should be adjustable, to make either
// side bigger/smaller." Same Gesture.Pan()/runOnJS pattern already proven
// live in FolderListView's drag-to-reorder handle -- not a new mechanism.
//
// Deliberately NOT used on phone or portrait tablet -- callers decide when
// to render this at all (see useIsTabletLandscape in context/responsive.tsx)
// rather than this component guessing from its own width, since a caller
// may want the split only past a wider breakpoint than TABLET_BREAKPOINT.
const MIN_RAIL = 240
const MAX_RAIL = 520
const HANDLE_HIT_WIDTH = 14

interface SplitPaneProps {
  /** Persists the chosen rail width across sessions, keyed per screen
   * (e.g. "far", "home") so resizing one split doesn't affect another. */
  storageKey: string
  defaultRailWidth?: number
  rail: React.ReactNode
  detail: React.ReactNode
}

export function SplitPane({ storageKey, defaultRailWidth = 320, rail, detail }: SplitPaneProps) {
  const { tokens } = useTheme()
  const persistKey = `splitpane_rail_width:${storageKey}`
  const [railWidth, setRailWidth] = useState(defaultRailWidth)
  // Read on mount only, not re-applied if defaultRailWidth changes later --
  // a persisted user choice should always win over a new default.
  const startWidth = useRef(defaultRailWidth)
  const loadedRef = useRef(false)
  // Gesture.Pan() is rebuilt every render, but the ACTIVE gesture instance
  // for an in-flight drag keeps whichever JS closures were bound when it
  // started -- confirmed live: onFinalize's handler kept persisting the
  // PRE-drag railWidth, since its closure over the `railWidth` state
  // variable never saw the onUpdate-driven re-renders that happened after
  // the gesture began. A ref sidesteps this entirely: reading `.current`
  // always returns the truly-latest value regardless of which render's
  // closure is doing the reading, since the ref object itself (not its
  // contents) is what got captured.
  const latestWidth = useRef(defaultRailWidth)

  useEffect(() => {
    AsyncStorage.getItem(persistKey).then((v) => {
      const n = v ? parseInt(v, 10) : NaN
      if (!isNaN(n) && n >= MIN_RAIL && n <= MAX_RAIL) {
        setRailWidth(n)
        startWidth.current = n
        latestWidth.current = n
      }
      loadedRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey])

  const handleDragStart = () => {
    startWidth.current = railWidth
  }
  const handleDragUpdate = (translationX: number) => {
    const next = Math.min(MAX_RAIL, Math.max(MIN_RAIL, startWidth.current + translationX))
    latestWidth.current = next
    setRailWidth(next)
  }
  const handleDragEnd = () => {
    AsyncStorage.setItem(persistKey, String(Math.round(latestWidth.current)))
  }

  const panGesture = Gesture.Pan()
    .onStart(() => {
      runOnJS(handleDragStart)()
    })
    .onUpdate((e) => {
      runOnJS(handleDragUpdate)(e.translationX)
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
    <View style={styles.row}>
      <View style={{ width: railWidth }}>{rail}</View>
      <GestureDetector gesture={panGesture}>
        <View style={styles.handleHit}>
          <View style={[styles.handleLine, { backgroundColor: tokens.bdr2 }]} />
        </View>
      </GestureDetector>
      <View style={styles.detail}>{detail}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  handleHit: {
    width: HANDLE_HIT_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'col-resize' as any } : null),
  },
  handleLine: { width: 1, height: '100%' },
  detail: { flex: 1, minWidth: 0 },
})
