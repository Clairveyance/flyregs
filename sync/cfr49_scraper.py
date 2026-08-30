#!/usr/bin/env python3
"""
49 CFR (DOT-wide) Scraper -- NTSB, TSA, HMR
=============================================================================
RC, 2026-08-14: "bring in and build the most relevant additions to the CFRs
for our core audience... maybe we just add them inside the FARs (since
they're closely tied) and create top chips to see/sort each. FAR, HMR,
NTSB, etc." First pass, small + broadly-relevant parts only:
  - 830  (NTSB) Notification and Reporting of Aircraft Accidents/Incidents
  - 1552 (TSA)  Flight Training Security Program
  - 1544 (TSA)  Aircraft Operator Security
  - 175  (HMR)  Carriage by Aircraft (hazardous materials)
Deliberately deferred to a later pass (see memory/flyregs_49cfr_content_gap_
pending.md): HMR 172 (the Hazardous Materials Table itself, ~3000+
structured entries -- a fundamentally different, much larger build), HMR
171/173 (172's own supporting definitions), TSA 1550, 49 CFR 40.

Source: same eCFR versioner API far_scraper.py already uses for Title 14 --
confirmed live 2026-08-14 that Title 49's feed is byte-identical in XML
shape (DIV6=SUBPART, DIV8=SECTION, same HEAD/P/CITA/TABLE tags) to Title
14's, so this reuses far_scraper.py's own parsing helpers verbatim rather
than re-deriving them. The only real difference: this scraper takes an
explicit small list of target parts (Title 49 spans hundreds of parts
across many different agencies -- PHMSA, NTSB, TSA, FMCSA, FRA... -- "every
part in Title 49" is not a coherent single scrape the way "every Part in
14 CFR Chapter I" is for FAR), and each part's `family` (HMR/NTSB/TSA) is
hardcoded per-part rather than derived from eCFR's structure, since that
grouping is a FlyRegs UI concept (the chip filter), not something eCFR's
own API exposes directly.

Modes:
  test    parse one part's live full-text XML, no DB writes, prints counts
  full    fetches every TARGET_PART, parses, upserts

Usage:
  python cfr49_scraper.py --mode test --part 830
  python cfr49_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional

import requests
from lxml import etree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revision_log import log_revisions  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("cfr49_scraper")

ECFR_API_BASE = "https://www.ecfr.gov/api/versioner/v1"
TITLE = "49"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

REQUEST_DELAY = 0.5
REQUEST_TIMEOUT = 30

TARGET_PARTS = [
    {"part": "830", "family": "NTSB"},
    {"part": "1544", "family": "TSA"},
    {"part": "1552", "family": "TSA"},
    {"part": "175", "family": "HMR"},
]


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, application/xml, text/xml, */*",
    })
    return s


def current_ecfr_date(session: requests.Session) -> str:
    resp = session.get(f"{ECFR_API_BASE}/titles.json", timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    titles = resp.json().get("titles", resp.json())
    if isinstance(titles, dict):
        titles = titles.get("titles", [])
    for t in titles:
        if str(t.get("number")) == TITLE:
            return t["up_to_date_as_of"]
    raise RuntimeError(f"Title {TITLE} not found in eCFR titles list")


# ──────────────────────────────────────────────────────────────────────────────
#  XML parsing -- copied verbatim from far_scraper.py (confirmed live: Title 49's
#  feed uses the identical DIV6/DIV8/HEAD/P/TABLE/CITA tag shape as Title 14's).
# ──────────────────────────────────────────────────────────────────────────────

def _elem_text(elem) -> str:
    text = "".join(elem.itertext())
    return " ".join(text.split())


_PARAGRAPH_TAGS = {"P", "FP", "FP-1", "FP-2", "FP-3", "FP-4"}
_TABLE_HEADER_MARK = ""  # Unicode Private Use Area -- never occurs in real scraped text


def _render_table(table_elem) -> str:
    lines = []
    caption = table_elem.find(".//CAPTION")
    if caption is not None:
        cap_text = _elem_text(caption)
        if cap_text:
            lines.append(cap_text)

    thead = table_elem.find(".//THEAD")
    header_rows = thead.findall(".//TR") if thead is not None else []
    body_rows = [r for r in table_elem.findall(".//TR") if r not in header_rows]

    for row in header_rows:
        cells = [_elem_text(c) for c in row if c.tag in ("TH", "TD")]
        cells = [c for c in cells if c]
        if cells:
            lines.append(_TABLE_HEADER_MARK + " | ".join(cells))

    for row in body_rows:
        cells = [_elem_text(c) for c in row if c.tag in ("TH", "TD")]
        cells = [c for c in cells if c]
        if cells:
            lines.append(" | ".join(cells))

    return "\n".join(lines)


def _extract_body_blocks(section_elem) -> list[str]:
    blocks: list[str] = []

    def walk(elem):
        for child in elem:
            if child.tag == "HEAD":
                continue
            if child.tag == "TABLE":
                rendered = _render_table(child)
                if rendered:
                    blocks.append(rendered)
            elif child.tag in _PARAGRAPH_TAGS:
                text = _elem_text(child)
                if text:
                    blocks.append(text)
            elif child.tag == "CITA":
                continue
            else:
                walk(child)

    walk(section_elem)
    return blocks


def parse_part_xml(xml_bytes: bytes, part: str) -> tuple[Optional[str], list[dict]]:
    """Returns (part_label, sections) -- part_label from the root element's
    own direct HEAD child (e.g. "PART 830-NOTIFICATION AND REPORTING OF
    AIRCRAFT ACCIDENTS..."), confirmed live to sit directly under the root
    regardless of whether the root's own tag is DIV5/DIV3/etc -- root.iter()
    below finds DIV6/DIV8 at any depth the same way, so the exact top-level
    wrapper tag doesn't matter for either half of this."""
    root = etree.fromstring(xml_bytes)

    # Some sections (confirmed live: 49 CFR 1544.3) carry two direct HEAD
    # children -- a bare "§ N" citation heading plus the real title (here,
    # "[Reserved]") -- so take the LAST HEAD child, not the first, for both
    # the part label and each section title below. A normal single-HEAD
    # element is unaffected (last of one is the only one).
    part_label = None
    part_heads = root.findall("HEAD")
    if part_heads:
        part_label = _elem_text(part_heads[-1])

    sections: list[dict] = []
    current_subpart_letter: Optional[str] = None
    current_subpart_title: Optional[str] = None

    for elem in root.iter():
        if elem.tag == "DIV6" and elem.get("TYPE") == "SUBPART":
            sp_head = elem.find("HEAD")
            current_subpart_letter = elem.get("N")
            current_subpart_title = _elem_text(sp_head) if sp_head is not None else None

        elif elem.tag == "DIV8" and elem.get("TYPE") == "SECTION":
            section_number = elem.get("N")
            sec_heads = elem.findall("HEAD")
            title = _elem_text(sec_heads[-1]) if sec_heads else None
            body_text = "\n\n".join(_extract_body_blocks(elem))

            if not section_number:
                continue

            sections.append({
                "section_number": section_number,
                "part": part,
                "subpart_letter": current_subpart_letter,
                "subpart_title": current_subpart_title,
                "title": title,
                "body_text": body_text or None,
            })

    return part_label, sections


def fetch_part(session: requests.Session, part: str, as_of: str, retries: int = 3) -> tuple[Optional[str], list[dict]]:
    url = f"{ECFR_API_BASE}/full/{as_of}/title-{TITLE}.xml"
    last_exc = None
    for attempt in range(retries):
        try:
            resp = session.get(url, params={"part": part}, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return parse_part_xml(resp.content, part)
        except requests.RequestException as e:
            last_exc = e
            if attempt < retries - 1:
                wait = 2 * (attempt + 1)
                log.warning(f"  Part {part} fetch failed ({e}) -- retrying in {wait}s")
                time.sleep(wait)
    raise last_exc


# ──────────────────────────────────────────────────────────────────────────────
#  Supabase
# ──────────────────────────────────────────────────────────────────────────────

def _supa_headers(extra: dict = None) -> dict:
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def upsert_part(part: str, label: str, family: str, sort_order: int) -> bool:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/cfr49_parts",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "part"},
        json=[{"part": part, "label": label, "family": family, "sort_order": sort_order}],
        timeout=30,
    )
    if not resp.ok:
        log.error(f"  cfr49_parts upsert failed: {resp.status_code} {resp.text[:300]}")
        return False
    return True


def upsert_sections(records: list[dict]) -> bool:
    try:
        n = log_revisions(
            SUPABASE_URL, _supa_headers(), doc_type="cfr49", table="cfr49_sections",
            key_field="section_number", text_field="body_text", title_field="title",
            new_rows=records,
        )
        if n:
            log.info(f"  Logged {n} revision(s) for What's Changed")
    except Exception as e:
        log.warning(f"  revision logging failed (non-fatal): {e}")
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/cfr49_sections",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "section_number"},
        json=records,
        timeout=30,
    )
    if not resp.ok:
        log.error(f"  cfr49_sections upsert failed: {resp.status_code} {resp.text[:300]}")
        return False
    return True


