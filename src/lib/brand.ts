import { Platform } from 'react-native'

// Native loads the font via @expo-google-fonts/montserrat (family name
// "Montserrat_400Regular"); web loads it via a Google Fonts CSS @import in
// global.css under the plain family name "Montserrat" + fontWeight. Regular
// weight matches the actual logo artwork's stroke thickness — Medium/SemiBold
// both read visibly heavier when checked side by side against the source art.
export const WORDMARK_FONT = Platform.select({ web: 'Montserrat', default: 'Montserrat_400Regular' })

// Sampled from the wordmark artwork's own gradient (flyregs-wordmark.png) so
// text rendered as the "FlyRegs" word matches the logo's actual gold rather
// than the app's flatter `tokens.gold` accent color. Dark mode uses the
// lighter/warmer end of that gradient; light mode needs the darker end for
// contrast against a pale background — the lighter value reads as washed-out
// gold-on-white.
export const WORDMARK_GOLD_DARK = '#E4C775'
export const WORDMARK_GOLD_LIGHT = '#8F6A2E'

export function wordmarkGoldFor(resolved: 'dark' | 'light'): string {
  return resolved === 'dark' ? WORDMARK_GOLD_DARK : WORDMARK_GOLD_LIGHT
}
