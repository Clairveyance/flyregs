#!/usr/bin/env python3
"""
Airworthiness Directives (AD) Scraper
========================================
Fetches every Airworthiness Directive Final Rule from the Federal
Register's public API, stores in Supabase.

Source, confirmed live 2026-07-24: the FAA's own Dynamic Regulatory System
(drs.faa.gov) is the "official" AD portal and has a genuinely well-
structured JSON API (POST /api/browse/doctype/ADFRAWD/documents/metadatas)
with convenient pre-built cross-reference fields (Affected AD/Superseded
AD/Affected By/Superseded By) -- but it's behind Akamai Bot Manager (a
`bm_sv` cookie / JS challenge), which blocks it categorically for a plain
requests-based scraper the same way every other scraper in this project
works, and which a GitHub Actions runner couldn't solve either. Confirmed
live: every /api/ endpoint (search AND content-download) returns 403
without passing that challenge, even with a full cookie jar replicated
from a real browser session.

Used instead: the Federal Register's own public API
(federalregister.gov/developers) -- fully public, no bot protection,
already used successfully elsewhere in this project. Filtering by
`conditions[cfr][title]=14&conditions[cfr][part]=39&conditions[type][]=RULE`
returns exactly "documents that amend 14 CFR Part 39" -- which by
definition IS the set of Airworthiness Directives (Part 39 exists for
nothing else), more precise than a keyword search for "airworthiness
directive" (which also matches NPRMs, corrections, and unrelated mentions).
Each result's `raw_text_url` gives the AD's full legally-mandated text,
which follows a consistent lettered-paragraph structure
((a) Effective Date, (b) Affected ADs, (c) Applicability, ...) reliable
enough to parse the same structured fields DRS's UI shows -- confirmed
live across multiple manufacturers/AD shapes before relying on it.
`pdf_url` points to a real govinfo.gov-hosted PDF (also not bot-protected)
used for on-demand image caching -- see backfill_ad_pdf_images.py.

The API's own "count" field caps at 10000 (an Elasticsearch result-window
artifact, not the true total -- confirmed live: DRS itself reports 17,075
current AD Final Rules). Paginating via `next_page_url`'s cursor-based
`search_after_cursor` (not raw page numbers) is what actually gets past
that cap.

Modes:
  test    first N results only, no DB writes -- verify parsing
  full    every AD Final Rule -- upserts airworthiness_directives, safe to
          re-run (idempotent on ad_number)
  incremental  only ADs published since the most recent citation_publish_date
               already in the DB -- what the weekly sync actually uses

Usage:
  python ad_scraper.py --mode test
  python ad_scraper.py --mode full
  python ad_scraper.py --mode incremental

Environment variables required for full/incremental mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys
import time
from datetime import date, datetime

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

FR_API = "https://www.federalregister.gov/api/v1/documents.json"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "FlyRegs/1.0 (contact: support@flyregs.com)"})

# The AD's own numbered header line, e.g.:
#   "2026-15-05 Textron Aviation Inc.: Amendment 39-23417; Docket No.
#   FAA-2026-7223; Project Identifier AD-2026-00329-A."
# A superseding AD sometimes uses "--" instead of a space right after the
# AD number ("2026-14-09--Bombardier, Inc.: Amendment...") -- confirmed
# live, both forms appear in real, current ADs.
AD_HEADER_RE = re.compile(
    r"(\d{4}-\d{2}-\d{2})(?:\s+|--)(.+?):\s*Amendment\s+([\d-]+);\s*Docket\s+No\.?\s*([A-Z0-9-]+)",
    re.IGNORECASE,
)

# Lettered top-level paragraphs in the regulatory text -- confirmed live as
# a consistent, legally-mandated structure across every AD checked (small
# GA airplanes through transport-category jets, different manufacturers).
PARAGRAPH_RE = re.compile(r"\n\(([a-z])\)\s+([^\n]+)\n\n(.*?)(?=\n\([a-z]\)\s+[^\n]+\n\n|\Z)", re.DOTALL)


def fetch_page(url: str, params: dict | None = None) -> dict:
    for attempt in range(3):
        try:
            resp = SESSION.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            log.warning(f"  fetch failed (attempt {attempt + 1}/3): {e}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch after 3 attempts: {url}")


def search_ads(
    since: str | None = None, until: str | None = None,
    limit: int | None = None, order: str = "oldest",
) -> list[dict]:
    """Enumerates every 14 CFR Part 39 Final Rule (i.e. every AD) in a given
    date window. `since`/`until` are YYYY-MM-DD date strings (inclusive).

    NOTE: ADs from the 1990s and earlier use different formatting
    conventions than the modern lettered-paragraph structure
    parse_ad_text() expects (confirmed live: order=oldest's first several
    thousand results are all 1990s-era ADs that fail to parse) -- test
    mode defaults to order="newest" for exactly this reason; only a full
    ingest run should actually reach that old material, and the parser
    logs a per-document warning rather than silently dropping it, so the
    real scope of that gap is visible, not hidden.

    NOTE: the Federal Register's search backend hard-caps at 10,000
    results for a single query REGARDLESS of pagination style (confirmed
    live: `next_page_url` goes null right at the 10,000th result, even
    with per_page=1000's own cursor-based pagination, which normally
    should get past a plain offset-window limit). A query spanning the AD
    corpus's full ~90-year history hits this every time -- see
    search_ads_full() for the date-chunking that actually gets past it."""
    params = {
        "conditions[cfr][title]": 14,
        "conditions[cfr][part]": 39,
        "conditions[type][]": "RULE",
        "per_page": 1000,
        "order": order,
        "fields[]": [
            "document_number", "title", "abstract", "publication_date",
            "pdf_url", "raw_text_url",
        ],
    }
    if since:
        params["conditions[publication_date][gte]"] = since
    if until:
        params["conditions[publication_date][lte]"] = until

    results = []
    url, url_params = FR_API, params
    while True:
        data = fetch_page(url, url_params)
        results.extend(data.get("results", []))
        log.info(f"  ...{len(results)} ADs found so far")
        if limit and len(results) >= limit:
            return results[:limit]
        next_url = data.get("next_page_url")
        if not next_url:
            if data.get("count", 0) > len(results) and len(results) % 10000 == 0 and results:
                log.warning(
                    f"  Hit the 10,000-result window with {data.get('count')} total reported — "
                    f"this date range needs splitting further to get the rest."
                )
            break
        # next_page_url already has every param (including the cursor)
        # baked into its own query string, so no params dict is needed —
        # passing one again would double up the querystring.
        url, url_params = next_url, None
    return results


def iter_years_full():
    """Yields (year, results) one year at a time, NEWEST year first — the
    AD program dates to 1938, and no single year has come remotely close to
    the 10,000-per-query cap (confirmed live: even the busiest recent years
    are in the low hundreds), so querying one year at a time reliably gets
    past the cap a single all-time query hits.

    Newest-first (not chronological) on purpose: 1990s-and-earlier ADs use
    a different formatting convention parse_ad_text() doesn't handle
    (confirmed live) and will mostly fail, and processing a full year takes
    real wall-clock time (a full-text fetch per AD) -- if this run gets
    interrupted or takes longer than expected, the most current, most
    relevant-to-active-aircraft ADs should already be saved, not the least
    useful ones."""
    current_year = datetime.now().year
    for year in range(current_year, 1937, -1):
        year_results = search_ads(since=f"{year}-01-01", until=f"{year}-12-31", order="oldest")
        yield year, year_results


def parse_ad_text(raw_text: str, document_number: str) -> dict | None:
    """Extracts structured fields from an AD's full legal text. Returns
    None if the text doesn't match the expected AD structure at all (a
    genuine parsing failure worth logging, not silently skipping)."""
    # Strip the FR boilerplate header/footer and the <pre>/<html> wrapper
    # every raw_text_url response has.
    text = re.sub(r"<[^>]+>", "", raw_text)

    # A single "\n" mid-text is a PDF line-wrap, not a real paragraph break
    # (those are "\n\n") -- confirmed live as a real bug: a docket number
    # wrapped across a line ("Docket No. FAA-\n2025-3435") truncated to
    # just "FAA-" since the header regex's character class doesn't span
    # newlines. Collapsed for header matching only; paragraph splitting
    # further down still needs the original "\n\n" boundaries intact, so
    # this uses a separate variable rather than mutating `text`. A
    # hyphen-then-linewrap ("FAA-\n2025") collapses with NO space (the
    # hyphen already signals a continuing token, e.g. "FAA-2025-3435" is
    # one docket ID) -- collapsing it to a space instead would have left
    # the docket number's own regex stopping short at the hyphen again,
    # just with a space in front of the rest instead of a lost tail.
    single_line = re.sub(r"-\n(?!\n)", "-", text)
    single_line = re.sub(r"(?<!\n)\n(?!\n)", " ", single_line)

    header_match = AD_HEADER_RE.search(single_line)
    if not header_match:
        return None
    ad_number, make, amendment, docket = header_match.groups()

    # Subject heading is the document's own title line, printed once near
    # the top ("Airworthiness Directives; Textron Aviation Inc. Airplanes").
    title_match = re.search(r"\n(Airworthiness Directives;[^\n]+)\n", text)
    subject_heading = title_match.group(1).strip() if title_match else None

    summary_match = re.search(r"SUMMARY:\s*(.+?)(?=\nDATES:|\nADDRESSES:)", text, re.DOTALL)
    summary = re.sub(r"\s+", " ", summary_match.group(1)).strip() if summary_match else None

    # Split the actual numbered AD (starting at its own header line) into
    # lettered paragraphs -- this is the part after "PART 39--AIRWORTHINESS
    # DIRECTIVES", not the preamble/SUPPLEMENTARY INFORMATION before it.
    # Anchored on that phrase (confirmed live, present verbatim in every AD
    # checked) rather than re-locating header_match's own matched string --
    # that string came from the whitespace-collapsed single_line version,
    # which can't be found by exact substring search in the original `text`
    # whenever the real header happened to wrap across a line.
    part39_match = re.search(r"PART 39-+AIRWORTHINESS DIRECTIVES", text, re.IGNORECASE)
    ad_body = text[part39_match.start():] if part39_match else text

    paragraphs = {}
    for m in PARAGRAPH_RE.finditer("\n" + ad_body):
        letter, heading, body = m.groups()
        paragraphs[heading.strip().lower()] = re.sub(r"\s+", " ", body).strip()

    applicability = paragraphs.get("applicability", "")
    affected_ads_text = paragraphs.get("affected ads", "")
    superseded_ad = None
    m = re.search(r"supersede[s]?\s+AD\s+([\d-]+)", affected_ads_text, re.IGNORECASE)
    if m:
        superseded_ad = m.group(1)

    model_match = re.search(r"[Mm]odel[s]?\s+([A-Za-z0-9,\-/\s]+?)(?:\s+airplanes|\s+helicopters|\s+gliders|\s+engines|,\s+certificated|\.)", applicability)
    model = model_match.group(1).strip() if model_match else None

    return {
        "ad_number": ad_number,
        "document_number": document_number,
        "subject_heading": subject_heading or "",
        "subject": paragraphs.get("subject", None),
        "make": make.strip(),
        "model": model,
        "amendment_number": amendment,
        "docket_number": docket,
        "superseded_ad": superseded_ad,
        "affected_ad": affected_ads_text if affected_ads_text.lower() != "none." else None,
        "summary": summary,
        "applicability": applicability or None,
        "unsafe_condition": paragraphs.get("unsafe condition", None),
        "body_text": ad_body.strip(),
    }


def _upsert(table: str, rows: list[dict], on_conflict: str) -> bool:
    if not rows:
        return True
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {len(rows)} rows into {table}")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            params={"on_conflict": on_conflict},
            json=rows,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  {table} upsert failed: {e}")
        return False


def process_ads(ad_summaries: list[dict], dry_run: bool) -> list[dict]:
    rows = []
    errors = 0
    for i, summary in enumerate(ad_summaries):
        doc_num = summary["document_number"]
        raw_text_url = summary.get("raw_text_url")
        if not raw_text_url:
            log.warning(f"  [{i + 1}/{len(ad_summaries)}] {doc_num} — no raw_text_url, skipping")
            errors += 1
            continue
        try:
            resp = SESSION.get(raw_text_url, timeout=30)
            resp.raise_for_status()
        except requests.RequestException as e:
            log.warning(f"  [{i + 1}/{len(ad_summaries)}] {doc_num} — fetch failed: {e}")
            errors += 1
            continue

        parsed = parse_ad_text(resp.text, doc_num)
        if not parsed:
            log.warning(f"  [{i + 1}/{len(ad_summaries)}] {doc_num} — could not parse AD structure")
            errors += 1
            continue

        parsed["product_type"] = None
        parsed["product_subtype"] = None
        parsed["pdf_url"] = summary.get("pdf_url")
        parsed["citation_publish_date"] = summary.get("publication_date")
        parsed["status"] = "Current"

        rows.append(parsed)
        if dry_run and i < 5:
            log.info(f"  [{i + 1}/{len(ad_summaries)}] {parsed['ad_number']} — {parsed['subject_heading']}")
            log.info(f"      Make: {parsed['make']!r}  Model: {parsed['model']!r}")
            log.info(f"      Superseded AD: {parsed['superseded_ad']!r}  Affected AD: {(parsed['affected_ad'] or '')[:60]!r}")

        time.sleep(0.2)  # polite pacing against a public API

    # An AD number can legitimately appear twice in one query result: the
    # FAA occasionally publishes a Federal Register CORRECTION notice for
    # an AD shortly after the original adoption (its own text literally
    # says "Sec. 39.13 [Corrected]" instead of "[Amended]") -- confirmed
    # live, not a scraper bug: AD 2026-03-06 has both a 2026-02415
    # original and a 2026-04331 correction of it. A single upsert batch
    # can't contain two rows targeting the same on_conflict key (Postgres
    # itself rejects it: "ON CONFLICT command cannot affect row a second
    # time"), and semantically the correction should win anyway since it's
    # the more accurate, more recent version. `search_ads`/`iter_years_full`
    # both query oldest-to-newest-within-year, so keeping the LAST
    # occurrence in list order keeps the correction over the original.
    deduped: dict[str, dict] = {}
    for row in rows:
        if row["ad_number"] in deduped:
            log.info(f"  {row['ad_number']}: duplicate in this batch (likely a Federal Register correction) — keeping the later one")
        deduped[row["ad_number"]] = row

    log.info(f"Parsed {len(rows)} ADs ({len(deduped)} distinct AD numbers), {errors} errors")
    return list(deduped.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["test", "full", "incremental"], default="test")
    parser.add_argument("--limit", type=int, default=None, help="cap the number of ADs processed (test mode default: 10)")
    args = parser.parse_args()

    if args.mode in ("full", "incremental") and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full/incremental mode.")
        sys.exit(1)

    since = None
    if args.mode == "incremental":
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives?select=citation_publish_date&order=citation_publish_date.desc&limit=1",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        since = rows[0]["citation_publish_date"] if rows else None
        log.info(f"Incremental mode: fetching ADs published since {since or '(none found — fetching all)'}")

    if args.mode == "full":
        # Upserts once PER YEAR, not once at the very end -- a run covering
        # the whole ~90-year corpus takes real wall-clock time (a full-text
        # fetch per AD), and batching everything into one final write means
        # an interruption anywhere loses ALL progress. Newest year first
        # (see iter_years_full's docstring), so the most relevant-to-
        # active-aircraft ADs land in the DB earliest.
        log.info("Searching Federal Register for every 14 CFR Part 39 Final Rule (full mode, newest year first)...")
        total_rows = 0
        for year, ad_summaries in iter_years_full():
            if not ad_summaries:
                continue
            log.info(f"=== {year}: {len(ad_summaries)} AD documents ===")
            rows = process_ads(ad_summaries, dry_run=False)
            if rows:
                ok = _upsert("airworthiness_directives", rows, "ad_number")
                if not ok:
                    log.error(f"  {year}: upsert failed, continuing to next year rather than losing all remaining progress")
                else:
                    total_rows += len(rows)
        log.info(f"Done. Total ADs upserted={total_rows}")
        return

    limit = args.limit or (10 if args.mode == "test" else None)
    order = "newest" if args.mode in ("test", "incremental") else "oldest"
    log.info(f"Searching Federal Register for 14 CFR Part 39 Final Rules (mode={args.mode}, limit={limit}, order={order})...")
    ad_summaries = search_ads(since=since, limit=limit, order=order)
    log.info(f"Found {len(ad_summaries)} AD documents to process")

    rows = process_ads(ad_summaries, dry_run=(args.mode == "test"))

    if args.mode != "test" and rows:
        ok = _upsert("airworthiness_directives", rows, "ad_number")
        if not ok:
            sys.exit(1)

    log.info(f"Done. ADs={len(rows)}")


if __name__ == "__main__":
    main()
