#!/usr/bin/env python3
"""
DRY RUN ONLY — scans every AC's already-parsed pdf_blocks for a gap in its
flat top-level section-number sequence (e.g. "1., 2., 3., 5." — skipping 4).

This is a general, symptom-level detector: it doesn't care WHY a number is
missing (font-encoding corruption like AC 21-50's, a parser length-cap
rejection, a genuinely-missing/renumbered section in the source PDF, etc.) —
any gap here means a reader's Contents list silently skips a number, which
looks broken regardless of root cause.

Only counts "flat" labels with no internal dot (e.g. "4.", not "4.1." or
"A.4") — those are the top-level chapter numbers the parser tracks via
lastFlatNum; decimal subsections are expected to nest and aren't part of
this sequence.

Usage:
  python3 scripts/detect_heading_gaps.py                # full corpus report
  python3 scripts/detect_heading_gaps.py --doc=21-50     # one AC, verbose
"""

import argparse
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

FLAT_LABEL_RE = re.compile(r"^(\d+)\.?$")


MAX_GAP = 2  # flag only 1-2 missing numbers -- see module docstring update below


def find_gaps(blocks: list):
    """Returns a list of (before, after) missing-number gaps, in document order.

    Only flags SMALL gaps (<= MAX_GAP numbers skipped). The parser's own
    NUMSEC classifier has an ALL-CAPS branch that is deliberately NOT gated by
    sequence continuity (old FAA Orders/ACs legitimately jump around --
    "6. PURPOSE" ... "21. DISTRIBUTION" -- reflecting a master template where
    only some numbered sections are used). Flagging every such jump produces
    massive noise unrelated to any real defect. A gap of exactly one or two
    missing numbers in an otherwise tight sequence (AC 21-50's "1, 2, 3, 5")
    is a much stronger, more specific signal of a genuinely dropped heading.
    """
    seq = []
    for b in blocks:
        if b.get("kind") != "section":
            continue
        label = (b.get("label") or "").strip()
        m = FLAT_LABEL_RE.match(label)
        if m:
            seq.append(int(m.group(1)))

    gaps = []
    for i in range(1, len(seq)):
        prev, cur = seq[i - 1], seq[i]
        if 1 < cur - prev <= MAX_GAP:
            gaps.append((prev, cur))
    return seq, gaps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Inspect a single AC by document_number, verbose output")
    args = ap.parse_args()

    if args.doc:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{args.doc}&select=document_number,pdf_blocks",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"No AC found for {args.doc}")
            return
        ac = rows[0]
        seq, gaps = find_gaps(ac["pdf_blocks"] or [])
        print(f"{ac['document_number']}: sequence = {seq}")
        print(f"  gaps: {gaps}")
        return

    acs = []
    page_size = 50
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=document_number,pdf_blocks&pdf_blocks=not.is.null"
            f"&order=document_number.asc&limit={page_size}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        acs.extend(batch)
        offset += page_size
    print(f"Scanning {len(acs)} ACs with pdf_blocks...")

    affected = []
    for ac in acs:
        seq, gaps = find_gaps(ac["pdf_blocks"] or [])
        if gaps:
            affected.append({"document_number": ac["document_number"], "sequence": seq, "gaps": gaps})

    report = {"acs_scanned": len(acs), "acs_affected": len(affected), "affected": affected}
    out_path = os.path.join(os.path.dirname(__file__), "..", "heading_gaps_report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nDone. {len(affected)} ACs have at least one section-number gap.")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
