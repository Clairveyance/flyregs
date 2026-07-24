#!/usr/bin/env python3
"""
FAR (14 CFR, Chapter I) Scraper
=================================
Fetches all Federal Aviation Regulations from the eCFR's official versioner
API, stores in Supabase. Scoped to Chapter I (Federal Aviation Administration)
only — the other Title 14 chapters (Office of the Secretary aviation
proceedings, Commercial Space Transportation, NASA, Air Transportation System
Stabilization) aren't what pilots/mechanics mean by "the FARs" and are out of
scope for this app.

Source, confirmed live 2026-07-23:
  Structure: GET /api/versioner/v1/structure/{date}/title-14.json
             — full Part > Subpart > Section outline, JSON.
  Full text: GET /api/versioner/v1/full/{date}/title-14.xml?part={N}
             — actual regulation text for one Part, XML.
             DIV6 = SUBPART, DIV8 = SECTION (HEAD = heading, P = paragraphs).

Unlike faa.gov, api.ecfr.gov (fetched via www.ecfr.gov) does not appear to
bot-block plain requests — no browser-header workaround needed here, but the
session still sends a realistic User-Agent for politeness/consistency with
the other scrapers.

Modes:
  test    structure fetch + one Part (61) full-text parse, no DB writes
  full    every Chapter I Part — upserts far_parts (reference table) and
          far_sections (content), safe to re-run on a schedule since eCFR
          publishes a versioned "as of" date and this always pulls current

Usage:
  python far_scraper.py --mode test
  python far_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import logging
import os
import sys
import time
from datetime import date, datetime, timezone
from typing import Optional

import requests
from lxml import etree

# ──────────────────────────────────────────────────────────────────────────────
#  Config
# ──────────────────────────────────────────────────────────────────────────────

ECFR_API_BASE = "https://www.ecfr.gov/api/versioner/v1"
TITLE = "14"
CHAPTER = "I"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

REQUEST_DELAY = 0.5
REQUEST_TIMEOUT = 30

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("far_scraper")


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
    """eCFR versions everything by date — use Title 14's own `up_to_date_as_of`
    rather than today's calendar date, since that's the date the API actually
    has content for (may lag today by a few days)."""
    resp = session.get(f"{ECFR_API_BASE}/titles.json", timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    titles = resp.json().get("titles", resp.json())
    if isinstance(titles, dict):
        titles = titles.get("titles", [])
    for t in titles:
        if str(t.get("number")) == TITLE:
            return t["up_to_date_as_of"]
    # Fallback — shouldn't happen given Title 14 is confirmed to exist.
    return date.today().isoformat()


# ──────────────────────────────────────────────────────────────────────────────
#  Step 1: Structure — Chapter I's Part list (the far_parts reference table)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_chapter1_parts(session: requests.Session, as_of: str) -> list[dict]:
    """Returns [{part, label, sort_order}] for every real Part under Chapter I.
    Skips reserved/placeholder parts (label containing 'Reserved' or 'XXX' —
    both confirmed to occur in the live structure, e.g. 'Part 199 [Reserved]'
    and 'Part 22—XXX')."""
    url = f"{ECFR_API_BASE}/structure/{as_of}/title-{TITLE}.json"
    resp = session.get(url, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    data = resp.json()

    chapter1 = next(
        (c for c in data["children"] if c["type"] == "chapter" and c["identifier"] == CHAPTER),
        None,
    )
    if not chapter1:
        raise RuntimeError("Chapter I not found in eCFR structure response")

    parts: list[dict] = []

    def walk(node):
        if node["type"] == "part":
            label = node["label"]
            if "reserved" in label.lower() or label.endswith("—XXX") or label.endswith("-XXX"):
                log.info(f"  Skipping reserved/placeholder: {label}")
                return
            parts.append({"part": node["identifier"], "label": label})
        for child in node.get("children", []):
            walk(child)

    walk(chapter1)
    for i, p in enumerate(parts):
        p["sort_order"] = i
    return parts


# ──────────────────────────────────────────────────────────────────────────────
#  Step 2: Full text for one Part → section records
# ──────────────────────────────────────────────────────────────────────────────

def _elem_text(elem) -> str:
    """Flatten an element's text content (including nested <I>/<E> etc.),
    collapsing whitespace the way PDF-derived text needs less of here since
    this is clean source XML, not OCR — mainly just joins wrapped lines."""
    text = "".join(elem.itertext())
    return " ".join(text.split())


# Leaf paragraph-style tags — flatten each as one paragraph via itertext().
# Confirmed live: some sections (e.g. § 91.905, a waiver-list section) use
# <EXTRACT><FP>/<FP-2> instead of plain <P> — same semantic role, different
# tag family (FP-2 etc. are indentation levels).
_PARAGRAPH_TAGS = {"P", "FP", "FP-1", "FP-2", "FP-3", "FP-4"}


_TABLE_HEADER_MARK = ""  # Unicode Private Use Area — never occurs in real scraped text


def _render_table(table_elem) -> str:
    """Flatten a <TABLE> into readable pipe-delimited text. Confirmed live:
    technical spec sections (e.g. Part 194's flight-recorder-parameter
    sections) carry their entire content as a <TABLE> with no <P> at all —
    silently skipping tables meant silently dropping those sections whole.

    Rows genuinely inside a <THEAD> are marked with _TABLE_HEADER_MARK so
    the app renders them as a real header instead of guessing — see
    aim_scraper.py's identical helper for the full story: a table with no
    real header text anywhere in the source got its first DATA row
    silently mislabeled as column headers on the AIM side, confirmed wrong
    against the real printed document. eCFR's XML does carry genuine
    <THEAD>/<TH> text for the FAR tables checked so far, but marking
    explicitly (rather than assuming "first row = header") costs nothing
    and closes off the same failure mode here too."""
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
    """Walk a DIV8 section's content (skipping HEAD), producing one text
    block per paragraph-like leaf and one flattened block per table. Wrapper
    elements with no direct textual role (EXTRACT, DIV, gpotbl_div) are
    transparent — recurse straight through them rather than special-casing
    every wrapper tag by name, since eCFR's schema has more of these than
    are worth enumerating individually."""
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
                continue  # trailing citation footer, not body content
            else:
                # Transparent wrapper (EXTRACT, DIV, gpotbl_div, or any
                # other grouping tag) — descend into it.
                walk(child)

    walk(section_elem)
    return blocks


def parse_part_xml(xml_bytes: bytes, part: str) -> list[dict]:
    """Walk a Part's full-text XML, yielding one record per DIV8 (SECTION),
    tagged with whichever DIV6 (SUBPART) it's nested under."""
    root = etree.fromstring(xml_bytes)

    sections: list[dict] = []
    current_subpart_letter: Optional[str] = None
    current_subpart_title: Optional[str] = None

    for elem in root.iter():
        if elem.tag == "DIV6" and elem.get("TYPE") == "SUBPART":
            head = elem.find("HEAD")
            current_subpart_letter = elem.get("N")
            current_subpart_title = _elem_text(head) if head is not None else None

        elif elem.tag == "DIV8" and elem.get("TYPE") == "SECTION":
            section_number = elem.get("N")
            head = elem.find("HEAD")
            title = _elem_text(head) if head is not None else None
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

    return sections


