import React, { createContext, useContext, useState } from 'react'
import { useColorScheme } from 'react-native'

export type ThemeMode = 'dark' | 'light' | 'auto'
export type ResolvedTheme = 'dark' | 'light'

export interface ThemeTokens {
  bg: string
  bg2: string
  bg3: string
  bg4: string
  inp: string
  t1: string
  t2: string
  t3: string
  t4: string
  blu: string
  bdim: string
  bbdr: string
  blt: string
  grn: string
  gdim: string
  gbdr: string
  amb: string
  adim: string
  abdr: string
  red: string
  gold: string
  goldlt: string
  goldbdr: string
  /** Brushed-silver accent, used for the DailyReg card's shimmer border and
   * translucent fill. Same lt/bdr triplet shape as gold above. `slvhi` and
   * `slvlo` are the two ends of the metallic sweep -- a gradient between
   * them is what reads as "shimmer" rather than a flat grey outline. */
  slv: string
  slvlt: string
  slvbdr: string
  slvhi: string
  slvlo: string
  bdr: string
  bdr2: string
}

export const darkTokens: ThemeTokens = {
  bg: '#07111E',
  bg2: '#0C1826',
  bg3: '#132030',
  bg4: '#1A2C42',
  inp: '#08121F',
  t1: '#EDF2FF',
  t2: '#9DB7CE',
  t3: '#7A9AB8',
  t4: '#537A99',
  blu: '#4B8EF5',
  bdim: 'rgba(75,142,245,0.12)',
  bbdr: 'rgba(75,142,245,0.28)',
  blt: '#93C5FD',
  grn: '#34D399',
  gdim: 'rgba(52,211,153,0.10)',
  gbdr: 'rgba(52,211,153,0.24)',
  amb: '#F59E0B',
  adim: 'rgba(245,158,11,0.12)',
  abdr: 'rgba(245,158,11,0.28)',
  // RC: "the red and orange are a bit too close in color/hue/contrast...
  // let's find a diff shade for the red to help it stand out better." The
  // old #F87171 (a light, fairly desaturated coral, L~71%) sat close in
  // visual weight to amb's punchier L~50% -- same lightness band as amber
  // now (a true, more saturated red instead of pastel coral), so hue does
  // the distinguishing instead of leaning on a lightness gap that shrank
  // at small sizes (the row status rings, badge text).
  red: '#EF4444',
  gold: '#C6A224',
  goldlt: 'rgba(198,162,36,0.12)',
  goldbdr: 'rgba(198,162,36,0.30)',
  slv: '#C7D0DC',
  // RC, 2026-08-05: "the DR box needs a slight translucency fill inside...
  // VERY subtle, opacity set to, start with 10%." Flat 10% alpha on the
  // silver base color, no separate lt/dark tuning like the other tokens
  // have -- deliberately a starting point RC expects to adjust in-app.
  slvlt: 'rgba(199,208,220,0.10)',
  slvbdr: 'rgba(199,208,220,0.35)',
  slvhi: '#F0F4F8',
  slvlo: '#8B96A6',
  bdr: 'rgba(255,255,255,0.07)',
  bdr2: 'rgba(255,255,255,0.14)',
}

export const lightTokens: ThemeTokens = {
  bg: '#E6EDF8',
  bg2: '#FFFFFF',
  bg3: '#CDD9EE',
  bg4: '#B8CADF',
  inp: '#FFFFFF',
  t1: '#050E1F',
  t2: '#14305A',
  t3: '#3A5E8A',
  t4: '#7A9AB8',
  blu: '#1A50CC',
  bdim: 'rgba(26,80,204,0.10)',
  bbdr: 'rgba(26,80,204,0.30)',
  blt: '#1A50CC',
  grn: '#0A7A50',
  gdim: 'rgba(10,122,80,0.10)',
  gbdr: 'rgba(10,122,80,0.26)',
  amb: '#F59E0B',
  adim: 'rgba(180,110,0,0.12)',
  abdr: 'rgba(180,110,0,0.32)',
  red: '#EF4444',
  gold: '#A87C00',
  goldlt: 'rgba(168,124,0,0.12)',
  goldbdr: 'rgba(168,124,0,0.32)',
  slv: '#6B7684',
  slvlt: 'rgba(107,118,132,0.10)',
  slvbdr: 'rgba(107,118,132,0.35)',
  slvhi: '#B8C2CE',
  slvlo: '#4A5563',
  bdr: 'rgba(0,0,0,0.11)',
  bdr2: 'rgba(0,0,0,0.20)',
}

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  tokens: ThemeTokens
  setMode: (m: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme() ?? 'dark'
  const [mode, setMode] = useState<ThemeMode>('dark')

  const resolved: ResolvedTheme =
    mode === 'auto' ? (systemScheme as ResolvedTheme) : mode

  const tokens = resolved === 'dark' ? darkTokens : lightTokens

  return (
    <ThemeContext.Provider value={{ mode, resolved, tokens, setMode }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider')
  return ctx
}
