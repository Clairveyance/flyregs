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
import html
import logging
import os
import re
import sys
import time
from datetime import date, datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revision_log import log_revisions  # noqa: E402

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

# raw_text_url's SGML source renders character entities as bracket-wrapped
# names ("[eacute]" for what should be "&eacute;") instead of proper
# &entity; syntax -- confirmed live via a corpus-wide sweep 2026-08-04:
# "R[eacute]gional" instead of "Régional", affecting make/summary/body_text
# and every other field derived from this same source text. The bracket
# tag-strip below never decoded these since it only ever saw literal "["
# text, not a real SGML entity reference.
#
# Distinct from legitimate bracketed Federal Register/CFR markup that must
# NOT be touched -- "[Amended]", "[Reserved]", "[GRAPHIC]" are real
# regulatory-drafting conventions (a genuinely reserved CFR section really
# is printed as "[Reserved]"), not corrupted entities. No separate
# allowlist is needed to protect them: none of those are real HTML5 entity
# names, so the html.entities.html5 lookup below leaves them untouched by
# construction.
SGML_ENTITY_RE = re.compile(r"\[([a-zA-Z]+)\]")
# "[[Page 8664]]"-style pagination artifacts from the FR's own PDF-to-text
# rendering -- not content, safe to drop outright rather than decode.
PAGE_BREAK_RE = re.compile(r"\[\[Page\s+[\d,]+\]\]\s*", re.IGNORECASE)
# Raw numeric HTML entities ("&#160;", the non-breaking-space reference) --
# a DIFFERENT artifact from the bracket-named ones above, confirmed live
# 2026-08-17 in 15 recent ADs (2026-15-11 through 2026-16-13): every source
# document's Cloudflare-obfuscated compliance-contact email renders in the
# FR's own full text as the literal fallback placeholder "[email protected]",
# and in these 15 the space inside it survived as a raw numeric entity
# instead of a real space ("[email&#160;protected]"). The real underlying
# email address isn't recoverable from this source at all -- FR's own
# published record only ever contains the placeholder text, same as any
# other Cloudflare-protected page -- so this decode ONLY fixes the space
# character, it never invents contact info. Scoped to numeric refs only
# (not a general HTML-entity decoder) to avoid touching genuine bracketed
# CFR drafting conventions like "[Reserved]" the same way SGML_ENTITY_RE's
# letters-only class already avoids them.
NUMERIC_ENTITY_RE = re.compile(r"&(?:amp;)?#(\d+);")


