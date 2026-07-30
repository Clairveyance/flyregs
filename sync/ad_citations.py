#!/usr/bin/env python3
"""
AD Cross-Reference Citation Extractor
========================================
Scans every airworthiness_directives row's own text (summary,
applicability, unsafe_condition, body_text) for AC/FAR/AIM mentions and
writes them to document_citations with citing_type='ad' — this is what
makes an AC/FAR/AIM page able to show "N ADs reference this" (the reverse-
citation direction explicitly requested alongside AD-to-AC/FAR/AIM inline
linking, which crossRefLinks.ts already handles at render time from the
same AD body text with no DB citations needed for that direction).

Same regex patterns already used for this class of mention elsewhere in
this project (aim_scraper.py's _AC_RE, crossRefLinks.ts's FAR pattern) --
kept consistent rather than reinventing a slightly-different one here.

Delete-then-insert per citing_type, same convention as
aim_scraper.py's delete_citations_for_source()/insert_citations() --
document_citations has no natural per-row unique key (a citing doc can
legitimately cite the same target more than once from different
sections), so a plain re-run without deleting first would duplicate.

Usage:
  python3 ad_citations.py --dry-run
  python3 ad_citations.py
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

AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:\.\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b")
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")


def fetch_all_ads() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives"
            f"?select=ad_number,summary,applicability,unsafe_condition,body_text"
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


def extract_citations(ad: dict) -> list[dict]:
    text = " ".join(filter(None, [ad.get("summary"), ad.get("applicability"), ad.get("unsafe_condition"), ad.get("body_text")]))
    citations = []
    seen = set()  # (cited_type, cited_id) dedup WITHIN one AD's own text — repeating the same AC 3x in one AD isn't 3 separate real citations

    for m in AC_RE.finditer(text):
        key = ("ac", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "ac", "cited_id": m.group(1), "label": None})

    for m in FAR_RE.finditer(text):
        key = ("far", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "far", "cited_id": m.group(1), "label": None})

    for m in AIM_PARA_RE.finditer(text):
        key = ("aim", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "aim", "cited_id": m.group(1), "label": None})

    return citations


def delete_ad_citations() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.ad"},
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

    ads = fetch_all_ads()
    log.info(f"Scanning {len(ads)} ADs for AC/FAR/AIM mentions...")

    all_citations = []
    for ad in ads:
        all_citations.extend(extract_citations(ad))

    by_type = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(f"Found {len(all_citations)} citations: {by_type}")

    known = fetch_known_ids()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real targets: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        log.info("Dry run — no writes made.")
        for c in all_citations[:20]:
            log.info(f"  AD {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_ad_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
