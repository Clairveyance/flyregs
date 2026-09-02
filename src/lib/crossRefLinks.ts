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
  // A "match but deliberately do NOT link" candidate. It still competes in the
  // earliest-start-wins resolver below, which is the whole point: it CONSUMES
  // the span so a later, wronger pattern can't claim it.
  suppress?: boolean
}

// The document currently being rendered -- only needed to disambiguate a
// BARE "§ N.N" citation (no "FAR"/"14 CFR" prefix), which is real-corpus
// self-citation shorthand in more than one title (confirmed live,
// 2026-08-23 QA sweep: cfr49_sections' own body text, e.g. § 1544.101,
// literally reads "...meets the requirements of § 1544.103...", matching
// sync/cfr49_citations.py's own extraction regex for that exact bare form).
// Omitted (or 'far') preserves this file's original behavior everywhere
// except a 49 CFR document, where a bare "§" now means "this same title,"
// not FAR -- an explicit "FAR "/"14 CFR " prefix is never ambiguous and
// always still means FAR regardless of selfType.
export type SelfType = 'far' | 'cfr49'

interface LinkPattern {
  regex: RegExp
  buildRoute?: (m: RegExpExecArray, selfType?: SelfType) => string
  isFigure?: boolean
  // Claim the span and render it as plain text. Used to stop a bare "part N"
  // under a CFR title we don't carry from falling through to the FAR branch.
  suppress?: boolean
  // For an enumeration match ("§§ 133.19, 133.21, and 133.23") -- returns
  // one candidate per individual citation found inside the whole match,
  // instead of treating the whole span as a single link. Whatever text sits
  // between them (", ", " and ") is left unlinked, same as any other gap.
  // Mutually exclusive with buildRoute (a pattern uses one or the other).
  buildSubMatches?: (m: RegExpExecArray, selfType?: SelfType) => { text: string; offset: number; route: string }[]
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
  // Accepts the spelled-out forms too. AIM prose is inconsistent with
  // itself: most paragraphs write "(See FIG 4-3-4.)" but some write
  // "Figure 4-3-4 is an example of a chart used to determine the
  // headwind..." -- confirmed live in AIM 4-3-3, where that mention
  // rendered as plain text with no way to open the figure it names,
  // even though the figure was sitting in the same paragraph's own
  // Figures & Tables strip. Case-insensitive so "figure"/"table"
  // mid-sentence match too.
  { regex: /\b(?:TBL|FIG|TABLE|FIGURE)\s+(\d+-\d+-\d+[a-z]?)\b/gi, buildRoute: (m) => `/aim/${m[1]}`, isFigure: true },
  // Explicit AIM paragraph reference in prose ("Paragraph 4-3-13", "Para.
  // 4-1-2"). Deliberately requires this prefix rather than matching bare
  // X-X-X numbers anywhere — a bare number in running prose is too easy to
  // false-positive on (dates, unrelated figures, etc).
  { regex: /\bPara(?:graph)?\.?\s+(\d+-\d+-\d+)\b/g, buildRoute: (m) => `/aim/${m[1]}` },
  // AC mention ("AC 90-67B", "(AC) 90-66"). ac/[id].tsx resolves a
  // document_number to its real UUID and redirects, so the raw matched
  // number can route directly with no lookup here.
  // Slash-form AC numbers ("AC 150/5300-13B" -- the entire airport-design 150
  // series) never matched: the `/` breaks `\d+(?:\.\d+)?-\d+`, so 2,614
  // mentions across 148 documents rendered as inert plain text while
  // "AC 90-67B" in the same sentence linked fine. Mirrors the same widening
  // already ported to all five sync/*_citations.py extractors -- this file has
  // now lagged those extractors three separate times.
  // encodeURIComponent because a slash-form number would otherwise emit
  // "/ac/150/5300-13B" -- TWO path segments, which cannot match the
  // single-segment ac/[id] route and would navigate nowhere. A dead link is
  // worse than the inert text this replaces (this file's own rule: an honest
  // non-link beats a confidently wrong one), so the slash is escaped and
  // ac/[id].tsx receives the decoded "150/5300-13B" to resolve against
  // document_number, exactly as it already does for "90-67B".
  { regex: /\bAC\)?\s+(\d+(?:\.\d+)?(?:\/\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b/g, buildRoute: (m) => `/ac/${encodeURIComponent(m[1])}` },
  // FAR section mention ("§ 91.107", "FAR 91.107", "FAR Section 91.107",
  // "14 CFR 91.107", "14 CFR section 91.107") -- confirmed live as a real
  // gap: AIM 5-4-9's "(14 CFR section 91.123)" rendered as plain text, not
  // a link, because the word "section" between "14 CFR" and the number
  // wasn't accounted for. "FAR Section N.N" (not just "14 CFR section N.N")
  // added 2026-08-19 -- a real user reported AC 120-12A doesn't MagicLink to
  // the FARs its own body plainly cites; its actual text reads "FAR Section
  // 91.181", which this pattern's "FAR " branch never allowed a "Section "
  // word after (only the "14 CFR" branch did) -- confirmed corpus-wide,
  // 15 ACs use this exact phrasing.
  // "section 8.4 of FAA Handbook AF P 6790.9" (FAR 171.7) is NOT a FAR
  // citation -- it points into an FAA handbook that happens to number its own
  // sections the same way. Caught while adding the bare-"Section N.N" rule
  // below: without this it would have linked to a nonexistent /far/8.4. Listed
  // BEFORE that rule so it wins the overlap (see this file's longest-match /
  // first-listed resolution note).
  { regex: /\b[Ss]ection\s+\d+\.\d+\s+of\s+(?:the\s+)?(?:FAA\s+)?(?:Handbook|Order|Advisory|Annex|ICAO)\b/g, suppress: true },
  {
    // A BARE "Section N.N" (no §, no FAR, no 14 CFR) added 2026-09-01. RC,
    // real device: "On this page, these other sections aren't hyperlinked.
    // They need to be." Confirmed corpus-wide before changing anything: 234
    // such references across 33 sections went unlinked, and they cluster in
    // exactly the places a reader most wants to tap through -- 107.205
    // (waiver of part 107 rules) is a LIST of them: "Section 107.25 --
    // Operation from a moving vehicle", "Section 107.31 -- Visual line of
    // sight", and so on. Safe because it still requires a real N.N section
    // number after the word, so prose like "this section" or "Section 8"
    // cannot match.
    regex: /(?:§\s*|\bFAR\s+(?:[Ss]ection\s+)?|\b14\s*CFR\s*(?:section\s+|§\s*)?|\b[Ss]ection\s+)(\d+\.\d+)\b/g,
    // A BARE "§ N.N" (nothing precedes the § in the match itself) is the
    // only ambiguous case -- "FAR "/"14 CFR " are unambiguous prefixes and
    // always mean FAR. See this file's SelfType comment for the real
    // cfr49-body-text repro this fixes (was always routing to a
    // nonexistent /far/1544.103-style section instead of /cfr49/1544.103).
    // "FAR "/"14 CFR " are unambiguous and always mean FAR. A bare "§ N.N" OR
    // a bare "Section N.N" carries no corpus of its own, so inside a 49 CFR
    // body it means that document's own corpus -- same reasoning, now applied
    // to both bare forms rather than only to §.
    buildRoute: (m, selfType) =>
      selfType === 'cfr49' && /^(?:§|[Ss]ection\b)/.test(m[0].trimStart())
        ? `/cfr49/${m[1]}`
        : `/far/${m[1]}`,
  },
  // 49 CFR section mention ("49 CFR 175.10", "49 CFR part 175.10") --
  // mirrors sync/ac_citations.py's and sync/aim_far_citations.py's own
  // CFR49_RE exactly (same server-side extraction that already produces a
  // real cited_type='cfr49' document_citations row for this text -- 98 real
  // rows confirmed live, 2026-08-23 QA sweep), but nothing rendered these as
  // tappable links in body text -- same "extracted but never linkified" gap
  // this file's own header comment describes for the patterns above, just
  // never closed for 49 CFR specifically.
  { regex: /\b49\s*CFR\s*(?:part\s+)?(\d+\.\d+)\b/gi, buildRoute: (m) => `/cfr49/${m[1]}` },
  // FAR section ENUMERATION ("§§ 133.19, 133.21, and 133.23", "§§ 133.41
  // and 133.43", "§§ 91.1 through 91.21") -- confirmed live, RC: "in FAR
  // 133, in the text body, there are 3 other FARs referenced. only the
  // first one has a hyperlink." Root cause: the single-citation pattern
  // above only recognizes a number immediately preceded by its own
  // "§"/"FAR"/"14 CFR" marker -- legal-citation lists conventionally carry
  // that marker ONCE, up front ("§§ A, B, and C" / "§§ A through B"),
  // leaving every number after the first with nothing for that pattern to
  // match on. This pattern instead matches the WHOLE list as one span (so
  // a `(b)`-style subparagraph between numbers like "27.865(b) and
  // 29.865(b)" doesn't break the scan), then hands back one sub-candidate
  // per bare X.X number found inside it via buildSubMatches -- each
  // becomes its own tappable link, with the connecting ", "/" and "/"
  // through " left as plain text between them, exactly like the
  // single-citation pattern already leaves surrounding prose alone.
  //
  // "through" added 2026-08-13 (RC screenshot, FAR 91.1(b)): a real,
  // corpus-wide-affecting gap distinct from the and/or case above --
  // "§§ 91.1 through 91.21" only ever linked 91.1, leaving 91.21 (the
  // RANGE's own second endpoint, a real, separately citable section)
  // permanently inert. This links the two endpoints actually named in the
  // text, same "link what's mentioned, don't try to be exhaustive"
  // posture as the and/or list case -- it does not attempt to enumerate
  // every section the range implies, which isn't knowable from FAR
  // section numbers alone (they aren't sequential integers).
  {
    regex: /(?:§§?\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+(?:\([a-zA-Z0-9]+\))?(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|through)\s+)\d+\.\d+(?:\([a-zA-Z0-9]+\))?)+)/g,
    // Same bare-"§§" ambiguity as the single-citation pattern above, same
    // fix -- see this file's SelfType comment.
    buildSubMatches: (m, selfType) => {
      const list = m[1]
      const offset = m[0].length - list.length
      const bareSection = m[0].trimStart().startsWith('§')
      const prefix = selfType === 'cfr49' && bareSection ? '/cfr49/' : '/far/'
      const subs: { text: string; offset: number; route: string }[] = []
      const numRe = /\d+\.\d+/g
      let sm: RegExpExecArray | null
      while ((sm = numRe.exec(list))) {
        subs.push({ text: sm[0], offset: offset + sm.index, route: `${prefix}${sm[0]}` })
      }
      return subs
    },
  },
  // Bare FAR Part mention ("Part 91", "14 CFR part 91", "FAR Part 61") with
  // no following section number -- mirrors sync/pcg_citations.py's own
  // FAR_PART_RE exactly (same server-side extraction that already produces
  // a real far_part document_citations row for this text), so a mention the
  // scraper counts is now also the mention that's actually tappable. Real
  // gap RC originally reported: P/CG's IFR_TAKEOFF_MINIMUMS_AND_DEPARTURE_
  // PROCEDURES definition reads "...part 91, prescribes standard takeoff
  // rules..." — MagicLinkPod correctly counted/linked this citation in the
  // bar below, but the same words in the body text rendered as inert plain
  // text, since this pattern didn't exist yet. Negative lookahead avoids
  // double-matching when a real dotted section immediately follows (the
  // FAR-section pattern above already handles that case on its own).
  // A "49 CFR " prefix gets its own branch first, routed to /cfr49/part/N
  // instead of /far/part/N -- confirmed live as a real MISLINK, not just a
  // miss, 2026-08-27 CFI RefPack audit: without this branch, "49 CFR part
  // 830" was matched by the generic (?:14 CFR|FAR)? branch below with its
  // optional group simply skipped, silently dropping the "49 CFR" prefix
  // and sending the reader to /far/part/830 -- a nonexistent FAR part,
  // since 830 is a CFR49 part number, not a FAR one. /cfr49/part/[part].tsx
  // already exists (mirrors far/part/[part].tsx) so this is a routing fix
  // only. {1,4} digits, not {1,3} like the FAR branch below -- real CFR49
  // parts run into 4 digits (TSA's 1544 and 1552, both real corpus parts,
  // both named in RC's own CFI-oral checklist under Security/TSA), unlike
  // FAR parts which never do.
  { regex: /\b49\s*CFR\s*[Pp]art\s+(\d{1,4})\b(?!\.\d)/g, buildRoute: (m) => `/cfr49/part/${m[1]}` },
  // A bare "part N" under a CFR title we do NOT carry must not fall through to
  // the generic FAR branch below. Same silently-optional-prefix trap as the
  // "49 CFR part 830" -> /far/part/830 mislink already fixed above: the `14 CFR`
  // prefix group is optional, so "1 CFR part 51" matched as if it were a FAR
  // part. This is not a missing link, it is a CONFIDENTLY WRONG one, and it is
  // corpus-wide -- every AD carries the incorporation-by-reference boilerplate
  // "...under 5 U.S.C. 552(a) and 1 CFR part 51.", so nearly every AD detail
  // screen rendered a tappable link to a 14 CFR Part 51 that does not exist.
  // Verified by running the real linkifyText: that sentence produced
  // "part 51" -> /far/part/51.
  { regex: /\b(?!14\b|49\b)\d{1,2}\s*CFR\s*[Pp]arts?\s+\d{1,4}\b(?!\.\d)/g, suppress: true },
  { regex: /\b(?:14\s*CFR\s*|FAR\s+)?[Pp]art\s+(\d{1,3})\b(?!\.\d)/g, buildRoute: (m) => `/far/part/${m[1]}` },
  // Plural "Parts N, M, and O" / "Parts N or M" -- the singular pattern
  // above requires "Part" immediately followed by exactly one number, so a
  // list like "Federal Aviation Regulations (FAR) Parts 121 or 135" (real
  // text, AC 120-12A) never matched at all. Confirmed corpus-wide (197
  // rows across AC/LOI/AD/FAR/CFR49). Same buildSubMatches shape as the FAR
  // section enumeration pattern above: match the whole list as one span,
  // then hand back one sub-candidate per bare part number inside. Mirrors
  // sync/*_citations.py's own FAR_PART_ENUM_RE exactly.
  //
  // Same "49 CFR" branch-first fix as the singular pattern above, same real
  // repro: ACS references_text routinely reads "49 CFR parts 175, 830, and
  // 1544" (confirmed live, e.g. FAA-S-8081-10E Area I.A) -- without this
  // branch every number in that list would mislink to /far/part/N instead
  // of /cfr49/part/N. {1,4} digits for the same reason as the singular
  // branch above -- this exact repro string's own "1544" would silently
  // fail to match at all under a {1,3} cap.
  {
    regex: /\b49\s*CFR\s*[Pp]arts\s+(\d{1,4}(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|through)\s+)\d{1,4})+)\b/g,
    buildSubMatches: (m) => {
      const list = m[1]
      const offset = m[0].length - list.length
      const subs: { text: string; offset: number; route: string }[] = []
      const numRe = /\d{1,4}/g
      let sm: RegExpExecArray | null
      while ((sm = numRe.exec(list))) {
        subs.push({ text: sm[0], offset: offset + sm.index, route: `/cfr49/part/${sm[0]}` })
      }
      return subs
    },
  },
  {
    regex: /\b(?:14\s*CFR\s*|FAR\s+)?[Pp]arts\s+(\d{1,3}(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|through)\s+)\d{1,3})+)\b/g,
    buildSubMatches: (m) => {
      const list = m[1]
      const offset = m[0].length - list.length
      const subs: { text: string; offset: number; route: string }[] = []
      const numRe = /\d{1,3}/g
      let sm: RegExpExecArray | null
      while ((sm = numRe.exec(list))) {
        subs.push({ text: sm[0], offset: offset + sm.index, route: `/far/part/${sm[0]}` })
      }
      return subs
    },
  },
  // P/CG glossary term mention — the exact phrase the AIM/FAR scrapers'
  // own citation regex already looks for.
  { regex: /Pilot\/Controller Glossary Term-\s*([^.]+)\.?/g, buildRoute: (m) => `/pcg/${slugifyPcgTerm(m[1].trim())}` },
  // Airworthiness Directive mention ("AD 2026-15-05", "AD 2025-17-12").
  // The AD number format (YYYY-NN-NN) is specific enough on its own that
  // requiring the "AD " prefix is enough to avoid false positives from
  // unrelated dates/numbers in surrounding prose.
  { regex: /\bAD\s+(\d{4}-\d{2}-\d{2})\b/g, buildRoute: (m) => `/ad/${m[1]}` },
  // AD table/figure caption mention ("Table 1 to Paragraph (c)", "Figure 1
  // to paragraph (j)") -- RC: "make sure the T&Fs are properly hyperlinked
  // in the text bodies." AD figures don't have per-page labels the way
  // AC/AIM figures do (see ad_figures' own comment), so there's no exact
  // label to resolve against -- ad/[id].tsx passes PlainTextBody a single
  // synthetic figures[0] instead of one per page specifically so the
  // isFigure length===1 fallback always resolves cleanly regardless of
  // which of an AD's (usually 1-3) relevant pages this exact mention
  // refers to. route is never actually used for navigation (isFigure
  // intercepts before routing) -- must still be a non-empty string, or
  // this wouldn't render as tappable at all.
  { regex: /\b(?:Table|Figure)\s+\d+[a-zA-Z]?\s+to\s+[Pp]aragraph\s*\([a-zA-Z0-9]+\)/gi, buildRoute: () => 'ad-figure', isFigure: true },
]

export function linkifyText(text: string, selfType?: SelfType): LinkSegment[] {
  const candidates: CandidateMatch[] = []
  for (const { regex, buildRoute, isFigure, buildSubMatches, suppress } of PATTERNS) {
    regex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = regex.exec(text))) {
      if (buildSubMatches) {
        for (const sub of buildSubMatches(m, selfType)) {
          candidates.push({ start: m.index + sub.offset, end: m.index + sub.offset + sub.text.length, text: sub.text, route: sub.route })
        }
      } else {
        candidates.push({ start: m.index, end: m.index + m[0].length, text: m[0], route: suppress ? '' : buildRoute!(m, selfType), isFigure, suppress })
      }
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
    segments.push({ text: c.text, route: c.suppress ? null : c.route, isFigure: c.isFigure })
    cursor = c.end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), route: null })
  return segments
}
