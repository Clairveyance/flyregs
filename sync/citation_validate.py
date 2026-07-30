#!/usr/bin/env python3
"""
Shared citation-target validation
========================================
Every *_citations.py script in this project (ac, ad, far, aim_far, pcg)
extracts cross-references via regex over raw prose and previously wrote
EVERY match straight to document_citations with no check that the target
actually exists. Confirmed live via a full-corpus audit (2026-07-29): this
produced 4,200+ dead-end MagicLinks app-wide (e.g. AC 27-1B citing FAR
23.1419 -- a real section number, but one that hasn't existed since Part 23
was rewritten in 2017; the regex has no way to know that).

loi_citation_extract.py already solved this exact problem for LOIs with a
resolved/historical distinction. This module generalizes that pattern to
every other content type so it's one shared, consistent check instead of
five slightly-different reimplementations.

A citation only needs its target to EXIST as a real row -- not to have
non-empty body text. A row that exists but is genuinely empty (a FAR
"[Reserved]" section, for instance) still renders a real, informative page
(see far/[id].tsx's Reserved-aware empty state); a row that doesn't exist
at all renders "not found," which is the actual dead end this module
prevents.
"""
from __future__ import annotations

import os

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

_TABLE_KEY = {
    "far": ("far_sections", "section_number"),
    "ac": ("advisory_circulars", "document_number"),
    "aim": ("aim_paragraphs", "paragraph_number"),
    "ad": ("airworthiness_directives", "ad_number"),
}


def _fetch_ids(table: str, key_col: str) -> set[str]:
    out: set[str] = set()
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": key_col, "limit": 1000, "offset": offset},
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.update(r[key_col] for r in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def fetch_known_ids() -> dict[str, set[str]]:
    """One real DB round-trip per content type, reused across every
    cited_type a script's regex set might produce. pcg is handled
    separately by callers that need it (its natural key -- term vs slug --
    depends on citing vs cited direction, unlike the other four)."""
    known: dict[str, set[str]] = {}
    for cited_type, (table, key_col) in _TABLE_KEY.items():
        known[cited_type] = _fetch_ids(table, key_col)
    return known


def fetch_known_pcg_slugs() -> set[str]:
    """Different citing scripts derive a PCG cited_id from the same term in
    three different ways -- pcg_scraper.py's own underscore-joined slug
    (the real pcg_terms.slug column), aim_scraper.py's raw
    term.upper() (spaces intact, matches pcg_terms.term), and ac_citations.py
    / far_citations.py's own hyphen-joined slugify_pcg_term(). Rather than
    unify those three call sites, this returns the union of all three forms
    so validation matches regardless of which convention produced a given
    citation."""
    out: set[str] = set()
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/pcg_terms",
            headers=HEADERS,
            params={"select": "term,slug", "limit": 1000, "offset": offset},
            timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        for r in batch:
            out.add(r["slug"])
            out.add(r["term"])
            out.add(r["term"].replace(" ", "-"))
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def filter_resolved(citations: list[dict], known: dict[str, set[str]]) -> tuple[list[dict], int]:
    """Returns (resolved_citations, dropped_count). A citation whose
    cited_type isn't in `known` at all (caller didn't fetch it) passes
    through unfiltered rather than being silently dropped."""
    resolved = []
    dropped = 0
    for c in citations:
        ids = known.get(c["cited_type"])
        if ids is None or c["cited_id"] in ids:
            resolved.append(c)
        else:
            dropped += 1
    return resolved, dropped
