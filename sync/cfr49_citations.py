#!/usr/bin/env python3
"""
49 CFR Cross-Reference Citation Extractor
========================================
Scans every cfr49_sections row's own body_text for FAR/AC/AIM/AD/other-cfr49
mentions and writes them to document_citations with citing_type='cfr49'.
Mirrors far_citations.py exactly (see that file's own header) -- built the
same day as the cfr49 content itself, per RC: "make sure all ML, refs,
links etc are fully incorporated into all new regs we're adding."

One real difference from far_citations.py: within cfr49 body text, a bare
"§ N.N" is an eCFR SAME-TITLE self-reference (confirmed live -- 49 CFR
830.6's own text says "The notification required in § 830.5 shall
contain...", meaning the OTHER 49 CFR section, never a FAR section). FAR
cross-references from cfr49 text are always explicitly prefixed "14 CFR" or
"FAR" (confirmed live in HMR 175.75's own text: "Class B aircraft cargo
compartment in 14 CFR 25.857(b)"). So this script uses two DISJOINT
patterns instead of far_citations.py's one combined FAR_RE -- CFR49_RE for
bare § (validated against cfr49_sections), FAR_RE for the explicit-prefix
form (validated against far_sections) -- rather than reusing FAR_RE's own
bare-§ branch, which would have mis-attributed every cfr49 self-reference
to cited_type='far'.

Usage:
  python3 cfr49_citations.py --dry-run
  python3 cfr49_citations.py
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

# Bare "§ N.N" -- a same-title (49 CFR) self-reference, see this file's own
# docstring. Deliberately does NOT include "FAR"/"14 CFR" the way
# far_citations.py's own FAR_RE does -- those are handled by FAR_RE below,
# a completely separate cited_type.
CFR49_RE = re.compile(r"§\s*(\d+\.\d+)\b")
# Explicit cross-title reference into 14 CFR -- never bare § within cfr49
# text (see docstring), so "FAR"/"14 CFR" must appear literally.
FAR_RE = re.compile(r"\b(?:FAR\s+|14\s*CFR\s*(?:section\s+)?)(\d+\.\d+)\b", re.IGNORECASE)
AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:/\d+)?(?:\.\d+)?[\-‐‑–]\d+[A-Za-z]*(?:[\-‐‑–]\d+)?)\b")
# The FAA also spells this out in full ("Advisory Circular No. 120-12A",
# "Advisory Circular 20-420") instead of abbreviating to "AC" -- confirmed
# live and corpus-wide (RC, real content-correction report): 36 LOIs alone
# use this phrasing with zero overlap with AC_RE, a real silent hole shared
# by every extractor built on this same AC_RE pattern (fixed together in
# ad/ac/aim/cfr49/far/loi/pcg/acs). Matches are whitespace-stripped below
# before use -- the source carries the same stray-space artifacts this
# corpus is already known for.
AC_RE_SPELLED = re.compile(r"\bAdvisory\s+Circular\s+(?:No\.?\s*)?(\d+(?:/\d+)?(?:\.\d+)?\s*[\-‐‑–]\s*\d+[A-Za-z]*(?:\s*[\-‐‑–]\s*\d+)?)\b", re.IGNORECASE)
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")
AD_RE = re.compile(r"\bAD\s+(\d{4}-\d{2}-\d{2})\b")

_HYPHEN_VARIANTS_RE = re.compile("[‐‑–]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)


def fetch_all_cfr49_sections() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/cfr49_sections"
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


def extract_citations(section: dict) -> list[dict]:
    text = section.get("body_text") or ""
    citations = []
    seen = set()
    own_id = section["section_number"]

    for m in CFR49_RE.finditer(text):
        cited = m.group(1)
        if cited == own_id:
            continue
        key = ("cfr49", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "cfr49", "cited_id": cited, "label": None})

    for m in FAR_RE.finditer(text):
        cited = m.group(1)
        key = ("far", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "far", "cited_id": cited, "label": None})

    for m in AIM_PARA_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("aim", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "aim", "cited_id": cited, "label": None})

    for m in AD_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("ad", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "ad", "cited_id": cited, "label": None})

    for m in AC_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "ac", "cited_id": cited, "label": None})

    for m in AC_RE_SPELLED.finditer(text):
        cited = _normalize_hyphens(re.sub(r"\s+", "", m.group(1)))
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "cfr49", "citing_id": own_id, "cited_type": "ac", "cited_id": cited, "label": None})

    return citations


def delete_cfr49_citations() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.cfr49", "cited_type": "in.(ac,far,aim,ad,cfr49)"},
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

    sections = fetch_all_cfr49_sections()
    log.info(f"Scanning {len(sections)} cfr49 sections for FAR/AC/AIM/AD/cfr49 mentions...")

    all_citations = []
    for s in sections:
        all_citations.extend(extract_citations(s))

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
            log.info(f"  cfr49 {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_cfr49_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
