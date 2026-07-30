#!/usr/bin/env python3
"""
ACS/PTS (Airman Certification Standards / Practical Test Standards) Scraper
=============================================================================
Fetches FAA ACS/PTS PDFs (37 total: 19 ACS + 18 PTS, all public domain,
incorporated by reference into 14 CFR part 61) and parses the real
hierarchical structure: Area of Operation > Task > Objective/References +
Knowledge/Risk Management/Skill elements. Feeds Ref Packets.

Source PDFs, confirmed live 2026-07-25:
  ACS list: https://www.faa.gov/training_testing/testing/acs
  PTS list: https://www.faa.gov/training_testing/testing/test_standards

Parsing approach (proven against the real Private Pilot ACS, FAA-S-ACS-6C):
  pypdf text extraction has two known, consistent quirks in these PDFs:
    1. A "drop cap" rendering bug: the label's first letter gets extracted
       AFTER the rest of the word, e.g. "eferences: R " instead of
       "References: ". Fixed with literal string replacement before any
       regex runs (see FIX_DROPCAPS below) -- confirmed only affects
       References/Objective/Note labels, not Knowledge/Risk Management/
       Skills (those extract in the correct order already).
    2. Bare "Task X. Title" text appears three times per real task (once in
       the front-matter Table of Contents with a dot-leader + page number,
       once as the real section header, and sometimes again in a rear
       Special Emphasis appendix) -- matching on that text alone
       over-counts. Anchoring on "Task X. Title\nReferences: ...\n
       Objective: " instead is reliable: References/Objective each appear
       EXACTLY once per real task in the doc body (confirmed: 61/61 for the
       Private Pilot ACS, matching the independently-counted References
       occurrences).

Modes:
  test    fetch + parse one already-downloaded PDF, no DB writes, prints
          counts (areas/tasks/elements) for manual sanity-checking
  full    fetches every doc from ACS_DOCUMENTS below, parses, upserts

Usage:
  python acs_scraper.py --mode test --pdf /path/to/downloaded.pdf --code FAA-S-ACS-6C
  python acs_scraper.py --mode full

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
import fitz  # PyMuPDF -- NOT pypdf: confirmed pypdf has a genuine
             # font-decoding bug on at least one real document (Sport Pilot
             # Helicopter ACS), silently substituting individual letters
             # (e.g. "Hover" extracted as "HovRe" -- e/j/v map to wrong
             # glyphs throughout that one PDF's specific embedded font).
             # PyMuPDF extracts the same document correctly. The unrelated
             # "drop cap" quirk (a label's first letter extracted out of
             # order, e.g. "eferences: R ") is a real PDF structure/draw-order
             # issue present in BOTH libraries -- FIX_DROPCAPS below still
             # applies regardless of extractor.

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("acs_scraper")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# First representative document proven against real content. Extending this
# list to the remaining 36 is the known next step (same parser, each needs
# its own PDF URL from the two FAA list pages and a spot-check of its
# element-count sanity, since PTS documents in particular are older and may
# not follow the exact same Knowledge/Risk Management/Skills layout ACS
# does -- confirm before trusting silently).
def _acs(code, title, slug, filename, prefix):
    return {
        "code": code, "title": title, "slug": slug, "doc_type": "acs",
        "pdf_url": f"https://www.faa.gov/training_testing/testing/acs/{filename}",
        "prefix": prefix,
    }


ACS_DOCUMENTS = [
    _acs("FAA-S-ACS-6C", "Private Pilot for Airplane Category ACS", "private-pilot-airplane", "private_airplane_acs_6.pdf", "PA"),
    _acs("FAA-S-ACS-13", "Private Pilot for Powered-Lift Category ACS", "private-pilot-powered-lift", "private_pl_acs_13.pdf", "PL"),
    _acs("FAA-S-ACS-15", "Private Pilot for Rotorcraft Category Helicopter Rating ACS", "private-pilot-helicopter", "private_helicopter_acs_15.pdf", "PH"),
    _acs("FAA-S-ACS-7B", "Commercial Pilot for Airplane Category ACS", "commercial-pilot-airplane", "commercial_airplane_acs_7.pdf", "CA"),
    _acs("FAA-S-ACS-2", "Commercial Pilot for Powered-Lift Category ACS", "commercial-pilot-powered-lift", "commercial_pl_acs_2.pdf", "CP"),
    _acs("FAA-S-ACS-16", "Commercial Pilot for Rotorcraft Category Helicopter Rating ACS", "commercial-pilot-helicopter", "commercial_helicopter_acs_16.pdf", "CH"),
    _acs("FAA-S-ACS-8C", "Instrument Rating - Airplane ACS", "instrument-rating-airplane", "instrument_rating_airplane_acs_8.pdf", "IR"),
    _acs("FAA-S-ACS-3", "Instrument Rating - Powered-Lift ACS", "instrument-rating-powered-lift", "instrument_pl_acs_3.pdf", "IP"),
    _acs("FAA-S-ACS-14", "Instrument Rating - Helicopter ACS", "instrument-rating-helicopter", "instrument_helicopter_acs_14.pdf", "IH"),
    # CFI-family prefixes are NOT "FI" as filenames/titles would suggest --
    # confirmed via full-document scan: "FI" appears ~145-148 times in each
    # (a shared "Additional Rating Task Table" appendix common across the
    # Flight Instructor family, using FI as a generic placeholder example),
    # while each document's own real element codes use a document-specific
    # prefix at 5-10x that frequency. Scanning only the first ~15 pages
    # during initial auto-detection picked the wrong (placeholder) one for
    # all five of these -- fixed by re-scanning full document text.
    _acs("FAA-S-ACS-25", "Flight Instructor for Airplane Category ACS", "cfi-airplane", "cfi_airplane_acs_25.pdf", "AI"),
    _acs("FAA-S-ACS-27", "Flight Instructor for Powered-Lift Category ACS", "cfi-powered-lift", "cfi_pl_acs_27.pdf", "IL"),
    _acs("FAA-S-ACS-29", "Flight Instructor for Rotorcraft Category Helicopter Rating ACS", "cfi-helicopter", "cfi_helicopter_acs_29.pdf", "HI"),
    _acs("FAA-S-ACS-28", "Flight Instructor - Instrument Rating Powered-Lift ACS", "cfii-powered-lift", "cfii_pl_acs_28.pdf", "PI"),
    _acs("FAA-S-ACS-11A", "Airline Transport Pilot and Type Rating for Airplane Category ACS", "atp-airplane", "atp_airplane_acs_11.pdf", "AA"),
    _acs("FAA-S-ACS-17", "Airline Transport Pilot and Type Rating for Powered-Lift Category ACS", "atp-powered-lift", "atp_pl_acs_17.pdf", "AP"),
    _acs("FAA-S-ACS-26", "Sport Pilot for Helicopter - Simplified Flight Controls ACS", "sport-pilot-helicopter", "Sport_Pilot-Helicopter_SFC_ACS.pdf", "SH"),
    _acs("FAA-S-ACS-31", "Sport Flight Instructor for Helicopter - Simplified Flight Controls ACS", "sport-cfi-helicopter", "Sport_Pilot_CFI_Helicopter_SFC_ACS-31.pdf", "FH"),
]

# Structurally different documents, handled separately rather than forced
# through this same pipeline: Aviation Mechanic ACS (FAA-S-ACS-1, combined
# Airframe/Powerplant, likely a different section layout given it covers
# multiple ratings in one document), the Military Competency ACS (small,
# 20-page, niche), and the Part 107/UAS ACS (FAA-S-ACS-10B -- Part 107 is a
# WRITTEN-TEST-ONLY certificate with no practical/skill component, so it
# almost certainly has no "Skills:" sections at all and may not use the
# Area of Operation/Task structure the same way). Confirm each one's real
# structure before reusing this parser rather than assuming it fits.

# Two DIFFERENT manifestations of the same underlying PDF issue (a drop-cap
# character's draw position not matching normal reading order), confirmed
# across documents and across BOTH pypdf and PyMuPDF -- it's a property of
# how these specific PDFs are constructed, not an extractor bug:
#   1. Missing-then-appended: "eferences: R " (the label's first letter is
#      missing, then reappears right after the colon+space).
#   2. Correctly-spelled-but-duplicated: "References:\nR\n" (the label
#      extracts fine, but the same drop-cap letter ALSO appears again alone
#      on its own following line).
# Regex (not literal string replacement) for both, since the exact
# whitespace varies per document (confirmed: one space in some documents,
# two in others, a bare newline in Sport Pilot Helicopter specifically) --
# a literal match silently failed for several documents (0 References
# matches, meaning every task in the doc was invisible to TASK_RE).
FIX_DROPCAPS = [
    (re.compile(r"eferences:\s+R\s+"), "References: "),
    (re.compile(r"bjective:\s+O\s+"), "Objective: "),
    (re.compile(r"ote:\s+N\s+"), "Note: "),
    (re.compile(r"References:\s*\n?R\s*\n"), "References: "),
    (re.compile(r"Objective:\s*\n?O\s*\n"), "Objective: "),
    (re.compile(r"Note:\s*\n?N\s*\n"), "Note: "),
    # A stray drop-cap letter can ALSO land glued directly onto the front of
    # the (correctly-spelled) label with no separator at all -- confirmed:
    # "Task A. Pilot Qualifications\nRReferences: ..." (Sport Pilot
    # Helicopter ACS). Lookahead-anchored to the exact label that follows,
    # so this can't accidentally eat a real word ending in R/O/N elsewhere.
    (re.compile(r"\bR(?=References:)"), ""),
    (re.compile(r"\bO(?=Objective:)"), ""),
    (re.compile(r"\bN(?=Note:)"), ""),
]

# Confirmed real bug: Area III in the Instrument Rating - Airplane ACS is
# titled "Air Traffic Control (ATC) Clearances and Procedures" -- the
# original character class had no parentheses, so this ENTIRE area header
# silently failed to match (not partially -- the whole area disappeared
# from AREA_RE's results), and every task after it got mis-attributed to
# whichever area DID match last (Area II), corrupting area_number for real
# tasks. Caught via a duplicate (area_number, task_letter) key rejected by
# the DB's own unique constraint -- not something a naive count-only sanity
# check would have caught, since total area/task/element counts still
# looked plausible.
AREA_RE = re.compile(r"Area of Operation ([IVXLC]+)\.\s+([A-Za-z0-9 ,'/&()-]+?)\s*\n")
# Anchors a real task on Objective/References both being present immediately
# after the header -- see module docstring for why bare "Task X." matching
# over-counts (TOC + appendix duplicates). Title is deliberately NOT DOTALL
# ([^\n]+ instead of .+?) so it can only ever span to the very next newline
# -- a DOTALL lazy quantifier here will silently swallow everything between
# a false match (the Table of Contents' "Task A." line, which has no
# References immediately after it) and the real header much further into
# the document, producing a "title" that's actually the entire TOC +
# Appendix + Introduction text. Confirmed this was happening: the fix is
# forcing the title to end at its own line, which also makes a TOC entry
# correctly FAIL to match at all (its next line is another TOC entry, not
# "References:"), so the regex engine moves on to the real header instead.
TASK_RE = re.compile(
    r"Task ([A-Z])\.\s+([^\n]+(?:\n[^\n]+)?)\nReferences: (.+?)\nObjective: (.+?)\n(?=Knowledge:|Risk\s*\nManagement:|Skills:)",
    re.DOTALL,
)
# Stops at the next element code, the next boilerplate section label
# (Knowledge:/Risk Management:/Skills:/Note:), a new Task, or end of span --
# without the section-label stop, an element's body_text bleeds into the
# next section's lead-in sentence (e.g. "...limitations. Risk Management:
# The applicant is able to...").
ELEMENT_RE = re.compile(
    r"\b([A-Z]{2}\.[IVXLC]+\.[A-Z]\.[KRS]\d+[a-z]?)\s+(.+?)"
    r"(?=\n[A-Z]{2}\.[IVXLC]+\.[A-Z]\.[KRS]\d+[a-z]?\s|\nTask [A-Z]\.|Knowledge:|Risk\s*\nManagement:|Skills:|Note:|\Z)",
    re.DOTALL,
)


def clean_text(t: str, running_header: Optional[str] = None) -> str:
    for pattern, good in FIX_DROPCAPS:
        t = pattern.sub(good, t)
    if running_header:
        # Every page repeats "<Document Title> (<CODE>)\n<page number>\n" as
        # a running header -- confirmed via direct page dumps. Left in, it
        # bleeds into whatever element's body_text happens to end right at
        # a page break. Stripped globally here rather than only from
        # individual element bodies after the fact, since the same bleed
        # risk applies to any field (title/objective/references) that could
        # land on a page boundary, not just elements.
        t = re.sub(re.escape(running_header) + r"\s*\d*\s*", "", t)
    return t


def extract_pdf_text(path: str) -> str:
    doc = fitz.open(path)
    try:
        return "\n".join(page.get_text() for page in doc)
    finally:
        doc.close()


def parse_document(full_text: str, prefix: str, running_header: Optional[str] = None) -> dict:
    full_text = clean_text(full_text, running_header)

    # De-dupe Areas of Operation (the header repeats as a running header on
    # every page within that section) -- keep first-seen order.
    areas_seen = {}
    for num, title in AREA_RE.findall(full_text):
        title = title.strip().rstrip(",")
        if num not in areas_seen:
            areas_seen[num] = title
    areas = [{"area_number": n, "title": t, "sort_order": i} for i, (n, t) in enumerate(areas_seen.items())]

    # Tasks, anchored on Objective/References (see module docstring).
    tasks = []
    task_matches = list(TASK_RE.finditer(full_text))
    for i, m in enumerate(task_matches):
        letter, title, refs, objective = m.groups()
        title = " ".join(title.split())  # collapse whitespace/line-wraps
        refs = " ".join(refs.split())
        objective = " ".join(objective.split())
        # Which Area of Operation this task belongs to: the nearest
        # "Area of Operation N." heading appearing before this task's own
        # position in the document.
        pos = m.start()
        area_num = None
        for am in AREA_RE.finditer(full_text[:pos]):
            area_num = am.group(1)
        tasks.append({
            "area_number": area_num,
            "task_letter": letter,
            "title": title,
            "objective": objective,
            "references_text": refs,
            "sort_order": i,
            "_span_start": m.end(),
            "_span_end": task_matches[i + 1].start() if i + 1 < len(task_matches) else len(full_text),
        })

    # Elements: scoped to each task's own text span so a K1 in Task A can
    # never bleed into Task B's element list even if the regex over-matches.
    elements = []
    type_map = {"K": "knowledge", "R": "risk_management", "S": "skill"}
    for t in tasks:
        span = full_text[t["_span_start"]:t["_span_end"]]
        for code, body in ELEMENT_RE.findall(span):
            code_prefix = code.split(".")[0]
            # "FI." is real, not the placeholder-appendix "FI" text noted
            # above -- confirmed against the actual PDF: Area I (Fundamentals
            # of Instructing) in EVERY Flight Instructor-family ACS document
            # (25/27/28/29/31) uses this literal shared prefix for its own
            # real element codes ("FI.I.A.K1"), never each document's own
            # prefix (AI/IL/PI/HI/FH), because FOI content is common across
            # all CFI certificates. The strict single-prefix filter silently
            # discarded all 6 of Area I's tasks in all 5 of these documents
            # (30 tasks, confirmed live -- Ref Packets showed an empty
            # Knowledge/Risk/Skills section for every one of them).
            if code_prefix != prefix and code_prefix != "FI":
                continue
            kind = type_map.get(code.split(".")[-1][0], "unknown")
            elements.append({
                "area_number": t["area_number"],
                "task_letter": t["task_letter"],
                "element_code": code,
                "element_type": kind,
                "body_text": " ".join(body.split()),
            })

    for t in tasks:
        del t["_span_start"], t["_span_end"]

    return {"areas": areas, "tasks": tasks, "elements": elements}


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
    rows = [{"doc_code": doc_code, **a} for a in areas]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_areas_of_operation",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,area_number"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def upsert_tasks(doc_code: str, tasks: list[dict]) -> dict:
    """Returns {(area_number, task_letter): task_id} for element linking."""
    rows = [{"doc_code": doc_code, **t} for t in tasks]
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_tasks",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=representation"}),
        params={"on_conflict": "doc_code,area_number,task_letter"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()
    return {(r["area_number"], r["task_letter"]): r["id"] for r in resp.json()}


def upsert_elements(doc_code: str, elements: list[dict], task_id_map: dict) -> None:
    rows = []
    seen_codes: set[str] = set()
    for e in elements:
        task_id = task_id_map.get((e["area_number"], e["task_letter"]))
        if not task_id:
            log.warning(f"  no task_id for element {e['element_code']}, skipping")
            continue
        # PostgREST's upsert fails outright if the SAME batch has two rows
        # with the same conflict key ("cannot affect row a second time") --
        # confirmed cause: an unlabeled inline aside re-mentioning an
        # element code (e.g. "an evaluator who chooses PA.I.H.K1 may
        # select...") matches ELEMENT_RE a second time. The document's own
        # first, in-context occurrence is always the real definition;
        # anything after that for the same code is the aside, not a second
        # definition -- keep first, drop the rest.
        if e["element_code"] in seen_codes:
            log.warning(f"  duplicate element_code {e['element_code']} -- keeping first occurrence, dropping this one")
            continue
        seen_codes.add(e["element_code"])
        rows.append({
            "doc_code": doc_code,
            "task_id": task_id,
            "element_code": e["element_code"],
            "element_type": e["element_type"],
            "body_text": e["body_text"],
            "sort_order": len(rows),
        })
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/acs_elements",
        headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        params={"on_conflict": "doc_code,element_code"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--pdf", help="Local PDF path (test mode)")
    ap.add_argument("--code", help="Document code (test mode)", default="FAA-S-ACS-6C")
    args = ap.parse_args()

    if args.mode == "test":
        if not args.pdf:
            log.error("--pdf required in test mode")
            sys.exit(1)
        doc = next((d for d in ACS_DOCUMENTS if d["code"] == args.code), ACS_DOCUMENTS[0])
        text = extract_pdf_text(args.pdf)
        running_header = f"{doc['title']} ({doc['code']})"
        parsed = parse_document(text, doc["prefix"], running_header)
        log.info(f"Areas: {len(parsed['areas'])}")
        log.info(f"Tasks: {len(parsed['tasks'])}")
        log.info(f"Elements: {len(parsed['elements'])}")
        by_type = {}
        for e in parsed["elements"]:
            by_type[e["element_type"]] = by_type.get(e["element_type"], 0) + 1
        log.info(f"  by type: {by_type}")
        # Sanity flag, not a hard failure -- a handful of documents have
        # unlabeled explanatory asides inline (confirmed once: a "for
        # example..." aside after PA.I.H.K1's sub-elements, with no Note:
        # label to anchor on) that can bleed into the preceding element's
        # body_text. Real elements are almost always under ~300 chars: flag
        # outliers for manual review rather than silently trusting them.
        long_ones = [e for e in parsed["elements"] if len(e["body_text"]) > 400]
        if long_ones:
            log.warning(f"  {len(long_ones)} element(s) over 400 chars -- review before trusting:")
            for e in long_ones:
                log.warning(f"    {e['element_code']}: {e['body_text'][:80]}...")
        return

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY required for full mode")
        sys.exit(1)

    for doc in ACS_DOCUMENTS:
        log.info(f"=== {doc['code']}: {doc['title']} ===")
        resp = requests.get(doc["pdf_url"], headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
        resp.raise_for_status()
        tmp_path = f"/tmp/{doc['code']}.pdf"
        with open(tmp_path, "wb") as f:
            f.write(resp.content)

        text = extract_pdf_text(tmp_path)
        running_header = f"{doc['title']} ({doc['code']})"
        parsed = parse_document(text, doc["prefix"], running_header)
        log.info(f"  parsed: {len(parsed['areas'])} areas, {len(parsed['tasks'])} tasks, {len(parsed['elements'])} elements")
        long_ones = [e for e in parsed["elements"] if len(e["body_text"]) > 400]
        if long_ones:
            log.warning(f"  {len(long_ones)} element(s) over 400 chars -- flagged for review, loaded anyway: {[e['element_code'] for e in long_ones]}")

        upsert_document(doc)
        upsert_areas(doc["code"], parsed["areas"])
        task_id_map = upsert_tasks(doc["code"], [
            {k: v for k, v in t.items() if not k.startswith("_")} for t in parsed["tasks"]
        ])
        upsert_elements(doc["code"], parsed["elements"], task_id_map)
        log.info(f"  loaded.")
        time.sleep(1)


if __name__ == "__main__":
    main()
