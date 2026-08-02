#!/usr/bin/env python3
"""
Shared content_revisions logging for FAR/AIM/P-CG/AD scrapers.
========================================
Generalizes the same What's Changed timeline AC's backfill-blocks.mjs
already logs (content_revisions table) -- the app side (src/lib/
whatsChanged.ts) already fully supports all 5 doc types ('ac' | 'far' |
'aim' | 'pcg' | 'ad', with correct routing/labels for each), confirmed by
reading it directly. Only the scraper side had ever actually written a
'far'/'aim'/'pcg'/'ad' row -- this is what closes that gap, shared across
all four rather than reimplemented once per scraper.

Unlike AC's block-level diff (parsed pdf_blocks, see backfill-blocks.mjs),
FAR/AIM/P-CG/AD store plain text (body_text / definition), so this diffs on
"\n\n"-delimited paragraphs instead -- same "set difference" idea (added =
new paragraphs not present in old, removed = old paragraphs not present in
new), just at plain-text granularity. Matches splitParagraphs()'s own
expectation in whatsChanged.ts (paragraphs joined with "\n\n"), so a
revision renders as real per-paragraph rows in the app, not one giant
undifferentiated text blob.

Usage (called BEFORE the real upsert, so the "old" text is still live):
    from revision_log import log_revisions
    n = log_revisions(
        SUPABASE_URL, headers, doc_type="far", table="far_sections",
        key_field="section_number", text_field="body_text", title_field="title",
        new_rows=records,
    )
"""
from __future__ import annotations

import logging
import re

import requests

log = logging.getLogger(__name__)


def _split_paragraphs(text: str | None) -> list[str]:
    if not text:
        return []
    return [p.strip() for p in text.split("\n\n") if p.strip()]


# A TBL/FIG's own display number is internal bookkeeping recomputed by
# backfill_aim_pdf_images.py's rebuild-from-truth pass (see that file's
# docstring) -- it can change between syncs (a table's real PDF number
# shifts as the AIM gets renumbered) with the table's CONTENT completely
# unchanged. Confirmed live 2026-08-02: a single local re-scrape+backfill
# cycle run for an unrelated fix logged 249 false "revisions" across the
# AIM corpus, every single one a pure "TBL 1-1-1" -> "TBL 1-1-8"-style
# renumber with byte-identical table content on both sides -- 100% noise,
# zero genuine FAA content changes, but indistinguishable from a real
# revision to a user reading What's Changed. Stripping the label prefix
# before comparing (comparison only -- the ORIGINAL text, label included,
# is still what gets stored if a paragraph turns out to have a genuine
# content difference elsewhere) makes a pure renumber invisible to the
# diff while a real content change still triggers it normally.
_LABEL_PREFIX_RE = re.compile(r"^(TBL|FIG)\s+[\d\-]+[A-Za-z]?\.?\s*")


def _normalize_for_diff(paragraph: str) -> str:
    return _LABEL_PREFIX_RE.sub("", paragraph, count=1)


def _fetch_existing(
    supabase_url: str, headers: dict, table: str, key_field: str,
    text_field: str, title_field: str, keys: list[str],
) -> dict[str, tuple[str, str]]:
    """Fetch {key: (text, title)} for existing rows, batched to stay well
    under any URL-length/query-size limit."""
    out: dict[str, tuple[str, str]] = {}
    batch = 150
    for i in range(0, len(keys), batch):
        chunk = keys[i:i + batch]
        in_list = ",".join(f'"{k}"' for k in chunk)
        resp = requests.get(
            f"{supabase_url}/rest/v1/{table}",
            headers=headers,
            params={"select": f"{key_field},{text_field},{title_field}", key_field: f"in.({in_list})"},
            timeout=30,
        )
        resp.raise_for_status()
        for row in resp.json():
            out[row[key_field]] = (row.get(text_field) or "", row.get(title_field) or "")
    return out


def log_revisions(
    supabase_url: str,
    headers: dict,
    doc_type: str,
    table: str,
    key_field: str,
    text_field: str,
    title_field: str,
    new_rows: list[dict],
) -> int:
    """Diffs new_rows' text_field against what's currently in the DB (fetched
    fresh here, so this MUST run before the real upsert overwrites it), and
    inserts one content_revisions row per changed doc_key. Returns the
    number of revisions logged. Never raises on a single-row failure --
    logs and continues, since a revision-log miss shouldn't block the real
    data upsert that follows it."""
    candidates = [r for r in new_rows if r.get(key_field) and r.get(text_field)]
    if not candidates:
        return 0

    keys = [r[key_field] for r in candidates]
    try:
        existing = _fetch_existing(supabase_url, headers, table, key_field, text_field, title_field, keys)
    except requests.exceptions.RequestException as e:
        log.warning(f"  revision_log: could not fetch existing {table} rows, skipping revision logging this run: {e}")
        return 0

    to_insert = []
    for row in candidates:
        key = row[key_field]
        new_text = row[text_field] or ""
        old = existing.get(key)
        if old is None:
            continue  # brand-new row -- not a revision, nothing to compare against
        old_text, _old_title = old
        if old_text == new_text:
            continue

        old_paras_list = _split_paragraphs(old_text)
        new_paras_list = _split_paragraphs(new_text)
        # Matched on NORMALIZED text (label prefix stripped) so a table/
        # figure that only got renumbered -- not a real content change --
        # doesn't count as added+removed. added/removed still store the
        # ORIGINAL (label-included) text for accurate display; only the
        # matching decision ignores the label.
        old_normalized = {_normalize_for_diff(p) for p in old_paras_list}
        new_normalized = {_normalize_for_diff(p) for p in new_paras_list}
        added = [p for p in new_paras_list if _normalize_for_diff(p) not in old_normalized]
        removed = [p for p in old_paras_list if _normalize_for_diff(p) not in new_normalized]
        if not added and not removed:
            continue  # whitespace/label-only difference -- not worth a timeline entry

        to_insert.append({
            "doc_type": doc_type,
            "doc_key": key,
            "doc_id": None,
            "title": row.get(title_field) or "",
            "added_text": "\n\n".join(added) if added else None,
            "removed_text": "\n\n".join(removed) if removed else None,
        })

    if not to_insert:
        return 0

    try:
        resp = requests.post(
            f"{supabase_url}/rest/v1/content_revisions",
            headers={**headers, "Prefer": "return=minimal"},
            json=to_insert,
            timeout=30,
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        log.warning(f"  revision_log: content_revisions insert failed ({len(to_insert)} rows): {e}")
        return 0

    return len(to_insert)
