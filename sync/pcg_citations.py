#!/usr/bin/env python3
"""
P/CG Cross-Reference Citation Extractor
========================================
Scans every pcg_terms row's own definition for AC/FAR/AIM/AD mentions and
writes them to document_citations with citing_type='pcg'. Mirrors
ac_citations.py / far_citations.py / ad_citations.py.

Deliberately does NOT extract pcg->pcg citations here -- pcg_terms.see_refs
(populated at scrape time from the FAA glossary's own structured "See "
cross-references) already covers that relationship precisely, and
pcg/[id].tsx already renders it as its own dedicated section. Duplicating
that into document_citations too would just create two different UIs
showing the same relationship.

Usage:
  python3 pcg_citations.py --dry-run
  python3 pcg_citations.py
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

# Widened 2026-08-10 (corpus-wide P/CG MagicLink investigation) after
# finding real, live misses: three friction-related terms (FRICTION_
# MEASUREMENT, MAINTENANCE_PLANNING_FRICTION_LEVEL, MINIMUM_FRICTION_LEVEL)
# and RUNWAY_SAFETY_AREA all cite "AC 150/5320-12" / "AC 150/5300-13" --
# the FAA's slash-form AC numbering (used for airport-design ACs) -- which
# the old pattern could never match at all: its first segment was a bare
# `\d+(?:\.\d+)?` with no slash option. Two of those four also use a
# Unicode hyphen (U+2010 "‐", seen literally in the source prose) where the
# old pattern's own capture group only ever wrote an ASCII "-" into
# cited_id -- harmless for the OLD pattern (it never reached the slash
# numbers that carry this), but would have silently produced an
# unresolvable cited_id here. All four resolve to a real advisory_circulars
# row via citation_validate.py's existing AC-base-number fallback (e.g.
# "150/5320-12" -> real row "150/5320-12C") once the digits/hyphens
# actually match -- no change needed there.
AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:/\d+)?(?:\.\d+)?[\-‐‑–]\d+[A-Za-z]*(?:[\-‐‑–]\d+)?)\b")
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")
AD_RE = re.compile(r"\bAD\s+(\d{4}-\d{2}-\d{2})\b")

# The FAA's own PDF->HTML text extraction is inconsistent about which
# hyphen-like character it uses in a given document (confirmed live: two of
# the four AC_RE matches above use U+2010 "‐" where the other two use plain
# ASCII "-" for the exact same "150/5320-12" style number). A cited_id has
# to be ASCII-normalized before it's ever compared against a real
# document_number, or it silently never resolves. See Robust Matching
# Mandate in project memory -- applied to all four regexes' captures here,
# not just AC's (the one confirmed affected), since the same FAA-source
# inconsistency could just as easily hit an AIM/AD dash some other week.
_HYPHEN_VARIANTS_RE = re.compile("[‐‑–]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)


def fetch_all_pcg_terms() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/pcg_terms"
            f"?select=slug,definition"
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


def extract_citations(term: dict) -> list[dict]:
    text = term.get("definition") or ""
    citations = []
    seen = set()
    own_id = term["slug"]

    for m in FAR_RE.finditer(text):
        cited_id = _normalize_hyphens(m.group(1))
        key = ("far", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "far", "cited_id": cited_id, "label": None})

    for m in AIM_PARA_RE.finditer(text):
        cited_id = _normalize_hyphens(m.group(1))
        key = ("aim", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "aim", "cited_id": cited_id, "label": None})

    for m in AD_RE.finditer(text):
        cited_id = _normalize_hyphens(m.group(1))
        key = ("ad", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "ad", "cited_id": cited_id, "label": None})

    for m in AC_RE.finditer(text):
        cited_id = _normalize_hyphens(m.group(1))
        key = ("ac", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "ac", "cited_id": cited_id, "label": None})

    return citations


def delete_pcg_citations() -> None:
    """Scoped to the cited_types this script writes.

    Harmless today -- sync/pcg_term_links.py scans FAR/AIM/AC/AD/LOI but not
    the glossary itself, so no pcg->pcg row exists for an unscoped delete to
    destroy. Scoped anyway so that adding glossary-to-glossary linking later
    can't silently resurrect the wipe-another-script's-rows bug that hit
    ad/ac/far/aim. cited_type='pcg' has exactly one owner: pcg_term_links.py.
    """
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.pcg", "cited_type": "in.(ac,far,aim,ad)"},
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

    terms = fetch_all_pcg_terms()
    log.info(f"Scanning {len(terms)} P/CG terms for AC/FAR/AIM/AD mentions...")

    all_citations = []
    for t in terms:
        all_citations.extend(extract_citations(t))

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
            log.info(f"  PCG {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_pcg_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
