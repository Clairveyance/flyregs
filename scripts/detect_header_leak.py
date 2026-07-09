#!/usr/bin/env python3
"""
DRY RUN ONLY — detects (does not fix) page header/footer text leaked into the
middle of pdf_text/pdf_blocks wherever a paragraph spans a page break in the
source PDF. pypdf's page.extract_text() (used at scrape time in
faa_scraper.py) concatenates all text on a page in stream order with no
concept of header/footer regions, so a running header like
"9/11/18  AC 43-4B  1-2" ends up injected verbatim into the middle of
whatever sentence happened to be flowing across that page boundary.

This script writes a report only — no database writes. Confirms scope and
shows real before/after examples so a human can review the exact cleaning
rule before it's ever applied for real.

Usage:
  python3 scripts/detect_header_leak.py                  # full corpus report
  python3 scripts/detect_header_leak.py --doc=43-4B       # one AC, verbose
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

# The leaked template, anchored on the AC's OWN document_number (very
# specific — low false-positive risk). Matches:
#   "9/11/18  AC 43-4B"
#   "9/14/18  AC 20-62E CHG 1"
#   "1/6/94 AC 25-9A"
DATE_RE = r"\d{1,2}/\d{1,2}/\d{2,4}"


def build_pattern(doc_num: str) -> re.Pattern:
    escaped = re.escape(doc_num)
    return re.compile(rf"{DATE_RE}\s+AC\s+{escaped}(\s+CHG\s+\d+)?", re.IGNORECASE)


def is_mid_sentence(text: str, start: int) -> bool:
    """True if the match interrupts running prose rather than sitting at a
    paragraph/section boundary — i.e. the nearest non-whitespace character
    before it is a lowercase letter, not sentence-ending punctuation."""
    before = text[:start].rstrip()
    if not before:
        return False
    last = before[-1]
    return last.isalpha() and last.islower()


def find_leaks(doc_num: str, text: str):
    pattern = build_pattern(doc_num)
    results = []
    for m in pattern.finditer(text):
        start, end = m.span()
        results.append(
            {
                "matched": m.group(0),
                "start": start,
                "end": end,
                "mid_sentence": is_mid_sentence(text, start),
                "context_before": text[max(0, start - 80):start],
                "context_after": text[end:end + 80],
            }
        )
    return results


def clean_preview(text: str, leaks: list) -> str:
    """Shows what stripping + whitespace-collapse would produce, without
    writing anything anywhere."""
    out = []
    pos = 0
    for leak in leaks:
        out.append(text[pos:leak["start"]])
        pos = leak["end"]
    out.append(text[pos:])
    cleaned = "".join(out)
    # Collapse the whitespace left behind (multiple spaces/newlines -> one space)
    return re.sub(r"[ \t]*\n[ \t\n]*", " ", cleaned)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Inspect a single AC by document_number, verbose output")
    args = ap.parse_args()

    if args.doc:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{args.doc}&select=document_number,pdf_text",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"No AC found for {args.doc}")
            return
        ac = rows[0]
        leaks = find_leaks(ac["document_number"], ac["pdf_text"] or "")
        print(f"{ac['document_number']}: {len(leaks)} leak(s) found\n")
        for i, leak in enumerate(leaks):
            print(f"--- leak {i+1} ({'MID-SENTENCE' if leak['mid_sentence'] else 'boundary'}) ---")
            print(f"  matched: {leak['matched']!r}")
            print(f"  before:  ...{leak['context_before']!r}")
            print(f"  after:   {leak['context_after']!r}...")
            print()
        cleaned = clean_preview(ac["pdf_text"] or "", leaks)
        idx = cleaned.find(ac["document_number"])  # just to anchor something readable
        print("--- cleaned preview around first leak ---")
        if leaks:
            approx = cleaned[:400]
            print(approx)
        return

    # Full corpus report — paginated, pdf_text can be large per row and a
    # single all-at-once request 521s at the proxy layer.
    acs = []
    page_size = 50
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=document_number,pdf_text&pdf_text=not.is.null"
            f"&order=document_number.asc&limit={page_size}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        acs.extend(batch)
        offset += page_size
    print(f"Scanning {len(acs)} ACs with pdf_text...")

    total_leaks = 0
    mid_sentence_count = 0
    boundary_count = 0
    affected_acs = 0
    samples = []

    for ac in acs:
        leaks = find_leaks(ac["document_number"], ac["pdf_text"] or "")
        if not leaks:
            continue
        affected_acs += 1
        total_leaks += len(leaks)
        for leak in leaks:
            if leak["mid_sentence"]:
                mid_sentence_count += 1
            else:
                boundary_count += 1
        if len(samples) < 40:
            samples.append({"document_number": ac["document_number"], "leaks": leaks[:2]})

    report = {
        "acs_scanned": len(acs),
        "acs_affected": affected_acs,
        "total_leak_occurrences": total_leaks,
        "mid_sentence_occurrences": mid_sentence_count,
        "boundary_occurrences": boundary_count,
        "samples": samples,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "header_leak_report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nDone. {affected_acs} ACs affected, {total_leaks} total occurrences")
    print(f"  mid-sentence (visibly breaks reading text): {mid_sentence_count}")
    print(f"  at paragraph/block boundary (lower harm):   {boundary_count}")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
