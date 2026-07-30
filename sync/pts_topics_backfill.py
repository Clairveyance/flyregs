#!/usr/bin/env python3
"""
PTS Topic Backfill
=============================================================================
PTS predates ACS's discrete Knowledge/Risk Management/Skill element codes --
pts_scraper.py already documented this and, as a deliberate MVP tradeoff,
left each PTS task's full flat outline jammed into one `objective` string
with no acs_elements rows at all (the Ref Packet task screen just hides
those sections when empty). Confirmed live: this reads as a genuinely BLANK
pack section to a user studying Task D of e.g. FAA-S-8081-15B, not a
formatting quirk -- 281 of 1141 tasks catalog-wide (9 whole PTS documents)
had zero Knowledge/Risk/Skill content, which is the opposite of what a
"study with this pack" feature can ship with.

The content isn't actually missing -- it's already sitting in `objective`
as a numbered outline (e.g. "To determine that the applicant: 1. Exhibits
knowledge of... 2. Makes a timely decision... 3. Applies appropriate
power..."). This script splits that flat text into individual list items
(new acs_elements rows, element_type='topic' -- deliberately NOT shoehorned
into knowledge/risk_management/skill, since a real PTS numbered item mixes
all three with no way to tell which is which; forcing a fake K/R/S label
here would misrepresent the source document) and trims `objective` down to
just its lead sentence, matching how ACS tasks already separate objective
from element list.

Marker detection: a real top-level item marker ("1.", "2.", ...) is
confirmed by STRICT sequential numbering starting at 1, not by matching the
text after it -- some real item bodies themselves start with a number
("1. 14 CFR parts 61, 71, 91, 95, and 97. 2. FAA-H-8083-15..."), which a
content-based heuristic would misread. Lettered sub-items (a./b./c.) are
kept merged into their parent numbered item rather than split further --
they're sub-bullets of one topic, not independently citable topics.
Confirmed against all 281 real PTS tasks before running for real: 276
split cleanly (1,540 items total), 5 have a single flowing sentence with
no enumerable breakdown at all (real content, not a parse failure --
spot-checked each one against the actual stored objective text).

A stray page-number digit sometimes bleeds onto the very last item from a
footer ("...if applicable. 27") -- stripped as a trailing bare 1-3 digit
number.

Usage:
  python pts_topics_backfill.py --mode test   # parse + report, no DB writes
  python pts_topics_backfill.py --mode full   # parse + upsert elements + trim objective

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import logging
import os
import re
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("pts_topics_backfill")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

PTS_DOC_CODES = [
    "FAA-S-8081-8C", "FAA-S-8081-15B", "FAA-S-8081-23B", "FAA-S-8081-22A",
    "FAA-S-8081-9E", "FAA-S-8081-20A", "FAA-S-8081-25C", "FAA-S-8081-21A",
    "FAA-S-8081-10E",
]

MARKER_RE = re.compile(r"(?<!\w)(\d{1,2})\.\s+")


def split_pts_outline(text: str) -> tuple[str, list[str]]:
    matches = list(MARKER_RE.finditer(text))
    confirmed = []
    expected = 1
    for m in matches:
        if int(m.group(1)) == expected:
            confirmed.append(m)
            expected += 1
    if len(confirmed) < 2:
        return text.strip(), []
    intro = text[: confirmed[0].start()].strip()
    items = []
    for i, m in enumerate(confirmed):
        start = m.end()
        end = confirmed[i + 1].start() if i + 1 < len(confirmed) else len(text)
        body = text[start:end].strip()
        body = re.sub(r"\s+\d{1,3}$", "", body)  # strip bled-in page number
        if body:
            items.append(body)
    return intro, items


def _headers(extra=None):
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def fetch_all(path: str, query: str, page: int = 1000) -> list:
    out = []
    start = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{path}?{query}&limit={page}&offset={start}",
            headers=_headers(),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        out.extend(data)
        if len(data) < page:
            break
        start += page
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    args = ap.parse_args()

    global SUPABASE_URL, SUPABASE_KEY
    key = SUPABASE_KEY or os.environ.get("EXPO_PUBLIC_SUPABASE_ANON_KEY", "")
    url = SUPABASE_URL or os.environ.get("EXPO_PUBLIC_SUPABASE_URL", "").rstrip("/")
    SUPABASE_URL, SUPABASE_KEY = url, key

    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required for full mode")
        sys.exit(1)

    total_tasks = 0
    total_items = 0
    total_no_split = 0

    # Query doc_type='pts' directly rather than the original hardcoded 9 --
    # covers any PTS doc added later (e.g. pts_multisection_scraper.py's
    # per-category sub-documents) without needing this list kept in sync.
    doc_codes = [d["code"] for d in fetch_all("acs_documents", "doc_type=eq.pts&select=code")]
    for code in doc_codes:
        tasks = fetch_all(
            "acs_tasks",
            f"doc_code=eq.{code}&select=id,area_number,task_letter,title,objective",
        )
        doc_items = 0
        doc_split_tasks = 0
        element_rows = []
        task_patches = []

        for t in tasks:
            total_tasks += 1
            intro, items = split_pts_outline(t["objective"] or "")
            if not items:
                total_no_split += 1
                continue
            doc_split_tasks += 1
            doc_items += len(items)
            total_items += len(items)
            for n, body in enumerate(items, start=1):
                element_rows.append(
                    {
                        "doc_code": code,
                        "task_id": t["id"],
                        "element_code": f"T.{t['area_number']}.{t['task_letter']}.{n}",
                        "element_type": "topic",
                        "body_text": body,
                        "sort_order": n - 1,
                    }
                )
            task_patches.append({"id": t["id"], "objective": intro})

        log.info(f"{code}: {len(tasks)} tasks, {doc_split_tasks} split, {doc_items} items")

        if args.mode == "full" and element_rows:
            resp = requests.post(
                f"{SUPABASE_URL}/rest/v1/acs_elements",
                headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                params={"on_conflict": "doc_code,element_code"},
                json=element_rows,
                timeout=60,
            )
            resp.raise_for_status()
            for p in task_patches:
                resp = requests.patch(
                    f"{SUPABASE_URL}/rest/v1/acs_tasks",
                    headers=_headers({"Prefer": "return=minimal"}),
                    params={"id": f"eq.{p['id']}"},
                    json={"objective": p["objective"]},
                    timeout=30,
                )
                resp.raise_for_status()
            log.info(f"  -> upserted {len(element_rows)} elements, trimmed {len(task_patches)} objectives")

    log.info(f"\nTotal: {total_tasks} tasks, {total_tasks - total_no_split} split, {total_items} items, {total_no_split} left as single-sentence objective")


if __name__ == "__main__":
    main()
