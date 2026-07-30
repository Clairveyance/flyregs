import { View, Text, StyleSheet } from 'react-native'

// P/CG (Pilot/Controller Glossary) has no matching SF Symbol/Ionicon --
// it's a dictionary, not a book or a document, so this draws the requested
// "small piece of paper with an A over a Z on it" directly with View/Text
// rather than pulling in an SVG library for one glyph. Shared between
// Icon.tsx (web) and Icon.native.tsx (SF Symbols) so both platforms render
// the identical mark.
export function PcgGlyph({ size, color }: { size: number; color?: string }) {
  const tint = color ?? '#000'
  return (
    <View style={[styles.page, { width: size * 0.78, height: size, borderColor: tint }]}>
      <Text style={[styles.letter, { color: tint, fontSize: size * 0.36, lineHeight: size * 0.4 }]}>A</Text>
      <Text style={[styles.letter, { color: tint, fontSize: size * 0.36, lineHeight: size * 0.4 }]}>Z</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    borderWidth: 1.4,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingVertical: '10%',
  },
  letter: {
    fontWeight: '800',
  },
})
