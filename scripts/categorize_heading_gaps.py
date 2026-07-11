#!/usr/bin/env python3
"""
DRY RUN ONLY — for every gap flagged by detect_heading_gaps.py, checks the
AC's raw pdf_text to see whether the missing number actually appears as a
plausible heading line ("N. ...") that the parser simply failed to
recognize (a real, fixable parser miss), versus genuinely not appearing
anywhere in the extractable text (needs case-by-case judgment — could be a
legitimate FAA numbering skip, a font-corruption casualty like AC 21-50's,
or lost to OCR noise).

Usage:
  python3 scripts/categorize_heading_gaps.py
"""

import json
import os
import re

import requests

SCRAPER_ENV = os.path.join(os.path.dirname(__file__), "..", ".env.scraper")


def load_env(path: str) -> dict:
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env(SCRAPER_ENV)
SUPABASE_URL = ENV["SUPABASE_URL"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}


def main():
    with open(os.path.join(os.path.dirname(__file__), "..", "heading_gaps_report.json")) as f:
        report = json.load(f)

    affected = report["affected"]
    print(f"Categorizing {len(affected)} flagged ACs...")

    findable = []   # missing number appears as a plausible heading line in raw text
    absent = []      # missing number doesn't appear as a heading-shaped line at all

    for n, entry in enumerate(affected):
        doc = entry["document_number"]
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{doc}&select=pdf_text",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows or not rows[0].get("pdf_text"):
            continue
        text = rows[0]["pdf_text"]
        lines = [l.strip() for l in text.split("\n")]

        doc_findable = []
        doc_absent = []
        for prev, cur in entry["gaps"]:
            # The missing number(s) are strictly BETWEEN prev and cur, e.g. a
            # (3, 5) gap means "4" is missing -- NOT "5", which is already
            # present and correctly parsed (this was the bug in the first
            # version of this script: it searched for "cur." and reported
            # false "findable" hits for numbers that were never missing).
            missing_nums = range(prev + 1, cur)
            for missing in missing_nums:
                pattern = re.compile(rf"^{missing}\.\s*[A-Z]")
                found = None
                for l in lines:
                    if pattern.match(l):
                        found = l[:80]
                        break
                if found:
                    doc_findable.append({"missing": missing, "line": found})
                else:
                    doc_absent.append({"missing": missing})

        if doc_findable:
            findable.append({"document_number": doc, "gaps": doc_findable})
        if doc_absent:
            absent.append({"document_number": doc, "gaps": doc_absent})

        if n % 50 == 0:
            print(f"  ...{n}/{len(affected)} checked")

    out = {
        "findable_count": len(findable),
        "absent_count": len(absent),
        "findable": findable,
        "absent": absent,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "heading_gaps_categorized.json")
    with open(out_path, "w") as f:
        json.dump(out, f, indent=2)

    print(f"\nDone. {len(findable)} ACs have at least one FINDABLE missing heading (real parser miss).")
    print(f"      {len(absent)} ACs have gaps where the number doesn't appear as a heading line at all.")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
