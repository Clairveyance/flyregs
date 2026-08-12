#!/usr/bin/env python3
"""
LOI -> LOI citation extraction.
================================
Real gap found 2026-08-12: an interpretation frequently cites PRIOR
interpretations by name (footnotes like "Legal Interpretation to Buster
W. Desselles Jr., from Rebecca B. MacPherson, Assistant Chief Counsel
for Regulations (July 31, 2009)."), but document_citations has never
had a single loi->loi row -- this citation TYPE was already fully wired
on the client side (citedItems.ts's CitedType union already includes
'loi', routeForCitedItem already returns /loi/${citedId}, MagicLinkPod
already knows how to resolve it via legal_interpretations.slug/title),
just never populated. Confirmed via `git log`/grep before writing this:
no other script has ever written cited_type='loi' rows.

WHY THE FOOTNOTE FORM, NOT THE INLINE "Name (year)" SHORTHAND
---------------------------------------------------------------
LOI bodies use both shapes. The footnote form ("Legal Interpretation to
<Name>, from <author>, <title> (<Month> <Day>, <Year>)") is the
structured, low-ambiguity one -- a fixed lead-in phrase, a full name,
and a real full date. The inline shorthand ("Desselles (2009)") is
genuinely ambiguous in isolation: bare "<Word> (<4 digits>)" can occur
in ordinary prose for all sorts of non-citation reasons. This module
only extracts from footnotes. It deliberately leaves inline shorthand
alone -- real content example that shows why the two shapes can even
disagree WITHIN one document: van-west-2018's footnote spells the name
"Desselles" but its own inline prose two pages later spells it
"Dessalles" (a real human/OCR inconsistency in the same PDF). Anchoring
matching to the more structured, single-spelling footnote form avoids
having to arbitrate between two different spellings of the same name.

MATCHING: NAME+YEAR AGAINST THE SLUG, NEVER A BARE SUBSTRING GUESS
---------------------------------------------------------------------
legal_interpretations.slug is not always "surname-year". Confirmed by
direct query before writing any matching logic:
    - "Buster W. Desselles Jr." (2009) -> slug "desselles-jr-2009"
      (surname is NOT the whole slug -- there's a suffix token first)
    - "John G. Olshock" (2010) -> slug
      "olshock-transpac-a-via-ti-on-academy-2010" (OCR-mangled middle,
      but the FIRST hyphen-token is still the clean surname)
    - newer/2024-era slugs sometimes lead with the YEAR instead of a
      name at all ("2024-frigid-air-drug-and-alcohol-reporting-legal-
      interpretation-of-14-cfr-part-111-111-220")
So a same-string-prefix match is not reliable. Instead: build an index
of every individual hyphen-split token in every slug, keyed by
(token, year) -- not just the first token -- and look up the
footnote's extracted surname (lowercased, punctuation stripped) plus
its extracted year against that index.

CONFIDENCE GATE: only write a link when the (surname, year) lookup
resolves to EXACTLY ONE legal_interpretations row. Zero matches means
that interpretation either isn't in our corpus (real, not an error --
e.g. van-west-2018's own footnote cites a 2010 David Tuuri letter that
doesn't exist as a separate DB row; only "tuuri-2011" does) or the
matcher missed it -- either way, silently NOT linking is always safe,
since the citation text itself is untouched in body_text regardless.
Two-or-more matches (a genuine surname collision within the same year)
is also left unresolved rather than guessed -- same "never guess wrong"
posture loi_citation_extract.py already established for FAR sections.

Usage:
    python3 sync/loi_loi_citations.py            # dry run, full report
    python3 sync/loi_loi_citations.py --write     # apply to document_citations
"""
from __future__ import annotations

import argparse
import os
import re
import sys

import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (source .env.scraper first)", file=sys.stderr)
    sys.exit(1)

HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

# "Legal Interpretation to <Name>, from <author/title text, up to 150
# chars> (<Month> <Day>, <Year>)" -- the trailing date's month/day are
# optional (a small number of footnotes give only a year), but the
# parenthesized 4-digit year is required. Non-greedy body so this stops
# at the FIRST parenthesized date after "from", which is this footnote's
# own -- footnotes in these letters are always a single sentence long,
# confirmed against every real sample pulled during development.
_FOOTNOTE_RE = re.compile(
    r"Legal Interpretation to\s+([A-Z][^,]{2,60}?),\s*from\s+.{0,150}?"
    r"\((?:[A-Za-z]+\.?\s+\d{1,2},\s*)?(\d{4})\)",
    re.DOTALL,
)

