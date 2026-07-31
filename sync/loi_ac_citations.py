#!/usr/bin/env python3
"""
LOI -> AC citation extractor.
=============================
Closes the last measured hole in the MagicLink graph. Scanning every LOI body
for AC references found 30 documents naming an AC in their prose, and the
graph held ZERO loi->ac links, because loi_scraper.py only ever extracts FAR
citations (via loi_citation_extract.py, which is deliberately FAR-only — a
legal interpretation is by definition an interpretation OF a regulation).

But interpretations routinely point at the guidance material too ("as
described in AC 120-16E"), and that is a link a reader wants.

WHY A SEPARATE SCRIPT rather than extending loi_scraper.py: the scraper only
writes citations for LOIs it touches during a scrape, so it could never
backfill the 1,055 already-loaded documents. This is a standalone full-corpus
re-scan, the same shape as ad_citations.py / aim_far_citations.py, and can be
re-run any time without re-scraping.

OWNERSHIP / DELETE SCOPING: this owns exactly citing_type='loi' AND
cited_type='ac'. It must not be widened. loi_scraper.py owns loi->far and
pcg_term_links.py owns loi->pcg; an over-broad delete here would silently
destroy theirs (that exact bug was found and fixed in ad_citations.py and
loi_scraper.py in this same pass).

Usage:
  python3 loi_ac_citations.py --dry-run
  python3 loi_ac_citations.py
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

# Same AC pattern already proven in ad_citations.py and aim_far_citations.py —
# kept identical rather than inventing a third dialect.
AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:\.\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b")


def fetch_all_lois() -> list[dict]:
    out, offset = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/legal_interpretations",
            headers=HEADERS,
            params={"select": "slug,title,summary,body_text", "limit": 1000, "offset": offset},
            timeout=120,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def _base(ac_id: str) -> str:
    """AC number with any trailing revision letter removed: 120-16E -> 120-16."""
    return re.sub(r"[A-Za-z]+$", "", ac_id)


def build_revision_map(known_acs: set[str]) -> dict[str, str]:
    """Maps an AC base number to the single AC we hold for it.

    WHY: interpretations cite the revision that was current when they were
    written. Measured here: of 28 cited ACs we couldn't resolve, 22 are an
    EARLIER REVISION of an AC we do hold (LOI says 120-16E, catalogue has
    120-16G). Dropping those loses real, useful links — the reader wants that
    AC, and the current revision is the right thing to open.

    THE TRAP THIS AVOIDS: matching on prefix would resurrect a bug this
    project already fixed once, where "AC 120-12" resolved to "AC 120-126A".
    So the match is on the EXACT base — base("120-12") == "120-12" never
    equals base("120-126A") == "120-126". And a base with more than one
    catalogue entry is skipped entirely rather than guessed at.
    """
    by_base: dict[str, list[str]] = {}
    for ac in known_acs:
        by_base.setdefault(_base(ac), []).append(ac)
    return {b: v[0] for b, v in by_base.items() if len(v) == 1}


def extract_citations(loi: dict) -> list[dict]:
    text = " ".join(filter(None, [loi.get("title"), loi.get("summary"), loi.get("body_text")]))
    citations, seen = [], set()
    for m in AC_RE.finditer(text):
        cited_id = m.group(1)
        if cited_id in seen:
            continue
        seen.add(cited_id)
        citations.append({
            "citing_type": "loi", "citing_id": loi["slug"],
            "cited_type": "ac", "cited_id": cited_id, "label": None,
        })
    return citations


def delete_existing() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.loi", "cited_type": "eq.ac"},
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
    log.info(f"Scanning {len(lois)} LOIs for AC mentions...")

    all_citations = []
    for loi in lois:
        all_citations.extend(extract_citations(loi))
    log.info(f"Found {len(all_citations)} loi->ac citations across "
             f"{len(set(c['citing_id'] for c in all_citations))} LOIs")

    known = fetch_known_ids()
    known_acs = known["ac"]

    # Redirect earlier-revision citations to the revision we actually hold,
    # BEFORE validation, so they survive filter_resolved instead of being
    # dropped as dead targets. See build_revision_map for the exact-base rule
    # that keeps this from re-creating the old 120-12 -> 120-126A mismatch.
    rev = build_revision_map(known_acs)
    redirected = 0
    for c in all_citations:
        if c["cited_id"] not in known_acs:
            target = rev.get(_base(c["cited_id"]))
            if target and target != c["cited_id"]:
                # Keep the citation as written in the LOI as the label, so the
                # reader can see it referenced an older revision.
                c["label"] = f"cited as AC {c['cited_id']}"
                c["cited_id"] = target
                redirected += 1
    log.info(f"Redirected {redirected} citations to the revision now in the catalogue.")

    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real ACs: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    # Dedupe AFTER the redirect, not before. extract_citations() dedupes on
    # the id as WRITTEN in the LOI, but the redirect above collapses several
    # of those onto one catalogue revision -- an LOI citing AC 120-16,
    # 120-16F and 120-16G produced three separate rows all pointing at
    # 120-16G. Measured live: loi->ac was the ONLY citation pair in the whole
    # corpus with duplicate rows (6 of 39, 15%), and document_citations has
    # no unique constraint to catch it. MagicLinks render per row, so each
    # duplicate showed up as a repeated link under the LOI.
    # Keep the first occurrence: it carries the "cited as AC ..." label from
    # the earliest revision actually mentioned.
    deduped, seen_pairs = [], set()
    for c in all_citations:
        key = (c["citing_id"], c["cited_id"])
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        deduped.append(c)
    if len(deduped) != len(all_citations):
        log.info(f"Deduped {len(all_citations) - len(deduped)} rows that collapsed "
                 f"onto the same AC revision after redirect.")
    all_citations = deduped

    if args.dry_run:
        for c in all_citations[:15]:
            log.info(f"  LOI {c['citing_id']} -> AC {c['cited_id']}")
        log.info("(dry run -- nothing written)")
        return

    delete_existing()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} rows.")


if __name__ == "__main__":
    main()
