import { useState, useEffect } from 'react'
import { Text, StyleSheet, TextStyle } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// Mirrors MagicLinkPod's per-letter shimmer technique exactly (same
// hexToRgb/lerpColor sampling, same slow incommensurate-sine phase drift,
// same ~15fps tick) but tuned for SmartSearch specifically per RC: "Keep
// it in the blue hues but give it that slow creeping shimmer like ML. But
// keep a thin letter font, not thick like the ML font is... should be
// very subtle. should barely notice it moves. same way the ML word
// movement works." A tight blue hue band (not a wide sweep) is what keeps
// the drift reading as "barely notice it moves," same reasoning as
// MagicLinkPod's own narrow gold/champagne/amber/copper band. Light mode
// gets its own deeper, more saturated stops rather than a paled-down copy
// of dark's -- see MagicLinkPod's own comment on why that specific
// shortcut washes out against a light background.
const BLUE_SPECTRUM_DARK = ['#3B6FE0', '#4B8EF5', '#93C5FD', '#7C9EF0', '#3B6FE0'] as const
const BLUE_SPECTRUM_LIGHT = ['#1A50CC', '#123D9E', '#3768D6', '#2A4FB8', '#1A50CC'] as const

function blueSpectrumFor(isDark: boolean): readonly string[] {
  return isDark ? BLUE_SPECTRUM_DARK : BLUE_SPECTRUM_LIGHT
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bch = Math.round(ab + (bb - ab) * t)
  return `rgb(${r},${g},${bch})`
}

function sampleBlueSpectrum(t: number, spectrum: readonly string[]): string {
  const scaled = Math.min(t, 0.9999) * (spectrum.length - 1)
  const i = Math.floor(scaled)
  return lerpColor(spectrum[i], spectrum[i + 1], scaled - i)
}

const SMARTSEARCH_LETTERS = 'SmartSearch'.split('')

export function SmartSearchLabel({ fontSize = 12, style }: { fontSize?: number; style?: TextStyle }) {
  const { resolved } = useTheme()
  const fs = useFS()
  const spectrum = blueSpectrumFor(resolved === 'dark')
  const [shimmerPhase, setShimmerPhase] = useState(0)

  useEffect(() => {
    const start = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      const t = (Date.now() - start) / 1000
      const wave = (Math.sin(t * 0.6) + Math.sin(t * 0.37 + 1.7) * 0.6) / 1.6 // ~[-1, 1], never repeats predictably
      setShimmerPhase((wave + 1) / 2) // normalize to [0, 1]
      timer = setTimeout(tick, 66) // ~15fps, same as MagicLinkPod
    }
    tick()
    return () => clearTimeout(timer)
  }, [])

  return (
    <Text style={[styles.text, style]}>
      {SMARTSEARCH_LETTERS.map((ch, i) => (
        <Text
          key={i}
          style={{
            color: sampleBlueSpectrum((i / (SMARTSEARCH_LETTERS.length - 1) + shimmerPhase) % 1, spectrum),
            fontSize: ch === 'S' ? fs(fontSize + 2) : fs(fontSize),
          }}
        >
          {ch}
        </Text>
      ))}
    </Text>
  )
}

const styles = StyleSheet.create({
  // Thin, not ML's 800 -- RC was explicit this should read as a lighter
  // mark, not a second bold brand competing with MagicLink's own.
  text: { fontWeight: '300', letterSpacing: 0.2 },
})
