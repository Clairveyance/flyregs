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
from citation_validate import fetch_known_ids, filter_resolved  # noqa: E402

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
# The FAA also spells this out in full ("Advisory Circular No. 120-12A",
# "Advisory Circular 20-420") instead of abbreviating to "AC" -- confirmed
# live and corpus-wide (RC, real content-correction report): 36 LOIs alone
# use this phrasing with zero overlap with AC_RE, a real silent hole shared
# by every extractor built on this same AC_RE pattern (fixed together in
# ad/ac/aim/cfr49/far/loi/pcg/acs). Matches are whitespace-stripped below
# before use -- the source carries the same stray-space artifacts this
# corpus is already known for.
AC_RE_SPELLED = re.compile(r"\bAdvisory\s+Circular\s+(?:No\.?\s*)?(\d+(?:/\d+)?(?:\.\d+)?\s*[\-‐‑–]\s*\d+[A-Za-z]*(?:\s*[\-‐‑–]\s*\d+)?)\b", re.IGNORECASE)
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+(?:[Ss]ection\s+)?|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")
# Widened to match ad_citations.py's own AD_RE (optional close-paren,
# tolerant of stray whitespace around the internal hyphens -- "AD 2022-
# 19- 02" is a real, confirmed PDF-extraction artifact) -- this file's
# copy had drifted narrower than the sibling that originally proved the
# wider pattern necessary, a real corpus-wide extraction-consistency gap
# found while auditing every citation regex for the same class of drift.
AD_RE = re.compile(r"\bAD\)?\s*(\d{4}\s*-\s*\d{2}\s*-\s*\d{2})\b")

# Added 2026-08-10 -- the real gap behind RC's own flagged example ("IFR
# TAKEOFF MINIMUMS AND DEPARTURE PROCEDURES" cites "Title 14 Code of
# Federal Regulations, part 91" with no section number). FAR_RE requires a
# dotted section number and correctly never matches this shape -- there was
# previously no extraction path for a bare Part reference at all. Now
# resolvable: routeForCitedItem (src/lib/citedItems.ts) sends cited_type=
# 'far_part' to /far/part/<part>, and citation_validate.py's _TABLE_KEY
# validates it against far_parts.part -- both fixed the same day, in the
# same investigation, specifically so this extraction could ship without
# creating a new dead-link class the moment it went live. The "14 CFR"/
# "FAR" prefix is optional (confirmed real prose omits it: "...for part 91
# or part 107 UAS..."), but the negative lookahead excludes a part number
# immediately followed by ".digit" -- that shape is a real section citation
# FAR_RE already owns (e.g. "part 91.113"), not a bare Part reference.
#
# Capture group changed \d{1,3} -> [1-9]\d{0,2} (no leading zero) 2026-08-17
# while porting this pattern to ac/ad/aim/far_citations.py: a real live
# false positive was found in AD body text -- "approved equivalent part
# 001, dated June 5..." (a physical service-bulletin part number, not a
# CFR Part) -- matching lowercase "part" the same way a genuine "part 91"
# reference does. No genuine FAA regulatory citation is ever
# zero-padded ("Part 091"), so this closes the false-positive class with
# zero risk to real matches. Ported back here for consistency even though
# no live pcg_terms row was confirmed hit by it (P/CG definitions are too
# short/curated to plausibly discuss numbered physical parts).
FAR_PART_RE = re.compile(r"\b(?:14\s*CFR\s*|FAR\s+)?[Pp]art\s+([1-9]\d{0,2})\b(?!\.\d)")
# Plural "Parts N, M, and O" -- see ac_citations.py's own FAR_PART_ENUM_RE
# comment.
FAR_PART_ENUM_RE = re.compile(r"\b(?:14\s*CFR\s*|FAR\s+)?[Pp]arts\s+([1-9]\d{0,2}(?:(?:\s*,\s*(?:and\s+|or\s+)?|\s+(?:and|or|through)\s+)[1-9]\d{0,2})+)\b")
_BARE_NUM_RE = re.compile(r"[1-9]\d{0,2}")

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
        cited_id = _normalize_hyphens(re.sub(r"\s+", "", m.group(1)))
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

    for m in AC_RE_SPELLED.finditer(text):
        cited_id = _normalize_hyphens(re.sub(r"\s+", "", m.group(1)))
        key = ("ac", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "ac", "cited_id": cited_id, "label": None})

    for m in FAR_PART_RE.finditer(text):
        cited_id = m.group(1)
        key = ("far_part", cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "far_part", "cited_id": cited_id, "label": None})

    for m in FAR_PART_ENUM_RE.finditer(text):
        for sm in _BARE_NUM_RE.finditer(m.group(1)):
            cited_id = sm.group(0)
            key = ("far_part", cited_id)
            if key not in seen:
                seen.add(key)
                citations.append({"citing_type": "pcg", "citing_id": own_id, "cited_type": "far_part", "cited_id": cited_id, "label": None})

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
        params={"citing_type": "eq.pcg", "cited_type": "in.(ac,far,far_part,aim,ad)"},
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
