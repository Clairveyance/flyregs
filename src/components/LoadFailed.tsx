import { View, Text, Pressable, StyleSheet } from 'react-native'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// "It didn't load" -- one component, every screen.
//
// The 2026-09-05 sweep found 29 screens that fetch from the network and show
// NOTHING when the fetch fails: supabase-js resolves {data: null, error}
// rather than throwing, so a failed read becomes an empty array and the screen
// renders its "no results" state. From the user's side a dead connection is
// indistinguishable from "this section is empty", and there is no way to
// retry short of leaving and coming back.
//
// far/index.tsx already had exactly this markup inline. Rather than paste it
// 29 more times -- which is how the highlight chip ended up with three
// definitions and one screen missing it entirely -- it lives here.
//
// `onRetry` is required on purpose. A failure message with no way to act on it
// is only marginally better than the blank screen it replaces.
export function LoadFailed({
  message = "Couldn't load this.",
  hint = 'Check your connection and try again.',
  onRetry,
  compact = false,
}: {
  message?: string
  hint?: string
  onRetry: () => void
  /** For a list's ListEmptyComponent, where the surrounding screen already
   *  provides its own padding and a full-height centre would look wrong. */
  compact?: boolean
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  return (
    <View style={[styles.wrap, compact ? styles.compact : styles.full]}>
      <Icon name="exclamationmark.triangle" size={fs(compact ? 22 : 28)} color={tokens.red} />
      <Text style={[styles.title, { color: tokens.t2, fontSize: fs(compact ? 14 : 15) }]}>{message}</Text>
      <Text style={[styles.hint, { color: tokens.t3, fontSize: fs(13) }]}>{hint}</Text>
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        style={[styles.btn, { backgroundColor: tokens.blu }]}
        accessibilityRole="button"
        accessibilityLabel="Try again"
      >
        <Text style={[styles.btnText, { fontSize: fs(14) }]}>Try Again</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  full: { flex: 1 },
  compact: { paddingVertical: 28 },
  title: { marginTop: 10, textAlign: 'center', fontWeight: '600' },
  hint: { marginTop: 6, textAlign: 'center' },
  btn: { marginTop: 14, paddingVertical: 8, paddingHorizontal: 18, borderRadius: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
})
