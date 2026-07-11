#!/usr/bin/env python3
"""
DRY RUN ONLY — measures scope of run-on numbered lists embedded inside a
single section/item body (or para) instead of being split into real list
items, e.g.:

  "The basic philosophy of a CPCP should consist of: 1. Personnel adequately
  trained...; 2. Thorough knowledge...; 3. Proper emphasis...; ... 13. Use of
  appropriate materials..."

The parser's ITEM_A/ITEM_N/ITEM_L rules only fire when a marker ("a.", "(1)",
"(a)") starts its own physical PDF line. When the FAA source PDF doesn't wrap
between list items, the whole enumerated list stays glued into one line of
running text and is parsed as ordinary body prose — no line boundary ever
exists for the classifier to split on.

This scans the ALREADY-PARSED pdf_blocks (no PDF re-download, no pdf_text
re-parse) for embedded strictly-ascending "N. " sequences of length >= 3
starting at 1 or 2 within a single body/text string, and reports how many
ACs/blocks are affected plus real samples, before any parser change is
designed.

Usage:
  python3 scripts/detect_inline_lists.py                # full corpus report
  python3 scripts/detect_inline_lists.py --doc=43-4B     # one AC, verbose
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

# A list-item marker: line-internal boundary punctuation (start of string, or
# ";"/":"/"." followed by whitespace -- i.e. the previous item just ended),
# then "N. " followed by an uppercase letter -- same shape NUMSEC/ITEM_N use
# for a genuine heading/item, just without its own physical line.
MARKER_RE = re.compile(r"(?:^|[;:.]\s+(?:and|or)\s+|[;:.]\s+)(\d{1,2})\.\s+(?=[A-Z])")

MIN_RUN = 3  # need at least 3 ascending items to be confident it's a real list


def find_runs(text: str):
    matches = [(int(m.group(1)), m.start()) for m in MARKER_RE.finditer(text)]
    runs = []
    i = 0
    while i < len(matches):
        run = [matches[i]]
        j = i + 1
        while j < len(matches) and matches[j][0] == run[-1][0] + 1:
            run.append(matches[j])
            j += 1
        if len(run) >= MIN_RUN and run[0][0] in (1, 2):
            runs.append(run)
        i = j if j > i + 1 else i + 1
    return runs


def block_strings(block: dict):
    """Yields (field_name, text) for the fields worth scanning on a block."""
    kind = block.get("kind")
    if kind in ("section", "item"):
        body = block.get("body") or ""
        if body:
            yield "body", body
    elif kind == "para":
        text = block.get("text") or ""
        if text:
            yield "text", text


def scan_ac(blocks: list):
    findings = []
    for idx, b in enumerate(blocks):
        for field, s in block_strings(b):
            runs = find_runs(s)
            for run in runs:
                start_num, start_pos = run[0]
                end_num, _ = run[-1]
                findings.append({
                    "block_index": idx,
                    "kind": b.get("kind"),
                    "field": field,
                    "items": end_num - start_num + 1,
                    "sample": s[max(0, start_pos - 40):start_pos + 160],
                })
    return findings


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
        findings = scan_ac(ac["pdf_blocks"] or [])
        print(f"{ac['document_number']}: {len(findings)} embedded list(s) found\n")
        for f in findings:
            print(f"  block[{f['block_index']}] ({f['kind']}.{f['field']}), {f['items']} items")
            print(f"    ...{f['sample']!r}...\n")
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

    affected_acs = 0
    total_lists = 0
    total_items = 0
    samples = []
    for ac in acs:
        findings = scan_ac(ac["pdf_blocks"] or [])
        if not findings:
            continue
        affected_acs += 1
        total_lists += len(findings)
        total_items += sum(f["items"] for f in findings)
        if len(samples) < 40:
            samples.append({"document_number": ac["document_number"], "findings": findings[:3]})

    report = {
        "acs_scanned": len(acs),
        "acs_affected": affected_acs,
        "total_lists": total_lists,
        "total_items": total_items,
        "samples": samples,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "inline_lists_report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nDone. {affected_acs} ACs affected, {total_lists} embedded lists, {total_items} total items")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