def decode_sgml_entities(text: str | None) -> str | None:
    if not text:
        return text
    text = PAGE_BREAK_RE.sub("", text)
    text = NUMERIC_ENTITY_RE.sub(lambda m: chr(int(m.group(1))), text)

    def _sub(m: re.Match) -> str:
        char = html.entities.html5.get(m.group(1).lower() + ";")
        return char if char else m.group(0)

    return SGML_ENTITY_RE.sub(_sub, text)


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
            "pdf_url", "raw_text_url", "effective_on",
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
    # every raw_text_url response has, then decode SGML entities -- done
    # here, before any field extraction, so every downstream field
    # (make/summary/body_text/subject_heading/applicability/...) inherits
    # the fix automatically since they all derive from `text`.
    #
    # NUL bytes (literal 0x00) are stripped here too -- confirmed live
    # 2026-08-05: a single NUL byte anywhere in one AD's raw_text_url
    # response (a PDF-to-text rendering artifact upstream at govinfo.gov,
    # not FlyRegs's own scrape) makes Postgres reject the whole batch
    # upsert with error 22P05 ("0x00 cannot be converted to text") -- NOT
    # just that one row. Two full years (2014, 2023) silently lost their
    # entire batch this way during the effective_date backfill before this fix.
    text = decode_sgml_entities(re.sub(r"<[^>]+>", "", raw_text)).replace("\x00", "")

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
    # Matched against `single_line` (already wrap-collapsed above for
    # header_match), NOT the raw `text` -- a long manufacturer name that
    # wraps across two physical PDF lines (e.g. "Embraer S.A. (Type
    # Certificate Previously Held by ...) Airplanes") used to get cut at
    # wherever the PDF happened to line-wrap, since `[^\n]+` against raw
    # `text` stops at the first newline regardless of whether that's the
    # end of the real title. Found live via a corpus-wide truncation sweep
    # (2026-08-02): 406 of 5,023 ADs affected, all truncated mid-phrase at
    # "(Type" specifically because that's a common wrap point for this
    # exact manufacturer-name pattern.
    title_match = re.search(r"Airworthiness Directives;[^\n]+", single_line)
    subject_heading = title_match.group(0).strip() if title_match else None

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

    # Widened 2026-08-12: the original character class excluded parentheses,
    # so "Model PA-60-601P (Aerostar 601P)... airplanes" (marketing name in
    # parens -- a common modern AD phrasing) and any applicability text with
    # a parenthetical exclusion clause before the real terminator word
    # ("Model AS350B... (except AS350B3 helicopters with...)... helicopters")
    # never matched at all -- confirmed live, a real backfill audit found
    # 650 ADs with real applicability text this missed. Now allows
    # parens/periods in the captured run, and matches the LAST occurrence
    # of a terminator word (not the first), so a nested exclusion clause's
    # own use of "helicopters"/etc doesn't truncate the real model list.
    model_match = re.search(r"[Mm]odel[s]?\s+([A-Za-z0-9,\-/\s()\.]+)(?:\s+airplanes|\s+helicopters|\s+gliders|\s+engines)\b(?!\s*with)", applicability)
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
    # What's Changed timeline logging -- must run BEFORE the upsert below,
    # which is about to overwrite whatever's currently live. See
    # revision_log.py's own header for why this generalizes AC's
    # block-level What's Changed logging to plain-text FAR/AIM/P-CG/AD.
    if table == "airworthiness_directives":
        try:
            n = log_revisions(
                SUPABASE_URL,
                {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"},
                doc_type="ad", table="airworthiness_directives",
                key_field="ad_number", text_field="body_text", title_field="subject_heading",
                new_rows=rows,
            )
            if n:
                log.info(f"  Logged {n} AD revision(s) for What's Changed")
        except Exception as e:
            log.warning(f"  revision logging failed (non-fatal): {e}")
    # Belt-and-suspenders NUL-byte strip -- parse_ad_text already strips
    # \x00 at the source, but this catches any other field derived from
    # upstream text (e.g. a future field sourced from the FR API's own
    # JSON, which CAN legally carry an escaped NUL) so one bad
    # character in one row can never again silently drop an entire year's
    # batch the way it did for 2014 and 2023.
    for row in rows:
        for k, v in row.items():
            if isinstance(v, str) and "\x00" in v:
                row[k] = v.replace("\x00", "")
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


def log_scraper_run(run: dict) -> None:
    """Write a scraper_runs record to Supabase.

    ad_scraper.py never had ANY scraper_runs logging at all -- a gap flagged
    but not fixed during the 2026-08-09 night-rules sweep that fixed the
    same table's silent-schema-drift bug for faa/far/aim/pcg_scraper.py (see
    those files' own log_scraper_run() for the full story). AD content
    itself has been syncing fine per its own updated_at evidence the whole
    time; this just closes the monitoring-coverage gap so a future real
    failure here doesn't go unnoticed the same way those did. Same
    non-silent-failure pattern as the other four scrapers: a failed insert
    here must never fail the actual scrape, but it must never vanish either.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json=run,
            timeout=10,
        )
        if not r.ok:
            log.error(f"log_scraper_run: insert failed ({r.status_code}): {r.text[:500]}")
        else:
            # Confirms the POST itself returned success -- added after a
            # real scheduled run (2026-08-10) left no row in scraper_runs
            # with zero errors/exceptions anywhere in the job log, an
            # un-diagnosable silent gap because success was already silent
            # by design here, same as failure used to be before the
            # 2026-08-09 fixes on the sibling scrapers. If this ever fires
            # again with still no row landing, the problem is downstream of
            # this POST (Supabase-side), not a swallowed client exception.
            log.info(f"log_scraper_run: inserted ({r.status_code})")
    except Exception as e:
        log.error(f"log_scraper_run: insert raised: {e}")


def process_ads(ad_summaries: list[dict], dry_run: bool) -> tuple[list[dict], int]:
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
        # effective_on is the FR API's own field for "when this rule takes
        # effect" -- confirmed live 2026-08-05 that it's populated back to
        # at least 2000 (this corpus's own earliest coverage), the same
        # source citation_publish_date already comes from. Was never
        # requested before, which is why effective_date sat 100% NULL
        # across all 5,023 existing rows.
        parsed["effective_date"] = summary.get("effective_on")
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
    return list(deduped.values()), errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["test", "full", "incremental"], default="test")
    parser.add_argument("--limit", type=int, default=None, help="cap the number of ADs processed (test mode default: 10)")
    parser.add_argument("--touched-out", default=None, help="write every touched ad_number to this file, one per line (for send-ad-alerts.mjs)")
    parser.add_argument(
        "--no-revision-log", action="store_true",
        help=(
            "Skip content_revisions logging for this run (sets SKIP_REVISION_LOG=1, "
            "read by revision_log.log_revisions()). Use for a manual backfill/repair "
            "run over already-known data -- e.g. a one-off `--mode full` to backfill "
            "a newly-added column -- so it can't log bogus What's Changed entries the "
            "way the 2026-08-06 effective_date backfill did (72 false positives, "
            "purged in sync/migrations_purge_content_revisions_false_positives.sql). "
            "Leave unset for the real weekly incremental cron sync."
        ),
    )
    args = parser.parse_args()
    if args.no_revision_log:
        os.environ["SKIP_REVISION_LOG"] = "1"

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
        run_record = {
            "mode": "full",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "status": "running",
        }
        # Upserts once PER YEAR, not once at the very end -- a run covering
        # the whole ~90-year corpus takes real wall-clock time (a full-text
        # fetch per AD), and batching everything into one final write means
        # an interruption anywhere loses ALL progress. Newest year first
        # (see iter_years_full's docstring), so the most relevant-to-
        # active-aircraft ADs land in the DB earliest.
        log.info("Searching Federal Register for every 14 CFR Part 39 Final Rule (full mode, newest year first)...")
        total_rows = 0
        total_ad_errors = 0
        upsert_failures = 0
        for year, ad_summaries in iter_years_full():
            if not ad_summaries:
                continue
            log.info(f"=== {year}: {len(ad_summaries)} AD documents ===")
            rows, ad_errors = process_ads(ad_summaries, dry_run=False)
            total_ad_errors += ad_errors
            if rows:
                ok = _upsert("airworthiness_directives", rows, "ad_number")
                if not ok:
                    log.error(f"  {year}: upsert failed, continuing to next year rather than losing all remaining progress")
                    upsert_failures += 1
                else:
                    total_rows += len(rows)
        log.info(f"Done. Total ADs upserted={total_rows}")
        run_record.update({
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "status": "success" if upsert_failures == 0 else "partial",
            "ad_total": total_rows,
            "ad_added": total_rows,
            "ad_errors": total_ad_errors + upsert_failures,
        })
        log_scraper_run(run_record)
        return

    run_record = {
        "mode": args.mode,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    limit = args.limit or (10 if args.mode == "test" else None)
    order = "newest" if args.mode in ("test", "incremental") else "oldest"
    log.info(f"Searching Federal Register for 14 CFR Part 39 Final Rules (mode={args.mode}, limit={limit}, order={order})...")
    ad_summaries = search_ads(since=since, limit=limit, order=order)
    log.info(f"Found {len(ad_summaries)} AD documents to process")

    rows, ad_errors = process_ads(ad_summaries, dry_run=(args.mode == "test"))

    upsert_failed = False
    if args.mode != "test" and rows:
        ok = _upsert("airworthiness_directives", rows, "ad_number")
        if not ok:
            upsert_failed = True

    if args.touched_out and rows:
        with open(args.touched_out, "w") as f:
            f.write("\n".join(row["ad_number"] for row in rows))

    log.info(f"Done. ADs={len(rows)}")

    if args.mode != "test":
        run_record.update({
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "status": "success" if (ad_errors == 0 and not upsert_failed) else "partial",
            "ad_total": len(ad_summaries),
            # NOT "net-new rows inserted" -- ADs successfully parsed and
            # upserted this run, full stop. Confirmed live 2026-08-11: a
            # count of 5 with only 4 fresh created_at rows in the DB looked
            # like undercounting but wasn't -- incremental mode's `since` is
            # `gte` on the single latest citation_publish_date already
            # stored, which is deliberately inclusive (an exclusive `gt`
            # would silently skip a same-day AD that hadn't landed in the FR
            # API yet on a prior run). Every run re-fetches and re-upserts
            # whatever's already stored for that one boundary date -- a
            # correct, idempotent no-op for it, just not a NEW row, and its
            # updated_at doesn't move since there's no update trigger on
            # this column. ad_added counting it is accurate, not a bug.
            "ad_added": len(rows),
            "ad_errors": ad_errors + (1 if upsert_failed else 0),
        })
        log_scraper_run(run_record)

    if upsert_failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
