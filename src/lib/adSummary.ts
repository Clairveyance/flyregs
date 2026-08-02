// Condenses an AD's `summary` into something that is actually a summary.
//
// THE PROBLEM, measured across all 5,022 ADs that have one: median 691
// characters, 100% over 300, longest 2,243. The FAA's "SUMMARY" field is the
// full Federal Register preamble paragraph, and it always follows the same
// four-beat boilerplate:
//
//   "The FAA is adopting a new airworthiness directive (AD) for all <make>
//    <long model list>. This AD was prompted by <finding>. This AD requires
//    <the actual actions>. The FAA is issuing this AD to address the unsafe
//    condition on these products."
//
// Rendered verbatim that is a wall of text where a summary belongs, and the
// one sentence a pilot or mechanic actually needs — what the AD REQUIRES —
// is buried in the middle. So this does not truncate from the front (which
// would reliably return the useless "is adopting a new AD for all..." beat).
// It picks the requirement sentence when one exists, and only falls back to
// leading text when it doesn't.
//
// Deliberately deterministic string work, NOT an LLM pass: this runs at
// render time, so it needs no backfill, costs nothing, and covers every AD
// including ones scraped next week.

/** Federal Register page markers leak into the scraped text mid-sentence
 * ("Airbus SAS [[Page 8664]] Model A330-200") and read as corruption. */
export function stripAdArtifacts(text: string): string {
  return text
    .replace(/\[\[Page\s+[^\]]*\]\]/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Pure boilerplate — true of essentially every AD, so it carries no
// information about THIS one.
const BOILERPLATE = [
  /^the faa is issuing this ad to address the unsafe condition/i,
  /^we are issuing this ad to address the unsafe condition/i,
  /^this ad is intended to address the unsafe condition/i,
]

/** Drops the "This AD " subject and re-capitalises. Applied to WHICHEVER
 * sentence is chosen, not just the requirement one — 154 summaries came out
 * still reading "This AD was prompted by..." when only the requires branch
 * did this. */
function lead(s: string): string {
  const t = s.replace(/^This AD\s+/i, '').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

const MAX = 200

function clip(s: string, max = MAX): string {
  const t = s.trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:]$/, '')}…`
}

/**
 * One-line gist of an AD. Prefers the requirement ("This AD requires ..."),
 * then the prompting finding, then the first non-boilerplate sentence.
 */
export function condenseAdSummary(raw: string | null | undefined): string {
  const text = stripAdArtifacts(raw ?? '')
  if (!text) return ''
  const parts = sentences(text).filter((s) => !BOILERPLATE.some((re) => re.test(s)))
  if (parts.length === 0) return clip(text)

  // 1. What the AD makes you DO — the reason a reader opened it.
  //
  // The leading "This AD " is dropped rather than reworded. Naively swapping
  // it for "Requires" produced "Requires requires repetitively inspecting..."
  // on 86% of the corpus, because the sentence already supplies its own verb
  // ("This AD requires X"). Dropping the subject and re-capitalising leaves a
  // clean "Requires X" — caught by running this over all 5,022 summaries
  // rather than eyeballing one.
  const requires = parts.find((s) => /\b(requires?|mandat\w+|prohibits?)\b/i.test(s))
  if (requires) return clip(lead(requires))

  // 2. Why it exists.
  const prompted = parts.find((s) => /\bprompted by\b/i.test(s))
  if (prompted) return clip(lead(prompted))

  return clip(lead(parts[0]))
}

/** True when condensing actually hid something, so the UI should offer to
 * expand rather than silently discarding most of the field. */
export function adSummaryWasCondensed(raw: string | null | undefined): boolean {
  const full = stripAdArtifacts(raw ?? '')
  return full.length > 0 && condenseAdSummary(raw) !== full
}
