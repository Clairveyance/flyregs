// Central registry of per-reg-type identity (label, icon, tint) so every
// chip/badge across the app -- What's New cards, Study Mode, Duels, Search,
// Browse cards -- draws from one place instead of re-picking an icon per
// screen. Icon names are SF Symbols (native renders them directly via
// expo-symbols; Icon.tsx's SF_TO_IONICONS map supplies the web fallback --
// add an entry there for any symbol introduced here that isn't already
// mapped).
export type RegType = 'far' | 'aim' | 'pcg' | 'ad' | 'loi' | 'ac'

export interface RegTypeMeta {
  label: string
  icon: string
}

export const REG_TYPE: Record<RegType, RegTypeMeta> = {
  far: { label: 'FAR', icon: 'book.closed.fill' },
  aim: { label: 'AIM', icon: 'map.fill' },
  // 'pcg.az' is a custom glyph (PcgGlyph.tsx), not an SF Symbol -- there's
  // no stock symbol for "a small page with A over Z on it," which is what
  // best reads as "alphabetical glossary" at a glance. Both Icon.tsx and
  // Icon.native.tsx special-case this name instead of resolving it through
  // SF Symbols/Ionicons.
  pcg: { label: 'P/CG', icon: 'pcg.az' },
  // Was the alert-triangle -- every AD item (routine or urgent alike) got
  // flagged as if it were an emergency, which both misrepresents most ADs
  // and burns out the one signal that should mean "this is genuinely
  // serious." ADs are FAA-mandated maintenance/inspection actions, so a
  // wrench reads correctly regardless of severity; the triangle is freed up
  // for an actual urgency signal if one gets built later.
  ad: { label: 'AD', icon: 'wrench.and.screwdriver.fill' },
  loi: { label: 'LOI', icon: 'envelope.open.fill' },
  ac: { label: 'AC', icon: 'megaphone.fill' },
}
