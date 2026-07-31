#!/usr/bin/env python3
"""
P/CG term -> document MagicLink builder.
========================================
Closes the single biggest hole in the MagicLink graph. Measured on the live
corpus before this existed:

    citing->cited   ac->pcg 0   far->pcg 0   ad->pcg 0   loi->pcg 0
                    aim->pcg 10   (out of 438 AIM paragraphs)

...i.e. the Pilot/Controller Glossary was effectively disconnected from the
rest of the corpus, even though a glossary is by definition the thing every
other document draws its vocabulary from. Confirmed concretely: AIM 11-4-6
contains 13 P/CG terms verbatim (CONTROLLED AIRSPACE, CLASS E AIRSPACE,
SPECIAL USE AIRSPACE, ...) and showed "P/CG terms 0" in its MagicLink pod.

WHY the existing extractors missed it: ac_citations/far_citations/
aim_citations/ad_citations/pcg_citations all match *document numbers* by
regex ("AC 91-73", "§ 91.3", "AIM 4-3-13", "AD 2018-02-04"). A P/CG entry has
no number -- its identifier IS an English phrase. Number-regex extraction can
never produce a ->pcg link, so this needs phrase matching instead, which is a
different mechanism and needs its own precision rules.

PRECISION RULES (the hard part -- a naive "link every P/CG term found" is
worse than no links at all, because ~40 of the 1,332 terms are ordinary words
like AIRCRAFT / TRAFFIC / ESTABLISHED / ASSOCIATED that appear in nearly every
FAA document and would bury the genuinely useful links):

  * Multi-word terms are always eligible -- "CONTROLLED AIRSPACE" is
    unambiguous wherever it appears.
  * Single-word terms must be >= MIN_SINGLE_LEN chars AND rare in the corpus
    (search_vocabulary.doc_freq <= MAX_SINGLE_DF). This keeps "B4UFLY" and
    "TRANSPONDER" while dropping "AIRCRAFT" (in ~half the corpus).
  * Matches are whole-phrase on word boundaries, longest-first, and a longer
    match consumes its span so "CLASS E AIRSPACE" doesn't also emit the
    shorter "AIRSPACE".
  * Hard cap per document, most-specific first, so one long AD can't emit 60
    links.

Idempotent: deletes this script's own ->pcg rows before inserting, because
document_citations has no unique constraint (see
memory/gotcha_upsert_nullable_conflict_key.md -- repeat runs previously
5x-bloated this table).

Usage:
  python3 pcg_term_links.py --dry-run
  python3 pcg_term_links.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from collections import defaultdict

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

# PostgREST + service key, exactly like the sibling citation extractors --
# NOT the Supabase management API. The management token can alter the whole
# project and is deliberately not a CI secret; the weekly workflows only ever
# hand the sync scripts SUPABASE_URL + SUPABASE_SERVICE_KEY. Using the mgmt
# API here would have made this script unrunnable in GitHub Actions without
# granting CI far more privilege than a data job needs.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

MIN_SINGLE_LEN = 7      # single-word term must be at least this long
MAX_SINGLE_DF = 400     # ...and appear in at most this many corpus documents
MAX_LINKS_PER_DOC = 12
MAX_TERM_WORDS = 6

# Ordinary English/aviation filler that happens to be a P/CG headword. These
# would otherwise match nearly every document in the corpus.
BLOCKLIST = {
    "AIRCRAFT", "TRAFFIC", "ESTABLISHED", "ASSOCIATED", "AIRPORT", "RUNWAY",
    "TAXIWAY", "APPROACH", "DEPARTURE", "ALTITUDE", "HEADING", "ROUTE",
    "SEGMENT", "REPORT", "REQUEST", "RESUME", "RADAR", "BEACON", "CEILING",
    "CLEARANCE", "FINAL", "HOLD", "SPEED", "TIME", "TOWER", "WAYPOINT",
    "AIRWAY", "APRON", "ARRIVAL", "BLOCKED", "CENTER", "CHART", "CIRCLE",
    "CLIMB", "CONTACT", "CROSS", "DELAY", "DESCEND", "EXPEDITE", "FEEDER",
    "FIX", "FLIGHT", "GATE", "GROUND", "LANDING", "LOCALIZER", "MINIMA",
    "MONITOR", "OPTION", "PILOT", "PROCEDURE", "RAMP", "READBACK", "SAY",
    "SERVICE", "SQUAWK", "STAND", "STOP", "TAXI", "TERMINAL", "TRACK",
    "TRANSMIT", "VERIFY", "WEATHER", "WIND",
    # Second pass, added after inspecting the actual link distribution rather
    # than guessing: these were the single most-linked terms in the whole
    # graph -- MAINTAIN 338, OPERATIONAL 312, DEVIATION 143, IMMEDIATELY 139,
    # CONTINUE 138. They ARE genuine P/CG entries (ATC phraseology), but as
    # plain English words they appear in nearly every FAA document, so each
    # one buried the specific links in ~300 documents while teaching a reader
    # nothing. The >= MIN_SINGLE_LEN + doc_freq filters don't catch them:
    # they're long enough, and their doc_freq sits just under the cap.
    "MAINTAIN", "OPERATIONAL", "IMMEDIATELY", "CONTINUE", "DEVIATION",
    "DISCRETE", "EXPECTED", "AFFIRMATIVE", "NEGATIVE", "ROGER", "STANDBY",
    "ACKNOWLEDGE", "ADVISE", "APPROVED", "CORRECTION", "DECISION",
}

WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-/]*")


def fetch_all(table: str, select: str) -> list[dict]:
    """Paginated PostgREST select -- an unfiltered request silently caps at
    1000 rows with no error (see memory/gotcha_postgrest_1000_row_cap.md)."""
    rows, off = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS,
            params={"select": select, "limit": 1000, "offset": off},
            timeout=120,
        )
        resp.raise_for_status()
        page = resp.json()
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def norm_words(text: str) -> list[str]:
    return [w.lower() for w in WORD_RE.findall(text or "")]


def build_term_index() -> dict[tuple[str, ...], tuple[str, str]]:
    """key = tuple of lowercased words -> (slug, display term)."""
    terms = fetch_all("pcg_terms", "slug,term")
    dfmap = {r["term"]: r["doc_freq"] for r in fetch_all("search_vocabulary", "term,doc_freq")}
    idx: dict[tuple[str, ...], tuple[str, str]] = {}
    skipped_generic = 0

    # PRIMARY-BEFORE-ICAO ORDERING -- this sort is load-bearing, not cosmetic.
    # 61 P/CG phrases exist twice: the FAA definition ("CONTROLLED AIRSPACE")
    # and an international one ("CONTROLLED AIRSPACE [ICAO]"). Both normalize
    # to the same key once the bracketed tag is stripped, so whichever is
    # written LAST wins the dict slot. Unsorted, that was the ICAO variant:
    # 1,079 of 7,269 links (15%) pointed at the international definition, and
    # the primary CONTROLLED_AIRSPACE entry -- this script's own headline
    # example -- ended up with ZERO inbound links. A US pilot reading the AIM
    # tapping "CONTROLLED AIRSPACE" got the ICAO definition instead of the FAA
    # one. Sorting untagged terms first, combined with setdefault below, makes
    # the primary definition win and leaves the [ICAO] entry reachable only by
    # its own distinct phrasing.
    def has_tag(t: dict) -> bool:
        return bool(re.search(r"\[[^\]]*\]\s*$", (t["term"] or "").strip()))

    for t in sorted(terms, key=lambda t: (has_tag(t), t["slug"] or "")):
        term = (t["term"] or "").strip()
        if not term:
            continue
        # Drop the FAA's bracketed source tags -- "RESTRICTED AREA [ICAO]" is
        # the same phrase in running text as "RESTRICTED AREA".
        clean = re.sub(r"\s*\[[^\]]*\]\s*$", "", term).strip()
        words = tuple(norm_words(clean))
        if not words or len(words) > MAX_TERM_WORDS:
            continue
        if len(words) == 1:
            w = words[0]
            if clean.upper() in BLOCKLIST or len(w) < MIN_SINGLE_LEN or dfmap.get(w, 0) > MAX_SINGLE_DF:
                skipped_generic += 1
                continue
        idx.setdefault(words, (t["slug"], term))
    log.info(f"eligible P/CG terms: {len(idx)} (skipped {skipped_generic} generic single-words)")
    return idx


def find_terms(text: str, idx, maxlen: int) -> list[tuple[str, str, int]]:
    """Longest-first, non-overlapping. Returns (slug, term, nwords)."""
    words = norm_words(text)
    n = len(words)
    used = [False] * n
    found: dict[str, tuple[str, str, int]] = {}
    for size in range(min(maxlen, MAX_TERM_WORDS), 0, -1):
        for i in range(0, n - size + 1):
            if any(used[i:i + size]):
                continue
            key = tuple(words[i:i + size])
            hit = idx.get(key)
            if hit:
                for j in range(i, i + size):
                    used[j] = True
                found.setdefault(hit[0], (hit[0], hit[1], size))
    # Most specific (longest phrase) first, then alphabetical for stability.
    return sorted(found.values(), key=lambda x: (-x[2], x[1]))[:MAX_LINKS_PER_DOC]


# (doc_type, table, key column, [text columns to concatenate])
# PostgREST can't evaluate SQL expressions, so the concatenation that used to
# live in the query now happens client-side in main().
SOURCES = [
    ("far", "far_sections", "section_number", ["title", "body_text"]),
    ("aim", "aim_paragraphs", "paragraph_number", ["title", "body_text"]),
    ("ac", "advisory_circulars", "document_number", ["title", "description"]),
    ("ad", "airworthiness_directives", "ad_number", ["subject_heading", "unsafe_condition"]),
    ("loi", "legal_interpretations", "slug", ["title", "summary"]),
]


def delete_existing() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"cited_type": "eq.pcg"},
        timeout=120,
    )
    resp.raise_for_status()


def insert_rows(rows: list[dict]) -> None:
    B = 500
    for i in range(0, len(rows), B):
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers={**HEADERS, "Prefer": "return=minimal"},
            json=rows[i:i + B],
            timeout=120,
        )
        resp.raise_for_status()
        log.info(f"  inserted {min(i + B, len(rows))}/{len(rows)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    idx = build_term_index()
    maxlen = max(len(k) for k in idx)

    rows: list[dict] = []
    per_type: dict[str, int] = defaultdict(int)
    for dtype, table, key, textcols in SOURCES:
        docs = fetch_all(table, ",".join([key] + textcols))
        log.info(f"{dtype}: scanning {len(docs)} docs...")
        for d in docs:
            k = d.get(key)
            if not k:
                continue
            text = " ".join((d.get(c) or "") for c in textcols)
            for slug, term, _ in find_terms(text, idx, maxlen):
                rows.append({
                    "citing_type": dtype, "citing_id": k,
                    "cited_type": "pcg", "cited_id": slug, "label": term,
                })
                per_type[dtype] += 1

    log.info("--- link counts by source type ---")
    for t, n in sorted(per_type.items()):
        log.info(f"  {t}->pcg: {n}")
    log.info(f"  TOTAL: {len(rows)}")

    if args.dry_run:
        log.info("(dry run -- nothing written)")
        return

    # Idempotent rebuild. Safe to re-run weekly: this owns every
    # cited_type='pcg' row, so clearing them first is what keeps repeat runs
    # from multiplying the table (document_citations has no unique constraint).
    delete_existing()
    insert_rows(rows)

    # POST-WRITE COUNT CHECK. delete-then-insert has a real failure mode that
    # is otherwise completely silent: if the process dies partway through the
    # batched insert, the old rows are already gone and the table is left
    # holding a fraction of the graph, with a clean-looking log and no error.
    # This bit for real on 2026-07-30 -- an interrupted run left 4,000 of
    # 6,096 rows and nothing anywhere said so. Exiting non-zero here makes a
    # partial write fail the weekly workflow loudly instead of quietly
    # shipping a degraded MagicLink graph.
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "count=exact", "Range": "0-0"},
        params={"select": "citing_id", "cited_type": "eq.pcg"},
        timeout=120,
    )
    resp.raise_for_status()
    actual = int(resp.headers.get("content-range", "0-0/0").split("/")[-1])
    if actual != len(rows):
        log.error(f"PARTIAL WRITE: expected {len(rows)} pcg rows, table has {actual}. Re-run this script.")
        sys.exit(1)
    log.info(f"done. verified {actual} rows.")


if __name__ == "__main__":
    main()
