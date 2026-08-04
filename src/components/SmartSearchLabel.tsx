import { useState, useEffect } from 'react'
import { Text, StyleSheet, TextStyle } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// Mirrors MagicLinkPod's per-letter shimmer TECHNIQUE (hexToRgb/lerpColor
// sampling, incommensurate-sine phase drift, ~15fps tick) but tuned much
// more conservatively after real-device feedback. RC's first read on this:
// "SS needs to shimmer much slower and more subtly." The phase-drift speed
// below was originally bit-identical to MagicLinkPod's own -- copying the
// TECHNIQUE doesn't mean the same SPEED reads the same way on a different,
// cooler-hued word, so this round turns down three independent knobs
// instead of just one: the drift frequency itself (~4x slower), the
// spectrum's own lightness range (narrower, no pale outlier stop), and the
// per-letter phase SPREAD (halved, so adjacent letters look closer to each
// other at any instant instead of spanning the full band across an
// 11-letter word). Light mode still gets its own deeper stops rather than
// a paled-down copy of dark's, same reasoning as MagicLinkPod's own split.
const BLUE_SPECTRUM_DARK = ['#3E72DE', '#5C97F2', '#7CB0F5', '#5C97F2', '#3E72DE'] as const
const BLUE_SPECTRUM_LIGHT = ['#1A50CC', '#2A5BD1', '#3768D6', '#2A5BD1', '#1A50CC'] as const

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
      // ~4x slower than the first pass (0.6/0.37 -> 0.15/0.09) -- still
      // never repeats predictably, just takes much longer to.
      const wave = (Math.sin(t * 0.15) + Math.sin(t * 0.09 + 1.7) * 0.6) / 1.6 // ~[-1, 1]
      setShimmerPhase((wave + 1) / 2) // normalize to [0, 1]
      timer = setTimeout(tick, 66) // ~15fps -- smoothness, not speed
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
            // *0.5 halves the instantaneous spread across letters -- the
            // full spread (each letter sampling a very different point on
            // the spectrum at the same instant) was a real driver of "not
            // subtle enough" alongside the phase-drift speed itself.
            color: sampleBlueSpectrum(((i / (SMARTSEARCH_LETTERS.length - 1)) * 0.5 + shimmerPhase) % 1, spectrum),
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
