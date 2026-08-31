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
  Versions:  GET /api/versioner/v1/versions/title-14.json?page={N}
             — real per-section amendment history. See far_amendment_dates.py.

CORRECTION (2026-08-05): this file used to state that "eCFR always serves the
current version, no separate 'what changed' tracking [is] needed the way
faa.gov's per-AC pages require", and so stamped updated_at = now() on every
row every run with no diff. That was wrong twice over. It meant every FAR row
shared one updated_at, which made Home's Date Range filter an all-or-nothing
toggle (0 results or all 4,292) and got the filter hidden for FAR. And eCFR
does publish change tracking — the /versions/ endpoint above — which now
populates far_sections.last_amended for 4,290 of 4,292 rows with genuine
dates spanning 2016-2026.

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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import table_grid  # noqa: E402
from revision_log import log_revisions  # noqa: E402
from far_amendment_dates import apply_dates as apply_amendment_dates  # noqa: E402

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


# RC, real device (14 CFR 93.123's JFK table), 2026-08-31: found while
# investigating the JFK table's missing column label that this constant was
# an EMPTY STRING here, not the real marker -- confirmed live: zero rows in
# far_sections have ever contained a real U+E000 header mark, versus 43 in
# aim_paragraphs (aim_scraper.py's own copy of this constant is correct).
# Every FAR table has been silently relying on the client's "no explicit
# header" fallback since this mechanism was introduced, exactly the failure
# mode aim_scraper.py's own comment on this same helper describes as
# already fixed once for AIM. Using the explicit  escape rather than
# pasting the raw glyph -- a genuinely invisible character is exactly how
# this went missing in the first place with no diff-visible trace of it.
_TABLE_HEADER_MARK = chr(0xE000)  # Unicode Private Use Area — never occurs in real scraped text; built via chr() so it cannot silently vanish from source again


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

    # RC, real device (14 CFR 93.123's "John F. Kennedy" table): "several
    # columns but no ref as to what those numbers mean." Root cause: the
    # old `cells = [c for c in cells if c]` below dropped any EMPTY cell
    # from a row before joining -- fine for a genuinely blank decorative
    # row, wrong for a header row whose leading corner cell is blank on
    # purpose (a real, common CFR convention when the row labels -- here,
    # 1500/1600/1700/1800/1900 -- are self-evident without a column name).
    # Dropping that one empty cell shifted every REAL header left by one
    # position, so "Air carriers | Commuters | Other" (3 cells) ended up
    # over "<hour> | Air carriers | Commuters | Other" data rows (4 cells)
    # -- confirmed against the live eCFR/GovInfo text, which does have a
    # 4th column, not a mislabeled 3-column table. Preserving cell POSITION
    # (empty string stays a placeholder in the list) instead of removing it
    # keeps every row's column count aligned; `any(cells)` still skips a
    # row that is genuinely, entirely empty.
    # colspan/rowspan are REAL in the eCFR XML and were ignored here until
    # 2026-08-31 -- 14 CFR 26.5's header is `<TH rowspan=2/><TH colspan=4>`
    # over 4 more <TH> and then 5-wide data rows, so emitting one cell per
    # source cell produced rows of 2, 4 and 5 and the headers no longer sat
    # over the columns they label. table_grid.render_grid expands both spans
    # into a real occupancy grid; see that module for the full story and for
    # why this logic is now shared rather than copied into each scraper.
    def _spans(row):
        return [
            (_elem_text(c), table_grid.parse_span(c.get("colspan")), table_grid.parse_span(c.get("rowspan")))
            for c in row
            if c.tag in ("TH", "TD")
        ]

    lines.extend(
        table_grid.render_grid(
            [_spans(r) for r in header_rows],
            [_spans(r) for r in body_rows],
            _TABLE_HEADER_MARK,
        )
    )

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
    # Must run BEFORE the upsert below -- it diffs against whatever's
    # currently live, which the upsert is about to overwrite. See
    # revision_log.py's own header for why this generalizes AC's
    # block-level What's Changed logging to plain-text FAR/AIM/P-CG/AD.
    try:
        n = log_revisions(
            SUPABASE_URL, _supa_headers(), doc_type="far", table="far_sections",
            key_field="section_number", text_field="body_text", title_field="title",
            new_rows=records,
        )
        if n:
            log.info(f"  Logged {n} FAR revision(s) for What's Changed")
    except Exception as e:
        log.warning(f"  revision logging failed (non-fatal): {e}")
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
    # Was a bare `except: pass` -- confirmed live, 2026-08-09: this run_record's
    # own field names (far_parts_total, far_sections_total, far_sections_dated,
    # far_errors) had NEVER matched any real column on the shared scraper_runs
    # table (which only ever had faa_scraper.py's AC-specific columns) --
    # every single FAR sync run had been silently failing to log here, this
    # whole time, with the swallowed exception hiding it completely. Columns
    # added back (sync/migrations_scraper_runs_far_aim_pcg_columns.sql); this
    # log line stays so any FUTURE drift shows up in the run's own log instead
    # of vanishing the same way again.
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
        else:
            # A silently-dropped row despite a success POST and zero
            # exceptions is what ad_scraper.py hit on a real 2026-08-10
            # scheduled run -- this confirms the POST itself succeeded, so
            # a repeat of that shape points downstream of this call, not at
            # a swallowed client exception. See ad_scraper.py's own
            # log_scraper_run() for the full incident.
            log.info(f"log_scraper_run: inserted ({r.status_code})")
    except Exception as e:
        log.error(f"log_scraper_run: insert raised: {e}")


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


