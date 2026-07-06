import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { useDrawer } from '@/context/drawer'
import { Icon } from '@/components/Icon'
import { WORDMARK_FONT, wordmarkGoldFor } from '@/lib/brand'

interface ScreenHeaderProps {
  /** Show the gold FlyRegs wordmark instead of a text title */
  showWordmark?: boolean
  title?: string
  right?: React.ReactNode
}

export function ScreenHeader({ showWordmark, title, right }: ScreenHeaderProps) {
  const { tokens, resolved } = useTheme()
  const wordmarkGold = wordmarkGoldFor(resolved)
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
          <Icon name="line.3.horizontal" size={22} color={tokens.t2} />
        </Pressable>

        <View style={styles.center}>
          {showWordmark ? (
            <Text style={[styles.wordmark, { color: wordmarkGold, fontSize: fs(20), fontFamily: WORDMARK_FONT }]}>FlyRegs</Text>
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
          <Icon name="chevron.left" size={22} color={tokens.blu} />
        </Pressable>

        <View style={styles.center}>
          {title ? (
            <Text style={[styles.title, { color: tokens.t1, fontSize: fs(17) }]} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>

        {right !== undefined ? (
          <View style={styles.overlayRight}>{right}</View>
        ) : (
          <Pressable onPress={open} style={styles.iconBtn} hitSlop={8}>
            <Icon name="line.3.horizontal" size={22} color={tokens.t2} />
          </Pressable>
        )}
      </View>
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
