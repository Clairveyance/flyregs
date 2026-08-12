#!/usr/bin/env python3
"""Backfill airworthiness_directives.model for rows where it's NULL, using
the exact same regex ad_scraper.py's own parser already applies to new/
touched ADs -- this only re-derives `model` from the row's OWN already-
stored `applicability` text, never re-scrapes or touches any other column.

1,665 of 5,599 ADs are missing `model` (2026-08-11 audit) -- these predate
whenever this regex was added/fixed, or were scraped before real model
extraction existed, and (being unamended since) were never re-touched by
the weekly incremental sync.

Usage:
  python3 sync/backfill_ad_model.py --dry-run
  python3 sync/backfill_ad_model.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"
env = {}
with open(f"{BASE}/.env.scraper") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
SUPABASE_URL = env["SUPABASE_URL"]
SUPABASE_KEY = env["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

# Byte-identical to ad_scraper.py's own model_match regex (widened
# 2026-08-12 to allow parens/periods and match the LAST terminator, not the
# first -- see that file's comment for why).
MODEL_RE = re.compile(
    r"[Mm]odel[s]?\s+([A-Za-z0-9,\-/\s()\.]+)(?:\s+airplanes|\s+helicopters|\s+gliders|\s+engines)\b(?!\s*with)"
)


def fetch_missing() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives"
            f"?select=ad_number,applicability&model=is.null&applicability=not.is.null"
            f"&limit=1000&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = fetch_missing()
    log.info(f"{len(rows)} ADs missing model, with real applicability text to re-derive from")

    resolved = 0
    still_none = 0
    for row in rows:
        m = MODEL_RE.search(row["applicability"] or "")
        model = m.group(1).strip() if m else None
        if not model:
            still_none += 1
            continue
        resolved += 1
        if args.dry_run:
            if resolved <= 15:
                log.info(f"  {row['ad_number']}: model = {model!r}")
            continue
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives?ad_number=eq.{row['ad_number']}",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"model": model},
            timeout=15,
        )
        if resp.status_code >= 400:
            log.warning(f"  Failed to update {row['ad_number']}: {resp.text[:200]}")

    log.info(f"{'Would resolve' if args.dry_run else 'Resolved'}: {resolved}, still no model (genuinely no match in text): {still_none}")


if __name__ == "__main__":
    main()
