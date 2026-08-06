import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

const SCALE_KEY = '@flyregs/font-scale'

// RC, real device: "it gets too small and not big enough" -- widened both
// ends. Floor raised slightly (0.85 -> 0.9) since the old minimum read as
// uncomfortably tiny rather than usefully compact; ceiling raised more
// (1.4 -> 1.75) since "not big enough" was specifically about the top end
// not giving real accessibility-scale headroom.
export const FONT_SCALE_MIN = 0.9
export const FONT_SCALE_MAX = 1.75

interface FontScaleContextType {
  fontScale: number
  setFontScale: (v: number) => void
}

const FontScaleContext = createContext<FontScaleContextType>({
  fontScale: 1.0,
  setFontScale: () => {},
})

export function FontScaleProvider({ children }: { children: ReactNode }) {
  const [fontScale, setFontScaleState] = useState<number>(1.0)

  useEffect(() => {
    AsyncStorage.getItem(SCALE_KEY).then((raw) => {
      const n = Number(raw)
      if (!isNaN(n) && n >= FONT_SCALE_MIN && n <= FONT_SCALE_MAX) {
        setFontScaleState(n)
      }
    })
  }, [])

  const setFontScale = (v: number) => {
    const clamped = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, v))
    setFontScaleState(clamped)
    AsyncStorage.setItem(SCALE_KEY, String(clamped))
  }

  return (
    <FontScaleContext.Provider value={{ fontScale, setFontScale }}>
      {children}
    </FontScaleContext.Provider>
  )
}

export function useFontScale() {
  return useContext(FontScaleContext)
}

/** Inline helper: scale a point size by the user's preference. */
export function useFS() {
  const { fontScale } = useFontScale()
  return (n: number) => Math.round(n * fontScale)
}

// RC, real device (iPad, web preview): tapping into a text field auto-
// zoomed the whole page. Root cause, confirmed corpus-wide: Mobile Safari
// (and any WebKit webview) auto-zooms on focus whenever the focused
// element's rendered font-size is under 16px -- and nearly every
// TextInput in this app renders at 13-15px through plain useFS(). Native
// iOS/Android have no such behavior, so this floor only applies on web.
//
// Use this ONLY for a TextInput's own fontSize, never for surrounding
// Text/labels -- flooring plain text to 16px everywhere would blow out
// the app's whole visual hierarchy just to work around a web-only quirk.
export function useInputFS() {
  const fs = useFS()
  return (n: number) => (Platform.OS === 'web' ? Math.max(fs(n), 16) : fs(n))
}
