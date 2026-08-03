import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

// Extracted from ac/[id].tsx's own "IN DOC" search bar, pixel-for-pixel,
// so every other content type (FAR/AIM/PCG/AD/LOI) gets identical search
// UI instead of a second, slightly-different reimplementation. Confirmed a
// real gap: AC was the only detail screen with in-document search at all.
export function InDocSearchBar({
  query,
  onQueryChange,
  onClear,
  matchCount,
  matchIdx,
  onPrev,
  onNext,
}: {
  query: string
  onQueryChange: (text: string) => void
  onClear: () => void
  matchCount: number
  matchIdx: number
  onPrev: () => void
  onNext: () => void
}) {
  const { tokens } = useTheme()
  const fs = useFS()

  return (
    <View style={[styles.sticky, { backgroundColor: tokens.bg, borderBottomColor: tokens.bdr }]}>
      <View
        style={[
          styles.bar,
          { backgroundColor: tokens.bg2, borderColor: query.length >= 2 ? tokens.blu : tokens.bdr2 },
        ]}
      >
        <View style={styles.row}>
          <Icon name="magnifyingglass" size={fs(15)} color={tokens.t3} />
          <View style={[styles.scope, { backgroundColor: tokens.bdim }]}>
            <Text style={[styles.scopeText, { color: tokens.blu, fontSize: fs(9) }]}>IN DOC</Text>
          </View>
          <TextInput
            style={[
              styles.input,
              { color: tokens.t1, fontSize: fs(15) },
              Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : undefined,
            ]}
            placeholder="Search..."
            placeholderTextColor={tokens.t4}
            value={query}
            onChangeText={onQueryChange}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <Pressable hitSlop={10} onPress={onClear} style={{ padding: 6 }}>
              <Icon name="xmark" size={fs(14)} color={tokens.t3} />
            </Pressable>
          )}
        </View>
        {query.length >= 2 && (
          <View style={[styles.resultRow, { borderTopColor: tokens.bdr2 }]}>
            {matchCount > 0 ? (
              <>
                <Text style={[styles.count, { color: tokens.t3, fontSize: fs(12.5) }]}>
                  {matchIdx + 1}/{matchCount} results
                </Text>
                <View style={styles.nav}>
                  <Pressable hitSlop={14} onPress={onPrev} style={{ padding: 8 }}>
                    <Icon name="chevron.up" size={fs(18)} color={tokens.t2} />
                  </Pressable>
                  <Pressable hitSlop={14} onPress={onNext} style={{ padding: 8 }}>
                    <Icon name="chevron.down" size={fs(18)} color={tokens.t2} />
                  </Pressable>
                </View>
              </>
            ) : (
              <Text style={[styles.count, { color: tokens.t4, fontSize: fs(12.5) }]}>No results</Text>
            )}
          </View>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  sticky: { paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  bar: {
    borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 9,
    width: '100%', maxWidth: 700, alignSelf: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  resultRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth,
  },
  nav: { flexDirection: 'row', gap: 14 },
  scope: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  scopeText: { fontWeight: '800', letterSpacing: 0.6 },
  input: { flex: 1, paddingVertical: 4 },
  count: { fontWeight: '600' },
})
