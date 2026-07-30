// far_sections.title is scraped with a "§ N.NN " prefix baked in (e.g.
// "§ 47.17 Fees."), which duplicates the section number wherever a title is
// shown next to a separately-rendered number badge (detail header, list
// rows, recents chips, What's New cards, etc). Safe no-op for every other
// content type — only FAR titles start with this pattern.
export function stripFarPrefix(title: string): string {
  return title.replace(/^§\s*[\d.]+\s*/, '')
}
