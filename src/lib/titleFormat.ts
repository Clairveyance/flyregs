// far_sections.title is scraped with a "§ N.NN " prefix baked in (e.g.
// "§ 47.17 Fees."), which duplicates the section number wherever a title is
// shown next to a separately-rendered number badge (detail header, list
// rows, recents chips, What's New cards, etc). Safe no-op for every other
// content type — only FAR titles start with this pattern.
export function stripFarPrefix(title: string): string {
  return title.replace(/^§\s*[\d.]+\s*/, '')
}

// P/CG entries have no separate "number" -- the term IS the identifier, so
// pcg/[id].tsx bookmarks it as BOTH document_number and title. Every list
// row that renders a number line above a title line then printed the same
// words twice ("ABEAM" / "ABEAM"), confirmed live in Saved. Returns the
// title to render, or '' when it adds nothing over the number already
// shown -- callers skip the title element entirely when this is empty
// (an empty <Text> still occupies its own margins/line-height).
//
// Case/whitespace-insensitive, and also catches the FAR shape where the
// title is just the number again after stripFarPrefix leaves it bare.
export function rowTitle(documentNumber: string, title: string): string {
  const stripped = stripFarPrefix(title ?? '')
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!stripped.trim()) return ''
  if (norm(stripped) === norm(documentNumber ?? '')) return ''
  return stripped
}
