// far_sections.title is scraped with a "§ N.NN " prefix baked in (e.g.
// "§ 47.17 Fees."), which duplicates the section number wherever a title is
// shown next to a separately-rendered number badge (detail header, list
// rows, recents chips, What's New cards, etc). Safe no-op for every other
// content type — only FAR titles start with this pattern.
export function stripFarPrefix(title: string): string {
  return title.replace(/^§\s*[\d.]+\s*/, '')
}

// airworthiness_directives.subject_heading is the FAA's own Federal
// Register title, which always starts with "Airworthiness Directives; "
// verbatim (confirmed corpus-wide, 5,023/5,023 rows) before the actual
// make/model-specific subject. Redundant wherever it's shown next to an
// "AD" type badge/icon/screen-header that already says as much -- Home's
// What's New cards, the AD browse list, SmartSearch results, and MagicLink
// cross-reference titles all pair this text with exactly that kind of
// badge. Safe no-op for every other content type; and the AD detail
// screen's own page title deliberately keeps the full official heading
// (it's not sitting next to a redundant badge there).
export function stripAdSubjectPrefix(subjectHeading: string): string {
  return subjectHeading.replace(/^Airworthiness Directives;\s*/i, '')
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
  const stripped = stripAdSubjectPrefix(stripFarPrefix(title ?? ''))
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!stripped.trim()) return ''
  if (norm(stripped) === norm(documentNumber ?? '')) return ''
  return stripped
}

// legal_interpretations.title arrives as a file-style slug
// ("Collins_2011_Legal_Interpretation") -- every LOI carries the same
// "_Legal_Interpretation" boilerplate suffix and underscore separators.
// Originally lived only in loi/[slug].tsx (the detail screen); the two
// browse/list screens (loi/index.tsx, loi/year/[year].tsx) each had their
// own inline `.replace(/-/g, ' ')`, which only handles hyphens -- the raw
// underscores and "_Legal_Interpretation" suffix rendered untouched on
// every row of every year's list (confirmed corpus-wide: all 36 rows of
// the 2018 list alone). Shared here so every LOI title renders the same
// way everywhere, not just on the one screen this was first built for.
export function humanizeLoiTitle(t: string): string {
  return t
    .replace(/[_-]?legal[_-]interpretation$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
}
