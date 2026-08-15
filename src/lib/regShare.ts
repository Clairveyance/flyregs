import type { FolderItemType } from '@/lib/folders'

// Builds a FlyRegs-branded share link for a single FAR/AIM/P-CG/AD/LOI/
// dictionary item -- mirrors acShare.ts's buildACShareLink() exactly
// (stateless, no DB row/token, same flyregs.com landing-page + JS-handoff
// pattern), just routed through the generic reg/ website page
// (01_Website/flyregs-website/reg/index.php) instead of AC's own dedicated
// one, since these types share the exact same share shape and don't need a
// near-duplicate website page each.

// MUST stay in sync with $TYPE_NAMES and VALID_TYPES in the website's
// 01_Website/flyregs-website/reg/index.php. A type present here but missing
// there produces a link that silently never opens the app on the recipient's
// phone (the page bails before attempting the deep link) -- 'loi' and
// 'dictionary' both shipped that way and had to be fixed on the site.
// 'dictionary' is in this union because Saved's own Share button routes
// every non-'ac' bookmark through buildRegShareLink, and dictionary terms
// are bookmarkable; it was previously reaching here anyway via an unchecked
// `as RegShareType` cast, which is what let the mismatch go unnoticed.
export type RegShareType = 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary'

export function buildRegShareLink(type: RegShareType, id: string, label: string, title?: string): string {
  const params = new URLSearchParams({ type, id, label })
  if (title) params.set('title', title)
  return `https://flyregs.com/reg/?${params.toString()}`
}

// Narrows a saved/foldered item's type to a shareable reg type, or null for
// the two that share by a different route entirely.
//
// Replaces three separate `as RegShareType` casts (Saved, Recents, Folder)
// that each silently widened a FolderItemType into a RegShareType it might
// not actually be. That cast is exactly how 'dictionary' started reaching
// the website as `?type=dictionary` -- a value the site's own VALID_TYPES
// rejected -- with nothing anywhere complaining. The `never` check below
// turns the next occurrence of that into a compile error instead: add a
// ninth FolderItemType without deciding how it shares, and this stops
// building.
//
// A null result means "not shareable via the generic reg/ page," NOT "not
// shareable" -- both null cases have their own working path (see below).
export function toRegShareType(t: FolderItemType): RegShareType | null {
  switch (t) {
    case 'far':
    case 'aim':
    case 'pcg':
    case 'ad':
    case 'loi':
    case 'dictionary':
      return t
    // Has its own dedicated landing page + link builder (flyregs.com/ac/,
    // buildACShareLink) because it alone carries a highlight snippet.
    case 'ac':
      return null
    // Shared as plain text by shareNote(); a note is user-authored content
    // with no public URL to hand off to.
    case 'note':
      return null
    // Not yet in RegShareType/the website's VALID_TYPES -- adding 'cfr49'
    // there is a real website deploy, deliberately not bundled into this
    // pass. Share disabled for cfr49 until that lands (Print/bookmark/
    // highlight/folder/download all work independently of this).
    case 'cfr49':
      return null
    default: {
      const _exhaustive: never = t
      return _exhaustive
    }
  }
}
