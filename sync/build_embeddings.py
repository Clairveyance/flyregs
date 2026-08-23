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
OPENAI_BATCH = 40  # OpenAI embeddings endpoint accepts up to 2048 inputs/req -- kept small for retry-friendliness
UPSERT_SUB_BATCH = 10  # content_chunks upsert batch size -- see upsert_chunks()'s own comment for why this is separate from OPENAI_BATCH and deliberately small


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
    # cfr49_sections was never added here -- confirmed live 2026-08-23
    # (scraper-automation audit): 49 CFR has had zero rows in content_chunks
    # since its sync went live, so semantic search has never covered it at
    # all despite the content being fully scraped and readable in the app.
    # Same shape as far_sections (single-chunk, small rows).
    "cfr49": ("cfr49_sections", "section_number", ["body_text"], "title"),
    # Mnemonics don't have a flat text column to embed -- `senses` is a
    # structured breakdown (letter/concept/detail per row). Rendered to
    # natural language below (render_mnemonic_text) instead of a straight
    # column join, so a query like "what does RAW FAT stand for" or "preflight
    # briefing mnemonic" actually lands close to the mnemonic's own embedding.
    # Stored under source_type "dictionary" (task #63) -- reuses the RegType
    # ask-flyregs.tsx/citedItems.ts already route and label correctly,
    # rather than inventing a parallel "mnemonic" type only this one path
    # would ever produce.
    "mnemonic": ("dictionary_terms", "slug", ["senses"], "term"),
}


def render_mnemonic_text(term: str, senses: list[dict] | str) -> str:
    """Turn a mnemonic's structured `senses` breakdown into a natural-
    language paragraph worth embedding. senses is a list of {usage,
    breakdown: [{letter, concept, detail}], definition} -- see the real
    shape confirmed live 2026-08-05 (e.g. "RAW FAT")."""
    import json
    if isinstance(senses, str):
        senses = json.loads(senses)
    parts = [f'"{term}" is an aviation mnemonic.']
    for sense in senses or []:
        breakdown = sense.get("breakdown") or []
        if breakdown:
            items = ", ".join(
                f"{b['letter']} – {b['concept']}" + (f" ({b['detail']})" if b.get("detail") else "")
                for b in breakdown if b.get("letter") and b.get("concept")
            )
            if items:
                parts.append(f"{term} stands for: {items}.")
        if sense.get("definition"):
            parts.append(sense["definition"])
    return " ".join(parts)


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


def fetch_rows(
    table: str, key_field: str, text_fields: list[str], title_field: str, only: str | None,
    extra_params: dict | None = None,
) -> list[dict]:
    # PostgREST silently caps unfiltered .select() results at 1000 rows with
    # no error -- confirmed the hard way elsewhere in this project (far/
    # index.tsx's AC count, pcg/[id].tsx's sibling nav). far_sections alone
    # is 4272 rows, so a single unpaginated fetch would quietly embed only
    # the first 1000 and call it done. Page with .range() until a page
    # comes back short.
    select = ",".join({key_field, title_field, *text_fields})
    if only:
        params = {"select": select, key_field: f"eq.{only}", **(extra_params or {})}
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
            params={"select": select, "limit": str(page_size), "offset": str(offset), **(extra_params or {})},
            timeout=60,
        )
        resp.raise_for_status()
        page = resp.json()
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out


# doc_type -> extra PostgREST filter params for fetch_rows, applied only to
# that source's rows (mnemonic is the one dictionary_terms category worth
# embedding for Ask FlyRegs -- the other ~9,760 rows are plain glossary
# entries, not natural-language-answerable content).
FETCH_FILTERS = {"mnemonic": {"category": "eq.mnemonic"}}

# doc_type -> the source_type actually written to content_chunks. Only
# "mnemonic" differs -- stored as "dictionary" so ask-flyregs.tsx/
# citedItems.ts's existing RegType routing/icon/label just works, rather
# than teaching those a brand-new type only this one source produces.
SOURCE_TYPE_OVERRIDE = {"mnemonic": "dictionary"}


