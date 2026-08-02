#!/usr/bin/env python3
"""
FAR Cross-Reference Citation Extractor
========================================
Scans every far_sections row's own body_text for AC/AIM/PCG/AD/other-FAR
mentions and writes them to document_citations with citing_type='far'.
Mirrors ac_citations.py / ad_citations.py exactly.

Confirmed real gap before this script existed: document_citations had zero
rows with citing_type='far'. FAR text is mostly cross-referencing other FAR
sections ("except as provided in § 91.117"), which this script also
captures (cited_type='far') so a FAR section's own body gets tappable
sibling-section links via crossRefLinks.ts at render time, and so a FAR
section that's the TARGET of another FAR section's reference shows up in
that target's own Related bars too.

Usage:
  python3 far_citations.py --dry-run
  python3 far_citations.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from citation_validate import fetch_known_ids, fetch_known_pcg_slugs, filter_resolved

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:\.\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b")
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")
AD_RE = re.compile(r"\bAD\s+(\d{4}-\d{2}-\d{2})\b")
PCG_RE = re.compile(r"Pilot/Controller Glossary Term-\s*([^.]+)\.")


def fetch_all_far_sections() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/far_sections"
            f"?select=section_number,body_text"
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


def slugify_pcg_term(term: str) -> str:
    s = term.strip().upper()
    s = re.sub(r"[^A-Z0-9]+", "-", s)
    return s.strip("-")


def extract_citations(section: dict) -> list[dict]:
    text = section.get("body_text") or ""
    citations = []
    seen = set()
    own_id = section["section_number"]

    for m in FAR_RE.finditer(text):
        cited = m.group(1)
        if cited == own_id:
            continue  # a section citing its own number ("as required by this section" restated with its own § number) isn't a real cross-reference
        key = ("far", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "far", "citing_id": own_id, "cited_type": "far", "cited_id": cited, "label": None})

    for m in AIM_PARA_RE.finditer(text):
        key = ("aim", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "far", "citing_id": own_id, "cited_type": "aim", "cited_id": m.group(1), "label": None})

    for m in AD_RE.finditer(text):
        key = ("ad", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "far", "citing_id": own_id, "cited_type": "ad", "cited_id": m.group(1), "label": None})

    # far->pcg is NOT written here -- sync/pcg_term_links.py owns every
    # cited_type='pcg' row corpus-wide. Same reasoning as ac_citations.py:
    # this narrow pass was a subset that got overwritten anyway (the 2,746
    # live far->pcg rows are all pcg_term_links output), and writing them
    # from two places is what forced delete_far_citations() to be unscoped.

    for m in AC_RE.finditer(text):
        cited = m.group(1)
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "far", "citing_id": own_id, "cited_type": "ac", "cited_id": cited, "label": None})

    return citations


def delete_far_citations() -> None:
    """Scoped to the cited_types this script owns.

    It used to delete EVERY citing_type='far' row, taking the 2,746 far->pcg
    links that sync/pcg_term_links.py owns with it -- the single largest
    block of P/CG MagicLinks in the corpus. Safe only by accident of
    scheduling (this runs Mon 12:00, pcg_term_links at 14:00 inside the AD
    sync), so the links were missing for two hours every week and would stay
    missing for a full week if the AD sync failed. Same fix as
    sync/ad_citations.py and sync/ac_citations.py.
    """
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.far", "cited_type": "in.(ac,far,aim,ad)"},
        timeout=30,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    if not rows:
        return
    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=chunk, timeout=30,
        )
        resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        return

    sections = fetch_all_far_sections()
    log.info(f"Scanning {len(sections)} FAR sections for AC/AIM/PCG/AD/FAR mentions...")

    all_citations = []
    for s in sections:
        all_citations.extend(extract_citations(s))

    by_type = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(f"Found {len(all_citations)} citations: {by_type}")

    known = fetch_known_ids()
    known["pcg"] = fetch_known_pcg_slugs()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real targets: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        log.info("Dry run — no writes made.")
        for c in all_citations[:20]:
            log.info(f"  FAR {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_far_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
