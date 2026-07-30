#!/usr/bin/env python3
"""
Backfill/refresh content_chunks + embeddings for semantic search.
========================================
Keyword search (search_far/search_aim/search_acs RPCs, ts_rank-based) can't
tell "aircraft weight and balance" from "how to teach weight and balance" --
tried tuning the ranking function (ts_rank_cd, term-coverage) and confirmed
live that fixing one case broke another. This is the real fix: embed every
FAR/AIM/P-CG/AC/AD/LOI chunk once, then compare a query's own embedding by
cosine distance via pgvector (content_chunks, semantic_search() RPC).

Chunking: FAR/AIM/P-CG/LOI rows are small enough to embed whole (single
chunk, index 0). AC/AD are not -- 452/781 ACs exceed a single embedding
call's ~8191-token limit (confirmed: max AC is 832K chars), so those are
split on paragraph boundaries into ~3000-char chunks (~750 tokens, comfortably
under the limit) with no overlap needed since paragraph boundaries are
already natural semantic breaks.

Usage:
    python3 build_embeddings.py --types far aim pcg          # small day-1 test
    python3 build_embeddings.py --types far aim pcg ac ad loi --all
    python3 build_embeddings.py --types ac --only 20-106      # single doc, for spot checks

Cost: OpenAI text-embedding-3-small, $0.02 / 1M tokens. Full corpus is
~113M characters (~28M tokens) -> under $1 total. Re-running only embeds
rows whose text changed since their last embedding (content-hash check),
so weekly re-runs after this are effectively free.
"""
from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
import time
from pathlib import Path

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMS = 1536
CHUNK_TARGET_CHARS = 3000
OPENAI_BATCH = 40  # OpenAI embeddings endpoint accepts up to 2048 inputs/req -- kept small for retry-friendliness AND because a 96-row upsert payload (96 x 1536-float embeddings) 500'd against PostgREST on LOI; smaller batches avoid the payload-size cliff


def load_env() -> dict:
    env = {}
    for fname in (".env.scraper", ".env.embeddings"):
        p = ROOT / fname
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            if k.startswith("export "):
                k = k[len("export "):].strip()
            env[k] = v.strip().strip('"').strip("'")
    return env


ENV = load_env()
SUPABASE_URL = ENV.get("SUPABASE_URL")
SUPABASE_SERVICE_KEY = ENV.get("SUPABASE_SERVICE_KEY")
OPENAI_API_KEY = ENV.get("OPENAI_API_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    sys.exit("Missing SUPABASE_URL/SUPABASE_SERVICE_KEY (.env.scraper)")

SB_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}

# doc_type -> (table, key_field, text_field(s), title_field)
SOURCES = {
    "far": ("far_sections", "section_number", ["body_text"], "title"),
    "aim": ("aim_paragraphs", "paragraph_number", ["body_text"], "title"),
    "pcg": ("pcg_terms", "slug", ["definition"], "term"),
    "loi": ("legal_interpretations", "slug", ["body_text"], "title"),
    "ac": ("advisory_circulars", "document_number", ["pdf_text"], "title"),
    "ad": ("airworthiness_directives", "ad_number", ["body_text"], "subject_heading"),
}


def split_paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.split("\n\n") if p.strip()]


def chunk_text(text: str, target_chars: int = CHUNK_TARGET_CHARS) -> list[str]:
    """Greedy paragraph-packing: fill each chunk up to target_chars, never
    splitting a paragraph across chunks unless that single paragraph alone
    exceeds target_chars (rare; falls back to a hard char-slice for those)."""
    paras = split_paragraphs(text)
    if not paras:
        return []
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for p in paras:
        if len(p) > target_chars * 2:
            if current:
                chunks.append("\n\n".join(current))
                current, current_len = [], 0
            for i in range(0, len(p), target_chars):
                chunks.append(p[i:i + target_chars])
            continue
        if current_len + len(p) > target_chars and current:
            chunks.append("\n\n".join(current))
            current, current_len = [], 0
        current.append(p)
        current_len += len(p) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def fetch_rows(table: str, key_field: str, text_fields: list[str], title_field: str, only: str | None) -> list[dict]:
    # PostgREST silently caps unfiltered .select() results at 1000 rows with
    # no error -- confirmed the hard way elsewhere in this project (far/
    # index.tsx's AC count, pcg/[id].tsx's sibling nav). far_sections alone
    # is 4272 rows, so a single unpaginated fetch would quietly embed only
    # the first 1000 and call it done. Page with .range() until a page
    # comes back short.
    select = ",".join({key_field, title_field, *text_fields})
    if only:
        params = {"select": select, key_field: f"eq.{only}"}
        resp = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SB_HEADERS, params=params, timeout=60)
        resp.raise_for_status()
        return resp.json()

    out: list[dict] = []
    # advisory_circulars.pdf_text can run up to 832K chars/row -- a 1000-row
    # page of those blew out PostgREST with a 500 (confirmed live). Small
    # tables don't need the extra round trips, so only shrink the page for
    # the tables actually carrying huge text blobs.
    page_size = 100 if table == "advisory_circulars" else 1000
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=SB_HEADERS,
            params={"select": select, "limit": str(page_size), "offset": str(offset)},
            timeout=60,
        )
        resp.raise_for_status()
        page = resp.json()
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out


