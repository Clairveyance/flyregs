// Builds a FlyRegs-branded share link for a single FAR/AIM/P-CG/AD item --
// mirrors acShare.ts's buildACShareLink() exactly (stateless, no DB row/
// token, same flyregs.com landing-page + JS-handoff pattern), just routed
// through the new generic reg/ website page (01_Website/flyregs-website/
// reg/index.php) instead of AC's own dedicated one, since these four types
// share the exact same share shape and don't need four near-duplicate
// website pages.

export type RegShareType = 'far' | 'aim' | 'pcg' | 'ad' | 'loi'

export function buildRegShareLink(type: RegShareType, id: string, label: string, title?: string): string {
  const params = new URLSearchParams({ type, id, label })
  if (title) params.set('title', title)
  return `https://flyregs.com/reg/?${params.toString()}`
}
