import { flushSync } from 'react-dom'

// RC, real iPad: tapping the search icon from a non-Home tab (e.g. Notes)
// navigated to Home but never raised the keyboard -- confirmed live via
// document.activeElement staying BODY even after a genuine click. Root
// cause: expo-router's tab screens hide inactive tabs (display:none-style),
// so calling searchInputRef.current?.focus() before the tab switch's React
// state update has actually committed to the DOM finds an input that isn't
// focusable yet -- the .focus() call is a silent no-op. Deferring the
// .focus() call until AFTER the switch (a microtask, RAF, etc.) was already
// tried and rejected for the ORIGINAL version of this bug (see
// focusSearchSignal.ts) because it falls outside WebKit's "user activation"
// window and the keyboard never raises.
//
// flushSync forces the navigation's state update to reconcile and commit
// synchronously, still inside the original click handler's callstack (no
// microtask/RAF gap), so by the time the caller's very next line runs,
// Home's screen is genuinely visible AND we're still within the activation
// window that lets WebKit show the keyboard.
export function runNavigateSync(fn: () => void): void {
  flushSync(fn)
}
