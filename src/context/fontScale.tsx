import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'

const SCALE_KEY = '@flyregs/font-scale'

export const FONT_SCALE_MIN = 0.85
export const FONT_SCALE_MAX = 1.4

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
