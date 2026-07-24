import { slugifyPcgTerm } from '@/lib/pcg'

// Turns inline cross-references inside FAR/AIM/P-CG body text — "(See TBL
// 2-1-1 and TBL 2-1-2.)", "AC 90-67B", "Pilot/Controller Glossary Term-
// Light Gun" — into tappable links, in place, at the exact spot they occur
// in the prose. Confirmed live as a real, significant gap: this content's
// citations were already being extracted into document_citations (feeding
// the Related bars' counts), but nothing rendered those same references as
// actual navigable links anywhere — not the counts-only Related bars, and
// not a single word of the body text itself, despite AIM paragraphs
// routinely reading like "(See TBL 2-1-1 and TBL 2-1-2.)" with zero way to
// tap through. "One of the biggest cross-ref features we have," per
// direct user feedback, sitting completely inert.
//
// Works from the plain rendered text alone (no scraper/DB changes) since
// every pattern here is exactly what the citation-extraction regexes
// already look for — just applied at render time instead of scrape time,
// so it works retroactively on data already in production too.

export interface LinkSegment {
  text: string
  route: string | null // null = plain, non-linked text
  // True for a TBL/FIG mention specifically — the caller (PlainTextBody)
  // tries to open the real page-image figure directly instead of just
  // following `route`. See the PATTERNS entry below for why routing alone
  // isn't reliable for these.
  isFigure?: boolean
}

interface CandidateMatch {
  start: number
  end: number
  text: string
  route: string
  isFigure?: boolean
}

interface LinkPattern {
  regex: RegExp
  buildRoute: (m: RegExpExecArray) => string
  isFigure?: boolean
}

// Order doesn't matter for correctness (overlap resolution below sorts by
// position, and prefers the longest match at a given start), but keeping
// the more specific patterns first reads more naturally.
const PATTERNS: LinkPattern[] = [
  // AIM Table/Figure reference. `route` here is a FALLBACK ONLY, used when
  // the figure can't be opened directly (see isFigure handling in
  // PlainTextBody) — routing by number alone is confirmed unreliable: AIM
  // 3-2-4's own body text says "(See TBL 3-2-1.)" referring to the exact
  // table already shown earlier in that SAME paragraph, but the table's
  // own HTML-generated caption number is "TBL 3-2-4" (matching its
  // containing paragraph, per that source's own convention) — "3-2-1" is
  // real-AIM-numbering text embedded in the prose, not a route anywhere.
  // Routing straight to /aim/3-2-1 would land on a completely unrelated
  // paragraph. Opening the current paragraph's own figure directly sidesteps
  // this numbering mismatch entirely instead of trying to resolve it.
  { regex: /\b(?:TBL|FIG)\s+(\d+-\d+-\d+[a-z]?)\b/g, buildRoute: (m) => `/aim/${m[1]}`, isFigure: true },
  // Explicit AIM paragraph reference in prose ("Paragraph 4-3-13", "Para.
  // 4-1-2"). Deliberately requires this prefix rather than matching bare
  // X-X-X numbers anywhere — a bare number in running prose is too easy to
  // false-positive on (dates, unrelated figures, etc).
  { regex: /\bPara(?:graph)?\.?\s+(\d+-\d+-\d+)\b/g, buildRoute: (m) => `/aim/${m[1]}` },
  // AC mention ("AC 90-67B", "(AC) 90-66"). ac/[id].tsx resolves a
  // document_number to its real UUID and redirects, so the raw matched
  // number can route directly with no lookup here.
  { regex: /\bAC\)?\s+(\d+(?:\.\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b/g, buildRoute: (m) => `/ac/${m[1]}` },
  // FAR section mention ("§ 91.107", "FAR 91.107", "14 CFR 91.107").
  { regex: /(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:§\s*)?)(\d+\.\d+)\b/g, buildRoute: (m) => `/far/${m[1]}` },
  // P/CG glossary term mention — the exact phrase the AIM/FAR scrapers'
  // own citation regex already looks for.
  { regex: /Pilot\/Controller Glossary Term-\s*([^.]+)\.?/g, buildRoute: (m) => `/pcg/${slugifyPcgTerm(m[1].trim())}` },
  // Airworthiness Directive mention ("AD 2026-15-05", "AD 2025-17-12").
  // The AD number format (YYYY-NN-NN) is specific enough on its own that
  // requiring the "AD " prefix is enough to avoid false positives from
  // unrelated dates/numbers in surrounding prose.
  { regex: /\bAD\s+(\d{4}-\d{2}-\d{2})\b/g, buildRoute: (m) => `/ad/${m[1]}` },
]

export function linkifyText(text: string): LinkSegment[] {
  const candidates: CandidateMatch[] = []
  for (const { regex, buildRoute, isFigure } of PATTERNS) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(text))) {
      candidates.push({ start: m.index, end: m.index + m[0].length, text: m[0], route: buildRoute(m), isFigure })
      if (m[0].length === 0) regex.lastIndex++ // guard against a zero-length match looping forever
    }
  }
  // Earliest start first; for ties, the LONGEST match wins (so a broader
  // pattern like the FAR one doesn't get pre-empted by a shorter, looser
  // partial match starting at the same spot).
  candidates.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

  const chosen: CandidateMatch[] = []
  let lastEnd = -1
  for (const c of candidates) {
    if (c.start >= lastEnd) {
      chosen.push(c)
      lastEnd = c.end
    }
  }

  if (chosen.length === 0) return [{ text, route: null }]

  const segments: LinkSegment[] = []
  let cursor = 0
  for (const c of chosen) {
    if (c.start > cursor) segments.push({ text: text.slice(cursor, c.start), route: null })
    segments.push({ text: c.text, route: c.route, isFigure: c.isFigure })
    cursor = c.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), route: null })
  return segments
}
