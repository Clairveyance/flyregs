#!/usr/bin/env python3
"""
PTS Multi-Section Scraper
=============================================================================
The 9 PTS documents pts_scraper.py deliberately skipped (its own
parse_document() returns ref_count=-1 and bails rather than corrupt data --
see that function's comment): each one covers MULTIPLE aircraft categories
in a single PDF (e.g. FAA-S-8081-3B = Recreational Pilot for Airplane AND
Rotorcraft/Helicopter AND Rotorcraft/Gyroplane), and each category restarts
its own Area of Operation numbering at "I." -- acs_tasks' unique key is
(doc_code, area_number, task_letter), so loading this straight would
silently overwrite one category's Task A with another's.

The fix mirrors how the rest of the catalog already handles multi-category
certificates: Private/Commercial/Sport Pilot etc. are already separate
RefPacks per category (Airplane, Rotorcraft Helicopter, ...), not one pack
with colliding area numbers. So each detected section here becomes its own
acs_documents row (own doc_code/slug/title), not a hack to cram multiple
categories into one pack.

Section detection: reuses pts_scraper.py's own proven AREA_RE/TASK_RE
matching (same caps-vs-mixed auto-detect, same front-matter stripping) --
this only adds a second pass that watches for the area number resetting to
"I" as a section boundary, instead of pts_scraper's bail-out.

Category labels: PTS documents that cover an additional/second category
consistently include an "ADDITIONAL RATINGS TASK TABLE" appendix headed
"Addition of a/an <category> Rating to an existing <cert> ... Certificate"
right before each section's own applicability table -- confirmed against
FAA-S-8081-3B (yields "ASEL", "Rotorcraft/Helicopter", "Rotorcraft/
Gyroplane" for its 3 real sections). Used when found; falls back to
"Section N" (flagged for manual review) when a document doesn't have this
appendix or the label doesn't match cleanly -- never fabricates a category
name it isn't confident in.

Modes:
  test    parse one already-downloaded PDF, no DB writes, prints
          per-section counts + detected labels for manual sanity-checking
  full    fetches every doc in MULTISECTION_CODES, parses, upserts each
          section as its own acs_documents row

Usage:
  python pts_multisection_scraper.py --mode test --pdf /path/to.pdf --code FAA-S-8081-3B
  python pts_multisection_scraper.py --mode full

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
import fitz

from pts_scraper import (
    AREA_RE, AREA_RE_CAPS, TASK_RE, TASK_RE_CAPS, body_text, PTS_DOCUMENTS,
)

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("pts_multisection_scraper")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

MULTISECTION_CODES = [
    "FAA-S-8081-3B", "FAA-S-8081-7C", "FAA-S-8081-16C", "FAA-S-8081-17A",
    "FAA-S-8081-18A", "FAA-S-8081-29A", "FAA-S-8081-30A", "FAA-S-8081-31A",
    "FAA-S-8081-32A",
]
MULTISECTION_DOCUMENTS = [d for d in PTS_DOCUMENTS if d["code"] in MULTISECTION_CODES]

ROMAN_VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100}


def roman_to_int(s: str) -> int:
    s = s.upper()
    total, prev = 0, 0
    for ch in reversed(s):
        v = ROMAN_VALUES.get(ch, 0)
        if v < prev:
            total -= v
        else:
            total += v
            prev = v
    return total


CATEGORY_RE = re.compile(r"Addition of (?:an?)\s+(.+?)\s+[Rr]ating", re.IGNORECASE)


def parse_multisection(full_text: str) -> list[dict]:
    """Same matching pts_scraper.parse_document() already proved correct,
    split into one dict per detected section instead of bailing on
    duplicate (area, task_letter) keys."""
    caps_count = len(re.findall(r"\bREFERENCES:", full_text))
    mixed_count = len(re.findall(r"\bReferences?:", full_text))
    use_caps = caps_count > mixed_count
    task_re = TASK_RE_CAPS if use_caps else TASK_RE

    body = body_text(full_text, task_re)
    if body is None:
        return []

    # Area-header convention is NOT always the same as the task convention --
    # confirmed on FAA-S-8081-7C: its tasks use mixed-case "Task A: Title" /
    # "Reference: ..." (use_caps=False), but its own real area headers are
    # ALL-CAPS "I. AREA OF OPERATION: FUNDAMENTALS OF INSTRUCTING" -- reusing
    # use_caps for area_re found only 5 stray false-positive matches (bare
    # single-letter "C" etc, same false-positive class pts_scraper.py's
    # body_text() already documents) instead of the real 13 areas.
    #
    # NOT a plain "whichever matches more" choice either -- AREA_RE (mixed)
    # is a strict superset of what AREA_RE_CAPS matches PLUS every stray
    # "C. Some Task Title" false positive (since AREA_RE has no case
    # requirement at all, "AREA OF OPERATION:" headers satisfy it too), so
    # it always has >= count and that heuristic picks the noisier pattern
    # every time. The literal phrase "AREA OF OPERATION:" is deliberate,
    # low-noise, and either present or not -- if the document uses it at
    # all, trust it over the generic bare "I. Title" pattern.
    literal_caps_label = len(re.findall(r"AREA OF OPERATION:", body))
    if literal_caps_label > 0:
        area_matches = list(AREA_RE_CAPS.finditer(body))
    else:
        area_matches = list(AREA_RE.finditer(body))
    task_matches = list(task_re.finditer(body))

    raw_tasks = []
    for i, m in enumerate(task_matches):
        if use_caps:
            letter = m.group(1) or "A"
            title = m.group(2).strip()
            refs = " ".join(m.group(3).split())
            objective = " ".join(m.group(4).split())
        else:
            letter = m.group(1) or m.group(3)
            title = (m.group(2) or m.group(4)).strip()
            refs = " ".join(m.group(5).split())
            objective = " ".join(m.group(6).split())
        pos = m.start()
        area_num, area_title = None, None
        for am in area_matches:
            if am.start() >= pos:
                break
            area_num, area_title = am.group(1), am.group(2).strip().rstrip(",")
        raw_tasks.append({
            "pos": pos,
            "area_number": area_num,
            "area_title": area_title,
            "task_letter": letter,
            "title": title,
            "objective": objective,
            "references_text": refs,
        })

    # Split into sections: a new section starts whenever area resets to "I"
    # (or lower) after we've seen a higher area number in the current one.
    sections: list[list[dict]] = []
    current: list[dict] = []
    max_seen = 0
    for t in raw_tasks:
        if t["area_number"] is None:
            continue
        val = roman_to_int(t["area_number"])
        if val <= 1 and max_seen > 1 and current:
            sections.append(current)
            current = []
            max_seen = 0
        current.append(t)
        max_seen = max(max_seen, val)
    if current:
        sections.append(current)

    out = []
    for si, sec_tasks in enumerate(sections):
        section_start = sec_tasks[0]["pos"]
        # 2000 chars, not a tighter guess -- confirmed against FAA-S-8081-3B
        # the real gap between the "Addition of a Rotorcraft/Helicopter
        # Rating..." marker and that section's first real task is ~1390
        # chars (the applicability table + "PILOT RATING(S) HELD" grid sit
        # between them), and this varies per document.
        lookback = body[max(0, section_start - 2000):section_start]
        cat_match = CATEGORY_RE.search(lookback)
        label = cat_match.group(1).strip() if cat_match else None

        areas_seen = {}
        tasks = []
        for i, t in enumerate(sec_tasks):
            if t["area_number"] not in areas_seen:
                areas_seen[t["area_number"]] = t["area_title"]
            tasks.append({
                "area_number": t["area_number"],
                "task_letter": t["task_letter"],
                "title": t["title"],
                "objective": t["objective"],
                "references_text": t["references_text"],
                "sort_order": i,
            })
        areas = [{"area_number": n, "title": ti, "sort_order": i} for i, (n, ti) in enumerate(areas_seen.items())]
        out.append({
            "section_index": si + 1,
            "label": label,
            "areas": areas,
            "tasks": tasks,
        })
    return out


def extract_pdf_text(path: str) -> str:
    doc = fitz.open(path)
    try:
        text = "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()
    # Confirmed real: FAA-S-8081-17A's checklist-style bullet glyph (a
    # Wingdings-esque symbol with no Unicode mapping) extracts as a literal
    # NUL byte -- Postgres text columns reject NUL outright (400 on the
    # whole upsert batch), and it happened to land inside a real task's
    # objective text (Area VIII Task C's span ran to end-of-section and
    # picked up the next section's front-matter checklist along with it).
    # Stripped globally here rather than only from the one field it was
    # caught in, since the same glyph could land anywhere a task/objective
    # span happens to end near one of these checklists.
    return text.replace("\x00", "")


def _headers(extra: Optional[dict] = None) -> dict:
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
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "code"},
        json=[{"code": doc["code"], "title": doc["title"], "slug": doc["slug"], "doc_type": "pts", "pdf_url": doc["pdf_url"]}],
        timeout=30,
    )
    resp.raise_for_status()


def upsert_areas(doc_code: str, areas: list[dict]) -> None:
    if not areas:
        return
    rows = [{"doc_code": doc_code, **a} for a in areas]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_areas_of_operation",
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,area_number"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def upsert_tasks(doc_code: str, tasks: list[dict]) -> None:
    if not tasks:
        return
    # A document's LAST section has no following section boundary to stop
    # at, so its span runs to end-of-body and can sweep up back-matter that
    # repeats a task letter under the same area (confirmed: FAA-S-8081-3B's
    # section 3 -- Area IX Task C matched twice, "Ground Resonance" then
    # "Systems and Equipment Malfunctions"). PostgREST's own upsert fails
    # outright ("cannot affect row a second time") if a single batch has two
    # rows sharing the same conflict key -- same class of issue
    # acs_scraper.py's upsert_elements already handles; keep first
    # occurrence, drop the rest rather than let the whole section fail.
    seen: set = set()
    rows = []
    for t in tasks:
        key = (t["area_number"], t["task_letter"])
        if key in seen:
            log.warning(f"  duplicate task {key} in {doc_code} -- keeping first occurrence, dropping this one")
            continue
        seen.add(key)
        rows.append({"doc_code": doc_code, **t})
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_tasks",
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,area_number,task_letter"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--pdf", help="Local PDF path (test mode)")
    ap.add_argument("--code", help="Document code (test mode)")
    args = ap.parse_args()

    if args.mode == "test":
        if not args.pdf:
            log.error("--pdf required in test mode")
            sys.exit(1)
        text = extract_pdf_text(args.pdf)
        sections = parse_multisection(text)
        log.info(f"{len(sections)} sections detected")
        for s in sections:
            total_els = sum(1 for _ in s["tasks"])
            log.info(f"  section {s['section_index']}: label={s['label']!r}  areas={len(s['areas'])}  tasks={len(s['tasks'])}")
            if not s["label"]:
                log.warning(f"    ! no category label detected -- would fall back to 'Section {s['section_index']}'")
        return

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        sys.exit(1)

    for doc in MULTISECTION_DOCUMENTS:
        log.info(f"\n=== {doc['code']}: {doc['title']} ===")
        try:
            resp = requests.get(doc["pdf_url"], headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
            resp.raise_for_status()
            tmp_path = f"/tmp/{doc['slug']}.pdf"
            with open(tmp_path, "wb") as f:
                f.write(resp.content)
        except Exception as e:
            log.error(f"  X download failed: {e}")
            continue

        text = extract_pdf_text(tmp_path)
        sections = parse_multisection(text)
        if not sections:
            log.warning(f"  ! zero sections parsed for {doc['code']} -- skipping, needs manual inspection")
            continue

        for s in sections:
            label = s["label"] or f"Section {s['section_index']}"
            sub_code = f"{doc['code']}-{s['section_index']}"
            sub_slug = f"{doc['slug']}-{s['section_index']}"
            sub_title = f"{doc['title']} — {label}"
            log.info(f"  section {s['section_index']}: {sub_code}  \"{sub_title}\"  areas={len(s['areas'])}  tasks={len(s['tasks'])}")
            try:
                upsert_document({"code": sub_code, "title": sub_title, "slug": sub_slug, "pdf_url": doc["pdf_url"]})
                upsert_areas(sub_code, s["areas"])
                upsert_tasks(sub_code, s["tasks"])
            except Exception as e:
                log.error(f"    X upsert failed for {sub_code}: {e}")
        log.info(f"  loaded {len(sections)} section(s).")
        time.sleep(0.5)

    log.info("\nDone.")


if __name__ == "__main__":
    main()
