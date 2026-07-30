// A single pending "where you jumped from" label -- not a full history
// stack. Set right before navigating via a cross-reference (a MagicLink tap
// or an in-doc hyperlink), consumed once by the destination screen on
// mount. Deliberately single-slot rather than push/pop: the ask is "let me
// get back to the one thing I was just reading," not a multi-hop breadcrumb
// trail, and a single mutable slot can't leak a stale label into an
// unrelated later navigation (tab bar, search result) the way an
// un-popped stack entry could.
let pending: string | null = null

export function setPendingBreadcrumb(label: string) {
  pending = label
}

export function consumePendingBreadcrumb(): string | null {
  const v = pending
  pending = null
  return v
}
