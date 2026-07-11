#!/usr/bin/env python3
"""
DRY RUN ONLY — re-runs the improved find_captions() (bold OR all-caps signal,
OCR-punctuation-tolerant) against every AC that currently has ZERO rows in
ac_figures, to measure how many were missed by the original bold-only
detector versus genuinely having no figures/tables at all. Writes samples
for manual false-positive review before any real re-extraction is run.

Usage:
  python3 scripts/audit_figure_miss.py
"""
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import find_captions  # noqa: E402

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


def fetch_all(table, select, extra=""):
    rows = []
    offset = 0
    page = 1000
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}?select={select}{extra}&limit={page}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        offset += page
        if len(batch) < page:
            break
    return rows


def main():
    acs = fetch_all("advisory_circulars", "id,document_number,pdf_url_cached", "&pdf_url_cached=not.is.null")
    figs = fetch_all("ac_figures", "ac_id")
    has_figs = set(f["ac_id"] for f in figs)
    zero = [a for a in acs if a["id"] not in has_figs]
    print(f"{len(zero)} ACs currently have zero figures. Re-scanning with improved detector...")

    gained = []
    still_zero = []
    for n, ac in enumerate(zero):
        try:
            pdf_bytes = requests.get(ac["pdf_url_cached"], timeout=60).content
            captions = list(find_captions(pdf_bytes))
        except Exception as e:
            print(f"[{n}] {ac['document_number']}: ERROR {e}")
            continue
        if captions:
            gained.append({
                "document_number": ac["document_number"],
                "count": len(captions),
                "samples": [{"page": p, "label": l, "caption": c} for p, l, c in captions[:3]],
            })
        else:
            still_zero.append(ac["document_number"])
        if n % 50 == 0:
            print(f"  ...{n}/{len(zero)} scanned, {len(gained)} would gain figures so far")

    report = {
        "zero_count": len(zero),
        "would_gain_count": len(gained),
        "still_zero_count": len(still_zero),
        "gained": gained,
        "still_zero": still_zero,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "figure_miss_audit.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nDone. {len(gained)} ACs would gain figures, {len(still_zero)} remain genuinely zero.")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
