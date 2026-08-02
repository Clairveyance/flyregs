#!/usr/bin/env python3
"""Load the Aviation Dictionary's Aviation Weather Handbook (FAA-H-8083-28B)
Appendix E tier -- "Abbreviations, Acronyms, and Initialisms" -- ONLY terms
not already covered by an earlier tier. No LLM used: this appendix is
simple `TERM  Definition` lines (space-separated, no em-dash), parsed
directly via regex from pypdf's own extract_text() output.

Source: https://www.faa.gov/sites/faa.gov/files/FAA-H-8083-28B.pdf
(fetched 2026-08-01, pages 499-508 of 514, "Appendix E")

Usage:
  python3 sync/load_dictionary_weather_appendix_e.py --dry-run
  python3 sync/load_dictionary_weather_appendix_e.py
"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, mgmt_sql  # noqa: E402

RAW_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".weather_appendix_e_raw.txt")
SKIP_PREFIXES = ("Note:",)  # footnotes, not real entries
SKIP_TERMS = {"and"}  # a stray line-wrap fragment of the appendix's own title ("...Acronyms, and\nInitialisms")


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def parse_entries():
    text = open(RAW_PATH, encoding="utf-8").read()
    entries = []
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("Appendix") or line.startswith(SKIP_PREFIXES):
            continue
        m = re.match(r"^(\d+D|\d+\s+[A-Z]{2,6}|U\.S\.|[A-Za-z0-9][A-Za-z0-9\-/]{0,9})\s+(.+)$", line)
        if m:
            term, defn = m.group(1), m.group(2)
            if term.startswith("°") or term in SKIP_TERMS:
                continue
            entries.append((term, defn))
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    entries = parse_entries()
    print(f"Parsed {len(entries)} raw entries.")

    existing = {r["term"] for r in mgmt_sql("select term from dictionary_terms")}
    new_entries = [(t, d) for t, d in entries if t not in existing]
    print(f"{len(new_entries)} not already covered by an earlier tier.")

    merged = {}
    for term, defn in new_entries:
        merged.setdefault(term, [])
        if defn not in merged[term]:
            merged[term].append(defn)

    rows = [{
        "term": term,
        "slug": f"wx-e-{slugify(term)}",
        "letter": term[0].upper() if term[0].isalpha() else "#",
        "category": "handbook",
        "senses": [{"definition": d, "usage": None} for d in defns],
        "source": "FAA-H-8083-28B (Aviation Weather Handbook), Appendix E",
    } for term, defns in merged.items()]

    if args.dry_run:
        for r in rows[:10]:
            print(" ", json.dumps(r, indent=2))
        return

    status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                         body=rows, prefer="resolution=merge-duplicates,return=minimal")
    print(f"Upserted {len(rows)} rows." if status in (200, 201, 204) else f"HTTP {status}: {str(body)[:300]}")


if __name__ == "__main__":
    main()