def embed_batch(texts: list[str]) -> list[list[float]]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set (.env.embeddings) -- cannot call the embeddings API")
    resp = requests.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={"model": EMBEDDING_MODEL, "input": texts},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    data.sort(key=lambda d: d["index"])
    return [d["embedding"] for d in data]


def existing_hashes(doc_type: str) -> dict[str, str]:
    """chunk_text sha -> True, keyed by (source_id, chunk_index), to skip
    re-embedding unchanged chunks on repeat runs."""
    out: dict[str, str] = {}
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/content_chunks",
            headers=SB_HEADERS,
            params={
                "select": "source_id,chunk_index,chunk_text",
                "source_type": f"eq.{doc_type}",
                "limit": "1000",
                "offset": str(offset),
            },
            timeout=60,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            break
        for r in rows:
            out[f"{r['source_id']}::{r['chunk_index']}"] = content_hash(r["chunk_text"])
        offset += len(rows)
        if len(rows) < 1000:
            break
    return out


def upsert_chunks(rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/content_chunks",
        headers={**SB_HEADERS, "Prefer": "resolution=merge-duplicates,return=minimal"},
        params={"on_conflict": "source_type,source_id,chunk_index"},
        json=rows,
        timeout=60,
    )
    resp.raise_for_status()


def run_type(doc_type: str, only: str | None, dry_run: bool) -> tuple[int, int]:
    table, key_field, text_fields, title_field = SOURCES[doc_type]
    log.info(f"[{doc_type}] fetching source rows from {table}...")
    rows = fetch_rows(table, key_field, text_fields, title_field, only)
    log.info(f"[{doc_type}] {len(rows)} source rows")

    existing = existing_hashes(doc_type)

    pending_texts: list[str] = []
    pending_meta: list[dict] = []
    total_chunks = 0
    total_embedded = 0

    def flush():
        nonlocal total_embedded
        if not pending_texts:
            return
        if dry_run:
            log.info(f"[{doc_type}] (dry-run) would embed {len(pending_texts)} chunks")
        else:
            vectors = embed_batch(pending_texts)
            for meta, vec in zip(pending_meta, vectors):
                meta["embedding"] = str(vec)
            try:
                upsert_chunks(pending_meta)
            except requests.exceptions.RequestException as e:
                # A single bad batch (confirmed once: a 500 from PostgREST on
                # an oversized upsert payload) shouldn't take down the whole
                # multi-type run -- log which source_ids were lost and keep
                # going; content-hashing means a re-run only retries these.
                lost = [m["source_id"] for m in pending_meta]
                log.warning(f"[{doc_type}] batch upsert failed ({len(lost)} chunks, ids: {lost[:5]}{'...' if len(lost) > 5 else ''}): {e}")
        total_embedded += len(pending_texts)
        pending_texts.clear()
        pending_meta.clear()

    for row in rows:
        key = row.get(key_field)
        title = row.get(title_field) or ""
        text = " ".join((row.get(f) or "") for f in text_fields).strip()
        if not key or not text:
            continue
        chunks = chunk_text(text)
        for idx, chunk in enumerate(chunks):
            total_chunks += 1
            h = content_hash(chunk)
            if existing.get(f"{key}::{idx}") == h:
                continue  # unchanged since last embed run
            embed_input = f"{title}\n\n{chunk}" if title else chunk
            pending_texts.append(embed_input[:8000])  # hard safety cap, well under the token limit
            pending_meta.append({
                "source_type": doc_type,
                "source_id": key,
                "chunk_index": idx,
                "title": title,
                "chunk_text": chunk,
            })
            if len(pending_texts) >= OPENAI_BATCH:
                flush()
                time.sleep(0.2)
    flush()

    log.info(f"[{doc_type}] done. {total_chunks} total chunks, {total_embedded} newly embedded/updated")
    return total_chunks, total_embedded


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--types", nargs="+", choices=list(SOURCES.keys()), required=True)
    ap.add_argument("--only", help="single source_id, for spot-checking one doc")
    ap.add_argument("--dry-run", action="store_true", help="chunk and count, skip embedding API calls")
    args = ap.parse_args()

    grand_chunks = 0
    grand_embedded = 0
    for t in args.types:
        c, e = run_type(t, args.only, args.dry_run)
        grand_chunks += c
        grand_embedded += e
    log.info(f"TOTAL: {grand_chunks} chunks across {len(args.types)} type(s), {grand_embedded} embedded/updated this run")


if __name__ == "__main__":
    main()
