import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { BADGE_LIFESPAN_KEY, DEFAULT_BADGE_LIFESPAN_DAYS, BADGE_LIFESPAN_OPTIONS } from '@/lib/badgeLifespan'

// Shared, LIVE badge-lifespan state — every screen that shows a NEW/UPD badge
// or the Home "What's New" feed reads from this context instead of each
// independently reading AsyncStorage on its own mount. This matters because
// the Drawer (where the setting is changed) is a persistent overlay rendered
// in the root layout, not a separate navigable screen (see components/Drawer.tsx)
// — closing it never fires a focus/mount event on the screen underneath, so a
// per-screen "read once on mount" effect would silently never see a change
// made while that screen stayed mounted the whole time. A shared context
// re-renders every subscriber immediately when the Drawer calls setBadgeDays.

interface BadgeLifespanContextType {
  badgeDays: number
  setBadgeDays: (days: number) => void
}

const BadgeLifespanContext = createContext<BadgeLifespanContextType>({
  badgeDays: DEFAULT_BADGE_LIFESPAN_DAYS,
  setBadgeDays: () => {},
})

export function BadgeLifespanProvider({ children }: { children: ReactNode }) {
  const [badgeDays, setBadgeDaysState] = useState(DEFAULT_BADGE_LIFESPAN_DAYS)

  useEffect(() => {
    AsyncStorage.getItem(BADGE_LIFESPAN_KEY).then((v) => {
      const n = v ? Number(v) : NaN
      if (!Number.isFinite(n) || n <= 0) return
      if (BADGE_LIFESPAN_OPTIONS.includes(n)) {
        setBadgeDaysState(n)
        return
      }
      // A previously-valid option (e.g. the old "7d") is no longer offered --
      // migrate to the closest current option rather than silently keeping
      // an orphaned value the picker can't even show as selected.
      const closest = BADGE_LIFESPAN_OPTIONS.reduce((best, opt) =>
        Math.abs(opt - n) < Math.abs(best - n) ? opt : best
      )
      setBadgeDaysState(closest)
      AsyncStorage.setItem(BADGE_LIFESPAN_KEY, String(closest))
    })
  }, [])

  const setBadgeDays = (days: number) => {
    setBadgeDaysState(days)
    AsyncStorage.setItem(BADGE_LIFESPAN_KEY, String(days))
  }

  return (
    <BadgeLifespanContext.Provider value={{ badgeDays, setBadgeDays }}>
      {children}
    </BadgeLifespanContext.Provider>
  )
}

export function useBadgeLifespan() {
  return useContext(BadgeLifespanContext)
}
