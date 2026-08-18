#!/usr/bin/env python3
"""
AC Cross-Reference Citation Extractor
========================================
Scans every advisory_circulars row's own pdf_text for FAR/AIM/PCG/AD
mentions and writes them to document_citations with citing_type='ac' --
mirrors ad_citations.py exactly (same regex patterns, same delete-then-
insert-per-citing_type convention).

Confirmed real, total gap before this script existed: document_citations
had zero rows with citing_type='ac' across the entire 778-AC catalog --
no ac_citations.py (or equivalent) had ever been built, despite
far/[id].tsx, aim/[id].tsx, and ad/[id].tsx's MagicLinkPod bars all
depending on inbound citations from ACs to populate their "Related ACs"
counts. This is why e.g. FAR 61.56 showed 0 Related ACs despite AC 61-98E
citing it directly in its own Purpose section.

Usage:
  python3 ac_citations.py --dry-run
  python3 ac_citations.py
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

# Same patterns as ad_citations.py / aim_far_citations.py / crossRefLinks.ts's
# render-time linkifier -- kept consistent rather than reinventing slightly
# different ones per source. FAR_RE also matches the "Title 14 of the Code
# of Federal Regulations (14 CFR) part 61, § 61.56" phrasing (the § form),
# which is the exact real-world shape confirmed missing on AC 61-98E.
#
# AC_RE widened 2026-08-10 (ported from pcg_citations.py's own fix, same
# day): the old pattern's first segment was a bare `\d+(?:\.\d+)?` with no
# slash option, so it could never match the FAA's slash-form AC numbering
# used for airport-design ACs ("AC 150/5320-12"). Real live misses of this
# exact shape were confirmed in P/CG prose; AC/FAR/AD prose reasonably cites
# the same airport-design AC family, so the same gap likely exists here too.
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
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")
AD_RE = re.compile(r"\bAD\s+(\d{4}-\d{2}-\d{2})\b")
PCG_RE = re.compile(r"Pilot/Controller Glossary Term-\s*([^.]+)\.")
# See far_citations.py's identical constant -- always explicitly prefixed
# "49 CFR" in real AC text (confirmed live: 80 real advisory_circulars rows
# contain it), never bare "§ N.N", so no collision with FAR_RE above.
CFR49_RE = re.compile(r"\b49\s*CFR\s*(?:part\s+)?(\d+\.\d+)\b", re.IGNORECASE)

# The FAA's own PDF->HTML text extraction is inconsistent about which
# hyphen-like character it uses for the same "150/5320-12" style number
# (confirmed live in pcg_citations.py's own investigation) -- normalize
# before comparing against a real document_number, or it silently never
# resolves. Same fix as pcg_citations.py, ported here.
_HYPHEN_VARIANTS_RE = re.compile("[‐‑–]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)


def fetch_all_acs() -> list[dict]:
    # Small page size -- pdf_text is often tens of KB per row, and a
    # limit=1000 pull (confirmed live) blows Supabase's statement timeout
    # (PostgREST error 57014). 100 stays well under it.
    out = []
    offset = 0
    page = 100
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=document_number,pdf_text"
            f"&limit={page}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out


def slugify_pcg_term(term: str) -> str:
    # Mirror src/lib/pcg.ts's slugifyPcgTerm exactly (upper-case, spaces/
    # punctuation to hyphens) so cited_id matches pcg_terms.slug.
    s = term.strip().upper()
    s = re.sub(r"[^A-Z0-9]+", "-", s)
    return s.strip("-")


def extract_citations(ac: dict) -> list[dict]:
    text = ac.get("pdf_text") or ""
    citations = []
    seen = set()  # (cited_type, cited_id) dedup WITHIN one AC's own text

    for m in FAR_RE.finditer(text):
        key = ("far", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "far", "cited_id": m.group(1), "label": None})

    for m in AIM_PARA_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("aim", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "aim", "cited_id": cited, "label": None})

    for m in AD_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("ad", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "ad", "cited_id": cited, "label": None})

    # ac->pcg is NOT written here. sync/pcg_term_links.py owns every
    # cited_type='pcg' row and rebuilds them across the whole corpus with
    # full glossary-phrase matching; this narrow PCG_RE pass was a strict
    # subset that got overwritten later the same day anyway (verified: the
    # 515 live ac->pcg rows are all pcg_term_links output). Writing them from
    # both places is what forced this script's delete to be unscoped, which
    # in turn wiped pcg_term_links' rows -- see delete_ac_citations().

    for m in AC_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        if cited == ac["document_number"]:
            continue  # self-citation (e.g. a "cancels AC 90-66" self-reference isn't real here) -- skip
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "ac", "cited_id": cited, "label": None})

    for m in AC_RE_SPELLED.finditer(text):
        cited = _normalize_hyphens(re.sub(r"\s+", "", m.group(1)))
        if cited == ac["document_number"]:
            continue
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "ac", "cited_id": cited, "label": None})

    for m in CFR49_RE.finditer(text):
        cited = m.group(1)
        key = ("cfr49", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ac", "citing_id": ac["document_number"], "cited_type": "cfr49", "cited_id": cited, "label": None})

    return citations


def delete_ac_citations() -> None:
    """Scoped to the cited_types this script owns.

    It used to delete EVERY citing_type='ac' row, which also removed the 515
    ac->pcg links that sync/pcg_term_links.py owns and rebuilds corpus-wide.
    That was only safe by accident of scheduling -- pcg_term_links runs last
    in the week (AD sync, Mon 14:00), after this one at 10:00 -- so between
    10:00 and 14:00 every AC lost its glossary MagicLinks, and if the AD sync
    ever failed they stayed gone until the next Monday. Same bug and same fix
    as sync/ad_citations.py.
    """
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.ac", "cited_type": "in.(ac,far,aim,ad,cfr49)"},
        timeout=30,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    if not rows:
        return
    # Chunked -- 778 ACs can produce several thousand rows, and PostgREST
    # has a practical payload-size ceiling worth staying well under.
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

    acs = fetch_all_acs()
    log.info(f"Scanning {len(acs)} ACs for FAR/AIM/PCG/AD/AC mentions...")

    all_citations = []
    for ac in acs:
        all_citations.extend(extract_citations(ac))

    by_type = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(f"Found {len(all_citations)} citations: {by_type}")

    # Only write citations whose target actually exists -- a regex match on
    # a plausible-looking section/AC/AD number is not the same as a real,
    # navigable target. See citation_validate.py's header comment for the
    # 4,200-dead-link audit finding that made this necessary.
    known = fetch_known_ids()
    known["pcg"] = fetch_known_pcg_slugs()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real targets: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        log.info("Dry run — no writes made.")
        for c in all_citations[:20]:
            log.info(f"  AC {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_ac_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
