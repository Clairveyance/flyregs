#!/usr/bin/env python3
"""Targeted AIM paragraph repair for the colspan/rowspan table-grid fix (2026-08-31).

WHY NOT sync_aim.sh
-------------------
Two independent reasons, and both matter:

1. sync_aim.sh step 4 runs sync/backfill_aim_pdf_images.py, which in the current
   working tree emits the new `?v=<content-hash>` cache-busting marker. The
   SHIPPED build (B38, commit 7603bd8) parses storage URLs with a greedy tail
   regex that folds `?v=` INTO the object path, so it would ask Supabase to sign
   "aim/page-0609.png?v=abc" -- an object that does not exist -- get null, and
   render a permanent error. Running that pipeline today would break EVERY AIM
   figure on an installed device. The scraper half of that work is deliberately
   uncommitted until a build ships with the client-side regex fix.

2. Even without (1), aim_scraper.py's own _upsert("aim_figures", ...) comment
   records a real production incident: a plain re-scrape rebuilds every figure's
   image_url from the raw FAA HTML, which is exactly what the PDF-page-image
   backfill replaces -- "252 stale/duplicate-image rows came back after one bare
   `python aim_scraper.py --mode full` run."

So this script does the narrowest possible thing: re-render ONLY the affected
paragraphs' body_text and upsert ONLY aim_paragraphs. It never writes
aim_figures, aim_citations, or any image_url, so neither hazard applies.

WHAT IT FIXES
-------------
The 5 AIM paragraphs whose tables still have header/data column misalignment,
from scripts/audit_table_header_alignment.py: 4-1-9, 5-3-1, 10-2-3, appendix_2,
appendix_4. Their tables use colspan/rowspan, which every flattener ignored
until sync/table_grid.py (commit 3187e5b).

Usage:
  python3 scripts/rescrape_aim_table_grid.py --dry-run   # fetch + render, no writes
  python3 scripts/rescrape_aim_table_grid.py             # apply
"""
from __future__ import annotations

import argparse
import os
import sys

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_BASE, "sync"))


def _load_env_file(name: str) -> None:
    """Same reason as rescrape_table_grid_parts.py: the scrapers read
    credentials from os.environ and the shell wrappers normally export them,
    so a directly-run script needs to load .env.scraper itself rather than
    asking anyone to source it by hand. Never overrides an already-exported var."""
    path = os.path.join(_BASE, name)
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(".env.scraper")

import aim_scraper as a  # noqa: E402

TARGETS = {"4-1-9", "5-3-1", "10-2-3", "appendix_2", "appendix_4"}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="render only, write nothing")
    args = ap.parse_args()

    if not args.dry_run and not (a.SUPABASE_URL and a.SUPABASE_KEY):
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY must be set to apply.", file=sys.stderr)
        return 1

    session = a.make_session()
    # fetch_index returns (chapters, pages) -- pages is the section list that
    # run_full iterates. Taking the first element instead gave 17 chapter rows
    # and matched zero targets.
    _chapters, sections = a.fetch_index(session)
    print(f"index: {len(sections)} AIM section pages")
    print(f"targets: {', '.join(sorted(TARGETS))}")
    print(f"mode: {'DRY RUN (no writes)' if args.dry_run else 'APPLY'}\n")

    found: dict[str, dict] = {}
    failures: list[tuple[str, str]] = []

    for page in sections:
        try:
            parsed = a.fetch_section(session, page)
        except Exception as e:  # noqa: BLE001
            failures.append((page.get("href", "?"), str(e)[:100]))
            continue
        for para in parsed.get("paragraphs", []):
            num = para.get("paragraph_number")
            if num in TARGETS and num not in found:
                found[num] = para

    missing = TARGETS - set(found)
    if missing:
        # Loud, not silent: a target that no longer resolves means the AIM was
        # renumbered upstream, and repairing 3 of 5 while reporting success is
        # exactly the silent-partial-run failure this project has hit 4 times.
        failures.append(("targets", f"not found in index: {sorted(missing)}"))
        print(f"MISSING TARGETS: {sorted(missing)}")

    for num in sorted(found):
        body = found[num].get("body_text") or ""
        piped = sum(1 for ln in body.split("\n") if " | " in ln)
        print(f"  {num:<12} body {len(body):>6} chars, {piped:>3} table row(s)")

    if args.dry_run:
        print(f"\nwould upsert {len(found)} of {len(TARGETS)} paragraphs (aim_paragraphs only)")
        return 1 if failures else 0

    rows = [found[n] for n in sorted(found)]
    if rows and not a._upsert("aim_paragraphs", rows, "paragraph_number"):
        failures.append(("upsert", "aim_paragraphs upsert returned False"))
        print("UPSERT FAILED")
    else:
        print(f"\nupserted {len(rows)} paragraph(s) -- aim_figures untouched")

    if failures:
        print(f"FAILURES: {failures}", file=sys.stderr)
        return 1
    print("OK -- re-run scripts/audit_table_header_alignment.py to confirm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
