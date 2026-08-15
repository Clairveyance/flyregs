#!/usr/bin/env python3
"""
AIM -> FAR Citation Extractor (body-text scan)
========================================
aim_scraper.py's own citation extraction only scans a paragraph's formal
<aside class="reference-box"> element, not its general body prose -- real
gap confirmed live: after adding FAR-mention detection to that function,
a full re-scrape only turned up 2 aim->far citations across the entire
438-paragraph corpus, because most FAR mentions in AIM live in ordinary
sentences ("(see 14 CFR 91.117)"), not the reference box. This script
mirrors ad_citations.py's proven approach: scan the paragraph's actual
stored body_text (+ reference_text) for FAR mentions with the same regex
already used everywhere else in this project, and write cited_type='far'
rows.

Deliberately scoped to ONLY cited_type='far' -- aim_scraper.py's own
reference-box extraction already covers aim/ac/pcg citations reasonably
(and precisely, via real DOM xref links for the aim->aim case), so this
script's delete-then-insert is scoped to (citing_type='aim' AND
cited_type='far') specifically, not the whole citing_type='aim' bucket --
re-running this must never wipe out the HTML scraper's own aim/ac/pcg rows.

Usage:
  python3 aim_far_citations.py --dry-run
  python3 aim_far_citations.py
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

# Same pattern already proven in ad_citations.py, aim_scraper.py, and
# crossRefLinks.ts's render-time linkifier.
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")

# AC mentions. aim_scraper.py also has an _AC_RE, but it only ever runs over
# the Reference BOX (`ref_text`), never the paragraph body -- so of the 27 AIM
# paragraphs that name an AC in their prose, exactly ONE was ever extracted.
# This script already reads body_text AND reference_text, so it is the right
# owner for both directions. Same pattern as ad_citations.py.
#
# Widened 2026-08-10 (ported from pcg_citations.py's own fix, same day): the
# old pattern couldn't match the FAA's slash-form AC numbering
# ("AC 150/5320-12") -- confirmed real live misses in P/CG text; AIM prose
# citing the same airport-design AC family would hit the identical gap.
AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:/\d+)?(?:\.\d+)?[\-\u2010\u2011\u2013]\d+[A-Za-z]*(?:[\-\u2010\u2011\u2013]\d+)?)\b")

# See far_citations.py's identical constant -- always explicitly prefixed
# "49 CFR" in real AIM text, never bare "\u00a7 N.N", so no collision with FAR_RE
# above. Low yield in AIM specifically (2 real paragraphs corpus-wide), but
# built for consistency with every other citing type this session added it
# to.
CFR49_RE = re.compile(r"\b49\s*CFR\s*(?:part\s+)?(\d+\.\d+)\b", re.IGNORECASE)

# See pcg_citations.py for why: the FAA's own PDF->HTML extraction is
# inconsistent about which hyphen-like character it uses for the same
# number, so a cited_id has to be ASCII-normalized before comparing against
# a real document_number, or it silently never resolves.
_HYPHEN_VARIANTS_RE = re.compile("[\u2010\u2011\u2013]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)


def fetch_all_paragraphs() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/aim_paragraphs"
            f"?select=paragraph_number,body_text,reference_text"
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


def extract_citations(para: dict) -> list[dict]:
    text = " ".join(filter(None, [para.get("body_text"), para.get("reference_text")]))
    citations = []
    seen = set()  # dedup WITHIN one paragraph -- repeating the same section 3x isn't 3 separate real citations

    for m in FAR_RE.finditer(text):
        cited_id = m.group(1)
        if ("far", cited_id) not in seen:
            seen.add(("far", cited_id))
            citations.append({
                "citing_type": "aim", "citing_id": para["paragraph_number"],
                "cited_type": "far", "cited_id": cited_id, "label": None,
            })

    for m in AC_RE.finditer(text):
        cited_id = _normalize_hyphens(m.group(1))
        key = ("ac", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({
                "citing_type": "aim", "citing_id": para["paragraph_number"],
                "cited_type": "ac", "cited_id": cited_id, "label": None,
            })

    for m in CFR49_RE.finditer(text):
        cited_id = m.group(1)
        key = ("cfr49", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({
                "citing_type": "aim", "citing_id": para["paragraph_number"],
                "cited_type": "cfr49", "cited_id": cited_id, "label": None,
            })

    return citations


def delete_aim_far_citations() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.aim", "cited_type": "in.(far,ac,cfr49)"},
        timeout=30,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows, timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        return

    paragraphs = fetch_all_paragraphs()
    log.info(f"Scanning {len(paragraphs)} AIM paragraphs for FAR mentions in body text...")

    all_citations = []
    for para in paragraphs:
        all_citations.extend(extract_citations(para))

    by_type: dict[str, int] = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(
        f"Found {len(all_citations)} citations {by_type} across "
        f"{len(set(c['citing_id'] for c in all_citations))} paragraphs"
    )

    known = fetch_known_ids()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real targets: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        log.info("Dry run — no writes made.")
        for c in all_citations[:20]:
            log.info(f"  AIM {c['citing_id']} -> {c['cited_type'].upper()} {c['cited_id']}")
        return

    delete_aim_far_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
