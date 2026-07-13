// iOS dictation sometimes commits the recognized phrase concatenated with
// whatever was already in the field instead of replacing it — e.g. speaking
// "airworthiness criteria" can land as "airworthiness criteriaairworthiness
// criteria" or "airworthiness criteria airworthiness criteria" the moment the
// mic button is released or the keyboard loses focus. Neither the uncontrolled
// TextInput fix nor avoiding remounts touches this — it's the native dictation
// commit itself delivering a duplicate. Collapse an exact whole-string
// duplicate (with zero or one separating space, case-insensitive) back down
// to a single occurrence before it ever reaches state.
export function collapseDictationDuplicate(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 4) return text
  const lower = trimmed.toLowerCase()

  // "word word" — duplicate separated by exactly one space
  if (trimmed.length % 2 === 1) {
    const mid = (trimmed.length - 1) / 2
    if (trimmed[mid] === ' ') {
      const a = lower.slice(0, mid)
      const b = lower.slice(mid + 1)
      if (a.length > 0 && a === b) return trimmed.slice(mid + 1)
    }
  }

  // "wordword" — duplicate concatenated with no separator
  if (trimmed.length % 2 === 0) {
    const half = trimmed.length / 2
    const a = lower.slice(0, half)
    const b = lower.slice(half)
    if (a === b) return trimmed.slice(half)
  }

  return text
}

// iOS dictation renders a spoken "dash"/"hyphen" using a Unicode dash variant
// (commonly U+2011 NON-BREAKING HYPHEN, sometimes U+2013 EN DASH) rather than
// the plain U+002D HYPHEN-MINUS a keyboard produces — visually identical in
// every font, so a query that LOOKS exactly like "20-191" in the search box
// can still return zero results, because ILIKE does a literal substring match
// against document_number, which is stored with a plain hyphen. Confirmed
// 2026-07-12: typing "20-191" works, speaking "twenty dash one nine one"
// (which renders as "20-191" on screen) does not. Smart quotes get the same
// treatment for the same reason (dictation renders spoken "apostrophe" as a
// curly ' rather than a straight ', which would break a phrase match against
// stored text that uses straight quotes).
const DASH_VARIANTS = /[‐‑‒–—―−]/g
const CURLY_QUOTE_VARIANTS = /[‘’]/g
const CURLY_DOUBLE_QUOTE_VARIANTS = /[“”]/g

export function normalizeSearchQuery(text: string): string {
  return text
    .replace(DASH_VARIANTS, '-')
    .replace(CURLY_QUOTE_VARIANTS, "'")
    .replace(CURLY_DOUBLE_QUOTE_VARIANTS, '"')
}