def fetch_part_sections(
    session: requests.Session, part: str, as_of: str, retries: int = 3
) -> list[dict]:
    """eCFR intermittently returns transient 503s / read timeouts under load
    (confirmed live during full-corpus runs — 5 of 82 parts failed this way
    in one production run) — retry with backoff before giving up, so a
    periodic re-sync doesn't silently drop whichever parts happen to hit a
    bad moment."""
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
                log.warning(f"  Part {part} fetch failed ({e}) — retrying in {wait}s")
                time.sleep(wait)
    raise last_exc


# ──────────────────────────────────────────────────────────────────────────────
#  Supabase — same raw-REST pattern as faa_scraper.py / pcg_scraper.py
# ──────────────────────────────────────────────────────────────────────────────

def _supa_headers(extra: dict = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def upsert_parts(parts: list[dict]) -> bool:
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {len(parts)} far_parts rows")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/far_parts",
            headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params={"on_conflict": "part"},
            json=parts,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  far_parts upsert failed: {e}")
        return False


def upsert_sections(records: list[dict]) -> bool:
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {len(records)} far_sections rows")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/far_sections",
            headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params={"on_conflict": "section_number"},
            json=records,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  far_sections upsert failed: {e}")
        return False


def log_scraper_run(run: dict) -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            json=run,
            timeout=10,
        )
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────────────
#  Run modes
# ──────────────────────────────────────────────────────────────────────────────

