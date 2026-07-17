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
  red: '#F87171',
  gold: '#C6A224',
  goldlt: 'rgba(198,162,36,0.12)',
  goldbdr: 'rgba(198,162,36,0.30)',
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
  red: '#F87171',
  gold: '#A87C00',
  goldlt: 'rgba(168,124,0,0.12)',
  goldbdr: 'rgba(168,124,0,0.32)',
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
