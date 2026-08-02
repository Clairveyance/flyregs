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
import re

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


# Strips a trailing revision-letter run only -- "90-105A" -> "90-105",
# "150/5210-7E" -> "150/5210-7". Deliberately narrower than a general
# alphanumeric strip: an AC number's own numeric segments (the "150/5210"
# part, or a "-7" sub-part) must never be touched, only a letter suffix
# sitting at the very end.
_AC_REVISION_SUFFIX_RE = re.compile(r"[A-Za-z]+$")


def _ac_base(document_number: str) -> str:
    return _AC_REVISION_SUFFIX_RE.sub("", document_number)


def build_ac_base_lookup(ac_ids: set[str]) -> dict[str, list[str]]:
    """base-number -> every real document_number sharing it, e.g.
    "90-105" -> ["90-105A"]. Confirmed live 2026-08-02 (MagicLink coverage
    sweep): prose almost always cites an AC by its bare base number ("AC
    90-105"), never the current revision letter a reader has no way to
    know without already having the document open -- of 54 real AIM->AC
    mentions found by aim_far_citations.py, 43 were being dropped as
    "target doesn't exist" purely because of this, not because the AC
    itself doesn't exist. See filter_resolved()'s own fallback for how
    this gets used -- only applied when it resolves to EXACTLY one real AC,
    never guessed among several."""
    lookup: dict[str, list[str]] = {}
    for real_id in ac_ids:
        lookup.setdefault(_ac_base(real_id), []).append(real_id)
    return lookup


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
    through unfiltered rather than being silently dropped.

    No signature change for any of the five existing callers -- the AC
    base-number fallback (see build_ac_base_lookup's own docstring) is
    computed here, once per call, straight from known['ac'] whenever a
    caller already fetched it (every current caller does, via
    fetch_known_ids()), so every script gets this fix automatically.

    Drops two shapes scripts/magiclink_audit.py caught live in production
    the day the AC base-number fallback above first ran for real: (1)
    self-links -- a document's own prose citing an earlier, un-revised form
    of its own number (e.g. AC 00-31A's text says "AC 00-31") now resolves
    the fallback straight back to the citing document itself; a handful of
    exact-match self-citations existed before this too (a doc naming itself
    in its own header/history text). Neither is a real MagicLink. (2)
    Post-resolution duplicate edges -- extract_citations()'s own dedup runs
    on the RAW matched text (e.g. "120-28" vs "120-28A" both appearing in
    the same document), so two distinct raw mentions that resolve to the
    same real target only collide here, after resolution, not before."""
    ac_base_lookup = build_ac_base_lookup(known["ac"]) if "ac" in known else {}

    resolved = []
    seen_edges: set[tuple] = set()
    dropped = 0
    for c in citations:
        ids = known.get(c["cited_type"])
        if ids is None or c["cited_id"] in ids:
            final = c
        elif c["cited_type"] == "ac":
            candidates = ac_base_lookup.get(_ac_base(c["cited_id"]), [])
            if len(candidates) == 1:
                final = {**c, "cited_id": candidates[0]}
            else:
                dropped += 1
                continue
        else:
            dropped += 1
            continue

        if final["cited_type"] == final["citing_type"] and final["cited_id"] == final["citing_id"]:
            dropped += 1
            continue
        edge = (final["citing_type"], final["citing_id"], final["cited_type"], final["cited_id"])
        if edge in seen_edges:
            dropped += 1
            continue
        seen_edges.add(edge)
        resolved.append(final)
    return resolved, dropped
