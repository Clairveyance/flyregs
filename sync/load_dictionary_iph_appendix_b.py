#!/usr/bin/env python3
"""Load the Aviation Dictionary's Instrument Procedures Handbook Appendix B
tier -- ONLY terms not already covered by an earlier tier.

Source: https://www.faa.gov/sites/faa.gov/files/regulations_policies/handbooks_manuals/aviation/instrument_procedures_handbook/FAA-H-8083-16B_Appendix_B.pdf
(fetched 2026-08-01, FAA-H-8083-16B) -- same clean "TERM—definition"
em-dash format as JO 7340.2 and PHAK's Appendix B, extracted via
pypdf.page.extract_text() (no LLM needed, text was already this clean).

Usage:
  python3 sync/load_dictionary_iph_appendix_b.py --dry-run
  python3 sync/load_dictionary_iph_appendix_b.py
"""
import argparse, json, os, re, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, mgmt_sql  # noqa: E402

RAW_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".iph_appendix_b_raw.txt")


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def parse_entries():
    text = open(RAW_PATH, encoding="utf-8").read()
    entries = []
    for line in text.split("\n"):
        line = line.strip()
        if "—" in line:
            term, _, defn = line.partition("—")
            term, defn = term.strip(), defn.strip()
            if term and defn and len(term) <= 20 and not defn.endswith("—"):
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

    # A couple of terms (e.g. "AFS") legitimately have two distinct meanings
    # in this appendix -- merge into one row's senses array rather than
    # colliding on slug, same principle as load_dictionary_contractions.py.
    merged = {}
    for term, defn in new_entries:
        merged.setdefault(term, [])
        if defn not in merged[term]:
            merged[term].append(defn)

    rows = [{
        "term": term,
        "slug": f"iph-b-{slugify(term)}",
        "letter": term[0].upper() if term[0].isalpha() else "#",
        "category": "handbook",
        "senses": [{"definition": d, "usage": None} for d in defns],
        "source": "FAA-H-8083-16B (Instrument Procedures Handbook), Appendix B",
    } for term, defns in merged.items()]

    if args.dry_run:
        for r in rows[:5]:
            print(" ", json.dumps(r, indent=2))
        return

    status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                         body=rows, prefer="resolution=merge-duplicates,return=minimal")
    print(f"Upserted {len(rows)} rows." if status in (200, 201, 204) else f"HTTP {status}: {str(body)[:300]}")


if __name__ == "__main__":
    main()
