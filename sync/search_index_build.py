#!/usr/bin/env python3
"""
SmartSearch index builder — rebuilds `search_vocabulary` + `search_term_associations`.
=====================================================================================
Replaces two ad-hoc scripts that lived in scripts/ (build_search_associations.py,
rebuild_search_vocabulary.py). Merging them was not cosmetic — three real
problems came from having them separate:

  1. NEITHER WAS AUTOMATED. They were run by hand once. Every weekly content
     sync afterwards would have drifted these tables out of date, silently
     degrading SmartSearch — against the app's own "always up to date" claim.
  2. BOTH USED THE SUPABASE MANAGEMENT API, so neither could run in GitHub
     Actions: the weekly workflows only ever provide SUPABASE_URL +
     SUPABASE_SERVICE_KEY, and a management token (which can alter the whole
     project) has no business being a CI secret for a data job.
  3. THEY FOUGHT OVER ONE TABLE. Both wrote `search_vocabulary` — the
     associations builder wrote STEMMED tokens, the vocabulary builder then
     overwrote it with UNSTEMMED surface forms. Correct only if run in that
     exact order, with nothing recording that dependency. Here there is one
     owner and one pass.

They also both scanned the identical 6-table corpus, so merging halves the
read work.

TWO INDEXES, TWO DIFFERENT TOKENIZATIONS — this is deliberate, do not unify:
  * `search_term_associations` is built over LIGHT-STEMMED tokens, so
    landing/landings collapse into one concept for the similarity maths.
  * `search_vocabulary` stores UNSTEMMED SURFACE FORMS, because it drives
    PREFIX expansion, which is a pure string operation. Using stemmed forms
    there leaked non-words into the UI — confirmed live: expanding "gas"
    offered "gase" and "gaseou" (the stemmer's output for gases/gaseous).

Ordering matters downstream: sync/pcg_term_links.py reads
`search_vocabulary.doc_freq` to decide whether a single-word P/CG term is
specific enough to link, so this MUST run before it. See sync_ad.sh.

Usage:
  python3 search_index_build.py --dry-run
  python3 search_index_build.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
from collections import Counter

import numpy as np
import requests
from scipy import sparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}

# Carries no topical signal; would otherwise dominate every association list.
STOPWORDS = set("""
a an and are as at be been being but by for from had has have he her his i if in
into is it its of on or our out over own s so such t than that the their them then
there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your
shall must may might can could should also each any all no not nor only other more
most some own same such per section paragraph subpart part chapter appendix
title code federal regulation regulations cfr faa administrator
means include includes including required require requires requirement requirements
use used using following provided provide provides accordance applicable
person persons operator operators aircraft airplane
date time day days year years number
issuing issued issue issues prompted prompt result results resulting report reports
reported addressed address addresses determine determined determines determining
receive received receives notice notified notify notification comment comments
proposed propose adopt adopted adopting final rule ruling docket amendment amend
amended amendments effective compliance comply complying complied action actions
condition conditions unsafe correct corrected corrective identified identify
inspect inspected inspection inspections replace replaced replacement install
installed installation accomplish accomplished perform performed appropriate
approved approve approval acceptable specified specify specific certain given
new existing prior previous subsequent additional further above below herein
paragraph paragraphs reference references note notes exception except unless
however therefore accordingly whether either neither both same different
appended denoted hourly remark remarks senior contraction pellet
""".split())

MIN_TERM_LEN = 3
MIN_DOC_FREQ = 5
MAX_DOC_FRAC = 0.30
TOP_K = 8
MIN_SIM = 0.32

TOKEN_RE = re.compile(r"[a-z][a-z\-']{2,}")

# (table, [columns to concatenate])
SOURCES = [
    ("far_sections", ["title", "body_text"]),
    ("aim_paragraphs", ["title", "body_text"]),
    ("pcg_terms", ["term", "definition"]),
    ("advisory_circulars", ["title", "description"]),
    ("airworthiness_directives", ["subject_heading", "unsafe_condition"]),
    ("legal_interpretations", ["title", "summary"]),
]


def fetch_all(table: str, select: str) -> list[dict]:
    """Paginated — an unfiltered PostgREST select silently caps at 1000 rows."""
    rows, off = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=HEADERS, params={"select": select, "limit": 1000, "offset": off},
            timeout=180,
        )
        resp.raise_for_status()
        page = resp.json()
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def replace_table(table: str, rows: list[dict]) -> None:
    """Full rebuild. These tables are wholly owned by this script, so clearing
    first is what keeps a weekly re-run from multiplying them (neither has a
    unique constraint)."""
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"term": "neq.\x00"},  # matches every row; PostgREST requires a filter
        timeout=180,
    )
    resp.raise_for_status()
    B = 1000
    for i in range(0, len(rows), B):
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={**HEADERS, "Prefer": "return=minimal"},
            json=rows[i:i + B], timeout=180,
        )
        r.raise_for_status()
        log.info(f"  {table}: {min(i + B, len(rows))}/{len(rows)}")


def stem(tok: str) -> str:
    """Light, deliberately NOT a real stemmer — over-stemming ("aviation" ->
    "aviat") would make the associations unreadable if ever surfaced."""
    if tok.endswith("ies") and len(tok) > 5:
        return tok[:-3] + "y"
    if tok.endswith(("sses", "shes", "ches")):
        return tok[:-2]
    if tok.endswith("s") and not tok.endswith("ss") and len(tok) > 3:
        return tok[:-1]
    return tok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    log.info("fetching corpus...")
    docs: list[str] = []
    for table, cols in SOURCES:
        rows = fetch_all(table, ",".join(cols))
        docs.extend(" ".join((r.get(c) or "") for c in cols) for r in rows)
        log.info(f"  {table}: {len(rows)}")
    n_docs = len(docs)
    log.info(f"total documents: {n_docs}")

    # ── Pass 1: unstemmed surface forms -> search_vocabulary ────────────────
    surface_df: Counter[str] = Counter()
    # ── Pass 2: stemmed tokens -> association matrix ────────────────────────
    stem_docs: list[set[str]] = []
    stem_df: Counter[str] = Counter()

    for d in docs:
        toks = TOKEN_RE.findall(d.lower())
        surface_df.update(set(toks))
        st = {stem(t) for t in toks}
        st = {t for t in st if len(t) >= MIN_TERM_LEN and t not in STOPWORDS}
        stem_docs.append(st)
        stem_df.update(st)

    vocab_rows = [
        {"term": t, "doc_freq": c}
        for t, c in surface_df.items()
        if c >= MIN_DOC_FREQ and len(t) >= MIN_TERM_LEN
    ]
    log.info(f"search_vocabulary: {len(vocab_rows)} surface forms")

    max_df = int(n_docs * MAX_DOC_FRAC)
    vocab = sorted(t for t, c in stem_df.items() if MIN_DOC_FREQ <= c <= max_df)
    vindex = {t: i for i, t in enumerate(vocab)}
    log.info(f"association vocabulary: {len(vocab)} stemmed terms")

    rows_i, cols_i = [], []
    for di, toks in enumerate(stem_docs):
        for t in toks:
            i = vindex.get(t)
            if i is not None:
                rows_i.append(i)
                cols_i.append(di)
    M = sparse.csr_matrix(
        (np.ones(len(rows_i), dtype=np.float32), (rows_i, cols_i)),
        shape=(len(vocab), n_docs), dtype=np.float32,
    )
    idf = np.log(n_docs / np.asarray(M.sum(axis=0)).ravel().clip(min=1)).astype(np.float32)
    M = M.multiply(idf[None, :]).tocsr()
    norms = np.sqrt(M.multiply(M).sum(axis=1)).A.ravel()
    norms[norms == 0] = 1.0
    M = sparse.diags(1.0 / norms).dot(M).tocsr().astype(np.float32)

    log.info("computing term-term similarity...")
    assoc_rows: list[dict] = []
    BLOCK = 400
    for start in range(0, len(vocab), BLOCK):
        end = min(start + BLOCK, len(vocab))
        sims = (M[start:end] @ M.T).toarray()
        for r in range(end - start):
            gi = start + r
            row = sims[r]
            row[gi] = 0.0
            if row.max() < MIN_SIM:
                continue
            top = np.argpartition(row, -TOP_K)[-TOP_K:]
            for j in top:
                if row[j] >= MIN_SIM:
                    assoc_rows.append({"term": vocab[gi], "related": vocab[j], "score": round(float(row[j]), 4)})
        log.info(f"  {end}/{len(vocab)}")
    log.info(f"search_term_associations: {len(assoc_rows)} pairs")

    if args.dry_run:
        log.info("(dry run -- nothing written)")
        return

    replace_table("search_vocabulary", vocab_rows)
    replace_table("search_term_associations", assoc_rows)
    log.info("done.")


if __name__ == "__main__":
    main()
