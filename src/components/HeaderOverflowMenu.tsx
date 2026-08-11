import { useState } from 'react'
import { View, Text, Pressable, StyleSheet, Modal, InteractionManager } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/context/theme'
import { useFS } from '@/context/fontScale'
import { Icon } from '@/components/Icon'

export interface OverflowMenuItem {
  icon: string
  label: string
  onPress: () => void
  /** Greyed out, still tappable -- matches how the individual icons this
   * replaces already showed a dimmed (not hidden) state for Plus-gated
   * actions, so tapping still routes to the paywall instead of doing
   * nothing. */
  disabled?: boolean
}

// RC, real device (annotated screenshot): "these are taking up too much
// space, esp when the 'return to top' [icon] is active. let's use the
// 3-vertical-dot expander to hide a few." Reusable trigger + dropdown so
// every reg detail screen (AC/FAR/AIM/P-CG/AD/LOI) collapses its
// Print/Share/Folder icons into ONE consistent affordance instead of each
// screen growing its own ad-hoc icon row. Horizontal "ellipsis" (not a
// true vertical 3-dot) is deliberate -- that's the icon iOS itself uses
// for "more" overflow menus (Safari, Mail, Files), and it's the one SF
// Symbol name already confirmed to render on device; a literal
// ellipsis.vertical isn't a standard SF Symbol.
export function HeaderOverflowMenu({
  items,
  hideTrigger,
  open: openProp,
  onOpenChange,
  position = 'top',
}: {
  items: OverflowMenuItem[]
  /** iPad: the "..." trigger itself moved to the bottom bar (RC, annotated
   * screenshot), so this instance only renders the dropdown -- the bottom
   * bar's own action drives `open`/`onOpenChange` instead. */
  hideTrigger?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** 'bottom' anchors the dropdown near the bottom bar instead of the
   * header, so it visually opens from wherever its trigger actually is. */
  position?: 'top' | 'bottom'
}) {
  const { tokens } = useTheme()
  const fs = useFS()
  const insets = useSafeAreaInsets()
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = onOpenChange ?? setOpenState

  return (
    <>
      {!hideTrigger && (
        <Pressable onPress={() => setOpen(true)} hitSlop={12} style={styles.trigger}>
          <Icon name="ellipsis" size={fs(21)} color={tokens.t2} />
        </Pressable>
      )}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)}>
          <View
            style={[
              styles.menu,
              position === 'bottom'
                ? { bottom: insets.bottom + 60 }
                : { top: insets.top + 52 },
              { backgroundColor: tokens.bg2, borderColor: tokens.bdr },
            ]}
          >
            {items.map((item, i) => (
              <Pressable
                key={i}
                // RC, real device: an item like Share (which presents ITS OWN
                // native modal, e.g. Share.share()'s UIActivityViewController)
                // "doesn't respond at all, or responds very late and
                // freezes/closes/crashes" -- classic iOS "present while
                // dismissing" race: setOpen(false) starts this dropdown
                // Modal's async dismiss transition, and firing item.onPress()
                // in the SAME tick asks UIKit to present a second modal on a
                // view controller that's still mid-dismissal. Deferring to
                // runAfterInteractions (rather than a magic-number setTimeout)
                // waits for that dismiss animation to actually finish first.
                onPress={() => {
                  setOpen(false)
                  InteractionManager.runAfterInteractions(() => item.onPress())
                }}
                disabled={item.disabled}
                style={[styles.row, i < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.bdr }]}
              >
                <Icon name={item.icon} size={fs(18)} color={item.disabled ? tokens.t4 : tokens.t2} />
                <Text style={[styles.label, { color: item.disabled ? tokens.t4 : tokens.t1, fontSize: fs(14.5) }]}>
                  {item.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  trigger: { padding: 4 },
  menu: {
    position: 'absolute',
    right: 12,
    minWidth: 168,
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  label: { fontWeight: '500' },
})
