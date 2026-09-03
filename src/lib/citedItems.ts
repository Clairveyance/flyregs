// Shared by every MagicLinkPod usage (far/aim/ad detail screens) -- routes a
// document_citations row to its own detail screen. 'far_part' is a real
// cited_type value alongside 'far' (a citation can point at a whole Part
// rather than one section, e.g. a bare "part 91" mention with no section
// number). This was a dead-end until 2026-08-10: far/[id].tsx looks up
// far_sections.section_number = id (expects a dotted number like "91.113"),
// so routing a bare part number like "91" there 404s every time -- the
// real destination is far/part/[part].tsx (far_parts.part = part), a
// separate, already-existing route this just never pointed at.
export type CitedType = 'ac' | 'far' | 'far_part' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary' | 'cfr49'

export function routeForCitedItem(citedType: string, citedId: string): string {
  switch (citedType) {
    case 'far_part':
      return `/far/part/${citedId}`
    case 'far':
      return `/far/${citedId}`
    case 'cfr49':
      return `/cfr49/${citedId}`
    case 'aim':
      return `/aim/${citedId}`
    case 'pcg':
      return `/pcg/${citedId}`
    case 'ad':
      return `/ad/${citedId}`
    case 'loi':
      return `/loi/${citedId}`
    case 'dictionary':
      return `/dictionary/${citedId}`
    default:
      // encodeURIComponent, because 125 of 781 ACs carry a slash in their
      // document number (the whole airport 150-series). Unencoded, the href
      // becomes "/ac/150/5300-13B" -- THREE path segments, which can never
      // match the single-segment ac/[id] route, so every one of those
      // citations landed on Expo Router's Unmatched Route screen.
      // crossRefLinks.ts already documents and solves exactly this; this file
      // never got the same fix. 740 document_citations rows are affected,
      // plus 4,917 of 20,821 AC chunks behind Ask FlyRegs.
      return `/ac/${encodeURIComponent(citedId)}`
  }
}
