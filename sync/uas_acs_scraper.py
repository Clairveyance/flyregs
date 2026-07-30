#!/usr/bin/env python3
"""
UAS/Part 107 ACS Scraper
=============================================================================
FAA-S-ACS-10B (Remote Pilot -- Small Unmanned Aircraft Systems ACS) is one
of the 3 documents acs_scraper.py's own docstring flagged as "structurally
different" and deferred. Test-parsing it against acs_scraper.py returned
0 areas/0 tasks -- confirmed why: this document uses the same underlying
Knowledge/Risk Management/Skill element-code taxonomy and "UA.<area>.<task>.
<K|R|S><n>" code format as every other ACS doc, but its own section labels
have no trailing colon and each sits alone on its own line ("References",
not "References:"; area headers are bare "I. Regulations", never "Area of
Operation:"). That's a distinct enough convention to need its own regexes,
not a variant of the existing ones.

Confirmed real and worth building for: Part 107 is a knowledge-test-only
certificate (no practical/skill component), and every single task's Risk
Management and Skills sections read literally "[Reserved]" / "[Not
Applicable]" -- verified across all 17 real tasks, not a sampling. This
script deliberately only extracts Knowledge elements; Risk Management and
Skills are skipped rather than stored as fake placeholder rows.

Modes:
  test    parse the already-downloaded PDF, no DB writes, prints counts
  full    fetches the doc, parses, upserts

Usage:
  python uas_acs_scraper.py --mode test --pdf /path/to/uas_acs.pdf
  python uas_acs_scraper.py --mode full

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

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("uas_acs_scraper")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

DOC = {
    "code": "FAA-S-ACS-10B",
    "title": "Remote Pilot – Small Unmanned Aircraft Systems (sUAS) Airman Certification Standards",
    "slug": "remote-pilot-uas",
    "doc_type": "acs",
    "pdf_url": "https://www.faa.gov/training_testing/testing/acs/uas_acs.pdf",
    "prefix": "UA",
}

AREA_RE = re.compile(r"\b([IVXLC]+)\.\s+([A-Za-z][A-Za-z0-9 ,'/&()-]*?)\n")
TASK_RE = re.compile(
    r"Task ([A-Z])\.\s+([^\n]+)\nReferences\s*\n(.+?)\nObjective\s*\n(.+?)\nKnowledge\s*\n(.+?)\n(?=Risk Management|\Z)",
    re.DOTALL,
)
# Same element-code shape every other ACS document uses -- confirmed live
# ("UA.I.A.K1" matches this exactly), reused verbatim rather than
# reinvented. Stops at the next element code or end of the task's own
# knowledge blob (already sliced to end right before "Risk Management").
ELEMENT_RE = re.compile(
    r"\b(UA\.[IVXLC]+\.[A-Z]\.K\d+[a-z]?)\s+(.+?)"
    r"(?=\nUA\.[IVXLC]+\.[A-Z]\.K\d+[a-z]?\s|\Z)",
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
            "area_number": area_num,
            "task_letter": letter,
            "title": title,
            "objective": objective,
            "references_text": refs,
            "sort_order": i,
        })

        for code, body in ELEMENT_RE.findall(knowledge_blob):
            elements.append({
                "area_number": area_num,
                "task_letter": letter,
                "element_code": code,
                "element_type": "knowledge",
                "body_text": " ".join(body.split()),
            })

    areas = [{"area_number": n, "title": t, "sort_order": i} for i, (n, t) in enumerate(areas_seen.items())]
    return {"areas": areas, "tasks": tasks, "elements": elements}


def _headers(extra: Optional[dict] = None) -> dict:
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
            log.warning(f"  duplicate element_code {e['element_code']} -- keeping first occurrence")
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