def embed_batch(texts: list[str]) -> list[list[float]]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set (.env.embeddings) -- cannot call the embeddings API")
    # Retry on 429/5xx with exponential backoff -- confirmed live 2026-08-23:
    # the weekly-embeddings-refresh.yml GH Actions run and a local catch-up
    # run happened to overlap and hit OpenAI's rate limit, and the whole job
    # died on the first 429 with zero retry. Even without a collision, a
    # multi-thousand-chunk run pushing this many requests can transiently
    # trip a rate limit on its own -- this was a real gap for the ongoing
    # weekly job, not just today's specific overlap.
    last_err = None
    for attempt in range(5):
        try:
            resp = requests.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
                json={"model": EMBEDDING_MODEL, "input": texts},
                timeout=120,
            )
            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("retry-after")
                wait = float(retry_after) if retry_after else (2 ** attempt) * 2
                log.warning(f"  embeddings API {resp.status_code}, retrying in {wait:.0f}s (attempt {attempt + 1}/5)")
                time.sleep(wait)
                last_err = requests.exceptions.HTTPError(f"{resp.status_code} after retries", response=resp)
                continue
            resp.raise_for_status()
            data = resp.json()["data"]
            data.sort(key=lambda d: d["index"])
            return [d["embedding"] for d in data]
        except requests.exceptions.RequestException as e:
            last_err = e
            wait = (2 ** attempt) * 2
            log.warning(f"  embeddings API request failed ({e}), retrying in {wait:.0f}s (attempt {attempt + 1}/5)")
            time.sleep(wait)
    raise RuntimeError(f"embed_batch failed after 5 attempts: {last_err}")


def existing_hashes(doc_type: str) -> dict[str, str]:
    """chunk_text sha -> True, keyed by (source_id, chunk_index), to skip
    re-embedding unchanged chunks on repeat runs."""
    stored_type = SOURCE_TYPE_OVERRIDE.get(doc_type, doc_type)
    out: dict[str, str] = {}
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/content_chunks",
            headers=SB_HEADERS,
            params={
                "select": "source_id,chunk_index,chunk_text",
                "source_type": f"eq.{stored_type}",
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


def upsert_chunks_batch(rows: list[dict]) -> None:
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


def upsert_chunks(rows: list[dict]) -> list[dict]:
    """Upserts in sub-batches of UPSERT_SUB_BATCH, falling back to one-row-
    at-a-time on any sub-batch failure. Confirmed live (2026-08-06, mnemonic
    re-embed): a 40-row upsert batch can genuinely 500 with `57014 canceling
    statement due to statement timeout` -- NOT the payload-size theory this
    file used to carry (a 40-row/~800KB payload isn't large; the real cost
    is per-row HNSW vector-index + tsvector-trigger maintenance on
    content_chunks, confirmed by timing: 5/10/20/30-row batches took
    0.8s/5.0s/9.5s/4.8s -- too volatile to fix with a single smaller
    constant, especially under concurrent load on the Micro compute tier).
    Returns the list of rows that ended up NOT successfully upserted (empty
    if everything succeeded) -- the caller must not count a row as embedded
    unless it's absent from this list. A prior version of this function
    counted every attempted row as a success regardless of whether the
    upsert actually happened, so a batch failure like the one above was
    reported as "N newly embedded/updated" while up to 40 rows silently kept
    serving stale chunk_text -- caught only by a manual direct DB check
    after the fact, not by anything this script itself reported."""
    failed: list[dict] = []
    for i in range(0, len(rows), UPSERT_SUB_BATCH):
        sub = rows[i:i + UPSERT_SUB_BATCH]
        try:
            upsert_chunks_batch(sub)
            continue
        except requests.exceptions.RequestException:
            pass
        # Sub-batch failed -- fall back to one row at a time so a single
        # slow/bad row can't take the rest of the sub-batch down with it.
        for row in sub:
            try:
                upsert_chunks_batch([row])
            except requests.exceptions.RequestException as e:
                log.warning(f"upsert failed for {row['source_type']}:{row['source_id']}::{row['chunk_index']}: {e}")
                failed.append(row)
    return failed


def run_type(doc_type: str, only: str | None, dry_run: bool) -> tuple[int, int]:
    table, key_field, text_fields, title_field = SOURCES[doc_type]
    stored_type = SOURCE_TYPE_OVERRIDE.get(doc_type, doc_type)
    log.info(f"[{doc_type}] fetching source rows from {table}...")
    rows = fetch_rows(table, key_field, text_fields, title_field, only, FETCH_FILTERS.get(doc_type))
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
            # upsert_chunks sub-batches + falls back to per-row retry
            # internally (see its own docstring) and returns only the rows
            # that genuinely never made it in -- content-hashing means a
            # re-run of this script will retry exactly those next time.
            # Deliberately NOT counting every attempted row here anymore:
            # confirmed live that the old code counted a whole failed batch
            # as "embedded" regardless of outcome, silently masking up to 40
            # stale rows behind a success-looking log line.
            failed = upsert_chunks(pending_meta)
            if failed:
                lost = [m["source_id"] for m in failed]
                log.warning(f"[{doc_type}] {len(lost)} chunk(s) still failed after per-row retry: {lost}")
        total_embedded += len(pending_texts) - (len(failed) if not dry_run else 0)
        pending_texts.clear()
        pending_meta.clear()

    for row in rows:
        key = row.get(key_field)
        title = row.get(title_field) or ""
        if doc_type == "mnemonic":
            text = render_mnemonic_text(title, row.get("senses"))
        else:
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
                "source_type": stored_type,
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