def run_test(session: requests.Session):
    """Structure fetch + Part 61 full-text parse, no DB writes."""
    log.info("TEST MODE — structure + Part 61 only (no DB writes)")
    as_of = current_ecfr_date(session)
    log.info(f"eCFR up-to-date-as-of: {as_of}")

    parts = fetch_chapter1_parts(session, as_of)
    log.info(f"Chapter I parts found: {len(parts)}")
    log.info(f"First 5: {[p['part'] for p in parts[:5]]}")

    sections = fetch_part_sections(session, "61", as_of)
    log.info(f"Part 61 sections parsed: {len(sections)}")
    for s in sections[:5]:
        log.info(f"\n{'─'*50}")
        log.info(f"§ {s['section_number']}  (Subpart {s['subpart_letter']}: {s['subpart_title']})")
        log.info(f"Title: {s['title']}")
        log.info(f"Body:  {(s['body_text'] or '')[:200]}")


def run_full(session: requests.Session):
    log.info("=" * 60)
    log.info("FULL SCRAPE — 14 CFR Chapter I")
    log.info("=" * 60)

    run_record = {
        "mode": "full",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    as_of = current_ecfr_date(session)
    log.info(f"eCFR up-to-date-as-of: {as_of}")

    parts = fetch_chapter1_parts(session, as_of)
    log.info(f"Chapter I parts to process: {len(parts)}")
    upsert_parts(parts)

    total_sections = 0
    errors = 0
    error_details = []

    for i, p in enumerate(parts, 1):
        part = p["part"]
        log.info(f"[{i}/{len(parts)}] Part {part} — {p['label']}")
        try:
            sections = fetch_part_sections(session, part, as_of)
            now = datetime.now(timezone.utc).isoformat()
            for s in sections:
                s["updated_at"] = now
            if sections and upsert_sections(sections):
                total_sections += len(sections)
                log.info(f"  → {len(sections)} sections")
            elif not sections:
                log.info("  → 0 sections (part has no directly-codified sections here)")
        except Exception as e:
            log.error(f"  ✗ Part {part} failed: {e}")
            errors += 1
            error_details.append({"part": part, "error": str(e)})
        time.sleep(REQUEST_DELAY)

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        "far_parts_total": len(parts),
        "far_sections_total": total_sections,
        "far_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Parts={len(parts)} Sections={total_sections} Errors={errors}")


# ──────────────────────────────────────────────────────────────────────────────
#  CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FAR (14 CFR Chapter I) Scraper")
    parser.add_argument(
        "--mode",
        choices=["test", "full"],
        default="test",
        help="test=structure + Part 61 only (no writes), full=every Chapter I part, upsert everything",
    )
    args = parser.parse_args()

    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.\n"
            "Use --mode test to verify parsing without DB credentials."
        )
        sys.exit(1)

    session = make_session()

    if args.mode == "test":
        run_test(session)
    elif args.mode == "full":
        run_full(session)


if __name__ == "__main__":
    main()
