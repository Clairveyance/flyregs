import React, { createContext, useContext, useEffect, useState } from 'react'
import { useColorScheme } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { setSyncedSetting, onSettingPulled, type SyncedSettingKey } from '@/lib/appSettings'

const REDSHIFT_KEY = '@flyregs/redshift'
const MODE_KEY = '@flyregs/thememode'

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

// Real red-shift (night-vision-preserving) lighting: rod cells that drive
// dark adaptation are insensitive to red but very sensitive to blue/green,
// so ANY blue/green content in emitted light ruins night vision. Every
// token here is R-dominant with G/B pushed near zero -- semantic colors
// that normally differ by HUE (blu/grn/amb/red) are differentiated by
// luminance and saturation instead, since hue is no longer available.
// RC-approved direction: real per-component rebuild, not a screen tint --
// this object is the whole point. First-pass values, expect tuning once
// RC sees it live, same as every other color choice this session.
export const redshiftTokens: ThemeTokens = {
  bg: '#0F0503',
  bg2: '#190805',
  bg3: '#241009',
  bg4: '#31160C',
  inp: '#140603',
  t1: '#FF6A4D',
  t2: '#D6553A',
  t3: '#A3402A',
  t4: '#6E2D1D',
  // Ordered least-to-most "attention" the same way the four semantic
  // colors are normally read (grn=calm < blu=neutral/interactive <
  // amb=caution < red=alarm), via brightness/saturation instead of hue.
  //
  // RC, 2026-08-13, real device: the "I Understand" primary-action button
  // (this color) read as too close to the overdue/danger red -- confirmed
  // why: blu/amb/red all sat at nearly the SAME lightness (53-54%), so grn
  // was the only color actually separated by lightness (35%) the way this
  // comment's own rule intends; blu and red could only be told apart by a
  // 26-point saturation gap at otherwise-identical brightness, too subtle
  // in the low-light conditions Red Shift exists for. Fixed the same way
  // this file's own rule already works for grn -- moved blu's lightness to
  // sit evenly BETWEEN grn (35%) and amb/red's shared 53-54% plateau,
  // rather than sharing it. Hue is untouched (13->14 is rounding noise,
  // not a deliberate shift) -- this stays a brightness/saturation fix, per
  // the rule above, not a hue one.
  blu: '#BC4824',
  bdim: 'rgba(188,72,36,0.12)',
  bbdr: 'rgba(188,72,36,0.30)',
  blt: '#E06B3F',
  grn: '#8A4028',
  gdim: 'rgba(138,64,40,0.10)',
  gbdr: 'rgba(138,64,40,0.26)',
  amb: '#F2701A',
  adim: 'rgba(242,112,26,0.12)',
  abdr: 'rgba(242,112,26,0.30)',
  red: '#FF2D12',
  // Premium accent stays the brightest/most saturated tone overall so
  // badges still pop; still fully within the red-orange band.
  gold: '#FF9A2E',
  goldlt: 'rgba(255,154,46,0.12)',
  goldbdr: 'rgba(255,154,46,0.32)',
  // "Silver" is normally neutral grey (R=G=B), which isn't red-safe --
  // desaturated warm rust reads as "the neutral/metallic one" relative to
  // the saturated accents without reintroducing green/blue.
  slv: '#8F6252',
  slvlt: 'rgba(143,98,82,0.10)',
  slvbdr: 'rgba(143,98,82,0.35)',
  slvhi: '#C4906F',
  slvlo: '#5C3A2E',
  bdr: 'rgba(255,80,50,0.08)',
  bdr2: 'rgba(255,80,50,0.16)',
}

interface ThemeContextValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  tokens: ThemeTokens
  setMode: (m: ThemeMode) => void
  redShift: boolean
  setRedShift: (v: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme() ?? 'dark'
  const [mode, setModeState] = useState<ThemeMode>('dark')
  const [redShift, setRedShiftState] = useState(false)

  useEffect(() => {
    AsyncStorage.getItem(REDSHIFT_KEY).then((raw) => {
      if (raw === '1') setRedShiftState(true)
    })
    // Appearance (Dark/Light/Auto) had no persistence at all -- unlike
    // redShift just above, setMode never wrote to AsyncStorage, so picking
    // Light or Auto in the drawer silently reverted to Dark on every app
    // restart. Confirmed live 2026-08-13: selected Light, reloaded, back to
    // Dark. Same key-per-setting pattern as REDSHIFT_KEY.
    AsyncStorage.getItem(MODE_KEY).then((raw) => {
      if (raw === 'dark' || raw === 'light' || raw === 'auto') setModeState(raw)
    })
  }, [])

  // A setting pulled from the user's other device has to take effect NOW.
  // Both values above are read from storage once, at mount; without this a
  // theme changed on the iPad would sit in this device's storage looking
  // ignored until the app was restarted, which reads as sync not working.
  useEffect(() => onSettingPulled((key, value) => {
    if (key === MODE_KEY && (value === 'dark' || value === 'light' || value === 'auto')) {
      setModeState(value)
    }
    if (key === REDSHIFT_KEY) setRedShiftState(value === '1')
  }), [])

  const resolved: ResolvedTheme =
    mode === 'auto' ? (systemScheme as ResolvedTheme) : mode

  const tokens = redShift ? redshiftTokens : resolved === 'dark' ? darkTokens : lightTokens

  const setMode = (m: ThemeMode) => {
    setModeState(m)
    setSyncedSetting(MODE_KEY as SyncedSettingKey, m)
  }

  // RC: "anytime it gets toggled ON/OFF, the default mode w/o it is Dark" --
  // normalize mode on both transitions, not just when turning on. Goes
  // through setMode (not setModeState) so this normalization persists too --
  // otherwise turning Red Shift on/off while on Light would flip the
  // *displayed* mode to Dark without saving it, so the very next reload
  // would silently pop back to whatever Light/Auto was last actually saved.
  const setRedShift = (v: boolean) => {
    setRedShiftState(v)
    setMode('dark')
    setSyncedSetting(REDSHIFT_KEY as SyncedSettingKey, v ? '1' : '0')
  }

  return (
    <ThemeContext.Provider value={{ mode, resolved, tokens, setMode, redShift, setRedShift }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be inside ThemeProvider')
  return ctx
}
