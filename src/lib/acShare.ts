// Builds a FlyRegs-branded share link for a single AC, optionally jumped to
// a specific highlighted passage. Deliberately stateless -- no DB row, no
// token -- since an AC (unlike a folder) is public content any signed-in
// user can already see; the link just needs to carry enough info for the
// recipient's own app to open the right screen and, if given, locate the
// same passage in their own copy of the AC's blocks.
//
// Routes through a flyregs.com/ac/ landing page (same JS-handoff pattern as
// join/confirm) rather than the bare flyregs:// scheme -- if the recipient
// doesn't have the app, a bare custom-scheme link fails silently. See
// 01_Website/flyregs-website/ac/index.html for the web side, and
// src/app/ac/[id].tsx's hlText handling for the in-app jump.
export function buildACShareLink(ac: { id: string; document_number: string; title: string }, hlSnippet?: string): string {
  const params = new URLSearchParams({ id: ac.id, doc: ac.document_number, title: ac.title })
  if (hlSnippet) params.set('hl', hlSnippet)
  return `https://flyregs.com/ac/?${params.toString()}`
}

// Trims a block's full text down to a short, still-unique-enough snippet for
// re-locating it via a substring match in the recipient's own pdf_blocks --
// short enough to keep the URL reasonable, long enough to not collide with
// unrelated blocks.
export function highlightSnippet(text: string): string {
  return text.trim().slice(0, 120)
}
