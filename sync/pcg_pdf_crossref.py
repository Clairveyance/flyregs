"""Cross-references every pcg_terms row (scraped from the FAA's P/CG HTML
edition) against the real Pilot/Controller Glossary text in the official
AIM PDF (the P/CG is literally the AIM's own glossary section).

MUST be run against the full "AIM Basic" edition
(faa.gov/air_traffic/publications/media/AIM_Basic_dtd_<date>_post.pdf), NOT
the "Basic w/ Chg N" bundle sync_aim.sh downloads -- confirmed live as a
real, significant surprise: the "Chg 1/2/3" combined PDF's glossary section
is a CHANGES-ONLY reprint, containing only the letters actually touched by
those changes (as of this writing: C, R, S only -- 3 of 23 letters). Using
it alone produced 844 of 1332 terms "not found", which looked like a
catastrophic scraper failure but was actually just this script pointed at
an incomplete document. The full Basic edition (dated before the changes
were incorporated) has the complete A-W glossary; expect a small, genuine
set of "not found" results for terms added/modified by later changes (e.g.
"COMBINED CONTROL FACILITY (CCF)", explicitly listed as newly-added in the
Chg 3 "EXPLANATION OF CHANGES" front matter) -- same "eCFR/HTML may be
ahead of the PDF baseline" pattern as FAR, not an error to chase.

Unlike FAR's cross-reference, this does NOT try to precisely segment the
PDF into per-term boundaries -- the glossary's PDF layout has no reliable
font/style signal distinguishing a new term from a continuation line (every
line is the same Times-Roman body font), and building a boundary regex
risks getting it wrong exactly at case boundaries with lots of embedded
ALL-CAPS acronyms mid-definition. Instead: the whole glossary is one
normalized text blob, and each DB definition is checked for whether its own
wording (first N words) actually appears in it -- robust to the PDF's own
segmentation, still catches "wrong/fabricated definition text" or "this
term has no basis in the real document at all."

Usage: python3 pcg_pdf_crossref.py <path-to-aim-basic.pdf>
"""
from __future__ import annotations

import os
import re
import sys

import fitz
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

GLOSSARY_START_MARKER = "Glossary was compiled"
INDEX_START_MARKER = "[References are to page numbers]"

WORD_RE = re.compile(r"[a-z0-9]+")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower())


def extract_glossary_text(pdf_path: str) -> str:
    doc = fitz.open(pdf_path)
    start_page = None
    end_page = doc.page_count
    for i, page in enumerate(doc):
        text = page.get_text()
        if start_page is None and GLOSSARY_START_MARKER in text:
            start_page = i
        elif start_page is not None and INDEX_START_MARKER in text:
            end_page = i
            break
    if start_page is None:
        raise RuntimeError("Could not find glossary start page")
    parts = [doc[i].get_text() for i in range(start_page, end_page)]
    text = " ".join(parts).lower()
    # Strip punctuation FIRST, then collapse whitespace -- confirmed live
    # as a real bug otherwise: removing a curly quote adjacent to an
    # already-single-spaced word (`is "abeam" a` -> `is  abeam  a`)
    # introduces a NEW double space that a later whitespace-collapse never
    # runs again to fix, so an exact-phrase substring search silently
    # fails even when the real wording is right there.
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return re.sub(r"\s+", " ", text)


def fetch_all_pcg_terms() -> list[dict]:
    out = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/pcg_terms?select=term,slug,definition&limit=1000&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 pcg_pdf_crossref.py <path-to-aim.pdf>")
        sys.exit(1)

    glossary_text = extract_glossary_text(sys.argv[1])
    print(f"Extracted glossary text: {len(glossary_text)} chars")

    terms = fetch_all_pcg_terms()
    print(f"DB: {len(terms)} P/CG terms")

    no_own_definition = 0  # see-ref-only terms, nothing to check
    not_found = []
    found = 0

    for row in terms:
        definition = (row["definition"] or "").strip()
        if not definition or definition.lower().startswith("(see") or "see-ref only" in definition.lower():
            no_own_definition += 1
            continue
        words = WORD_RE.findall(definition.lower())
        if len(words) < 4:
            no_own_definition += 1
            continue
        # First 8 real words of the definition, as a phrase -- specific
        # enough to not false-positive-match unrelated text, short enough
        # to survive minor PDF word-wrap/whitespace differences.
        probe = " ".join(words[:8])
        if probe in glossary_text:
            found += 1
        else:
            not_found.append((row["term"], definition[:100]))

    print(f"\nFound in PDF (definition wording confirmed): {found}")
    print(f"No standalone definition to check (see-ref only, etc.): {no_own_definition}")
    print(f"NOT FOUND in PDF glossary text: {len(not_found)}")
    print("\n--- Sample NOT FOUND (up to 30) ---")
    for term, snippet in not_found[:30]:
        print(f"  {term} | {snippet}")


if __name__ == "__main__":
    main()
