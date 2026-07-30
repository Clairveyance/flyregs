#!/usr/bin/env python3
"""
PTS (Practical Test Standards) Scraper
=============================================================================
The 18 legacy PTS documents -- older FAA standards not yet replaced by ACS,
still real, current, public-domain content feeding Ref Packets alongside the
17 ACS documents sync/acs_scraper.py already loads. Shares the same target
tables (acs_documents/acs_areas_of_operation/acs_tasks/acs_elements,
doc_type='pts') so the app's Ref Packet screens need no PTS-specific code.

PTS predates the ACS Knowledge/Risk Management/Skill element taxonomy --
confirmed against the real Private Pilot (Rotorcraft Gyroplane) PTS
(FAA-S-8081-15B): each Task has an Objective followed by one flat numbered/
lettered outline (no K/R/S element codes at all). No acs_elements rows are
written for PTS docs -- the Ref Packet task screen already hides the
Knowledge/Risk Management/Skills sections when empty, so this degrades
correctly with no UI changes needed. The full outline is kept as the task's
objective text, not thrown away.

Source PDFs, confirmed live 2026-07-25 via
https://www.faa.gov/training_testing/testing/test_standards (all 18 direct
PDF links extracted from that page's real DOM, not guessed).

Real format quirks confirmed against FAA-S-8081-15B (fixed below, expect
more per-document quirks across the other 17 -- same class of variance the
ACS scraper hit, log a self-check per document rather than trusting blindly):
  1. Two different Task header shapes in the SAME document: "Task A: Title"
     (the common one) and, at least once, "A.  Task: \nTitle" (title on its
     own next line). TASK_RE below matches both via alternation.
  2. "References:" is sometimes "Reference:" (singular) -- inconsistent
     even within one document (Areas VI, VII, IX of the sample all used the
     singular form while the rest of the doc used the plural). Matched with
     `References?:`.
  3. Area of Operation headings have TWO shapes too: "I. \nTitle" (title on
     next line) and "II. Title" (title on the same line, space-separated).
     AREA_RE's `\.\s+` (not `\.\s*\n\s*`) matches both.
  4. The document's real "Areas of Operation:" body section is NOT the
     first occurrence of that literal string -- it appears once as a plain
     TOC section label near the front too. Always take the LAST occurrence
     before parsing, not the first.

Modes:
  test    fetch + parse one already-downloaded PDF, no DB writes, prints
          counts and a self-check (References?: count vs matched tasks)
  full    fetches every doc from PTS_DOCUMENTS below, parses, upserts

Usage:
  python pts_scraper.py --mode test --pdf /path/to/downloaded.pdf --code FAA-S-8081-15B
  python pts_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import logging
import os
import re
import sys
import time
from typing import Optional

import requests
import fitz  # PyMuPDF -- same choice as acs_scraper.py, see its header for why

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("pts_scraper")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def _pts(code, title, slug, filename):
    return {
        "code": code, "title": title, "slug": slug, "doc_type": "pts",
        "pdf_url": f"https://www.faa.gov/training_testing/testing/acs/{filename}",
    }


# All 18, direct hrefs confirmed live from the real PTS list page DOM.
PTS_DOCUMENTS = [
    _pts("FAA-S-8081-3B", "Recreational Pilot Practical Test Standards for Airplane Category and Rotorcraft Category", "recreational-airplane-rotorcraft", "recreational_airplane_helicopter_pts_3.pdf"),
    _pts("FAA-S-8081-7C", "Flight Instructor Practical Test Standards for Rotorcraft Category Gyroplane Rating", "cfi-gyroplane", "cfi_gyroplane_pts_7.pdf"),
    _pts("FAA-S-8081-8C", "Flight Instructor Practical Test Standards for Glider Category", "cfi-glider", "cfi_glider_pts_8.pdf"),
    _pts("FAA-S-8081-9E", "Flight Instructor Instrument Practical Test Standards for Airplane Rating and Helicopter Rating", "cfii-airplane-helicopter", "cfi_instrument_pts_9.pdf"),
    _pts("FAA-S-8081-10E", "Aircraft Dispatcher Practical Test Standards", "aircraft-dispatcher", "aircraft_dispatcher_pts_10.pdf"),
    _pts("FAA-S-8081-15B", "Private Pilot Practical Test Standards for Rotorcraft Category Gyroplane Rating", "private-pilot-gyroplane", "private_gyroplane_pts_15.pdf"),
    _pts("FAA-S-8081-16C", "Commercial Pilot Practical Test Standards for Rotorcraft Category Gyroplane Rating", "commercial-pilot-gyroplane", "commercial_gyroplane_pts_16.pdf"),
    _pts("FAA-S-8081-17A", "Private Pilot Practical Test Standards for Lighter-Than-Air Category", "private-pilot-lta", "private_lta_pts_17.pdf"),
    _pts("FAA-S-8081-18A", "Commercial Pilot Practical Test Standards for Lighter-Than-Air Category", "commercial-pilot-lta", "commercial_lta_pts_18.pdf"),
    _pts("FAA-S-8081-20A", "Airline Transport Pilot and Aircraft Type Rating Practical Test Standards for Rotorcraft Category Helicopter Rating", "atp-helicopter", "atp_helicopter_pts_20.pdf"),
    _pts("FAA-S-8081-21A", "Flight Engineer Practical Test Standards for Reciprocating Engine, Turbopropeller, and Turbojet Powered Aircraft", "flight-engineer", "engineer_pts_21.pdf"),
    _pts("FAA-S-8081-22A", "Private Pilot Practical Test Standards for Glider Category", "private-pilot-glider", "private_glider_pts_22.pdf"),
    _pts("FAA-S-8081-23B", "Commercial Pilot Practical Test Standards for Glider Category", "commercial-pilot-glider", "commercial_glider_pts_23.pdf"),
    _pts("FAA-S-8081-25C", "Parachute Rigger Practical Test Standards", "parachute-rigger", "rigger_pts_25.pdf"),
    _pts("FAA-S-8081-29A", "Sport Pilot and Sport Pilot Flight Instructor Rating Practical Test Standards for Airplane Category, Gyroplane Category, and Glider Category", "sport-pilot-airplane-gyroplane-glider", "sport_airplane_pts_29.pdf"),
    _pts("FAA-S-8081-30A", "Sport Pilot and Sport Pilot Flight Instructor Rating Practical Test Standards for Lighter-Than-Air Category", "sport-pilot-lta", "sport_lta_pts_30.pdf"),
    _pts("FAA-S-8081-31A", "Sport Pilot and Sport Pilot Flight Instructor Practical Test Standards for Powered Parachute Category and Weight-Shift-Control Aircraft Category", "sport-pilot-wsc-pp", "sport_wsc_pp_pts_31.pdf"),
    _pts("FAA-S-8081-32A", "Private Pilot Practical Test Standards for Powered Parachute Category and Weight-Shift-Control Aircraft Category", "private-pilot-wsc-pp", "private_wsc_pp_pts_32.pdf"),
]

AREA_RE = re.compile(r"\b([IVXLC]+)\.\s+([A-Za-z0-9 ,'/&()-]+?)\s*\n")
TASK_RE = re.compile(
    r"(?:Task ([A-Z]): ([^\n]+)|([A-Z])\.\s+Task:\s*\n\s*([^\n]+))\s*\n"
    r"References?: (.+?)\nObjective: (.+?)\n(?=Task [A-Z]:|[A-Z]\.\s+Task:|\b[IVXLC]+\.\s+[A-Za-z]|\Z)",
    re.DOTALL,
)


def extract_pdf_text(path: str) -> str:
    doc = fitz.open(path)
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


AREA_RE_CAPS = re.compile(r"\b([IVXLCl]+)\.\s+AREA OF OPERATION:\s*([A-Za-z0-9 ,'/&()-]+?)\s*\n")
# All-caps variant: "A. TASK: TITLE" (occasionally bare "TASK: TITLE" with no
# letter when it's the only task in its Area -- defaults to "A" below). A
# NOTE: paragraph sometimes sits between the title and REFERENCES -- matched
# optionally so it doesn't break the anchor the way it silently did before
# this fix (confirmed: Private Glider PTS FAA-S-8081-22A had 5 such NOTEs,
# each one swallowing the real task that followed into the wrong match).
# REFERENCES values themselves stay mixed-case even when the label is all
# caps, and "Objective" uses a period, not a colon, in this variant.
TASK_RE_CAPS = re.compile(
    # Title sometimes wraps onto a second line (all-caps titles run long,
    # e.g. "AIRCRAFT HANDBOOKS, MANUALS, MEL, CDL, AND OPERATIONS
    # \nSPECIFICATIONS" in the Flight Engineer PTS) -- an optional second
    # `[^\n]+` line, same fix already proven for the ACS scraper's own
    # 2-line title wrap.
    r"(?:([A-Z])\.\s+)?TASK:\s*([^\n]+?(?:\n[^\n]+?)?)\s*\n(?:\s*NOTE:.+?\n\s*\n)?"
    # A stray single space sometimes sits between the newline and
    # "Objective" (confirmed: CFI Glider PTS, "NOTE:" tucked between
    # References and Objective leaves " \n Objective." behind) -- `\n\s*`
    # instead of a bare `\n` tolerates it without needing a literal-NOTE
    # branch in this specific position too.
    r"REFERENCES:\s*(.+?)\n\s*Objective\.?:?\s*(.+?)\n"
    r"(?=(?:[A-Z]\.\s+)?TASK:|\b[IVXLCl]+\.\s+AREA OF OPERATION:|\Z)",
    re.DOTALL,
)


def body_text(full_text: str, task_re: re.Pattern) -> Optional[str]:
    """Slice past the front-matter TOC/boilerplate into the real body,
    anchored on the FIRST genuine task match (References/Objective content
    immediately following its header) rather than a prose section label --
    confirmed unreliable: several PTS documents mention "Area(s) of
    Operation" many times in front-matter prose, so the naive "last
    occurrence of that phrase" heuristic lands mid-document on unrelated
    text for those. A real task match can't happen inside a TOC (TOC entries
    have dot-leaders + a page number immediately after, never real
    References/Objective content), so anchoring there is reliable regardless
    of how many incidental mentions of "Area of Operation" precede it."""
    first = task_re.search(full_text)
    if not first:
        return None
    # Just enough lookback for the Area I heading (+ a short Note:) directly
    # preceding the real Task A -- confirmed ~136 chars in a real sample.
    # A much wider margin (previously 3000) reached back far enough to also
    # catch the front-matter "Applicant's Practical Test Checklist" section
    # (a bare "I. Preflight Preparation / A. .../ B. .../ C. Weather
    # Information" outline with checkboxes) whose lettered items false-
    # matched AREA_RE too, since single letters like "C" are also valid
    # roman numerals -- confirmed live: produced a bogus area_number "C".
    start = max(0, first.start() - 600)
    return full_text[start:]


def parse_document(full_text: str) -> dict:
    # Auto-detect format: all-caps "REFERENCES:"/"TASK:" vs mixed-case
    # "References:"/"Task X:" -- confirmed both conventions are real,
    # roughly evenly split across the 18 PTS documents.
    caps_count = len(re.findall(r"\bREFERENCES:", full_text))
    mixed_count = len(re.findall(r"\bReferences?:", full_text))
    use_caps = caps_count > mixed_count
    area_re = AREA_RE_CAPS if use_caps else AREA_RE
    task_re = TASK_RE_CAPS if use_caps else TASK_RE

    body = body_text(full_text, task_re)
    if body is None:
        return {"areas": [], "tasks": [], "elements": [], "ref_count": 0}

    area_matches = list(area_re.finditer(body))

    tasks = []
    areas_seen = {}  # only areas a REAL task actually resolves to -- see note below
    task_matches = list(task_re.finditer(body))
    for i, m in enumerate(task_matches):
        if use_caps:
            letter = m.group(1) or "A"  # bare "TASK:" with no letter -- sole task in its Area
            title = m.group(2).strip()
            refs = " ".join(m.group(3).split())
            objective = " ".join(m.group(4).split())
        else:
            letter = m.group(1) or m.group(3)
            title = (m.group(2) or m.group(4)).strip()
            refs = " ".join(m.group(5).split())
            objective = " ".join(m.group(6).split())
        pos = m.start()
        # Nearest PRECEDING area heading, not "any match anywhere earlier in
        # the body" -- the front matter routinely repeats a bare outline of
        # every Area/Task ("Applicant's Practical Test Checklist", and
        # again as a plain index right before the real content) with no
        # References/Objective attached. Its lettered task rows (e.g. "C.
        # Ground Resonance") false-match area_re too, since single letters
        # like C/V/X/L are also valid roman numerals -- confirmed live.
        # Deriving the areas list ONLY from what real tasks resolve to
        # (rather than every area_re match in the body) keeps those stray
        # index entries from ever surfacing as a bogus area_number "C".
        area_num, area_title = None, None
        for am in area_matches:
            if am.start() >= pos:
                break
            area_num, area_title = am.group(1), am.group(2).strip().rstrip(",")
        if area_num is not None and area_num not in areas_seen:
            areas_seen[area_num] = area_title
        tasks.append({
            "area_number": area_num,
            "task_letter": letter,
            "title": title,
            "objective": objective,
            "references_text": refs,
            "sort_order": i,
        })

    areas = [{"area_number": n, "title": t, "sort_order": i} for i, (n, t) in enumerate(areas_seen.items())]

    # Real (area_number, task_letter) duplicates with DIFFERENT titles mean
    # this document restarts its own Area numbering across multiple
    # sections (confirmed: FAA-S-8081-3B covers Airplane AND Rotorcraft
    # category in one PDF, each with its own Area I-X) -- acs_tasks' unique
    # key is (doc_code, area_number, task_letter), so upserting this would
    # silently overwrite one section's task with the other's. Flag instead
    # of corrupting data; needs a dedicated compound-key/section-aware
    # handling pass, same bucket as the 3 known structurally-different ACS
    # documents.
    seen_titles: dict = {}
    for t in tasks:
        key = (t["area_number"], t["task_letter"])
        if key in seen_titles and seen_titles[key] != t["title"]:
            return {"areas": [], "tasks": [], "elements": [], "ref_count": -1}
        seen_titles[key] = t["title"]

    ref_count = len(re.findall(r"\bREFERENCES:" if use_caps else r"\bReferences?:", body))
    return {"areas": areas, "tasks": tasks, "elements": [], "ref_count": ref_count}


def _supa_headers(extra: Optional[dict] = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def upsert_document(doc: dict) -> None:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_documents",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "code"},
        json=[{
            "code": doc["code"], "title": doc["title"], "slug": doc["slug"],
            "doc_type": doc["doc_type"], "pdf_url": doc["pdf_url"],
        }],
        timeout=30,
    )
    resp.raise_for_status()


def upsert_areas(doc_code: str, areas: list[dict]) -> None:
    if not areas:
        return
    rows = [{"doc_code": doc_code, **a} for a in areas]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_areas_of_operation",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,area_number"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def upsert_tasks(doc_code: str, tasks: list[dict]) -> None:
    if not tasks:
        return
    rows = [{"doc_code": doc_code, **t} for t in tasks]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_tasks",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,area_number,task_letter"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--pdf", help="Local PDF path (test mode)")
    ap.add_argument("--code", help="Document code (test mode)", default="FAA-S-8081-15B")
    args = ap.parse_args()

    if args.mode == "test":
        if not args.pdf:
            log.error("--pdf required in test mode")
            sys.exit(1)
        text = extract_pdf_text(args.pdf)
        parsed = parse_document(text)
        if parsed["ref_count"] == -1:
            log.warning("Multi-section document (Area numbering restarts) -- needs section-aware handling")
            return
        log.info(f"Areas: {len(parsed['areas'])}")
        log.info(f"Tasks: {len(parsed['tasks'])}")
        log.info(f"References literal count: {parsed['ref_count']} (should match Tasks)")
        if len(parsed["tasks"]) != parsed["ref_count"]:
            log.warning("  ! MISMATCH -- some task(s) not captured, needs inspection before trusting this doc")
        return

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        sys.exit(1)

    for doc in PTS_DOCUMENTS:
        log.info(f"\n=== {doc['code']}: {doc['title']} ===")
        try:
            resp = requests.get(doc["pdf_url"], headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
            resp.raise_for_status()
            tmp_path = f"/tmp/{doc['slug']}.pdf"
            with open(tmp_path, "wb") as f:
                f.write(resp.content)
        except Exception as e:
            log.error(f"  ✗ download failed: {e}")
            continue

        text = extract_pdf_text(tmp_path)
        parsed = parse_document(text)
        if parsed["ref_count"] == -1:
            log.warning(f"  ! {doc['code']} restarts Area numbering across multiple sections (e.g. Airplane + Rotorcraft in one PDF) -- needs section-aware handling, skipping")
            continue
        log.info(f"  Areas: {len(parsed['areas'])}  Tasks: {len(parsed['tasks'])}  References: {parsed['ref_count']}")
        if len(parsed["tasks"]) != parsed["ref_count"]:
            log.warning(f"  ! MISMATCH for {doc['code']} -- {parsed['ref_count'] - len(parsed['tasks'])} task(s) likely uncaptured, skipping upsert (needs manual inspection)")
            continue
        if len(parsed["tasks"]) == 0:
            log.warning(f"  ! ZERO tasks parsed for {doc['code']} -- skipping upsert, needs individual inspection")
            continue
        if not parsed["areas"]:
            log.warning(f"  ! ZERO areas parsed for {doc['code']} -- skipping upsert, needs individual inspection")
            continue

        try:
            upsert_document(doc)
            upsert_areas(doc["code"], parsed["areas"])
            upsert_tasks(doc["code"], parsed["tasks"])
            log.info(f"  ✓ upserted")
        except Exception as e:
            log.error(f"  ✗ upsert failed for {doc['code']}: {e}")
        time.sleep(0.5)

    log.info("\nDone.")


if __name__ == "__main__":
    main()
