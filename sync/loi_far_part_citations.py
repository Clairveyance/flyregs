#!/usr/bin/env python3
"""
LOI -> FAR Part citation extractor.
====================================
Closes a real, large hole in the MagicLink graph, found 2026-08-10 while
checking LOI's citation coverage the same way the P/CG sweep did earlier
that day: 87.6% of LOIs have at least one citation, but sampling the
zero-citation ones found most DO contain real citation-shaped text --
5 of 6 sampled had a genuine "14 CFR"/"Part N" mention that produced zero
extracted citations. Root cause: loi_citation_extract.py (loi_scraper.py's
own extractor) is deliberately, correctly SECTION-only -- it never looks
for a bare Part reference at all, by design (see that file's own header).

Rather than scanning noisy OCR body_text for "Part N" (real, but risks
false positives and needs the same OCR-tolerant digit handling
loi_citation_extract.py already built for section numbers), this uses a
BETTER, already-available source: legal_interpretations.cfr_part_reference,
DRS's own structured metadata field, captured at scrape time but until now
only ever rendered as plain display text (src/app/loi/[slug].tsx and
friends), never turned into a real, navigable citation. It's a clean,
pipe-delimited list ("Part 61 | Part 91"), zero OCR risk, zero extraction
risk -- DRS's own official classification of what this letter is about.

Measured before building this: 973 of 1,055 LOIs (92%) have this field
populated; 84 of those currently have ZERO citations of any kind (this
would be their first real MagicLink). The other 889 mostly already have a
specific FAR-section citation from loi_scraper.py's own extraction -- this
adds the coarser Part-level link alongside it, which is not redundant: a
reader benefits from "this letter is about Part 135" even when it also
cites one specific section, the same reasoning already applied to P/CG's
own far_part citations earlier the same day (see
sync/pcg_citations.py's FAR_PART_RE and citation_validate.py's far_part
entry in _TABLE_KEY, both added in that earlier pass -- this reuses that
same validated destination, routing, and validation infrastructure).

WHY A SEPARATE SCRIPT rather than extending loi_scraper.py: same reasoning
as loi_ac_citations.py -- the scraper only writes citations for LOIs it
touches during a scrape, so it could never backfill the 1,055 already-
loaded documents. Full-corpus re-scan, safe to re-run any time.

OWNERSHIP / DELETE SCOPING: owns exactly citing_type='loi' AND
cited_type='far_part'. Must not be widened -- loi_scraper.py owns
loi->far, loi_ac_citations.py owns loi->ac, pcg_term_links.py owns
loi->pcg.

Usage:
  python3 loi_far_part_citations.py --dry-run
  python3 loi_far_part_citations.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from citation_validate import fetch_known_ids, filter_resolved

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

# cfr_part_reference is pipe-delimited "Part N" tokens, e.g. "Part 61 | Part 91".
# Confirmed live: every real value matches this shape exactly (no "Parts
# 61 and 91", no bare numbers, no CFR title prefix) -- DRS writes it
# consistently, unlike free-form OCR prose.
PART_TOKEN_RE = re.compile(r"\bPart\s+(\d{1,3})\b")


def fetch_all_lois() -> list[dict]:
    out, offset = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/legal_interpretations",
            headers=HEADERS,
            params={"select": "slug,cfr_part_reference", "limit": 1000, "offset": offset},
            timeout=120,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def extract_citations(loi: dict) -> list[dict]:
    ref = loi.get("cfr_part_reference") or ""
    citations, seen = [], set()
    for m in PART_TOKEN_RE.finditer(ref):
        part = m.group(1)
        if part in seen:
            continue
        seen.add(part)
        citations.append({
            "citing_type": "loi", "citing_id": loi["slug"],
            "cited_type": "far_part", "cited_id": part, "label": None,
        })
    return citations


def delete_existing() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.loi", "cited_type": "eq.far_part"},
        timeout=60,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    B = 500
    for i in range(0, len(rows), B):
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=rows[i:i + B], timeout=60,
        )
        resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        sys.exit(1)

    lois = fetch_all_lois()
    log.info(f"Scanning {len(lois)} LOIs' cfr_part_reference for Part mentions...")

    all_citations = []
    for loi in lois:
        all_citations.extend(extract_citations(loi))
    log.info(f"Found {len(all_citations)} loi->far_part citations across "
              f"{len(set(c['citing_id'] for c in all_citations))} LOIs")

    known = fetch_known_ids()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real far_parts: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        for c in all_citations[:20]:
            log.info(f"  LOI {c['citing_id']} -> Part {c['cited_id']}")
        log.info("(dry run -- nothing written)")
        return

    delete_existing()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} rows.")


if __name__ == "__main__":
    main()
