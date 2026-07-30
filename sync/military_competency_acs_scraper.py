#!/usr/bin/env python3
"""
Military Competency ACS Scraper
=============================================================================
FAA-S-ACS-12 (Commercial Pilot – Military Competence ACS) -- the "small,
20-page, niche document" acs_scraper.py's own docstring named as one of the
3 structurally-different documents deferred from the main pipeline. Test-
parsing it against acs_scraper.py returned 0/0/0, same as the other two.

Real structure confirmed against the actual PDF: same MC.<area>.<task>.K<n>
element-code convention as every other ACS document, but its own labels
have no colon and area/task headers mix BOTH the same-line and next-line
title conventions within one document ("I. \nCommercial Pilot Privileges
and Limitations" next-line, but "III. Accident Reporting" same-line) --
confirmed genuinely knowledge-test-only (0 real Skills sections, the one
"Risk Management" hit in the whole document is an unrelated prose mention,
not a section label) -- only 5 real tasks across 3 areas total, matching
"small, niche."

Modes:
  test    parse the already-downloaded PDF, no DB writes, prints counts
  full    fetches the doc, parses, upserts

Usage:
  python military_competency_acs_scraper.py --mode test --pdf /path/to/mcn_acs.pdf
  python military_competency_acs_scraper.py --mode full

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
import fitz

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("military_competency_acs_scraper")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

DOC = {
    "code": "FAA-S-ACS-12",
    "title": "Commercial Pilot – Military Competence Airman Certification Standards",
    "slug": "commercial-pilot-military-competence",
    "doc_type": "acs",
    "pdf_url": "https://www.faa.gov/training_testing/testing/acs/mcn_acs.pdf",
}

# Permissive on purpose (\s+ matches both a same-line space and a
# next-line break) -- confirmed this single document uses BOTH area-header
# conventions ("I. \nTitle" AND "III. Title" on one line).
AREA_RE = re.compile(r"\b([IVXLC]+)\.\s+([A-Za-z][A-Za-z0-9 ,'/&()-]*?)\n")
TASK_RE = re.compile(
    r"Task\s*\n([A-Z])\.\s+([^\n]+)\nReferences\s*\n(.+?)\nObjective\s*\n(.+?)\nKnowledge\s*\n(.+?)"
    r"\n(?=Task\s*\n[A-Z]\.|\b[IVXLC]+\.\s+[A-Z]|Appendix|\Z)",
    re.DOTALL,
)
ELEMENT_RE = re.compile(
    r"\b(MC\.[IVXLC]+\.[A-Z]\.K\d+[a-z]?)\s+(.+?)"
    r"(?=\nMC\.[IVXLC]+\.[A-Z]\.K\d+[a-z]?\s|\Z)",
    re.DOTALL,
)


def extract_pdf_text(path: str) -> str:
    doc = fitz.open(path)
    try:
        text = "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()
    return text.replace("\x00", "")


def parse_document(full_text: str) -> dict:
    area_matches = list(AREA_RE.finditer(full_text))
    task_matches = list(TASK_RE.finditer(full_text))

    areas_seen: dict = {}
    tasks = []
    elements = []
    for i, tm in enumerate(task_matches):
        letter = tm.group(1)
        title = " ".join(tm.group(2).split())
        refs = " ".join(tm.group(3).split())
        objective = " ".join(tm.group(4).split())
        knowledge_blob = tm.group(5)

        pos = tm.start()
        area_num, area_title = None, None
        for am in area_matches:
            if am.start() >= pos:
                break
            area_num, area_title = am.group(1), am.group(2).strip()
        if area_num is not None and area_num not in areas_seen:
            areas_seen[area_num] = area_title

        tasks.append({
            "area_number": area_num, "task_letter": letter, "title": title,
            "objective": objective, "references_text": refs, "sort_order": i,
        })

        for code, body in ELEMENT_RE.findall(knowledge_blob):
            clean_body = " ".join(body.split())
            # A bled-in page-footer number lands on whichever element
            # happens to be last on a page (confirmed: "...privileges. 4",
            # "...rules. 5") -- stripped as a trailing bare 1-3 digit number.
            clean_body = re.sub(r"\s+\d{1,3}$", "", clean_body)
            elements.append({
                "area_number": area_num, "task_letter": letter, "element_code": code,
                "element_type": "knowledge", "body_text": clean_body,
            })

    areas = [{"area_number": n, "title": t, "sort_order": i} for i, (n, t) in enumerate(areas_seen.items())]
    return {"areas": areas, "tasks": tasks, "elements": elements}


def _headers(extra=None) -> dict:
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def upsert_document(doc: dict) -> None:
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_documents",
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "code"},
        json=[{"code": doc["code"], "title": doc["title"], "slug": doc["slug"], "doc_type": doc["doc_type"], "pdf_url": doc["pdf_url"]}],
        timeout=30,
    )
    resp.raise_for_status()


def upsert_areas(doc_code: str, areas: list) -> None:
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


def upsert_tasks(doc_code: str, tasks: list) -> dict:
    rows = [{"doc_code": doc_code, **t} for t in tasks]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_tasks",
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=representation"}),
        params={"on_conflict": "doc_code,area_number,task_letter"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()
    return {(r["area_number"], r["task_letter"]): r["id"] for r in resp.json()}


def upsert_elements(doc_code: str, elements: list, task_id_map: dict) -> None:
    rows = []
    seen = set()
    for e in elements:
        task_id = task_id_map.get((e["area_number"], e["task_letter"]))
        if not task_id:
            continue
        if e["element_code"] in seen:
            continue
        seen.add(e["element_code"])
        rows.append({
            "doc_code": doc_code, "task_id": task_id, "element_code": e["element_code"],
            "element_type": e["element_type"], "body_text": e["body_text"], "sort_order": len(rows),
        })
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_elements",
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,element_code"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--pdf", help="Local PDF path (test mode)")
    args = ap.parse_args()

    if args.mode == "test":
        if not args.pdf:
            log.error("--pdf required in test mode")
            sys.exit(1)
        parsed = parse_document(extract_pdf_text(args.pdf))
        log.info(f"Areas: {len(parsed['areas'])}")
        log.info(f"Tasks: {len(parsed['tasks'])}")
        log.info(f"Elements: {len(parsed['elements'])}")
        for a in parsed["areas"]:
            log.info(f"  {a['area_number']}: {a['title']}")
        return

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        sys.exit(1)

    resp = requests.get(DOC["pdf_url"], headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
    resp.raise_for_status()
    tmp_path = f"/tmp/{DOC['slug']}.pdf"
    with open(tmp_path, "wb") as f:
        f.write(resp.content)

    parsed = parse_document(extract_pdf_text(tmp_path))
    log.info(f"parsed: {len(parsed['areas'])} areas, {len(parsed['tasks'])} tasks, {len(parsed['elements'])} elements")

    upsert_document(DOC)
    upsert_areas(DOC["code"], parsed["areas"])
    task_id_map = upsert_tasks(DOC["code"], parsed["tasks"])
    upsert_elements(DOC["code"], parsed["elements"], task_id_map)
    log.info("loaded.")


if __name__ == "__main__":
    main()
