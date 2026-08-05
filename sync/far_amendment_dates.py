#!/usr/bin/env python3
"""
FAR amendment dates from eCFR's version index
==============================================
Populates `far_sections.last_amended` with the section's real latest
amendment date, replacing reliance on `updated_at` (which is a sync stamp
that every row shares -- see migrations_far_last_amended.sql for the full
history of that mistake).

Source, confirmed live 2026-08-05:
  GET /api/versioner/v1/versions/title-14.json?page={N}
      -> {"content_versions": [{identifier, amendment_date, issue_date,
                                type, part, removed, substantive}, ...],
          "meta": {"total_pages": "16", "result_count": "15319", ...}}

  One row PER AMENDMENT per section, so a section amended six times since
  2016 appears six times. We keep the max amendment_date per identifier.
  `identifier` is exactly our `far_sections.section_number` format ("91.3",
  "61.109") -- no normalisation needed, verified against all 4,292 rows.

  NOTE the `per_page` param is REJECTED by this endpoint ("Found unpermitted
  parameter: :per_page"). Page size is fixed at 1000; only `page` works.

The tracking-start floor
------------------------
eCFR's version history begins when eCFR itself began tracking, so a section
untouched since then gets stamped with one of four bulk snapshot dates:
2016-08-01, 2016-12-05, 2016-12-30, 2017-01-01. Roughly 74% of Title 14
sits at that floor. Those dates are true as "not amended since at least
this date" but NOT as "amended on this date" -- 14 CFR 1.1 has not been
untouched since only 2016. `last_amended_is_floor` marks them so display
code can say "no changes since 2016 or earlier" instead of inventing an
amendment that never happened. Range filtering is unaffected either way.

Usage:
  python far_amendment_dates.py               # fetch + write
  python far_amendment_dates.py --dry-run     # fetch + report, no writes

Environment (same as the other scrapers):
  SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import json
import logging
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

ECFR_VERSIONS_URL = "https://www.ecfr.gov/api/versioner/v1/versions/title-14.json"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# eCFR's bulk "this is where our history starts" snapshot dates. Anything
# stamped with one of these was not observed to change -- it is a lower
# bound, not an event. Confirmed by distribution: these four account for
# 4,541 of 6,349 Title 14 sections, in blocks of 1,966 / 1,221 / 757 / 597.
TRACKING_FLOOR_DATES = {"2016-08-01", "2016-12-05", "2016-12-30", "2017-01-01"}

REQUEST_DELAY = 0.4
REQUEST_TIMEOUT = 120

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("far_amendment_dates")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
        return json.loads(r.read().decode())


def fetch_latest_amendments() -> dict[str, str]:
    """{section_number: latest amendment_date} for every live 14 CFR section.

    Removed sections are dropped -- they aren't in our corpus, and keeping
    them would only add noise to the coverage numbers below.
    """
    first = _get_json(f"{ECFR_VERSIONS_URL}?page=1")
    total_pages = int(first.get("meta", {}).get("total_pages", 1))
    log.info(f"eCFR reports {first.get('meta', {}).get('result_count')} version rows across {total_pages} pages")

    # value = (amendment_date, removed) for the section's MOST RECENT row.
    # "Removed" has to be read off the latest row, not "ever removed" -- a
    # section can be removed and later reinstated, and that reinstated
    # section is live and in our corpus.
    latest: dict[str, tuple[str, bool]] = {}

    def absorb(payload: dict) -> None:
        for v in payload.get("content_versions", []):
            if v.get("type") != "section":
                continue
            ident = v.get("identifier")
            when = v.get("amendment_date") or v.get("date")
            if not ident or not when:
                continue
            prev = latest.get(ident)
            if prev is None or when > prev[0]:
                latest[ident] = (when, bool(v.get("removed")))

    absorb(first)
    for page in range(2, total_pages + 1):
        time.sleep(REQUEST_DELAY)
        absorb(_get_json(f"{ECFR_VERSIONS_URL}?page={page}"))
        if page % 5 == 0:
            log.info(f"  ...page {page}/{total_pages}, {len(latest)} sections so far")

    live = {k: v[0] for k, v in latest.items() if not v[1]}
    log.info(
        f"{len(latest)} sections with an amendment date "
        f"({len(latest) - len(live)} removed, {len(live)} live)"
    )
    return live


def _supa(method: str, path: str, body=None, extra_headers=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    headers.update(extra_headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw.strip() else []


def fetch_corpus_sections() -> list[dict]:
    """Every far_sections row. Paged -- PostgREST silently caps an unfiltered
    select at 1,000 rows, which would quietly leave 3/4 of the corpus
    un-dated. See memory/gotcha_postgrest_1000_row_cap.md."""
    out, offset = [], 0
    while True:
        chunk = _supa(
            "GET",
            "far_sections?select=id,section_number&order=id",
            extra_headers={"Range-Unit": "items", "Range": f"{offset}-{offset + 999}"},
        )
        out.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return out


def apply_dates(dry_run: bool) -> int:
    amendments = fetch_latest_amendments()
    rows = fetch_corpus_sections()
    log.info(f"far_sections: {len(rows)} rows")

    updates, misses = [], []
    for r in rows:
        when = amendments.get(r["section_number"])
        if not when:
            misses.append(r["section_number"])
            continue
        updates.append({
            "id": r["id"],
            "last_amended": when,
            "last_amended_is_floor": when in TRACKING_FLOOR_DATES,
        })

    floor = sum(1 for u in updates if u["last_amended_is_floor"])
    years = Counter(u["last_amended"][:4] for u in updates)
    log.info(
        f"matched {len(updates)}/{len(rows)} ({100 * len(updates) / max(len(rows), 1):.2f}%) — "
        f"{len(updates) - floor} with a real observed amendment date, {floor} at the tracking floor"
    )
    log.info(f"year distribution: {dict(sorted(years.items()))}")
    if misses:
        log.warning(f"{len(misses)} section(s) absent from eCFR's version index: {sorted(misses)[:20]}")

    if dry_run:
        log.info("[DRY-RUN] no writes")
        return 0

    # Via set_far_last_amended() rather than a REST upsert -- a partial-column
    # upsert can't satisfy far_sections' NOT NULLs, and sending body_text back
    # just to set a date risks clobbering content. The RPC touches only the two
    # date columns. See migrations_far_last_amended_rpc.sql.
    written = 0
    for i in range(0, len(updates), 500):
        batch = updates[i:i + 500]
        n = _supa("POST", "rpc/set_far_last_amended", body={"rows": batch})
        written += int(n) if isinstance(n, int) else len(batch)
        log.info(f"  wrote {written}/{len(updates)}")
    return written


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run and not (SUPABASE_URL and SUPABASE_KEY):
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        sys.exit(1)

    n = apply_dates(args.dry_run)
    log.info(f"done — {n} rows updated")


if __name__ == "__main__":
    main()
