#!/usr/bin/env python3
"""Targeted repair re-scrape for the colspan/rowspan table-grid fix (2026-08-31).

WHY A TARGETED SCRIPT AND NOT `far_scraper.py --mode full`
----------------------------------------------------------
The grid fix (see sync/table_grid.py) changes how EVERY table is flattened, but
only 20 sections across 9 parts actually render differently -- measured, not
guessed: a before/after harness ran the old and the new flattener over all 173
tables in Title 14 Chapter I and recorded exactly which sections changed
(0 regressions). A full-chapter re-scrape would rewrite ~2,000 sections to fix
20, and eCFR reliably 503s on the larger parts mid-run (Part 91 failed 4 times
in a row during the last repair), so a full run is both riskier and slower for
no benefit.

REVISION LOGGING IS DISABLED, DELIBERATELY
------------------------------------------
This is a repair pass over already-known content, not a real content update.
far_scraper.py's own --no-revision-log flag exists for exactly this case: without
it, rewriting these sections would emit bogus "What's Changed" entries telling
users the FAA amended 14 CFR 26.5 today, which it did not. SKIP_REVISION_LOG=1
is set below before far_scraper is imported.

Usage:
  python3 scripts/rescrape_table_grid_parts.py --dry-run   # fetch + render + diff, NO writes
  python3 scripts/rescrape_table_grid_parts.py             # apply
"""
from __future__ import annotations

import argparse
import os
import sys

os.environ["SKIP_REVISION_LOG"] = "1"  # must be set BEFORE far_scraper is imported

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_BASE, "sync"))


def _load_env_file(name: str) -> None:
    """far_scraper reads credentials from os.environ, and the shell wrappers
    (sync.sh / sync_aim.sh) are what normally export them -- so running this
    script directly failed with "SUPABASE_URL / SUPABASE_SERVICE_KEY must be
    set to apply". Load .env.scraper here instead of asking anyone to source it
    by hand: same file, same keys, same parsing as scripts/author_fact_deck.py's
    own load_env(). Never overwrites a variable that is already exported, so a
    CI runner that injects real secrets still wins."""
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

import far_scraper as fs  # noqa: E402

# Derived from the measured before/after sweep, not hand-picked: these are
# EXACTLY the sections whose rendered text changes under the grid fix.
#
# Scoped to the section, not the part, on purpose. Re-scraping all 9 parts
# fetches 1,209 sections to fix 20 -- and while the other 1,189 would be
# written back byte-identical, the write still bumps their updated_at, which
# this app's sync and "What's Changed" paths read. Rewriting a thousand rows
# to repair twenty is blast radius with no upside.
SECTIONS_BY_PART = {
    "25":  ["25.509", "25.815", "25.1323", "25.1395"],
    "26":  ["26.5"],
    "27":  ["27.1395"],
    "29":  ["29.807", "29.815", "29.1395"],
    "34":  ["34.60", "34.71"],
    "139": ["139.203"],
    "171": ["171.311", "171.313", "171.317"],
    "241": ["3", "7", "22"],
    "420": ["420.19", "420.21"],
}
PARTS = list(SECTIONS_BY_PART)
TARGET_TOTAL = sum(len(v) for v in SECTIONS_BY_PART.values())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="fetch and render, report what WOULD change, write nothing")
    args = ap.parse_args()

    if not args.dry_run and not (fs.SUPABASE_URL and fs.SUPABASE_KEY):
        print("ERROR: SUPABASE_URL / SUPABASE_SERVICE_KEY must be set to apply.", file=sys.stderr)
        return 1

    session = fs.make_session()
    as_of = fs.current_ecfr_date(session)
    print(f"eCFR as_of: {as_of}")
    print(f"parts: {', '.join(PARTS)}   mode: {'DRY RUN (no writes)' if args.dry_run else 'APPLY'}\n")

    total, failures = 0, []
    for part in PARTS:
        try:
            records = fs.fetch_part_sections(session, part, as_of)
        except Exception as e:  # noqa: BLE001 -- report and continue, never half-succeed silently
            failures.append((part, str(e)[:120]))
            print(f"  Part {part}: FETCH FAILED -- {str(e)[:120]}")
            continue
        wanted = set(SECTIONS_BY_PART[part])
        targeted = [r for r in records if r.get("section_number") in wanted]
        missing = wanted - {r.get("section_number") for r in targeted}
        if missing:
            # A target that no longer resolves means the section was renumbered
            # or removed upstream -- surface it loudly rather than quietly
            # repairing 2 of 3 and reporting success.
            failures.append((part, f"target sections not found in fetch: {sorted(missing)}"))
            print(f"  Part {part}: MISSING TARGETS {sorted(missing)}")
        print(f"  Part {part}: {len(records)} fetched, {len(targeted)}/{len(wanted)} target section(s) matched")
        if args.dry_run:
            for r in targeted:
                n_tables = (r.get("body_text") or "").count(" | ")
                print(f"      would rewrite {r['section_number']}  ({n_tables} pipe-joined cells)")
            total += len(targeted)
            continue
        if not targeted:
            continue
        if not fs.upsert_sections(targeted):
            failures.append((part, "upsert returned False"))
            print(f"  Part {part}: UPSERT FAILED")
            continue
        total += len(targeted)
        print(f"  Part {part}: upserted {len(targeted)}")

    print(f"\n{'would upsert' if args.dry_run else 'upserted'}: {total} of {TARGET_TOTAL} target sections")
    if failures:
        # Exit non-zero on partial failure -- this project has been bitten four
        # separate times by scrapers that exit 0 after a partial run and leave
        # the corpus silently stale with a green job.
        print(f"FAILURES: {failures}", file=sys.stderr)
        return 1
    print("OK -- re-run scripts/audit_table_header_alignment.py to confirm.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
