// One-shot "focus SmartSearch and open the keyboard" signal -- the iPad
// landscape tab bar's search icon (PersistentTabBar.tsx) needs to work from
// any screen, including ones that don't have their own search field (a FAR
// reading pane, for instance). Navigating to Home and then focusing its
// input needs the focus to survive that navigation, but only needs to
// survive it once -- a plain in-memory flag is enough (no AsyncStorage
// round-trip needed, unlike justConfirmed.ts's cross-launch case) since
// this never needs to outlive the current app session.
let pending = false

export function requestFocusSearch(): void {
  pending = true
}

export function consumeFocusSearchRequest(): boolean {
  if (!pending) return false
  pending = false
  return true
}
