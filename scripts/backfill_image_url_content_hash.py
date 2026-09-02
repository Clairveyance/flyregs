#!/usr/bin/env python3
"""Appends a `?v=<content-hash>` cache-busting marker to every already-stored
figure/image URL that does not have one yet.

WHY THIS EXISTS
---------------
Every figure/image upload site writes a fully deterministic object name and
re-uploads over it with `x-upsert: true`, so the returned
`/object/public/<bucket>/<fname>` URL was byte-for-byte identical no matter
how much the image itself had changed. The app caches figure images to disk
keyed on exactly that URL (src/lib/imageCache.ts, `versionFor`) and has no
other invalidation path whatsoever -- these rows carry no `updated_at`
column, nothing checks an ETag, and there is no user-facing cache-clear. A
corrected or revised regulatory figure therefore never reached a device that
had already viewed the old one.

The upload sites now emit `?v=<sha256(bytes)[:12]>` (see `content_version` in
scripts/extract_figures.py and sync/backfill_aim_pdf_images.py), which fixes
this going forward. This script is the one-time catch-up for rows written
before that marker existed.

READ THIS BEFORE RUNNING IT
---------------------------
Running this CHANGES image_url for every affected row, which by design makes
every device treat those images as new and re-download them once. That is a
real, if one-time, cost, and it is why this script defaults to a dry run and
requires an explicit --apply.

Whether it is worth paying differs per table:

  * aim_figures   -- probably NOT worth running. sync_aim.sh re-renders and
                     re-uploads these page images every week, so they will
                     acquire a correct hash on their own within one sync
                     cycle, at no extra cost beyond the re-download the fix
                     is supposed to cause anyway.
  * ac_figures    -- optional. scripts/extract_figures.py --docs-file deletes
                     and re-inserts these rows on the weekly sync, so a
                     revised AC gets brand-new row ids (= brand-new cache
                     keys) and already invalidates by accident. Rows for ACs
                     that are never revised simply never change.
  * ad_figures    -- the real reason this script exists. sync/backfill_ad_
                     figures.py's main() SKIPS every AD that already has
                     ad_figures rows, so those images are never re-rendered
                     and will never acquire a hash on their own. Without a
                     backfill they keep the old no-marker behaviour forever.
  * ac_formula_refs -- 4 rows; trivial either way.

Usage:
    python3 scripts/backfill_image_url_content_hash.py                  # dry run, all tables
    python3 scripts/backfill_image_url_content_hash.py --table ad_figures
    python3 scripts/backfill_image_url_content_hash.py --table ad_figures --apply

NOTE (2026-08-31): written but deliberately NOT run -- it writes to the live
database, which was out of scope for the change that introduced it.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys

import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
SUPABASE_URL = SCRAPER["SUPABASE_URL"]
SERVICE_KEY = SCRAPER["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

TABLES = ["ac_figures", "ac_formula_refs", "aim_figures", "ad_figures"]

PUBLIC_PREFIX = "/storage/v1/object/public/"
AUTH_PREFIX = "/storage/v1/object/"

# PostgREST caps a single response at 1000 rows regardless of `limit`, so
# every read here pages explicitly rather than trusting one big request.
PAGE = 1000


def fetch_rows(table: str) -> list[dict]:
    rows, offset = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": "id,image_url", "limit": PAGE, "offset": offset, "order": "id.asc"},
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < PAGE:
            return rows
        offset += PAGE


def fetch_object_bytes(public_url: str) -> bytes:
    # These buckets are private (see sync/migrations_gate_storage_buckets.sql),
    # so the stored "public-style" URL is an identifier, not something
    # fetchable. Swap in the authenticated object endpoint and use the service
    # key -- same swap sync/loi_vision_cleanup.py already does.
    auth_url = public_url.replace(PUBLIC_PREFIX, AUTH_PREFIX, 1)
    resp = requests.get(auth_url, headers=HEADERS, timeout=120)
    resp.raise_for_status()
    return resp.content


def patch_image_url(table: str, row_id: str, new_url: str) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        params={"id": f"eq.{row_id}"},
        json={"image_url": new_url},
        timeout=30,
    )
    resp.raise_for_status()


def process(table: str, apply: bool) -> tuple[int, int, int, int]:
    rows = fetch_rows(table)
    skipped_marked = skipped_empty = updated = failed = 0
    for row in rows:
        url = row.get("image_url") or ""
        if not url:
            # aim_figures.image_url is NOT NULL but backfill_aim_pdf_images.py
            # writes "" for a table it cannot resolve to any PDF page.
            skipped_empty += 1
            continue
        if "?v=" in url:
            skipped_marked += 1
            continue
        if PUBLIC_PREFIX not in url:
            # Not a Storage object we own -- leave it completely alone.
            skipped_empty += 1
            continue
        try:
            digest = hashlib.sha256(fetch_object_bytes(url)).hexdigest()[:12]
        except Exception as e:  # noqa: BLE001 -- one bad object must not abort the run
            print(f"  FAILED {table} {row['id']}: {e}")
            failed += 1
            continue
        new_url = f"{url}?v={digest}"
        if apply:
            try:
                patch_image_url(table, row["id"], new_url)
            except Exception as e:  # noqa: BLE001
                print(f"  FAILED PATCH {table} {row['id']}: {e}")
                failed += 1
                continue
        updated += 1
        if updated <= 3:
            print(f"  {'PATCHED' if apply else 'would patch'} {row['id']} -> ...?v={digest}")
    return updated, skipped_marked, skipped_empty, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", choices=TABLES, help="only this table (default: all four)")
    ap.add_argument(
        "--apply",
        action="store_true",
        help="actually write. Without it this only reports what it would do.",
    )
    args = ap.parse_args()

    targets = [args.table] if args.table else TABLES
    if not args.apply:
        print("DRY RUN -- nothing will be written. Re-run with --apply to commit.\n")
    else:
        print(
            "APPLYING. Every updated row's image_url changes, which makes every\n"
            "device re-download that image once. This is intended, and one-time.\n"
        )

    total_failed = 0
    for table in targets:
        print(f"{table}:")
        updated, marked, empty, failed = process(table, args.apply)
        total_failed += failed
        print(
            f"  {updated} {'updated' if args.apply else 'would be updated'}, "
            f"{marked} already marked, {empty} skipped (empty/non-storage), {failed} failed\n"
        )

    # Non-zero exit on any failure so a CI/cron invocation surfaces it rather
    # than reporting a clean run -- same convention as sync.sh's own steps.
    return 1 if total_failed else 0


if __name__ == "__main__":
    sys.exit(main())
