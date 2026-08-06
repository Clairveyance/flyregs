import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useFocusEffect } from 'expo-router'

// RC, iPad, five annotated screenshots (search Cancel, Home's filter icon,
// AC detail's overflow menu + bookmark, Notes' Select/+New, Notes editor's
// Back/Folder/Share/Delete/Done): "all things like this need to find their
// way to the bottom of the screen." A screen registers its own header-style
// action buttons here instead of rendering them in its own header;
// PersistentTabBar renders whatever's currently registered in a dedicated
// cluster. iPad-only consumption (see PersistentTabBar) -- phone keeps its
// existing per-screen headers exactly as they are, there's no spare room
// down there for a phone to also carry this.
export interface ScreenAction {
  key: string
  /** SF Symbol name -- renders as an icon like the tab bar's own icons. */
  icon?: string
  /** Plain text, for actions that were a text link/button (Cancel, Select,
   * +New, Done, a "< Back" label) rather than an icon. */
  label?: string
  onPress: () => void
  /** primary = filled pill (matches a screen's own "+New"/"Done" style).
   * destructive = red (Delete). default = plain icon/text color. */
  variant?: 'default' | 'primary' | 'destructive'
  disabled?: boolean
}

interface ScreenActionsContextValue {
  actions: ScreenAction[]
  setActions: (actions: ScreenAction[]) => void
}

const ScreenActionsContext = createContext<ScreenActionsContextValue | null>(null)

export function ScreenActionsProvider({ children }: { children: React.ReactNode }) {
  const [actions, setActions] = useState<ScreenAction[]>([])
  return (
    <ScreenActionsContext.Provider value={{ actions, setActions }}>
      {children}
    </ScreenActionsContext.Provider>
  )
}

export function useScreenActionsContext() {
  const ctx = useContext(ScreenActionsContext)
  if (!ctx) throw new Error('useScreenActionsContext must be inside ScreenActionsProvider')
  return ctx
}

/**
 * Registers on focus, clears on blur -- a screen's actions must never leak
 * onto a DIFFERENT screen the instant you navigate away (Notes' own
 * Select/+New showing up over, say, the FAR reading screen).
 *
 * Every action's onPress is dispatched through a ref that's updated on
 * EVERY render, regardless of `deps` -- so a caller never needs to (and
 * must not) put its own onPress functions in `deps` just to stay fresh.
 * Confirmed live as a real infinite-render-loop bug: an unmemoized onPress
 * (created fresh every render) in `deps` made the registration effect
 * refire every render, which called setActions, which re-rendered the
 * screen, which recreated the same unmemoized function, forever. `deps`
 * should only ever hold PRIMITIVES that describe when the action SET
 * itself meaningfully changes shape (e.g. AC's bookmarked boolean, so the
 * icon swaps bookmark/bookmark.fill) -- never a function reference.
 */
export function useScreenActions(actions: ScreenAction[], deps: React.DependencyList) {
  const { setActions } = useScreenActionsContext()
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  useFocusEffect(
    useCallback(() => {
      const stable = actionsRef.current.map((_, i) => ({
        ...actionsRef.current[i],
        onPress: () => actionsRef.current[i]?.onPress(),
      }))
      setActions(stable)
      return () => setActions([])
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
  )
}
