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

Opt-out for manual/backfill/dev-repair runs (SKIP_REVISION_LOG): added
2026-08-12 after a real production incident -- a manual, ad-hoc
`ad_scraper.py --mode full` run on 2026-08-06, backfilling the newly-added
effective_date column across the whole AD corpus (see commit 927fd34),
logged 72 bogus content_revisions rows. None were real FAA content changes
-- root cause was `ad_number` collisions (a base AD and its own later "R1"/
"R2" revision, or two textually-unrelated ADs the FAA happens to have
assigned the same number, both a real, separate, pre-existing gap in
ad_scraper.py's AD-number parsing, NOT something this opt-out fixes) that
made a single full-corpus re-scrape's own internal write-then-overwrite
sequence look like a live "revision" to log_revisions(), even though
nothing the FAA published had actually changed that week. log_revisions()
has no way to distinguish "the real weekly cron sync found genuinely new
FAA content" from "someone re-ran the scraper locally to backfill/repair
already-known data" -- both call the exact same `_upsert()` path in every
scraper. This env var is that distinction, made explicit by whoever's
running the command instead of guessed at afterward.

Checked once, at the top of log_revisions() itself (not duplicated in each
scraper) so every current AND future caller is covered automatically.
Defaults OFF (unset/empty = still logs, i.e. nothing changes for the real
cron-triggered production runs) -- must be deliberately opted into for a
known backfill/repair run:
    SKIP_REVISION_LOG=1 python sync/ad_scraper.py --mode full
Each scraper's CLI also exposes this as --no-revision-log (sets the same
env var right before the run starts) so a human doesn't have to remember
the raw variable name -- see each scraper's own main().
"""
from __future__ import annotations

import logging
import os
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

# Confirmed live 2026-08-10: AIM TBL 3-1-1 -> TBL 3-1-4 (Basic VFR Weather
# Minimums) logged as a "revision" even after the label-prefix strip above,
# because the table renumber came bundled with a pure reformat of the SAME
# unchanged cell content -- a row header like "Class E:" followed by a real
# newline and its sub-row on the next line in one extraction pass became
# "Class E ; " (colon swapped for a semicolon, newline collapsed to a
# space) joined onto the same line in the other, and a handful of row-
# ending periods appeared/disappeared right at those same collapsed-
# newline points ("...10,000 feet MSL" vs "...10,000 feet MSL."). Same
# numbers, same words, same table -- zero substantive difference, just the
# AIM PDF-table-to-text extraction serializing a cell/row boundary
# differently between passes. Two additional normalizations, comparison-
# only exactly like the label-prefix strip above (the ORIGINAL text is
# still what gets stored/shown if a paragraph has a genuine difference
# elsewhere):
#   1. Whitespace-run collapsing -- a mid-paragraph "\n" vs " " at the same
#      logical row/cell boundary is the same reformat artifact, not a
#      wording change.
#   2. ":" and ";" treated as equivalent at a clause boundary (i.e.
#      followed by whitespace) -- the row-header colon-vs-semicolon swap
#      above, and a generalization of it: neither carries substantive
#      meaning at that position, only which typographic convention that
#      extraction pass used.
# A bare "." immediately before whitespace is ALSO dropped -- confirmed
# from the same real case (2 separate spots where a sentence/row-ending
# period appeared on one side and not the other, immediately at a
# collapsed-newline boundary, with the surrounding words byte-identical).
# Deliberately narrow: only a period directly followed by whitespace is
# affected, so this can't quietly eat a decimal point ("10.5") or an
# abbreviation mid-word -- and per the module's own diff granularity, any
# REAL wording change anywhere else in the same paragraph still leaves a
# residual difference after this normalization and still triggers a
# revision normally (verified against the real §36.1501 MOSAIC rewrite,
# which is genuine FAR content, not noise -- still registers as different
# after all of the above).
_CLAUSE_PUNCT_RE = re.compile(r"\s*[:;]\s*")
_TRAILING_PERIOD_RE = re.compile(r"\.(?=\s)")
_WHITESPACE_RUN_RE = re.compile(r"\s+")

# Confirmed live 2026-08-13 (RC asked to verify the 16 logged FAR revisions
# against the FAA's own eCFR record -- 135.363 came back as NOT a real
# amendment: eCFR's versioner API shows amendment_date 2017-01-01 with the
# two more recent issue_dates both substantive=false, meaning zero real
# text change since 2017, yet content_revisions had a diff logged for it).
# Root cause, found by reading the actual added_text/removed_text: a PDF
# line-wrap hyphenation artifact -- one extraction pass kept the literal
# "author- ize" / "observ- ance" (hyphen + space, from where the word
# wrapped across a line in the source PDF), the other correctly rejoined it
# to "authorize" / "observance". Same word, same meaning, pure extraction
# noise -- same family as the label-prefix and whitespace/punctuation
# normalizations above, just a different artifact shape. Comparison-only,
# same as those: the ORIGINAL text (hyphen included or not) is still what
# gets stored/shown if a paragraph has a genuine difference elsewhere.
_LINEBREAK_HYPHEN_RE = re.compile(r"(\w)-\s+(\w)")


def _normalize_for_diff(paragraph: str) -> str:
    p = _LABEL_PREFIX_RE.sub("", paragraph, count=1)
    p = _WHITESPACE_RUN_RE.sub(" ", p).strip()
    p = _CLAUSE_PUNCT_RE.sub(" ; ", p)
    p = _TRAILING_PERIOD_RE.sub("", p)
    p = _LINEBREAK_HYPHEN_RE.sub(r"\1\2", p)
    p = _WHITESPACE_RUN_RE.sub(" ", p).strip()
    return p


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
    changed_keys: set | None = None,
) -> int:
    """Diffs new_rows' text_field against what's currently in the DB (fetched
    fresh here, so this MUST run before the real upsert overwrites it), and
    inserts one content_revisions row per changed doc_key. Returns the
    number of revisions logged. Never raises on a single-row failure --
    logs and continues, since a revision-log miss shouldn't block the real
    data upsert that follows it.

    If `changed_keys` is passed, every key_field value with a genuine
    (post-noise-filtering) content diff is added to it in place -- lets a
    caller stamp a real "last changed" date on exactly the rows that
    actually changed, without re-implementing this same diff a second time
    (see pcg_amendment dates, task #300 -- P/CG has no other source for a
    per-term change date at all). A brand-new row (no prior version to
    diff against) is deliberately NOT added -- "first time we've seen
    this" isn't the same claim as "this changed on this date."
    """
    if os.environ.get("SKIP_REVISION_LOG"):
        # Opt-out for a known manual/backfill/dev-repair run -- see this
        # module's own docstring for the 2026-08-06 incident that motivated
        # it. changed_keys is deliberately left untouched (not populated)
        # too: a backfill/repair run re-storing already-known data isn't a
        # genuine content change, so nothing here should get a new
        # last_amended stamp either, for the same reason.
        log.info(f"  revision_log: SKIP_REVISION_LOG set, skipping revision logging for doc_type={doc_type!r} ({len(new_rows)} row(s) not diffed)")
        return 0

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

        if changed_keys is not None:
            changed_keys.add(key)

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
