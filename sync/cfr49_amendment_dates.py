#!/usr/bin/env python3
"""
49 CFR amendment dates from eCFR's version index
================================================
Populates `cfr49_sections.last_amended` / `last_amended_is_floor`, which were
100% NULL -- every one of the 86 rows -- so the app's Date Range filter and
"What's Changed" could never answer anything about 49 CFR.

This is a deliberate clone of far_amendment_dates.py, which has been proven
against all 4,293 FAR sections (4,283 exact matches vs eCFR). Same endpoint
family, same floor concept, same identifier format. Two differences, both
because 49 CFR is tiny by comparison (86 rows vs 4,293):

  * Writes with a plain per-row PATCH instead of the set_far_last_amended RPC.
    That RPC exists because a partial-column UPSERT cannot satisfy
    far_sections' NOT NULLs and re-sending body_text just to set a date risks
    clobbering content. A PATCH updates only the named columns and has neither
    problem, and at 86 rows the extra round trips are irrelevant. No new
    migration needed.
  * Filters the version index to the four parts we actually carry
    (830 NTSB, 175 HMR, 1544 and 1552 TSA) rather than taking all of Title 49,
    which is enormous and almost entirely outside this app's scope.

Usage:
  python3 sync/cfr49_amendment_dates.py --dry-run   # fetch + report, no writes
  python3 sync/cfr49_amendment_dates.py             # fetch + write

Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import json
import logging
import os
import sys
import time
import urllib.request
from collections import Counter

ECFR_VERSIONS_URL = "https://www.ecfr.gov/api/versioner/v1/versions/title-49.json"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# The parts this app actually carries. Title 49 as a whole is far larger and
# entirely out of scope; fetching it all and then discarding 99% would just be
# noise in the coverage numbers below.
OUR_PARTS = {"830", "175", "1544", "1552"}

# Same concept as far_amendment_dates.py's: eCFR's history starts when eCFR
# started tracking, so an untouched section carries a bulk snapshot date that
# is true as "not amended since at least this" but NOT as "amended on this".
# Title 49's floor dates are DERIVED AT RUNTIME rather than hardcoded -- the
# FAR script's four constants were measured for Title 14 and there is no
# reason to assume Title 49 shares them. See _derive_floor_dates.
REQUEST_DELAY = 0.4
REQUEST_TIMEOUT = 120

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("cfr49_amendment_dates")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")


def _get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
        return json.loads(r.read().decode())


def fetch_latest_amendments() -> dict[str, str]:
    """{section_number: latest amendment_date} for our four Title 49 parts."""
    first = _get_json(f"{ECFR_VERSIONS_URL}?page=1")
    total_pages = int(first.get("meta", {}).get("total_pages", 1))
    log.info(f"eCFR reports {first.get('meta', {}).get('result_count')} version rows "
             f"across {total_pages} pages")

    latest: dict[str, tuple[str, bool]] = {}

    def absorb(payload: dict) -> None:
        for v in payload.get("content_versions", []):
            if v.get("type") != "section":
                continue
            if str(v.get("part") or "") not in OUR_PARTS:
                continue
            ident = v.get("identifier")
            when = v.get("amendment_date") or v.get("date")
            if not ident or not when:
                continue
            prev = latest.get(ident)
            # "Removed" is read off the LATEST row, not "ever removed" -- a
            # section can be removed and later reinstated, and the reinstated
            # one is live and in our corpus.
            if prev is None or when > prev[0]:
                latest[ident] = (when, bool(v.get("removed")))

    absorb(first)
    for page in range(2, total_pages + 1):
        time.sleep(REQUEST_DELAY)
        absorb(_get_json(f"{ECFR_VERSIONS_URL}?page={page}"))
        if page % 10 == 0:
            log.info(f"  ...page {page}/{total_pages}, {len(latest)} in-scope sections so far")

    live = {k: v[0] for k, v in latest.items() if not v[1]}
    log.info(f"{len(latest)} in-scope sections with a date "
             f"({len(latest) - len(live)} removed, {len(live)} live)")
    return live


# eCFR's version history begins when eCFR began tracking, so a bulk snapshot
# can only come from that era. Title 14's measured floors are 2016-08-01,
# 2016-12-05, 2016-12-30 and 2017-01-01 (see far_amendment_dates.py).
TRACKING_ERA_END = "2017-12-31"


def _derive_floor_dates(dates: list[str]) -> set[str]:
    """A tracking-floor date is a bulk snapshot: one date shared by an
    implausibly large block of sections AND falling in eCFR's tracking-start
    era. Derived rather than hardcoded, because the FAR script's four
    constants were measured for Title 14 and Title 49 need not share them.

    THE ERA CEILING IS NOT OPTIONAL, and a first version of this without it
    got it wrong. Size alone flagged 2024-07-30, which carries 15 of our 86
    sections -- but those are 14 sections of Part 1552 plus one of 1544, i.e.
    the 2024 TSA Flight Training Security Program rulemaking. That is a REAL
    amendment day, and marking it as a floor would have told a user "no
    changes since 2024 or earlier" about a part that changed on exactly that
    date. A real rulemaking amending a whole part in one day looks identical
    to a snapshot if you only count rows.

    With the ceiling, the two surviving floors are 2016-08-15 (14 sections,
    all Part 175) and 2016-12-05 (33 sections, all Part 1544) -- and
    2016-12-05 is one of Title 14's measured floors too, which is good
    corroboration that these are eCFR artifacts rather than FAA events.
    """
    if not dates:
        return set()
    counts = Counter(dates)
    threshold = max(3, int(len(dates) * 0.15))
    floors = {d for d, n in counts.items()
              if n >= threshold and d <= TRACKING_ERA_END}
    rejected = {d: n for d, n in counts.items()
                if n >= threshold and d > TRACKING_ERA_END}
    if floors:
        log.info(f"derived tracking-floor dates: {sorted((d, counts[d]) for d in floors)}")
    if rejected:
        log.info(f"large same-date blocks kept as REAL amendments (post-{TRACKING_ERA_END}): "
                 f"{sorted(rejected.items())}")
    return floors


def _supa(method: str, path: str, body=None, extra_headers=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
               "Content-Type": "application/json"}
    headers.update(extra_headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw.strip() else []


def apply_dates(dry_run: bool) -> int:
    amendments = fetch_latest_amendments()
    rows = _supa("GET", "cfr49_sections?select=id,section_number&order=section_number")
    log.info(f"cfr49_sections: {len(rows)} rows")

    floors = _derive_floor_dates(list(amendments.values()))

    updates, misses = [], []
    for r in rows:
        when = amendments.get(r["section_number"])
        if not when:
            misses.append(r["section_number"])
            continue
        updates.append({"id": r["id"], "last_amended": when,
                        "last_amended_is_floor": when in floors})

    at_floor = sum(1 for u in updates if u["last_amended_is_floor"])
    years = Counter(u["last_amended"][:4] for u in updates)
    log.info(f"matched {len(updates)}/{len(rows)} "
             f"({100 * len(updates) / max(len(rows), 1):.1f}%) — "
             f"{len(updates) - at_floor} with a real observed date, {at_floor} at the floor")
    log.info(f"year distribution: {dict(sorted(years.items()))}")
    if misses:
        log.warning(f"{len(misses)} section(s) absent from eCFR's index: {sorted(misses)}")

    if dry_run:
        log.info("[DRY-RUN] no writes")
        return 0

    written = 0
    for u in updates:
        _supa("PATCH", f"cfr49_sections?id=eq.{u['id']}",
              body={"last_amended": u["last_amended"],
                    "last_amended_is_floor": u["last_amended_is_floor"]})
        written += 1
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