def log_scraper_run(run: dict) -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            json=run,
            timeout=10,
        )
        if not r.ok:
            log.error(f"log_scraper_run: insert failed ({r.status_code}): {r.text[:500]}")
    except Exception as e:
        log.error(f"log_scraper_run: insert raised: {e}")


# ──────────────────────────────────────────────────────────────────────────────
#  Run modes
# ──────────────────────────────────────────────────────────────────────────────

def run_test(session: requests.Session, part: str):
    log.info(f"TEST MODE -- Part {part} only (no DB writes)")
    as_of = current_ecfr_date(session)
    log.info(f"eCFR up-to-date-as-of: {as_of}")
    label, sections = fetch_part(session, part, as_of)
    log.info(f"Part label: {label}")
    log.info(f"Sections parsed: {len(sections)}")
    for s in sections[:5]:
        log.info(f"\n{'-'*50}")
        log.info(f"§ {s['section_number']}  (Subpart {s['subpart_letter']}: {s['subpart_title']})")
        log.info(f"Title: {s['title']}")
        log.info(f"Body:  {(s['body_text'] or '')[:200]}")


def run_full(session: requests.Session):
    log.info("=" * 60)
    log.info("FULL SCRAPE -- 49 CFR target parts")
    log.info("=" * 60)

    run_record = {"mode": "full", "started_at": datetime.now(timezone.utc).isoformat(), "status": "running"}
    as_of = current_ecfr_date(session)
    log.info(f"eCFR up-to-date-as-of: {as_of}")

    total_sections = 0
    errors = 0
    error_details = []

    for i, tp in enumerate(TARGET_PARTS, 1):
        part, family = tp["part"], tp["family"]
        log.info(f"[{i}/{len(TARGET_PARTS)}] Part {part} ({family})")
        try:
            label, sections = fetch_part(session, part, as_of)
            if not label:
                raise RuntimeError(f"no part label found in XML for part {part}")
            upsert_part(part, label, family, i)
            now = datetime.now(timezone.utc).isoformat()
            for s in sections:
                s["updated_at"] = now
            if sections and upsert_sections(sections):
                total_sections += len(sections)
                log.info(f"  -> {label}: {len(sections)} sections")
            elif not sections:
                log.warning(f"  -> 0 sections parsed for part {part} -- check parser against real XML")
        except Exception as e:
            log.error(f"  x Part {part} failed: {e}")
            errors += 1
            error_details.append({"part": part, "error": str(e)})
        time.sleep(REQUEST_DELAY)

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        # Was far_parts_total/far_sections_total/far_errors -- piggybacked
        # on FAR's own columns since cfr49 never had any of its own, making
        # a real CFR49 run indistinguishable from a real FAR run by column
        # alone. Dedicated columns added
        # (sync/migrations_scraper_runs_loi_cfr49_columns.sql), found in the
        # 2026-08-23 scraper-automation audit.
        "cfr49_total": len(TARGET_PARTS),
        "cfr49_added": total_sections,
        "cfr49_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Parts={len(TARGET_PARTS)} Sections={total_sections} Errors={errors}")
    return errors


def main():
    parser = argparse.ArgumentParser(description="49 CFR (NTSB/TSA/HMR) Scraper")
    parser.add_argument("--mode", choices=["test", "full"], default="test")
    parser.add_argument("--part", help="Part number for test mode (default: 830)", default="830")
    args = parser.parse_args()

    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.")
        sys.exit(1)

    session = make_session()
    if args.mode == "test":
        run_test(session, args.part)
    elif args.mode == "full":
        # A logged status="partial" run used to exit 0 unconditionally --
        # confirmed live 2026-08-29 as the reason a real eCFR read-timeout
        # on Part 830 (2026-08-24) left those 6 sections silently a full
        # day stale while the GH Actions job stayed green throughout, with
        # nothing else in the pipeline ever surfacing that. See
        # far_scraper.py's identical comment on the other 6 scrapers this
        # same fix was applied to.
        errors = run_full(session)
        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()
