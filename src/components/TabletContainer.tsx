import { View, StyleSheet, ViewStyle } from 'react-native'
import { useResponsive } from '@/context/responsive'

// Wraps a screen's content so it reads as a real tablet layout instead of a
// stretched phone screen -- centers a readable-width column with breathing
// room on either side. A no-op on phone (renders children directly, no
// extra View/style at all) so this is safe to drop into any screen without
// touching its phone behavior. This is the "content stays a sane width"
// half of iPad optimization; true master-detail split-view navigation
// (list and detail panes side by side, not just a wide single column) is a
// separate, larger project -- see flyregs_pending.md.
export function TabletContainer({
  children,
  style,
  disabled,
}: {
  children: React.ReactNode
  style?: ViewStyle
  /** Callers building their own full-width tablet layout (a master-detail
   * split, for instance) opt out of the centered-column treatment entirely
   * -- the whole point of a split is using the width this would otherwise
   * take away. */
  disabled?: boolean
}) {
  const { isTablet, contentMaxWidth } = useResponsive()
  if (!isTablet || disabled) return <>{children}</>
  return (
    <View style={styles.outer}>
      <View style={[styles.inner, { maxWidth: contentMaxWidth }, style]}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  outer: { flex: 1, alignItems: 'center', width: '100%' },
  inner: { flex: 1, width: '100%' },
})
