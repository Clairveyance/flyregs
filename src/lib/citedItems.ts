// Shared by every MagicLinkPod usage (far/aim/ad detail screens) -- routes a
// document_citations row to its own detail screen. 'far_part' is a real
// cited_type value alongside 'far' (a citation can point at a whole Part
// rather than one section); both open the same /far/<id> route since
// far/[id].tsx already resolves either shape.
export type CitedType = 'ac' | 'far' | 'far_part' | 'aim' | 'pcg' | 'ad' | 'loi' | 'dictionary'

export function routeForCitedItem(citedType: string, citedId: string): string {
  switch (citedType) {
    case 'far':
    case 'far_part':
      return `/far/${citedId}`
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
      return `/ac/${citedId}`
  }
}
