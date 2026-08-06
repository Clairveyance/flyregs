// "Focus SmartSearch and open the keyboard" -- the tab bar's search icon
// (PersistentTabBar.tsx) needs to work from any screen, including ones that
// don't have their own search field (a FAR reading pane, for instance).
//
// RC, real device: tapping the search icon navigated to Home but never
// raised the keyboard. Root cause: the original implementation set a
// one-shot flag, called router.navigate(), and relied on Home's own
// useFocusEffect to notice the flag and call .focus() on the next
// animation frame. On web, WebKit only shows the on-screen keyboard for a
// .focus() call that happens while the original tap's "user activation" is
// still alive -- and by the time an async navigation transition finishes,
// a useFocusEffect fires, and a requestAnimationFrame resolves, that
// activation has expired, so the input focuses silently with no keyboard.
//
// Fix: Home registers its own focus function here as soon as it mounts
// (it stays mounted as a background tab for the whole session, per the
// existing useFocusEffect-not-useEffect comment in index.tsx, so this
// registration only ever needs to happen once). The tab bar then calls
// that function DIRECTLY, synchronously, in the same tap handler that
// triggers the navigation -- no async gap, so the activation is still
// live and the keyboard actually appears. requestFocusSearch/
// consumeFocusSearchRequest stay as a defensive fallback for the
// vanishingly unlikely case Home hasn't registered yet.
let homeFocusHandler: (() => void) | null = null
let pending = false

export function registerHomeSearchFocus(fn: (() => void) | null): void {
  homeFocusHandler = fn
}

export function focusHomeSearchNow(): boolean {
  if (!homeFocusHandler) return false
  homeFocusHandler()
  return true
}

export function requestFocusSearch(): void {
  pending = true
}

export function consumeFocusSearchRequest(): boolean {
  if (!pending) return false
  pending = false
  return true
}
