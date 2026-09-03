#!/usr/bin/env python3
"""Mandatory pre-write snapshot for any bulk content operation.

RC, 2026-09-02, after I emptied three Advisory Circulars mid-re-scrape:
"dammit man, i told you about regression. and now you've lost more stuff...
we spent so much time and money fixing everything, then you just delete it
b/c you're acting carelessly. stop it. you CANNOT allow any regression."

He is right, and an apology is not a fix. The incident was not bad luck: a
script whose only purpose was to ADD text was structurally CAPABLE of removing
it, and nothing stood between a failed fetch and a destructive write. Two
guards now block that specific path (upsert_ac refuses an empty overwrite;
the re-scraper refuses any non-longer extraction), but guards only cover the
failure you already thought of.

This covers the ones I haven't. Before any bulk write touches stored content,
snapshot the exact rows first, to disk, outside the database. Then a mistake
is an inconvenience instead of a loss.

Snapshots land in CODE_BACKUPS/content_snapshots/ next to the existing code
backups, one timestamped JSON per operation, and are never pruned
automatically -- disk is cheaper than re-deriving a corpus.

Usage:
    from content_snapshot import snapshot_rows
    path = snapshot_rows("advisory_circulars", "document_number",
                         ["43.13-1B", "29-2C"],
                         columns="document_number,pdf_text,pdf_blocks",
                         label="rescrape_truncated")
    # ... only now do the writes ...

Restoring is deliberately a separate, human-run step -- see restore_snapshot().
"""

import json
import os
import pathlib
import time
from typing import Iterable, Optional

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

SNAPSHOT_DIR = (
    pathlib.Path(__file__).resolve().parent.parent.parent
    / "CODE_BACKUPS" / "content_snapshots"
)


def _headers(extra: dict = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def snapshot_rows(
    table: str,
    key_column: str,
    keys: Iterable[str],
    columns: str = "*",
    label: str = "bulk",
) -> Optional[str]:
    """Write the current state of these rows to disk. Returns the file path.

    Raises on failure rather than returning quietly: if the snapshot did not
    happen, the caller must NOT proceed with its writes. That ordering is the
    whole point -- a snapshot you skip on error is not a safety net.
    """
    keys = [k for k in keys]
    if not keys:
        return None
    if not (SUPABASE_URL and SUPABASE_KEY):
        raise RuntimeError("snapshot_rows: SUPABASE_URL / SUPABASE_SERVICE_KEY not set")

    rows = []
    # One request per key: these rows can be multi-megabyte (a single AC's
    # pdf_text is now up to 3.3 MB), and a batched `in.()` of them risks a
    # response big enough to fail for reasons that have nothing to do with
    # the snapshot's job.
    for k in keys:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers(),
            params={"select": columns, key_column: f"eq.{k}"},
            timeout=120,
        )
        resp.raise_for_status()
        rows.extend(resp.json())

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    path = SNAPSHOT_DIR / f"{table}_{label}_{stamp}.json"
    payload = {
        "table": table,
        "key_column": key_column,
        "columns": columns,
        "taken_at": stamp,
        "requested_keys": keys,
        "row_count": len(rows),
        "rows": rows,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False))
    size_mb = path.stat().st_size / 1_048_576
    print(f"  snapshot: {len(rows)} row(s) of {table} -> {path.name} ({size_mb:.1f} MB)")
    return str(path)


def restore_snapshot(path: str, only_keys: Optional[Iterable[str]] = None) -> int:
    """Write a snapshot's rows back. Human-run, never automatic.

    Deliberately not called by any scraper. Restoring is a decision, not a
    fallback -- an automatic restore could just as easily undo a legitimate
    later change as repair a mistake.
    """
    data = json.loads(pathlib.Path(path).read_text())
    key_col = data["key_column"]
    wanted = set(only_keys) if only_keys else None
    n = 0
    for row in data["rows"]:
        k = row.get(key_col)
        if wanted and k not in wanted:
            continue
        body = {c: v for c, v in row.items() if c != key_col}
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/{data['table']}",
            headers=_headers({"Prefer": "return=minimal"}),
            params={key_col: f"eq.{k}"},
            json=body,
            timeout=120,
        )
        resp.raise_for_status()
        n += 1
    print(f"  restored {n} row(s) from {pathlib.Path(path).name}")
    return n
