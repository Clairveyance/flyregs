import React, { createContext, useContext, useState, useCallback } from 'react'
import { router } from 'expo-router'

interface DrawerContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
}

const DrawerContext = createContext<DrawerContextValue | null>(null)

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <DrawerContext.Provider
      value={{
        isOpen,
        open: () => setIsOpen(true),
        close: () => setIsOpen(false),
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
