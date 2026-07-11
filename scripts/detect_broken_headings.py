#!/usr/bin/env python3
"""
DRY RUN ONLY — measures scope of a distinct defect from the header/footer
leak: a bold heading-like text run whose leading "N. " section number is
missing or garbled (e.g. "~ubstantiation..." instead of "4. Substantiation
..."). Confirmed via font metadata (PyMuPDF get_text("dict") span flags)
that the fragment genuinely IS bold — a real heading the parser should
recognize — just missing/corrupted its own numbering, most likely a broken
ToUnicode CMap entry for a stylized numeral glyph in the source PDF's
embedded font. This reproduces identically across two independent PDF
libraries (pypdf, PyMuPDF), so it's a defect in the source PDF itself, not
an extraction-library artifact — unlike the header/footer leak, which is
fully recoverable by stripping known boilerplate.

This script only detects and reports candidates — no writes anywhere.

Usage:
  python3 scripts/detect_broken_headings.py                # full corpus scan
  python3 scripts/detect_broken_headings.py --doc=21-50     # one AC, verbose
"""

import argparse
import io
import json
import os
import re

import fitz
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

BOLD_FLAG = 1 << 4

# A bold line that does NOT start with a normal heading number ("4. Foo" or
# "a. Foo") but DOES start with an unusual leading symbol/punctuation
# (the telltale sign of a corrupted numeral glyph), followed by lowercase
# body-style prose. Real bold section titles start with a digit; real bold
# item labels start with a lowercase letter + period. Neither of those is a
# false positive here.
NORMAL_HEADING_RE = re.compile(r"^\s*(\d+\.|\(?[a-z]\)?\.)\s")
# Excludes normal brackets/parens (legitimate table-header units like
# "[m/s]" or sub-item labels like "(vi)") — a genuinely eaten leading
# numeral produces an unusual standalone symbol (e.g. "~") immediately
# followed by several lowercase letters forming a real word fragment, not a
# short bracketed unit.
SUSPECT_RE = re.compile(r"^\s*[^\w\s()\[\]{}]{1,2}[a-z]{3,}")
MIN_TEXT_LEN = 15


def find_candidates(pdf_bytes: bytes):
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    candidates = []
    for i, page in enumerate(doc):
        d = page.get_text("dict")
        for block in d["blocks"]:
            for line in block.get("lines", []):
                spans = line["spans"]
                if not spans:
                    continue
                # A leading non-bold fragment (e.g. a stray "... " from the
                # previous item's tail) can share a line with the real bold
                # heading run — find where the bold text actually starts
                # rather than trusting spans[0].
                bold_start = None
                for idx, s in enumerate(spans):
                    if s["text"].strip() and (s["flags"] & BOLD_FLAG):
                        bold_start = idx
                        break
                if bold_start is None:
                    continue
                text = "".join(s["text"] for s in spans[bold_start:]).strip()
                if not text or len(text) < MIN_TEXT_LEN:
                    continue
                if NORMAL_HEADING_RE.match(text):
                    continue
                if SUSPECT_RE.match(text):
                    candidates.append({"page": i + 1, "text": text[:100]})
    doc.close()
    return candidates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Inspect a single AC by document_number, verbose output")
    args = ap.parse_args()

    if args.doc:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{args.doc}&select=document_number,pdf_url_cached",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"No AC found for {args.doc}")
            return
        ac = rows[0]
        pdf_bytes = requests.get(ac["pdf_url_cached"], timeout=60).content
        candidates = find_candidates(pdf_bytes)
        print(f"{ac['document_number']}: {len(candidates)} candidate(s)")
        for c in candidates:
            print(f"  p{c['page']}: {c['text']!r}")
        return

    acs = []
    page_size = 50
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=document_number,pdf_url_cached&pdf_url_cached=not.is.null"
            f"&order=document_number.asc&limit={page_size}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        acs.extend(batch)
        offset += page_size
    print(f"Scanning {len(acs)} ACs...")

    affected = 0
    total_candidates = 0
    samples = []
    for n, ac in enumerate(acs):
        try:
            pdf_bytes = requests.get(ac["pdf_url_cached"], timeout=60).content
            candidates = find_candidates(pdf_bytes)
        except Exception as e:
            print(f"[{n}] {ac['document_number']}: ERROR {e}")
            continue
        if candidates:
            affected += 1
            total_candidates += len(candidates)
            if len(samples) < 50:
                samples.append({"document_number": ac["document_number"], "candidates": candidates[:3]})
        if n % 50 == 0:
            print(f"  ...{n}/{len(acs)} scanned, {affected} affected so far")

    report = {
        "acs_scanned": len(acs),
        "acs_affected": affected,
        "total_candidates": total_candidates,
        "samples": samples,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "broken_headings_report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nDone. {affected} ACs affected, {total_candidates} candidate broken headings")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
