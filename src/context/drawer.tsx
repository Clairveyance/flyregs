import React, { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { router } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'

// RC, iPad: "there's plenty of room for Account to open fully to the right
// of the burger... make use of this ipad space." iPad-only: the drawer
// (Drawer.tsx) stays open and offset-aware screens (RAIL_AWARE_PATHS below)
// render beside it as a resizable next pane instead of the drawer closing
// and the screen taking over edge-to-edge. railWidth is the drawer panel's
// width, draggable on tablet via a handle on its trailing edge, persisted
// like SplitPane's own rail widths.
const RAIL_WIDTH_KEY = '@flyregs/drawer-rail-width'
export const DRAWER_WIDTH_DEFAULT = 284
export const DRAWER_WIDTH_MIN = 240
export const DRAWER_WIDTH_MAX = 420

interface DrawerContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  railWidth: number
  setRailWidth: (w: number) => void
}

const DrawerContext = createContext<DrawerContextValue | null>(null)

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [railWidth, setRailWidthState] = useState(DRAWER_WIDTH_DEFAULT)

  useEffect(() => {
    AsyncStorage.getItem(RAIL_WIDTH_KEY).then((raw) => {
      const n = Number(raw)
      if (!isNaN(n) && n >= DRAWER_WIDTH_MIN && n <= DRAWER_WIDTH_MAX) {
        setRailWidthState(n)
      }
    })
  }, [])

  const setRailWidth = useCallback((w: number) => {
    const clamped = Math.max(DRAWER_WIDTH_MIN, Math.min(DRAWER_WIDTH_MAX, w))
    setRailWidthState(clamped)
    AsyncStorage.setItem(RAIL_WIDTH_KEY, String(clamped))
  }, [])

  return (
    <DrawerContext.Provider
      value={{
        isOpen,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
        railWidth,
        setRailWidth,
      }}
    >
      {children}
    </DrawerContext.Provider>
  )
}

export function useDrawer() {
  const ctx = useContext(DrawerContext)
  if (!ctx) throw new Error('useDrawer must be inside DrawerProvider')
  return ctx
}

/**
 * Back handler for screens opened *from* the drawer. Pops the screen and
 * re-opens the drawer so the user lands back on the burger menu, not the
 * screen behind it. The drawer is a root-level overlay, so opening it after
 * the pop keeps it visible over whatever screen was underneath.
 */
export function useReturnToMenu() {
  const { open } = useDrawer()
  return useCallback(() => {
    router.back()
    open()
  }, [open])
}

/**
 * iPad only: screens that render beside the still-open drawer as a rail
 * pane (see Drawer.tsx's nav()) instead of taking over edge-to-edge. Read
 * this list from account.tsx too when deciding whether to apply railInset.
 */
export const RAIL_AWARE_PATHS = ['/account']

/** The left inset a rail-aware screen should apply to its own root
 * container so its content starts after the (still open) drawer panel
 * instead of rendering underneath it. 0 on phone or when the drawer isn't
 * relevant. */
export function useRailInset(isTablet: boolean): number {
  const { isOpen, railWidth } = useDrawer()
  return isTablet && isOpen ? railWidth : 0
}
