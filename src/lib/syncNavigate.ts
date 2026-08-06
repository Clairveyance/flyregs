// Native default: React Native has no WebKit-style "user activation" window
// to race against, so a plain call is all that's needed. See
// syncNavigate.web.ts for why the web build needs more than this.
export function runNavigateSync(fn: () => void): void {
  fn()
}
