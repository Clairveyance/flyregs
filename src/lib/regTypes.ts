// Central registry of per-reg-type identity (label, icon, tint) so every
// chip/badge across the app -- What's New cards, Study Mode, Duels, Search,
// Browse cards -- draws from one place instead of re-picking an icon per
// screen. Icon names are SF Symbols (native renders them directly via
// expo-symbols; Icon.tsx's SF_TO_IONICONS map supplies the web fallback --
// add an entry there for any symbol introduced here that isn't already
// mapped).
export type RegType = 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'ac' | 'dictionary' | 'cfr49'

export interface RegTypeMeta {
  label: string
  icon: string
}

export const REG_TYPE: Record<RegType, RegTypeMeta> = {
  far: { label: 'FAR', icon: 'book.closed.fill' },
  aim: { label: 'AIM', icon: 'map.fill' },
  // P/CG uses a headset: the Pilot/Controller Glossary is the shared
  // radio vocabulary between pilot and controller, so a headset reads
  // instantly. Replaced a custom "paper with A over Z" glyph
  // (PcgGlyph.tsx, deleted) which tested as an Ace playing card at every
  // size it actually renders at -- there's
  // no stock symbol for "a small page with A over Z on it," which is what
  // best reads as "alphabetical glossary" at a glance. Both Icon.tsx and
  // Icon.native.tsx special-case this name instead of resolving it through
  // SF Symbols/Ionicons.
  pcg: { label: 'P/CG', icon: 'headset' },
  // Was the alert-triangle -- every AD item (routine or urgent alike) got
  // flagged as if it were an emergency, which both misrepresents most ADs
  // and burns out the one signal that should mean "this is genuinely
  // serious." ADs are FAA-mandated maintenance/inspection actions, so a
  // wrench reads correctly regardless of severity; the triangle is freed up
  // for an actual urgency signal if one gets built later.
  ad: { label: 'AD', icon: 'wrench.and.screwdriver.fill' },
  loi: { label: 'LOI', icon: 'envelope.open.fill' },
  ac: { label: 'AC', icon: 'megaphone.fill' },
  // Icon/naming locked in 2026-08-01 (flyregs_decisions.md) ahead of the
  // screen itself -- a stack of books, deliberately distinct from FAR's
  // single closed book, since A/D is a broad cross-corpus reference source
  // rather than one regulation body.
  dictionary: { label: 'A/D', icon: 'books.vertical.fill' },
  // 49 CFR spans 3 families (NTSB/TSA/HMR, see cfr49_scraper.py) shown
  // together in one MagicLink bar -- a federal building reads as "DOT-wide
  // regulation" generically, deliberately distinct from FAR's own single
  // closed book (same reasoning as dictionary's own comment above: A/D
  // needed a visually different icon from FAR despite both being
  // "regulatory reference" in a loose sense).
  cfr49: { label: '49 CFR', icon: 'building.columns.fill' },
}

// RC, real device, B42, via the in-app bug report: "It seems like the reg
// identifier was listed twice. Let's make sure this isn't happening in other
// places in the app." Screenshot: an Ask FlyRegs result reading "AC AC 68-1A".
//
// Two DIFFERENT duplications produce that, and both are composition bugs, not
// data bugs -- every stored identifier and title was checked and is clean
// (0 of 786 AC numbers carry their own "AC " prefix):
//
//   1. The type name twice. A badge prints REG_TYPE.label, and the identifier
//      beside it is formatted as "AC 68-1A" / "AD 2005-05-53" -- which already
//      begins with that same label. FAR and AIM never showed it because their
//      identifiers start with a SYMBOL ("§ 67.307", "¶ 4-3-13"), so "FAR
//      § 67.307" reads correctly. P/CG and LOI were already fixed once, in
//      place, when they printed "P/CG P/CG" and "LOI LOI" -- the same bug, the
//      same shape, fixed only where it was seen. This is the third time.
//
//   2. The identifier twice. Every one of the 4,188 FAR and 82 49 CFR chunk
//      titles begins with its own section number ("§ 67.307 Mental."), so a
//      card showing "FAR § 67.307" above it prints the number twice. Visible
//      in RC's own screenshot, just less glaring than the one he circled.
//      Fixed at display: the detail screens already show the number and the
//      title as separate lines, so this just matches them.
//
// A third route to the same symptom -- an empty title falling back to the
// identifier -- was found by the audit below once these two were fixed; see
// composeRegTitle.
//
// All of it lives here, in the registry that owns `label`, so a new reg type
// cannot reintroduce any of them. scripts/reg_badge_composition_audit.py checks that
// nothing composes a label with an identifier by hand instead.

/** The identifier a result row shows beside its type badge, or null when the
 *  type has none beyond the badge itself.
 *
 *  null for P/CG and LOI: their real title IS the identifying information, so
 *  there is no number to print. (This used to live in semantic-search.tsx.
 *  It moved here so the whole composition rule -- identifier, badge, title --
 *  sits in one module that scripts/reg_badge_composition_audit.py can execute
 *  against the real corpus, rather than being three functions on three
 *  different layers that nothing checks together.) */
export function regIdentifierLabel(type: RegType, id: string): string | null {
  switch (type) {
    case 'far': return `§ ${id}`
    case 'aim': return `¶ ${id}`
    case 'ad': return `AD ${id}`
    case 'ac': return `AC ${id}`
    // cfr49 deliberately stays null, i.e. unchanged. Its badge shows no
    // number today, so its title carrying one ("§ 171.1 Purpose and scope.")
    // duplicates nothing. Giving it a FAR-style identifier here would be a
    // consistency change nobody asked for, in a fix for the opposite problem.
    default: return null
  }
}

/** Badge text for a result row: the type label, plus its identifier when that
 *  adds something the label does not already say. */
export function composeRegBadge(type: RegType, identifier: string | null | undefined): string {
  const label = REG_TYPE[type].label
  const id = identifier?.trim()
  if (!id) return label
  const lowerId = id.toLowerCase()
  const lowerLabel = label.toLowerCase()
  // The identifier already carries the type name -- print it alone.
  if (lowerId === lowerLabel || lowerId.startsWith(lowerLabel + ' ')) return id
  return `${label} ${id}`
}

/** The title line for a result row -- empty when the row has nothing to say
 *  that its badge is not already saying, in which case the caller should
 *  render no title line at all.
 *
 *  Returning the identifier as a last-resort title is what this deliberately
 *  does NOT do. Three ADs (2011-13-03, 2016-25-21, 2019-22-02) reach the app
 *  with an empty subject_heading, and the old fallback chain turned that into
 *  a card whose badge AND title were both "AD 2011-13-03" -- the same
 *  identifier-twice complaint, arriving by a completely different route than
 *  the AC one. Found by the audit, not by looking. The badge is already
 *  showing the number; saying it again adds nothing, and the snippet below
 *  still carries real content. */
export function composeRegTitle(title: string | null | undefined, identifier: string | null | undefined): string {
  const t = (title ?? '').trim()
  const id = identifier?.trim()
  if (!t) return ''
  if (!id || !t.toLowerCase().startsWith(id.toLowerCase())) return t
  // Separators the corpora actually use between a number and its title.
  return t.slice(id.length).replace(/^[\s.:—-]+/, '')
}
