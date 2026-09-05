import { View, Text, StyleSheet } from 'react-native'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// The little yellow "highlighted passage" chip that sits under a saved row.
//
// ONE definition. The exact same seven colour constants and the same chip
// markup were pasted into (tabs)/saved.tsx and folder/shared/[id].tsx, and
// folder/[id].tsx -- your OWN folders -- had no chip at all, so a highlight
// filed in a personal folder was indistinguishable from a plain bookmark of
// the same reg. That is the inconsistency this component closes, and keeping
// three copies is what let it open in the first place.
//
// RC, 2026-09-05 (about the shared-folder row): "This reg with some highlights
// when it shows up on the screen, it truncates the entire title of the reg so
// you don't really even know what it is beyond the number." The fix there was
// to render the title AND this chip rather than one or the other; this
// component exists so all three screens do that the same way.
const HIGHLIGHT_BG = 'rgba(255, 213, 0, 0.12)'
const HIGHLIGHT_BDR = 'rgba(255, 213, 0, 0.4)'
const HIGHLIGHT_TEXT = '#8a6d00'
const HIGHLIGHT_TEXT_DARK = '#E0C040'
// Red Shift keeps night vision: no blue/yellow, warm amber only.
const HIGHLIGHT_BG_REDSHIFT = 'rgba(224, 86, 46, 0.16)'
const HIGHLIGHT_BDR_REDSHIFT = 'rgba(224, 86, 46, 0.45)'
const HIGHLIGHT_TEXT_REDSHIFT = '#FF9A6B'

export function HighlightTag({
  label,
  snippet,
  showIcon = true,
}: {
  /** A section label to print in bold before the snippet, e.g. "61.85". */
  label?: string | null
  /** The highlighted passage itself. Clipped to one line by design -- the row
   *  above it carries the identity; this is a reminder of WHICH passage. */
  snippet?: string | null
  showIcon?: boolean
}) {
  const { tokens, redShift, resolved } = useTheme()
  const fs = useFS()
  const fg = redShift ? HIGHLIGHT_TEXT_REDSHIFT : resolved === 'dark' ? HIGHLIGHT_TEXT_DARK : HIGHLIGHT_TEXT
  return (
    <View style={[styles.tag, {
      backgroundColor: redShift ? HIGHLIGHT_BG_REDSHIFT : HIGHLIGHT_BG,
      borderColor: redShift ? HIGHLIGHT_BDR_REDSHIFT : HIGHLIGHT_BDR,
    }]}>
      {showIcon && <Icon name="highlighter" size={fs(11)} color={fg} />}
      {label ? (
        <Text style={{ color: fg, fontWeight: '700', fontSize: fs(10.5) }}>{`§ ${label} `}</Text>
      ) : null}
      {snippet ? (
        <Text numberOfLines={1} style={{ color: tokens.t2, fontSize: fs(11.5), flex: 1 }}>{snippet}</Text>
      ) : (
        <Text style={{ color: fg, fontWeight: '700', fontSize: fs(10.5) }}>HIGHLIGHT</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    // Metrics taken from folder/shared/[id].tsx's copy, which was the more
    // refined of the two: alignSelf keeps the chip hugging its own text
    // instead of stretching the full row width, and maxWidth stops a long
    // snippet pushing the row out.
    alignSelf: 'flex-start',
    maxWidth: '100%',
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginTop: 4,
  },
})
