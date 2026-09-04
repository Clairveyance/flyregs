import { Pressable, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native'
import { Icon } from '@/components/Icon'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'

// RC, "Suggest a feature", 2026-09-03: "On all of the regulation search
// pages where we have the long scroll of all the different potential
// regulations we should also include the 'back to top' button that we have
// for inside each actual document... anywhere in the app where we have a
// long scrolling list of items where the top bar disappears for the search
// field itself disappears with a scroll, will want to have this back to
// the top button available."
//
// Extracted from the exact pattern each document-detail screen (far/[id],
// aim/[id], ac/[id], ad/[id], pcg/[id], cfr49/[id], loi/[slug]) already had
// -- same icon, same 200px threshold, same header-right placement -- so the
// long BROWSE lists (far/index, aim/index, ...) get the identical, already-
// familiar affordance instead of a second, subtly-different one.
export const BACK_TO_TOP_THRESHOLD = 200

export function BackToTop({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const { tokens } = useTheme()
  const fs = useFS()
  if (!visible) return null
  return (
    <Pressable onPress={onPress} hitSlop={12} style={{ padding: 4 }}>
      <Icon name="arrow.up.circle" size={fs(21)} color={tokens.t3} />
    </Pressable>
  )
}

// Shared onScroll handler shape -- one function works for both ScrollView
// and FlatList (their onScroll event types are identical), so a screen just
// wires `onScroll={makeBackToTopScrollHandler(setScrollY)}` instead of
// hand-rolling the same one-liner at every call site.
export function makeBackToTopScrollHandler(setScrollY: (y: number) => void) {
  return (e: NativeSyntheticEvent<NativeScrollEvent>) => setScrollY(e.nativeEvent.contentOffset.y)
}
