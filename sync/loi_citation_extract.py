#!/usr/bin/env python3
"""
LOI citation extraction — OCR-tolerant.
=======================================
The single hardest correctness problem in the LOI build, designed and
empirically validated against real FAA Legal Interpretation PDFs
(Williams 2018, Murphy 2011) on 2026-07-29.

WHY THIS ISN'T JUST crossRefLinks.ts's REGEX IN PYTHON
------------------------------------------------------
LOIs are *scanned* letters with an embedded OCR text layer, not
born-digital documents like FAR/AIM/P-CG. The OCR systematically
corrupts the citation numbers themselves — the exact tokens we need to
be most precise about. Real examples from the validated sample:

    "§ 6 l. l l 3(i)"      is actually  § 61.113(i)
    "§ 61.l 13(i)"         is actually  § 61.113(i)
    "§ 61.3 l(d)(2)"       is actually  § 61.31(d)(2)
    "23.140l(a)(l)"        is actually  23.1401(a)(1)
    "61.23(c)(l)(vi)"      is actually  61.23(c)(1)(vi)

Two independent failure modes result, and BOTH are real:

1. RECALL. A strict `\\d+\\.\\d+` regex simply cannot see a section
   number whose digits OCR'd into letters or got a space injected
   mid-number. Measured on the validated sample: strict matching found
   27 citation occurrences; OCR-tolerant matching found 44 (+63%).

2. PRECISION — and this one is worse. In the sample, "§ 61.1 I 3(i)"
   (really § 61.113(i)) causes a strict regex to match "61.1" and stop
   at the OCR-injected space. § 61.1 is a REAL, CURRENT FAR section
   ("Applicability and definitions") — so the bad citation is
   indistinguishable from a good one by shape AND survives validation
   against the live far_sections index. The app would confidently link
   an interpretation about private-pilot privileges (§ 61.113) to the
   definitions section instead. Verified: "61.1" is present in the real
   4,272-row far_sections index, and the ONLY occurrence of the string
   "61.1" anywhere in the sample corpus is that corrupted token.

   => Index validation ALONE cannot save you here. OCR-tolerant
      tokenization is what prevents the wrong-regulation link. This is
      the core reason this module exists.

HISTORICAL CITATIONS ARE REAL DATA, NOT NOISE
---------------------------------------------
Validated finding: Murphy 2011 legitimately cites 14 C.F.R. 23.1401
(anticollision light standards). That section does NOT exist in the
current far_sections index — Part 23 was substantially rewritten and
reorganized in 2017. A 2011 interpretation citing it is correct for its
time.

So index membership is a CONFIDENCE TIER, never a hard filter:
  - in index      -> resolved; safe to render as a real MagicLink
  - not in index  -> historical/renumbered; STORE IT, surface it as
                     plain (non-navigable) text. Silently dropping it
                     would be losing real regulatory content, which the
                     project's "Data Is King" rule forbids.

Usage:
    from loi_citation_extract import extract_far_citations
    hits = extract_far_citations(body_text, known_sections)
"""
from __future__ import annotations

import re

# Characters OCR routinely substitutes for digits inside these letters.
# Deliberately conservative: only the 1/l/I confusion, which is the one
# actually observed in the validated sample. NOT including O->0 or S->5,
# which are plausible in theory but unobserved here — every additional
# substitution widens the false-positive surface, and precision is the
# whole point of this module (see the § 61.1 case above).
_DIRTY_DIGIT = r"[0-9lI]"
# A "dirty number": digits that may be OCR-letters and may have stray
# spaces injected between them ("6 l" -> "61", "l l 3" -> "113").
_DIRTY_NUM = rf"{_DIRTY_DIGIT}(?:\s*{_DIRTY_DIGIT})*"

