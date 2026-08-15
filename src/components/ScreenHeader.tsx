import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useDrawer } from '@/context/drawer'
import { Icon } from '@/components/Icon'
import { WORDMARK_FONT, wordmarkGoldFor } from '@/lib/brand'
import { useLongPressPreview } from '@/lib/useLongPressPreview'
import { LongPressPreviewCard } from '@/components/LongPressPreviewCard'

interface ScreenHeaderProps {
  /** Show the gold FlyRegs wordmark instead of a text title */
  showWordmark?: boolean
  title?: string
  /** Custom title content (e.g. The Wing's neon sign) — takes priority over `title`. */
  titleElement?: React.ReactNode
  right?: React.ReactNode
}

export function ScreenHeader({ showWordmark, title, titleElement, right }: ScreenHeaderProps) {
  const { tokens, resolved, redShift } = useTheme()
  const wordmarkGold = wordmarkGoldFor(resolved, redShift)
  const fs = useFS()
  const { open } = useDrawer()
  const insets = useSafeAreaInsets()

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: tokens.bg,
          borderBottomColor: tokens.bdr,
        },
      ]}
    >
      <View style={styles.row}>
        <Pressable onPress={open} style={styles.iconBtn} hitSlop={8}>
          <Icon name="line.3.horizontal" size={fs(22)} color={tokens.t2} />
        </Pressable>

        <View style={styles.center}>
          {showWordmark ? (
            <Text style={[styles.wordmark, { color: wordmarkGold, fontSize: fs(20), fontFamily: WORDMARK_FONT }]}>FlyRegs</Text>
          ) : titleElement ? (
            titleElement
          ) : title ? (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]}>{title}</Text>
          ) : null}
        </View>

        <View style={styles.rightSlot}>
          {right ?? <View style={{ width: 32 }} />}
        </View>
      </View>
    </View>
  )
}

// ─── Used inside content overlays ─────────────────────────────────────────────
// Overlays: Back on left, custom right element or drawer-menu fallback.

interface OverlayHeaderProps {
  title?: string
  onBack: () => void
  /** When provided, renders directly in the right slot (no drawer press). */
  right?: React.ReactNode
}

export function OverlayHeader({ title, onBack, right }: OverlayHeaderProps) {
  const { tokens } = useTheme()
  const fs = useFS()
  const { open } = useDrawer()
  const insets = useSafeAreaInsets()
  // Most screens pass a short, deliberately-chosen title that always fits --
  // but a handful pass real user content instead (folder/[id].tsx's
  // folder?.name, folder/shared/[id].tsx's folderName, my-aircraft/[id].tsx's
  // aircraft nickname/make/model), which can genuinely run long and get cut
  // off the same way FAR Part titles do. Fixed once here, in the shared
  // header every screen renders, rather than patched per screen -- same
  // hook/card pair as far/index.tsx's own long-press preview. Harmless on
  // the many screens with a short static title: nothing to see that isn't
  // already fully visible.
  const { preview, previewHeight, setPreviewHeight, showPreview, hidePreview } = useLongPressPreview()

  return (
    <View
      style={[
        styles.overlayContainer,
        {
          paddingTop: insets.top,
          backgroundColor: tokens.bg,
          borderBottomColor: tokens.bdr,
        },
      ]}
    >
      <View style={styles.overlayRow}>
        <Pressable onPress={onBack} style={styles.iconBtn} hitSlop={8}>
          <Icon name="chevron.left" size={fs(22)} color={tokens.blu} />
        </Pressable>

        <View style={styles.center}>
          {title ? (
            <Pressable
              onLongPress={(e) => showPreview(title, e)}
              onPressOut={hidePreview}
              delayLongPress={350}
            >
              <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]} numberOfLines={1}>
                {title}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {right !== undefined ? (
          <View style={styles.overlayRight}>{right}</View>
        ) : (
          <Pressable onPress={open} style={styles.iconBtn} hitSlop={8}>
            <Icon name="line.3.horizontal" size={fs(22)} color={tokens.t2} />
          </Pressable>
        )}
      </View>
      <LongPressPreviewCard
        preview={preview}
        previewHeight={previewHeight}
        onLayoutHeight={setPreviewHeight}
        onDismiss={hidePreview}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
    zIndex: 20,
  },
  row: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  overlayContainer: {
    borderBottomWidth: 1,
    zIndex: 20,
  },
  overlayRow: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  iconBtn: {
    padding: 5,
    borderRadius: 8,
    width: 32,
    alignItems: 'center',
  },
  center: {
    flex: 1,
    // Without this, a flex child's default min-width is its own content
    // width on web -- so a long title (folder/[id].tsx's folder?.name, etc)
    // never actually shrinks to make room for the right slot, and just
    // overlaps it instead of truncating cleanly. RC, real device: a 25-char
    // folder name overlapped the header's Invite icon by 15px on a 3-icon
    // right slot (Invite/Rename/Delete) -- numberOfLines={1} below was
    // already correct, it just never got a bounded width to truncate against.
    minWidth: 0,
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  rightSlot: {
    minWidth: 32,
    alignItems: 'flex-end',
  },
  overlayRight: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 2,
  },
  wordmark: {
    fontSize: 20,
    letterSpacing: -0.3,
  },
  title: {
    fontWeight: '600',
    fontSize: 17,
  },
})