# Suffix tokens that can trail a surname in the captured name -- strip
# before taking the last word as the surname itself.
_SUFFIXES = {"jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "esq", "esq."}


def rest_get_all(path: str, select: str, extra_params: dict | None = None) -> list[dict]:
    out, offset, page = [], 0, 1000
    while True:
        params = {"select": select, "offset": offset, "limit": page}
        if extra_params:
            params.update(extra_params)
        resp = requests.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        chunk = resp.json()
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def build_slug_index(rows: list[dict]) -> dict[tuple[str, int], list[dict]]:
    """(hyphen-token, year) -> [{id, slug}, ...] for every real LOI row."""
    index: dict[tuple[str, int], list[dict]] = {}
    for row in rows:
        if row.get("year") is None:
            continue
        tokens = set(t for t in row["slug"].lower().split("-") if t and not t.isdigit())
        for tok in tokens:
            index.setdefault((tok, row["year"]), []).append({"id": row["id"], "slug": row["slug"]})
    return index


def extract_surname(raw_name: str) -> str | None:
    words = [w.strip(".,") for w in raw_name.strip().split() if w.strip(".,")]
    while words and words[-1].lower() in _SUFFIXES:
        words.pop()
    if not words:
        return None
    surname = re.sub(r"[^a-z]", "", words[-1].lower())
    return surname or None


def extract_citations(body_text: str, self_slug: str, index: dict[tuple[str, int], list[dict]]) -> list[dict]:
    """Returns [{raw_name, year, matched_slug|None, candidates: [...]}], one
    per distinct (surname, year) footnote found. Never includes a
    citation resolving to this document's own slug (self-citation footnotes
    do occur -- a letter re-quoting its own prior paragraph -- and would be
    a meaningless self-link)."""
    seen: dict[tuple[str, int], dict] = {}
    for m in _FOOTNOTE_RE.finditer(body_text):
        raw_name, year_s = m.group(1), m.group(2)
        year = int(year_s)
        surname = extract_surname(raw_name)
        if not surname:
            continue
        key = (surname, year)
        if key in seen:
            continue
        candidates = index.get(key, [])
        candidates = [c for c in candidates if c["slug"] != self_slug]
        matched = candidates[0]["slug"] if len(candidates) == 1 else None
        seen[key] = {
            "raw_name": raw_name.strip(),
            "surname": surname,
            "year": year,
            "matched_slug": matched,
            "n_candidates": len(candidates),
        }
    return list(seen.values())


def write_citations(citing_slug: str, resolved: list[dict]) -> None:
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        # Scoped delete -- same defect class already fixed once in
        # ad_citations.py/loi_scraper.py: never delete rows this script
        # doesn't own (loi->far, loi->ac, loi->pcg are owned by other
        # scripts sharing this same citing_id).
        params={"citing_type": "eq.loi", "citing_id": f"eq.{citing_slug}", "cited_type": "eq.loi"},
        timeout=15,
    )
    if not resolved:
        return
    rows = [
        {"citing_type": "loi", "citing_id": citing_slug, "cited_type": "loi", "cited_id": r["matched_slug"], "label": None}
        for r in resolved
    ]
    requests.post(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows,
        timeout=15,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="Apply resolved citations to document_citations (default: dry run report only)")
    ap.add_argument("--limit", type=int, default=None, help="Only process the first N candidate docs (debugging)")
    args = ap.parse_args()

    print("Fetching legal_interpretations index...")
    all_rows = rest_get_all("legal_interpretations", "id,slug,year")
    print(f"  {len(all_rows)} total rows.")
    index = build_slug_index(all_rows)

    print("Fetching candidate docs (body_text mentions 'Legal Interpretation to')...")
    candidates = rest_get_all(
        "legal_interpretations", "id,slug,body_text",
        extra_params={"body_text": "ilike.*Legal Interpretation to*"},
    )
    print(f"  {len(candidates)} candidate docs.")
    if args.limit:
        candidates = candidates[: args.limit]

    total_footnotes = 0
    total_resolved = 0
    total_ambiguous = 0
    total_unresolved = 0
    docs_with_resolved = 0

    for doc in candidates:
        cites = extract_citations(doc["body_text"], doc["slug"], index)
        if not cites:
            continue
        resolved = [c for c in cites if c["matched_slug"]]
        ambiguous = [c for c in cites if not c["matched_slug"] and c["n_candidates"] > 1]
        unresolved = [c for c in cites if not c["matched_slug"] and c["n_candidates"] == 0]

        total_footnotes += len(cites)
        total_resolved += len(resolved)
        total_ambiguous += len(ambiguous)
        total_unresolved += len(unresolved)
        if resolved:
            docs_with_resolved += 1

        print(f"\n{doc['slug']}:")
        for c in cites:
            if c["matched_slug"]:
                print(f"  RESOLVED   {c['raw_name']!r} ({c['year']}) -> {c['matched_slug']}")
            elif c["n_candidates"] > 1:
                print(f"  AMBIGUOUS  {c['raw_name']!r} ({c['year']}) -> {c['n_candidates']} candidates, skipped")
            else:
                print(f"  unresolved {c['raw_name']!r} ({c['year']}) -> no match in corpus")

        if args.write and resolved:
            write_citations(doc["slug"], resolved)

    print("\n" + "=" * 70)
    print(f"Docs scanned: {len(candidates)}  |  docs with >=1 resolved citation: {docs_with_resolved}")
    print(f"Footnote citations found: {total_footnotes}  |  resolved: {total_resolved}  "
          f"ambiguous(skipped): {total_ambiguous}  unresolved(skipped): {total_unresolved}")
    if not args.write:
        print("\nDRY RUN -- no writes made. Re-run with --write to apply resolved citations.")


if __name__ == "__main__":
    main()
