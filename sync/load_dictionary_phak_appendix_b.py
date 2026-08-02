#!/usr/bin/env python3
"""Load the Aviation Dictionary's second tier: Pilot's Handbook of
Aeronautical Knowledge (FAA-H-8083-25C) Appendix B, "Acronyms,
Abbreviations, and NOTAM Contractions" -- ONLY the terms not already
covered by JO 7340.2 (load_dictionary_contractions.py), since Appendix B's
own text says "For a more complete list of contractions used in aviation,
see FAA Order JO 7340.2" -- it's a curated subset plus some NOTAM-specific
contractions JO 7340.2 doesn't carry.

Source: PHAK full PDF's own outline/bookmarks (pypdf .outline), which
contain Appendix B pre-parsed as clean "TERM—definition" pairs -- no OCR,
no LLM, this is literally the PDF author's own bookmark text.
https://www.faa.gov/regulations_policies/handbooks_manuals/aviation/faa-h-8083-25c.pdf
(fetched 2026-08-01, FAA-H-8083-25C)

Usage:
  python3 sync/load_dictionary_phak_appendix_b.py --dry-run
  python3 sync/load_dictionary_phak_appendix_b.py
"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, mgmt_sql  # noqa: E402

OUTLINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".phak_appendix_b_outline.txt")
# Appendix B starts right after the "Acronyms, Abbreviations, and NOTAM
# Contractions" header line and runs to Appendix C -- located once by hand
# against the fetched outline dump, stable for this PDF revision.
APPENDIX_B_START_MARKER = "Acronyms, Abbreviations, and NOTAM Contractions"
APPENDIX_C_MARKER = "Appendix C"


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def parse_entries():
    lines = open(OUTLINE_PATH, encoding="utf-8").read().split("\n")
    start = next(i for i, l in enumerate(lines) if l.strip() == APPENDIX_B_START_MARKER)
    end = next(i for i, l in enumerate(lines) if i > start and l.strip() == APPENDIX_C_MARKER)
    entries = []
    for l in lines[start:end]:
        if "—" in l:  # em-dash
            term, _, defn = l.partition("—")
            term, defn = term.strip(), defn.strip()
            if term and defn and len(term) <= 20:
                entries.append((term, defn))
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    entries = parse_entries()
    print(f"Parsed {len(entries)} raw entries from PHAK Appendix B.")

    existing = {r["term"] for r in mgmt_sql("select term from dictionary_terms")}
    new_entries = [(t, d) for t, d in entries if t not in existing]
    print(f"{len(new_entries)} not already covered by JO 7340.2 contractions (or a prior run of this script).")

    rows = []
    for term, defn in new_entries:
        rows.append({
            "term": term,
            "slug": f"afh-b-{slugify(term)}",
            "letter": term[0].upper() if term[0].isalpha() else "#",
            "category": "handbook",
            "senses": [{"definition": defn, "usage": None}],
            "source": "FAA-H-8083-25C (Pilot's Handbook of Aeronautical Knowledge), Appendix B",
        })

    if args.dry_run:
        print("Sample new rows:")
        for r in rows[:5]:
            print(" ", json.dumps(r, indent=2))
        return

    BATCH = 500
    upserted = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status not in (200, 201, 204):
            print(f"  chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            upserted += len(chunk)
    print(f"Upserted {upserted} rows into dictionary_terms.")


if __name__ == "__main__":
    main()
