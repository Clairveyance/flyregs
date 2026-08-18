#!/usr/bin/env python3
"""
LOI -> FAR citation backfill.
=============================
loi_scraper.py's extract_far_citations()/write_citations() only ever run
against an LOI at SCRAPE time -- there was no standalone script to re-run
extraction against the 1,055 already-scraped LOIs whenever
loi_citation_extract.py's own regex gets improved (same shape gap
loi_ac_citations.py already solved for loi->ac). Confirmed missing while
auditing the whole MagicLink extraction pipeline for gaps (RC: "we still
get these issues... explore all scenarios... discover ways and areas that
might be needed but missing"): _LEAD_IN's original 4 lead-in shapes never
caught a bare "FAR 91.409"-style citation with no "14 CFR"/section word/
symbol in front of it -- 35 LOIs, 58 distinct section numbers, real
regulatory content sitting unlinked purely because this backfill path
didn't exist to pick up the regex fix.

Reuses loi_scraper.py's own extract_far_citations()/write_citations()
directly rather than reimplementing the resolve/label/delete-scope logic
a second time -- write_citations() already scopes its delete to
citing_type='loi' AND citing_id=<this LOI> AND cited_type='far', so a
re-run here can never touch loi->ac/loi->pcg/loi->loi/loi->far_part rows
owned by their own separate scripts.

Usage:
  python3 loi_far_citations_backfill.py --dry-run
  python3 loi_far_citations_backfill.py
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from loi_scraper import extract_far_citations, fetch_known_far_sections, write_citations

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


def fetch_all_lois() -> list[dict]:
    out, offset = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/legal_interpretations",
            headers=HEADERS,
            params={"select": "slug,body_text", "limit": 1000, "offset": offset},
            timeout=120,
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

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        sys.exit(1)

    known_far_sections = fetch_known_far_sections()
    lois = fetch_all_lois()
    log.info(f"Re-extracting FAR citations for {len(lois)} LOIs against {len(known_far_sections)} known sections...")

    total_resolved = 0
    total_docs_with_citations = 0
    failed_slugs = []
    for loi in lois:
        text = loi.get("body_text") or ""
        if not text:
            continue
        citations = extract_far_citations(text, known_far_sections)
        resolved = [c for c in citations if c["resolved"]]
        if resolved:
            total_docs_with_citations += 1
            total_resolved += len(resolved)
        if args.dry_run:
            continue
        # write_citations() now raises on a failed delete (see its own
        # comment -- found live via magiclink_audit after this backfill's
        # first run silently duplicated one LOI's rows when its delete
        # transiently failed). Catching per-LOI here so one bad HTTP call
        # over 1,000+ sequential requests can't abort the whole run --
        # logged and reported at the end instead, so a real failure is
        # visible rather than either crashing everything or corrupting the
        # dedup invariant silently.
        try:
            write_citations(loi["slug"], loi["slug"], citations)
        except Exception as e:
            log.warning(f"  Failed to write citations for {loi['slug']}: {e}")
            failed_slugs.append(loi["slug"])

    log.info(f"{total_docs_with_citations} LOIs have at least one resolved FAR citation, {total_resolved} total citation rows.")
    if failed_slugs:
        log.warning(f"{len(failed_slugs)} LOIs failed to write (re-run this script to retry them): {failed_slugs}")
    if args.dry_run:
        log.info("(dry run -- nothing written)")
    else:
        log.info("Done.")


if __name__ == "__main__":
    main()
