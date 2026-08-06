#!/usr/bin/env python3
"""
AIM real per-paragraph change dates from the Explanation of Changes page
==========================================================================
Populates `aim_paragraphs.last_amended` -- see migrations_aim_last_amended.sql
for why this is deliberately partial coverage, not a bug: the FAA doesn't
publish AIM version history anywhere (no eCFR-equivalent for the AIM), so
the only real source is the current edition's own "Explanation of Changes"
page, which names the specific paragraphs it touched.

Source, confirmed live 2026-08-05:
  https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap0_section_0.html
  Structure: one "Effective: <Month DD, YYYY>" line for the whole edition,
  then a lettered list (a, b, c, ...) where each item's FIRST line names
  one or more paragraph numbers ("4-7-4. AUTHORITY FOR ...", sometimes two
  numbers back-to-back like "5-1-1. ...\n5-4-5. ..." when one change
  touches both). A trailing "g. Editorial Changes" item and an "h. Entire
  Publication" item are prose, not paragraph-numbered -- skipped, since
  attributing an editorial sweep to one specific paragraph would overstate
  what's actually known. Only lettered items with a real leading N-N-N
  paragraph number get a date.

This only ever dates the paragraphs called out in the CURRENT edition --
re-running this after a future AIM update will overwrite with that
edition's own set, not accumulate history. That's correct: this script
answer the question "when did the FAA say this paragraph last changed,"
not "build a full history we don't have a source for."

Usage:
  python aim_amendment_dates.py               # fetch + write
  python aim_amendment_dates.py --dry-run     # fetch + report, no writes

Environment: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import json
import logging
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

from bs4 import BeautifulSoup

EOC_URL = "https://www.faa.gov/air_traffic/publications/atpubs/aim_html/chap0_section_0.html"
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
REQUEST_TIMEOUT = 60

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("aim_amendment_dates")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"

# Matches a leading AIM paragraph number at the start of an item's text,
# e.g. "4-7-4." or "5-1-1." -- always digit-hyphen-digit-hyphen-digit. Each
# lettered item's FIRST line carries a "a. "/"b. " marker before the real
# paragraph number (e.g. "b. 5-1-1. PREFLIGHT PREPARATION"); a second
# paragraph named in the same item appears on its own continuation line
# with no letter marker at all. The optional leading group absorbs the
# marker either way.
PARA_NUM_RE = re.compile(r"^(?:[a-z]\.\s*)?(\d+-\d+-\d+)\.")
EFFECTIVE_RE = re.compile(r"Effective:\s*([A-Za-z]+ \d{1,2},\s*\d{4})")


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_eoc() -> tuple[str, list[str]]:
    """Returns (effective_date_iso, [paragraph_number, ...])."""
    html = _get(EOC_URL)
    soup = BeautifulSoup(html, "html.parser")
    main = soup.find("main") or soup.body
    text = main.get_text("\n", strip=True)

    m = EFFECTIVE_RE.search(text)
    if not m:
        raise RuntimeError("Could not find an 'Effective: <date>' line on the EoC page")
    from datetime import datetime
    effective = datetime.strptime(m.group(1), "%B %d, %Y").date().isoformat()

    paragraphs = []
    for line in text.split("\n"):
        m = PARA_NUM_RE.match(line.strip())
        if m:
            paragraphs.append(m.group(1))
    return effective, sorted(set(paragraphs))


def _supa_patch(paragraph_number: str, last_amended: str) -> bool:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/aim_paragraphs?paragraph_number=eq.{urllib.parse.quote(paragraph_number)}",
        data=json.dumps({"last_amended": last_amended}).encode(),
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        method="PATCH",
    )
    try:
        urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT)
        return True
    except urllib.error.HTTPError as e:
        log.error(f"  {paragraph_number}: PATCH failed — {e.code} {e.read().decode()[:200]}")
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.dry_run and not (SUPABASE_URL and SUPABASE_KEY):
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        sys.exit(1)

    effective, paragraphs = parse_eoc()
    log.info(f"Current AIM edition effective {effective}, {len(paragraphs)} paragraph(s) named: {paragraphs}")

    if args.dry_run:
        log.info("[DRY-RUN] no writes")
        return

    written = 0
    for p in paragraphs:
        if _supa_patch(p, effective):
            written += 1
    log.info(f"done — {written}/{len(paragraphs)} paragraphs updated")


if __name__ == "__main__":
    main()