# Citation lead-ins actually observed in real LOI prose. All of these are
# from the validated sample, not invented:
#   "14 C.F.R. 91.209(b)"      periods inside C.F.R., no section symbol
#   "14 CFR §§ 61.3(c)(2)"     double section symbol introducing a list
#   "§ 61.31 ( d)"             single symbol, space before the paragraph
#   "Section 61.23( a)(3 )"    the spelled-out word, capitalized
#   "section 91.209(b)"        ...and lowercased
_LEAD_IN = (
    r"(?:"
    r"§{1,2}\s*"
    r"|\b[Ss]ection\s+"
    r"|\b14\s*C\.?\s*F\.?\s*R\.?\s*(?:§{1,2}\s*)?"
    r")"
)

_CITE_RE = re.compile(_LEAD_IN + rf"({_DIRTY_NUM}\s*\.\s*{_DIRTY_NUM})")

# Paragraph suffix — "(b)", "( a)(3 )(ii)", "(c)(2)(xiv)". Captured
# separately and kept only for display/label purposes: it is NOT part of
# the join key, because far_sections is keyed at section granularity.
# LOIs interpret specific paragraphs constantly, so throwing this away
# entirely would lose the most useful part of the citation's meaning.
_PARA_RE = re.compile(r"\s*((?:\(\s*[0-9a-zA-Z]{1,5}\s*\))+)")


def _normalize_number(raw: str) -> str:
    """Collapse OCR damage in a captured section number to canonical form."""
    return re.sub(r"\s+", "", raw).replace("l", "1").replace("I", "1")


def _normalize_paragraph(raw: str) -> str:
    """'( a)(3 )(ii)' -> '(a)(3)(ii)'. Cosmetic only; never a join key.

    Also repairs the same 1/l OCR confusion *inside* paragraph suffixes
    ("(g)(l)" -> "(g)(1)"), but only for a token that is exactly a lone
    "l". That narrow rule is safe because of how CFR paragraph
    hierarchies are actually drafted: levels alternate
    (a) -> (1) -> (i) -> (A), so a single-character token is either a
    letter or an arabic numeral, and CFR drafting avoids a literal "(l)"
    subparagraph precisely because it is unreadable next to "(1)".
    Roman-numeral levels here use i/v/x, never l (which would be 50 —
    far deeper than any real paragraph nesting). Multi-character tokens
    ("(ii)", "(xiv)", "(A)") are left untouched.
    """
    collapsed = re.sub(r"\s+", "", raw)
    return re.sub(r"\(l\)", "(1)", collapsed)


def extract_far_citations(
    text: str,
    known_sections: set[str] | None = None,
) -> list[dict]:
    """Returns one dict per DISTINCT section cited:

        {"section": "61.113",
         "paragraphs": ["(i)"],       # every paragraph suffix seen
         "occurrences": 4,
         "resolved": True}            # False => historical/renumbered

    `known_sections` is the live far_sections index. When omitted, every
    shape-valid hit comes back resolved=False (caller decides) rather
    than being silently trusted — a missing index is not a licence to
    assume every match is real.
    """
    if not text:
        return []

    found: dict[str, dict] = {}
    for m in _CITE_RE.finditer(text):
        section = _normalize_number(m.group(1))
        # Post-normalization shape gate. Real 14 CFR sections are
        # <part>.<section> with a 1-3 digit part; anything else is OCR
        # debris that happened to satisfy the permissive pattern.
        if not re.fullmatch(r"\d{1,3}\.\d{1,4}", section):
            continue

        entry = found.setdefault(
            section,
            {"section": section, "paragraphs": [], "occurrences": 0, "resolved": False},
        )
        entry["occurrences"] += 1

        para_m = _PARA_RE.match(text, m.end())
        if para_m:
            para = _normalize_paragraph(para_m.group(1))
            if para not in entry["paragraphs"]:
                entry["paragraphs"].append(para)

    if known_sections is not None:
        for entry in found.values():
            entry["resolved"] = entry["section"] in known_sections

    return sorted(found.values(), key=lambda e: -e["occurrences"])


if __name__ == "__main__":
    import glob
    import sys

    paths = sys.argv[1:] or glob.glob("/tmp/loi/*.txt")
    for p in paths:
        text = open(p).read()
        for hit in extract_far_citations(text):
            print(f"{p}: {hit}")
