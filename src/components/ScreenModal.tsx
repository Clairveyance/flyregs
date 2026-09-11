import { Modal, type ModalProps } from 'react-native'
import { useIsFocused } from 'expo-router'

/**
 * React Native's <Modal> for anything a SCREEN owns. Use this, never the raw
 * one, everywhere except the app-level ConfirmDialog (see below).
 *
 * WHY THIS EXISTS
 * A modal's `visible` flag is state on the screen component, and expo-router
 * keeps that screen mounted in the stack when you navigate away. An RN
 * <Modal> renders into a native window above the entire app and does not care
 * which screen is focused. So navigating away leaves the sheet on screen,
 * fully interactive, floating over something it has nothing to do with.
 *
 * Found 2026-09-10 during the first real-device sweep: with Edit Aircraft
 * open on my-aircraft/[id], a deep link to Study Mode navigated underneath
 * and left the Edit Aircraft card sitting on top of it. It survived eight
 * consecutive deep links.
 *
 * REACHABLE HOW -- worth stating, because it is easy to dismiss as impossible:
 * not by tapping, since an open modal eats touches and nothing in-app can
 * navigate underneath it. It needs navigation from OUTSIDE the render tree --
 * a push notification tap (this app sends AD alerts), a universal link, or a
 * flyregs:// link. Narrow, but the AD-alert path is one we ship.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT DO
 * It only withholds `visible` while the owning screen is blurred. It does not
 * touch the caller's state, so nothing changes at the call sites and no close
 * handler fires unexpectedly. Clearing the state on blur was the alternative
 * and was rejected: it would silently discard a form the user never dismissed.
 *
 * Both halves measured on device, 2026-09-10, on the exact sequence that
 * produced the bug: open Edit Aircraft, deep-link to Study Mode -> Study Mode
 * is clean; press back -> Edit Aircraft returns with its fields intact.
 * Worth knowing which "back" that is: popping the stack returns to the same
 * mounted screen, so the sheet comes back. A deep link to the SAME route
 * pushes a fresh screen instead, which starts with visible=false and no
 * sheet -- also verified, and also correct, since that is a new screen and
 * not a return to the old one.
 *
 * THE ONE EXEMPTION
 * ConfirmDialog.tsx keeps the raw <Modal>. Its provider sits ABOVE <Stack> in
 * _layout.tsx, so it belongs to the app rather than to any screen -- there is
 * no screen whose focus should be able to hide the app's only confirm dialog.
 * scripts/screen_modal_audit.py enforces exactly that split.
 */
export function ScreenModal({ visible, children, ...rest }: ModalProps) {
  // useIsFocused resolves against the nearest screen, and falls back to the
  // root navigation container when there isn't one -- so this is safe even if
  // a future caller renders it outside a screen, where it simply reads as
  // always-focused rather than throwing.
  const isFocused = useIsFocused()
  return (
    <Modal visible={!!visible && isFocused} {...rest}>
      {children}
    </Modal>
  )
}