def reconcile_removed_sections(seen_section_numbers: set[str]) -> int:
    """Delete any far_sections row NOT seen in this full run -- eCFR's own
    feed only ever returns what's CURRENTLY codified, so a section that
    used to be in our table but wasn't returned this time has been
    repealed/reserved since the last full sync. Confirmed live 2026-08-11:
    93.101/93.103 (the NY North Shore Helicopter Route rule, self-expired
    2026-07-29) sat serving as "current law" for 12 days, reachable by 3
    real MagicLink citations from Legal Interpretations, because this file
    had zero delete/reconciliation logic at all -- unlike faa_scraper.py's
    mark_cancelled_acs(). far_sections has no status column the way
    advisory_circulars does, so unlike that sibling this is a real DELETE,
    not a status flip -- there's nothing else a "current federal
    regulations" table could correctly do with a row eCFR no longer serves.
    Only called from run_full() (a full run covers every Part, so
    "not seen" is meaningful); never from run_test's tiny subset.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 0
    try:
        # PostgREST silently caps an unpaginated .select() at 1000 rows --
        # far_sections alone is 4200+, so this MUST page or it would treat
        # every section past the first 1000 as "not seen" and delete real,
        # current regulations. Same pattern as build_embeddings.py's own
        # fetch_rows(), which hit this exact table for this exact reason.
        db_section_numbers: set[str] = set()
        offset = 0
        while True:
            resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/far_sections",
                headers=_supa_headers(),
                params={"select": "section_number", "limit": "1000", "offset": str(offset)},
                timeout=30,
            )
            resp.raise_for_status()
            page = resp.json()
            db_section_numbers.update(row["section_number"] for row in page)
            if len(page) < 1000:
                break
            offset += 1000
    except Exception as e:
        log.error(f"  reconcile: couldn't read current far_sections, skipping (non-fatal): {e}")
        return 0

    stale = db_section_numbers - seen_section_numbers
    if not stale:
        return 0

    log.warning(f"  {len(stale)} section(s) no longer in eCFR's current feed, removing: {sorted(stale)}")
    stale_list = ",".join(stale)
    try:
        # Dead citations first (FK-shaped cleanup, same order as the manual
        # 2026-08-11 fix) -- both directions, a removed section can be
        # either the citing or the cited side.
        for col in ("cited_id", "citing_id"):
            requests.delete(
                f"{SUPABASE_URL}/rest/v1/document_citations",
                headers=_supa_headers(),
                params={"and": f"({col}.in.({stale_list}),cited_type.eq.far)" if col == "cited_id"
                        else f"({col}.in.({stale_list}),citing_type.eq.far)"},
                timeout=30,
            ).raise_for_status()
        requests.delete(
            f"{SUPABASE_URL}/rest/v1/far_sections",
            headers=_supa_headers(),
            params={"section_number": f"in.({stale_list})"},
            timeout=30,
        ).raise_for_status()
    except Exception as e:
        log.error(f"  reconcile: delete failed (non-fatal, will retry next full sync): {e}")
        return 0
    return len(stale)


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
    seen_section_numbers: set[str] = set()

    for i, p in enumerate(parts, 1):
        part = p["part"]
        log.info(f"[{i}/{len(parts)}] Part {part} — {p['label']}")
        try:
            sections = fetch_part_sections(session, part, as_of)
            now = datetime.now(timezone.utc).isoformat()
            for s in sections:
                s["updated_at"] = now
                seen_section_numbers.add(s["section_number"])
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

    # Only reconcile deletions if this run actually covered every part
    # cleanly -- if any part errored, seen_section_numbers is an incomplete
    # picture of "what eCFR currently has," and treating that gap as "these
    # sections were repealed" would delete real, still-current sections.
    removed = 0
    if errors == 0:
        removed = reconcile_removed_sections(seen_section_numbers)
    else:
        log.warning(f"  Skipping stale-section reconciliation: {errors} part(s) failed this run, seen-set is incomplete")

    # Real amendment dates, from eCFR's own version index. This has to run
    # AFTER the section upserts above, because those unconditionally rewrite
    # updated_at on every row -- a sync stamp, not a change date. The docstring
    # at the top of this file used to assert no change-tracking was needed
    # ("eCFR always serves the current version"); that was wrong, and it left
    # Home's Date Range filter unable to answer "what changed" for FAR at all.
    # A failure here is logged, not fatal: stale dates are a degraded filter,
    # whereas aborting would discard a completed content scrape.
    amended = 0
    try:
        amended = apply_amendment_dates(dry_run=False)
    except Exception as e:
        log.error(f"  ✗ amendment-date pass failed: {e}")
        error_details.append({"part": "amendment_dates", "error": str(e)})

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        "far_parts_total": len(parts),
        "far_sections_total": total_sections,
        "far_sections_dated": amended,
        "far_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(
        f"\nDone. Parts={len(parts)} Sections={total_sections} "
        f"Dated={amended} Removed={removed} Errors={errors}"
    )
    return errors


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
    parser.add_argument(
        "--no-revision-log", action="store_true",
        help=(
            "Skip content_revisions logging for this run (sets SKIP_REVISION_LOG=1, "
            "read by revision_log.log_revisions()). Use for a manual backfill/repair "
            "run over already-known data, so it can't log bogus What's Changed "
            "entries. Leave unset for the real scheduled cron sync."
        ),
    )
    args = parser.parse_args()
    if args.no_revision_log:
        os.environ["SKIP_REVISION_LOG"] = "1"

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
        # A logged status="partial" run (some eCFR part failed) used to
        # exit 0 unconditionally -- the GH Actions job stayed green even
        # though the corpus is now silently behind for whichever part
        # errored, with nothing else in the pipeline ever surfacing that.
        # Confirmed live 2026-08-29 as a real, not hypothetical, gap in
        # this exact bug's SIBLING (cfr49_scraper.py's Part 830 eCFR
        # timeout: silently a full day stale, job green throughout).
        errors = run_full(session)
        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()
