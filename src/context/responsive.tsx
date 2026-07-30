import { createContext, useContext, useEffect, useState } from 'react'
import { useWindowDimensions } from 'react-native'

// iPad's smallest real width in portrait is 744pt (iPad mini) -- 768 is the
// classic Expo/RN breakpoint convention and sits safely below that with
// margin for split-screen multitasking (where an iPad app can be resized
// down to roughly half its full width). Phones never reach this width even
// at their largest (iPhone 16 Pro Max is 430pt), so there's no ambiguity
// between "big phone" and "small tablet" to worry about.
const TABLET_BREAKPOINT = 768

interface ResponsiveContextValue {
  width: number
  height: number
  isTablet: boolean
  // Content max-width for centered, readable columns on a tablet-wide
  // screen -- unconstrained text at full iPad width reads as a stretched
  // phone screen, which is exactly the "scaled iPhone view" problem this
  // is meant to fix. 700 keeps body text at a comfortable line length
  // (roughly matching a phone's own reading width) while leaving real
  // breathing room in the surrounding chrome, rather than filling the
  // full 1024pt+ canvas edge-to-edge.
  contentMaxWidth: number
}

const ResponsiveContext = createContext<ResponsiveContextValue>({
  width: 0, height: 0, isTablet: false, contentMaxWidth: 700,
})

export function ResponsiveProvider({ children }: { children: React.ReactNode }) {
  const { width, height } = useWindowDimensions()
  const [value, setValue] = useState<ResponsiveContextValue>({
    width, height, isTablet: width >= TABLET_BREAKPOINT, contentMaxWidth: 700,
  })

  useEffect(() => {
    setValue({ width, height, isTablet: width >= TABLET_BREAKPOINT, contentMaxWidth: 700 })
  }, [width, height])

  return <ResponsiveContext.Provider value={value}>{children}</ResponsiveContext.Provider>
}

export function useResponsive() {
  return useContext(ResponsiveContext)
}

// Convenience for the common case (most call sites only need the boolean).
export function useIsTablet(): boolean {
  return useContext(ResponsiveContext).isTablet
}
