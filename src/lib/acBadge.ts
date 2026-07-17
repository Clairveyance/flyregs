import type { ThemeTokens } from '@/context/theme'

// Single source of truth for which of the three "this AC is new/changed"
// badges (NEW/UPD/VER) an AC should show -- used by every place that renders
// one (Home's What's New card, series list rows, AC detail screen). Kept
// here instead of duplicated per-screen after getting burned once already by
// three near-identical copies of the old (wrong) `cancels`-based logic
// drifting out of sync with each other.
export type BadgeKind = 'new' | 'upd' | 'ver'

// Splits a document number into its numeric/base part and a trailing letter
// suffix, e.g. "20-136C" -> { base: "20-136", suffix: "C" }. Document numbers
// with no trailing letter (e.g. "20-191") get suffix "".
function splitDocNumberVersion(docNumber: string): { base: string; suffix: string } {
  const m = docNumber.match(/^(.*\d)([A-Za-z]+)$/)
  if (m) return { base: m[1], suffix: m[2].toUpperCase() }
  return { base: docNumber, suffix: '' }
}

// Three distinct kinds of "this AC is new/changed," each with its own badge:
//  - 'upd': the SAME document number got an in-place revision we have a real
//    diff for (changed_block_indices populated) -- opening it shows the
//    update-banner-with-jump-arrows.
//  - 'ver': this AC cancels an older AC sharing the same base number but a
//    different letter suffix (e.g. 20-136C cancels 20-136B) -- a version
//    bump (same guidance, moved a letter grade), not a new topic.
//  - 'new': everything else, including cancelling a completely different,
//    unrelated AC number -- there's no shared identity/diff to show, so from
//    the reader's perspective this is a new document (the AC screen's own
//    "Cancels" section still states what it replaces).
export function getBadgeKind(ac: {
  document_number: string
  cancels?: string[] | null
  changed_block_indices?: number[] | null
}): BadgeKind {
  if (ac.changed_block_indices && ac.changed_block_indices.length > 0) return 'upd'
  if (ac.cancels && ac.cancels.length > 0) {
    const { base } = splitDocNumberVersion(ac.document_number)
    if (ac.cancels.some((c) => splitDocNumberVersion(c).base === base)) return 'ver'
  }
  return 'new'
}

// One place mapping a badge kind to its label + colors (green/blue/amber),
// so every screen's badge looks identical and a future color tweak only
// happens once. Amber for 'ver' deliberately reuses the existing (until now
// unused) `amb`/`adim`/`abdr` tokens rather than introducing a fourth hue.
export function getBadgeStyle(kind: BadgeKind, tokens: ThemeTokens): {
  label: string
  color: string
  background: string
  border: string
} {
  switch (kind) {
    case 'upd':
      return { label: 'UPD', color: tokens.blu, background: tokens.bdim, border: tokens.bbdr }
    case 'ver':
      return { label: 'VER', color: tokens.amb, background: tokens.adim, border: tokens.abdr }
    case 'new':
    default:
      return { label: 'NEW', color: tokens.grn, background: tokens.gdim, border: tokens.gbdr }
  }
}
