#!/usr/bin/env python3
"""ACS/PTS reference-text -> structured citation extractor.

references_text on acs_tasks is real FAA-authored text like
"14 CFR parts 1, 61, 91, 95, 97; 49 CFR part 830; AIM; FAA-H-8083-2, ..."
-- confirmed via a full-corpus regex-coverage check (2026-08-11) that every
segment is one of: a 14 CFR part list, an AC number list, a bare "AIM"
mention, an FAA handbook code, or a non-regulatory publication (Chart
Supplements, POH/AFM, NOTAMs, Flight Manual) -- no LLM needed, this is a
pure parse.

Deliberately scoped to FAR/AC/AIM only (the three types this app has a
knowledge-level taxonomy for) -- handbook/chart-supplement/POH mentions are
real but don't map onto FlyRegs' own corpus, so they're not extracted.

FAR "14 CFR parts 1, 61, 91" cites a whole PART, not a specific section
(ACS documents are written at that granularity) -- so cited_id for 'far' is
a bare part number, not a section number. The consuming weight function
(far_relevance_weight, see migrations_relevance_weighting.sql) looks up by
part for exactly this reason.

Usage:
  python3 sync/acs_reference_extract.py --dry-run
  python3 sync/acs_reference_extract.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"
env = {}
with open(f"{BASE}/.env.scraper") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
SUPABASE_URL = env["SUPABASE_URL"]
SUPABASE_KEY = env["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

FAR_PARTS_RE = re.compile(r"14\s*CFR\s*part(?:s)?\s*([\d,\s&andPARTS]+?)(?=;|$)", re.I)
AC_RE = re.compile(r"\bAC\s+(\d+(?:/\d+)?(?:\.\d+)?[\-‐‑–]\d+[A-Za-z0-9]*)", re.I)
# The FAA also spells this out in full ("Advisory Circular No. 120-12A",
# "Advisory Circular 20-420") instead of abbreviating to "AC" -- confirmed
# live and corpus-wide (RC, real content-correction report): 36 LOIs alone
# use this phrasing with zero overlap with AC_RE, a real silent hole shared
# by every extractor built on this same AC_RE pattern (fixed together in
# ad/ac/aim/cfr49/far/loi/pcg/acs). Matches are whitespace-stripped below
# before use -- the source carries the same stray-space artifacts this
# corpus is already known for.
AC_RE_SPELLED = re.compile(r"\bAdvisory\s+Circular\s+(?:No\.?\s*)?(\d+(?:/\d+)?(?:\.\d+)?\s*[\-‐‑–]\s*\d+[A-Za-z0-9]*(?:\s*[\-‐‑–]\s*\d+)?)\b", re.IGNORECASE)
AIM_RE = re.compile(r"^\s*AIM\s*$", re.I)
_HYPHEN_VARIANTS_RE = re.compile("[‐‑–]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)


def fetch_all_tasks() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/acs_tasks"
            f"?select=doc_code,area_number,task_letter,references_text"
            f"&references_text=not.is.null&limit=1000&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def extract_citations(task: dict) -> list[dict]:
    text = task.get("references_text") or ""
    citations = []
    seen = set()

    def add(cited_type: str, cited_id: str):
        key = (cited_type, cited_id)
        if key not in seen:
            seen.add(key)
            citations.append({
                "doc_code": task["doc_code"], "area_number": task["area_number"],
                "task_letter": task["task_letter"], "cited_type": cited_type, "cited_id": cited_id,
            })

    for m in FAR_PARTS_RE.finditer(text):
        for part in re.findall(r"\d+", m.group(1)):
            add("far", part)

    for m in AC_RE.finditer(text):
        add("ac", _normalize_hyphens(m.group(1)))

    for m in AC_RE_SPELLED.finditer(text):
        add("ac", _normalize_hyphens(re.sub(r"\s+", "", m.group(1))))

    for seg in text.split(";"):
        if AIM_RE.match(seg.strip()):
            add("aim", "AIM")

    return citations


def delete_all() -> None:
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/acs_task_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"id": "not.is.null"},
        timeout=30,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    if not rows:
        return
    for i in range(0, len(rows), 500):
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/acs_task_citations",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=rows[i:i + 500], timeout=30,
        )
        resp.raise_for_status()


def refresh_materialized_view() -> None:
    import json as _json
    mgmt_env = {}
    with open(f"{BASE}/.env.supabase-mgmt") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            mgmt_env[k] = v
    resp = requests.post(
        f"https://api.supabase.com/v1/projects/{mgmt_env['SUPABASE_PROJECT_REF']}/database/query",
        headers={"Authorization": f"Bearer {mgmt_env['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        json={"query": "refresh materialized view public.acs_citation_density;"},
        timeout=60,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tasks = fetch_all_tasks()
    log.info(f"Scanning {len(tasks)} ACS/PTS tasks with references_text...")

    all_citations = []
    for t in tasks:
        all_citations.extend(extract_citations(t))

    by_type: dict[str, int] = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(f"Extracted {len(all_citations)} citations: {by_type}")

    if args.dry_run:
        log.info("Dry run -- no writes made.")
        for c in all_citations[:25]:
            log.info(f"  {c['doc_code']} {c['area_number']}.{c['task_letter']} -> {c['cited_type'].upper()} {c['cited_id']}")
        return

    delete_all()
    insert_citations(all_citations)
    refresh_materialized_view()
    log.info(f"Done. Wrote {len(all_citations)} citation rows, refreshed acs_citation_density.")


if __name__ == "__main__":
    main()
