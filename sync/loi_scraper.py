#!/usr/bin/env python3
"""
LOI (Legal Interpretations) Scraper
=====================================
Sources every FAA Chief Counsel Legal Interpretation from the Dynamic
Regulatory System (DRS, drs.faa.gov) — the FAA's own home for these since
the old .../interpretations page's static file listing was retired.
Pipeline validated live 2026-07-29 via a real DevTools capture session
(see PROJECT_NOTES/flyregs_loi_build_spec.md for the full research
writeup and the reasoning behind every design choice below).

Two DRS endpoints, both confirmed working with ONLY `jwt`+`user` headers
(no cookies needed for either). (Earlier versions of this scraper used a
THIRD endpoint, `simpleSearch` -- abandoned 2026-07-29 after discovering
its pagination hard-caps around offset ~40-65 regardless of auth level;
see PROJECT_NOTES/flyregs_loi_build_spec.md §1b for the full story.)

  1. POST /api/browse/doctype/LEGAL_INTERPRETATIONS/documents/metadatas
     Body: {"page": "N"}, N zero-indexed, 25 results/page. Returns
     `documentListTotalCount` (the real, current corpus size -- 1,055 as
     of this build, re-read live each run, never hardcoded) and a
     `documentList[]` where each item ALREADY includes both `docUniqueId`
     and the file-handle `id` (UUID, required for step 2) plus every
     metadata field needed (title, CFR Part/Section Reference, Document
     Issue Date/Year) in a flat `subText` array of
     {metadataName, metadataValue} pairs. This single endpoint replaces
     both the old search call AND the old per-document metadata call.

  2. GET /api/content/alf/{id}
     The actual PDF binary. Full download with no Range header needed —
     confirmed live: returns the complete file matching len(pdf_bytes).

WHY THE PDF GETS RE-UPLOADED TO OUR OWN STORAGE (not just linked)
-------------------------------------------------------------------
DRS's PDF endpoint requires the jwt/user auth headers this scraper uses.
A real user's device can't load that URL directly — and baking a
scraper's session token into the client app would be both wrong (a
backend secret shipped to every device) and fragile (the token expires
in ~12h). So every PDF gets cached into our own public Storage bucket,
exactly like advisory_circulars.pdf_url_cached already does for ACs.

THE JWT IS A SHORT-LIVED GUEST TOKEN — OPERATIONAL DEPENDENCY
-------------------------------------------------------------------
Observed ~12 hour validity (iat/exp). No anonymous way to mint a fresh
one was found (a handful of plausible /api/drs/auth/* guesses all
403'd) — refreshing it requires a human to load drs.faa.gov once and
capture a new token from DevTools Network (see the build spec for the
exact steps). This script FAILS LOUDLY (not silently) when the token
has expired, rather than producing a quietly-empty or partial run.

Modes:
  test    first N search results only, no DB/Storage writes
  full    the whole corpus (or --touched-file-scoped incremental, once
          that mode is added) — upserts legal_interpretations, uploads
          PDFs to the 'legal-interpretations' Storage bucket

Usage:
  python3 loi_scraper.py --mode test --limit 5
  python3 loi_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, DRS_JWT, DRS_USER
"""
from __future__ import annotations

import argparse
import io
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone

import fitz  # PyMuPDF
import requests

sys.path.insert(0, os.path.dirname(__file__))
from loi_citation_extract import extract_far_citations

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
DRS_JWT = os.environ.get("DRS_JWT", "")
DRS_USER = os.environ.get("DRS_USER", "E")

DRS_BASE = "https://drs.faa.gov"
STORAGE_BUCKET = "legal-interpretations"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": UA,
    "Referer": f"{DRS_BASE}/browse/LEGAL_INTERPRETATIONS/doctypeDetails",
    "jwt": DRS_JWT,
    "user": DRS_USER,
})


class DrsAuthExpired(RuntimeError):
    """Raised when DRS rejects the current jwt -- see this module's own
    header comment for why there's no automatic recovery from this."""


def _check_auth_response(resp: requests.Response, context: str) -> None:
    if resp.status_code in (401, 403):
        raise DrsAuthExpired(
            f"DRS rejected the request ({resp.status_code}) during {context}. "
            "The DRS_JWT guest token has almost certainly expired (~12h lifetime). "
            "Re-capture a fresh token: open https://drs.faa.gov/search in a browser, "
            "run a search, open DevTools > Network > XHR, find any drs.faa.gov "
            "request, and copy its 'jwt' request header into DRS_JWT in .env.scraper. "
            "See PROJECT_NOTES/flyregs_loi_build_spec.md for the full capture steps."
        )


def browse_page(page: int) -> dict:
    """One page (25 items) of DRS's authenticated Browse+Filters view for
    Legal Interpretations. `page` is zero-indexed, sent as a JSON STRING
    -- confirmed live 2026-07-29 via a real DevTools capture (page "0"
    and "1" return distinct, correctly-ordered slices; page "42", the
    final page for a 1,055-doc corpus, returns exactly the remaining 5)."""
    resp = SESSION.post(
        f"{DRS_BASE}/api/browse/doctype/LEGAL_INTERPRETATIONS/documents/metadatas",
        json={"page": str(page)},
        timeout=30,
    )
    _check_auth_response(resp, f"browse page {page}")
    resp.raise_for_status()
    return resp.json()


def iter_all_search_hits():
    """Yields every documentList item across the full paginated corpus,
    using the response's own documentListTotalCount -- never a hardcoded
    corpus size, since the whole point is this trickles in over time (per
    the expansion plan's monthly-cadence note)."""
    page = 0
    total = None
    while total is None or page * 25 < total:
        resp = browse_page(page)
        total = resp["documentListTotalCount"]
        docs = resp.get("documentList", [])
        if not docs:
            break
        for d in docs:
            yield d
        page += 1
        time.sleep(0.3)  # polite pacing


def _subtext(hit: dict, name: str) -> str:
    """Look up a value out of a documentList item's flat subText array of
    {metadataName, metadataValue} pairs -- the metadatas endpoint's
    equivalent of the old summaryguiddocview call's `metadatas` dict."""
    for f in hit.get("subText", []):
        if f.get("metadataName") == name:
            return f.get("metadataValue") or ""
    return ""


def fetch_pdf_bytes(file_id: str) -> bytes:
    resp = SESSION.get(f"{DRS_BASE}/api/content/alf/{file_id}", timeout=60)
    _check_auth_response(resp, f"PDF fetch ({file_id})")
    resp.raise_for_status()
    return resp.content


def upload_pdf(pdf_bytes: bytes, slug: str) -> str | None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    fname = f"{slug}.pdf"
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{STORAGE_BUCKET}/{fname}"
    try:
        resp = requests.put(
            upload_url,
            headers={
                "apikey": SUPABASE_KEY,
                "Authorization": f"Bearer {SUPABASE_KEY}",
                "Content-Type": "application/pdf",
                "x-upsert": "true",
            },
            data=pdf_bytes,
            timeout=120,
        )
        if resp.status_code in (200, 201):
            return f"{SUPABASE_URL}/storage/v1/object/public/{STORAGE_BUCKET}/{fname}"
        log.warning(f"  Storage upload got {resp.status_code}: {resp.text[:200]}")
    except requests.RequestException as e:
        log.error(f"  Storage upload failed ({slug}): {e}")
    return None


# ── Parsing ──────────────────────────────────────────────────────────────

# Slug from the search result's title, e.g. "Douglas_Jr_2009_Legal_Interpretation"
# -> "douglas-jr-2009". Strips the constant "_Legal_Interpretation" suffix
# and lowercases/hyphenates the rest.
def make_slug(title: str) -> str:
    stripped = re.sub(r"_Legal_Interpretation$", "", title, flags=re.IGNORECASE)
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", stripped).strip("-").lower()
    return slug or re.sub(r"[^a-zA-Z0-9]+", "-", title).strip("-").lower()


# The addressee line sits right after the letterhead block and right
# before "Dear ...". Real observed shape (Williams 2018, Douglas 2009,
# Murphy 2011): a name/firm line, then "Dear Mr./Ms./Mr. and Mrs. X".
# Not attempted as a hard requirement -- addressee is a display nicety,
# never a join key, so a miss here just leaves the field blank rather
# than blocking ingest.
_ADDRESSEE_RE = re.compile(r"\n([A-Z][A-Za-z.,\-' ]{2,60})\nDear\s")
_SUMMARY_RE = re.compile(
    r"(This (?:is|letter is) in response to.{0,400}?\.)", re.DOTALL
)


def parse_letter_text(text: str) -> dict:
    addressee_m = _ADDRESSEE_RE.search(text)
    summary_m = _SUMMARY_RE.search(text)
    return {
        "addressee": re.sub(r"\s+", " ", addressee_m.group(1)).strip() if addressee_m else None,
        "summary": re.sub(r"\s+", " ", summary_m.group(1)).strip() if summary_m else None,
    }


def parse_issued_date(date_str: str | None) -> str | None:
    """DRS's own 'Document Issue Date' field, e.g. '07/31/2009' -- already
    clean/structured, no OCR to fight (unlike parsing the letterhead
    stamp out of the scanned page itself)."""
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str.strip(), "%m/%d/%Y").date().isoformat()
    except ValueError:
        return None


# ── Ingest ───────────────────────────────────────────────────────────────

_HTML_TAG_RE = re.compile(r"<[^>]+>")

# body_text is the PDF's own embedded OCR text layer (PyMuPDF get_text()),
# used as-is -- no independent re-OCR happens here (see the file-level
# comment on loi_quality_scan.py). A handful of specific character
# misreads recur identically across MANY different letters because they
# all share the same FAA letterhead image/template, so the exact same OCR
# error gets baked into scan after scan. Confirmed corpus-wide 2026-08-19:
# "U.S. Deportment of Transportation" (should read "Department") appeared
# in 213 of 1055 documents, always as the identical letterhead phrase,
# zero false-positive risk (no legitimate letter would ever say
# "Deportment"). Fixing these here, at scrape time, means a future re-scan
# can't silently reintroduce an error already corrected once in the DB --
# the alternative (a one-time SQL backfill only) would drift the next time
# any of these 213 documents gets re-scraped.
_KNOWN_OCR_MISREADS = [
    (re.compile(r"\bDeportment\b", re.IGNORECASE), "Department"),
]


def _fix_known_ocr_misreads(text: str) -> str:
    for pattern, replacement in _KNOWN_OCR_MISREADS:
        text = pattern.sub(replacement, text)
    return text


def process_one(hit: dict, mode: str, known_far_sections: set[str] | None) -> dict | None:
    doc_unique_id = hit["docUniqueId"]
    file_id = hit["id"]
    raw_title = hit.get("headerLink", {}).get("metadataValue") or doc_unique_id
    # DRS's own search-result highlighter wraps matched query terms in
    # <span class='highlight'>...</span> -- confirmed live: it bled into
    # this exact title field for any document whose real title happens to
    # literally contain the search/browse query text. Strip unconditionally
    # rather than trying to avoid triggering it.
    title = _HTML_TAG_RE.sub("", raw_title).strip()
    slug = make_slug(title)

    pdf_bytes = fetch_pdf_bytes(file_id)
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    body_text = "\n".join(p.get_text() for p in doc)
    body_text = _fix_known_ocr_misreads(body_text)
    page_count = len(doc)

    parsed = parse_letter_text(body_text)
    year_str = _subtext(hit, "Document Issue Year")
    year = int(year_str) if year_str.isdigit() else None

    cfr_section_reference = _subtext(hit, "CFR Section Reference") or None
    # DRS's own metadata occasionally expands a stated range ("Sections
    # 91.181 through 91.215") into every individual section number FAR
    # past the letter's actual stated endpoint -- confirmed on one 1990
    # letter where this field ballooned to 1,540 pipe-separated entries
    # (22KB) reaching all the way to 91.1721, nowhere near what the letter
    # itself discusses. This is DRS's own data, not something we compute,
    # so there's no parsing bug on our side to fix -- but blindly storing
    # whatever DRS returns risks silently poisoning FAR-section cross-
    # references for hundreds of unrelated sections. No real interpretation
    # cites more than a few dozen sections (worst normal case seen: 27) --
    # if DRS ever hands back something this obviously wrong again, drop it
    # to null (a normal, already-handled state) and log it loudly, rather
    # than storing 22KB of noise silently.
    if cfr_section_reference and cfr_section_reference.count("|") > 60:
        print(
            f"WARNING: {slug!r} DRS CFR Section Reference has "
            f"{cfr_section_reference.count('|') + 1} entries "
            f"({len(cfr_section_reference)} chars) -- discarding as almost "
            f"certainly a DRS metadata error, not storing."
        )
        cfr_section_reference = None

    record = {
        "slug": slug,
        "doc_unique_id": doc_unique_id,
        "title": title,
        "addressee": parsed["addressee"],
        "year": year,
        "issued_date": parse_issued_date(_subtext(hit, "Document Issue Date")),
        "source_url": f"{DRS_BASE}/browse/excelExternalWindow/{doc_unique_id}",
        "cfr_part_reference": _subtext(hit, "CFR Part Reference") or None,
        "cfr_section_reference": cfr_section_reference,
        "summary": parsed["summary"],
        "body_text": body_text,
        "size_bytes": len(pdf_bytes) or None,
        "text_quality": "ocr",  # every sample checked so far is a scanned letter
    }

    if mode == "test":
        citations = extract_far_citations(body_text, known_far_sections)
        return {**record, "_pages": page_count, "_citations": citations}

    cached_url = upload_pdf(pdf_bytes, slug)
    record["pdf_url_cached"] = cached_url

    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
    }
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/legal_interpretations",
        headers=headers,
        params={"on_conflict": "doc_unique_id"},
        json=record,
        timeout=30,
    )
    if resp.status_code >= 400:
        log.warning(f"  Upsert failed for {slug}: {resp.status_code} {resp.text[:200]}")
        return None
    row = resp.json()[0]

    citations = extract_far_citations(body_text, known_far_sections)
    write_citations(row["id"], slug, citations)

    return {**record, "id": row["id"], "_citations": citations}


def fetch_known_far_sections() -> set[str]:
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    sections: set[str] = set()
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/far_sections",
            headers=headers,
            params={"select": "section_number", "limit": 1000, "offset": offset},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        sections.update(r["section_number"] for r in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return sections


def write_citations(loi_id: str, slug: str, citations: list[dict]) -> None:
    """Only RESOLVED (currently-real) sections become navigable MagicLinks
    -- see loi_citation_extract.py's own header comment for why an
    unresolved/historical citation must never be silently dropped from
    the LOI record itself (it stays in body_text, just isn't linked).

    document_citations has no unique constraint to upsert against (same
    as every other *_citations.py script in this project) -- delete this
    LOI's own rows first, then plain-insert the fresh set, so a re-run
    never duplicates.
    """
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    # raise_for_status() -- found live via magiclink_audit after
    # loi_far_citations_backfill.py's first full-corpus run: a delete that
    # silently no-ops (a transient 5xx, previously unchecked) leaves this
    # LOI's OLD rows in place, and the insert below then lands duplicates
    # right on top of them (edwards-islandair-2014 -> FAR 117.1/117.5, 1
    # LOI out of 1,055 in that run). Raising means the caller sees the
    # real failure and can retry/report instead of silently corrupting the
    # dedup invariant this function's whole design depends on.
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**headers, "Prefer": "return=minimal"},
        # Scoped to the cited_type this scraper OWNS. It used to delete every
        # row for this LOI regardless of type, which also wiped the loi->pcg
        # links owned by pcg_term_links.py and the loi->ac links owned by
        # loi_ac_citations.py -- same defect already fixed in ad_citations.py,
        # found by auditing for the pattern rather than waiting for it to bite.
        params={"citing_type": "eq.loi", "citing_id": f"eq.{slug}", "cited_type": "eq.far"},
        timeout=15,
    )
    resp.raise_for_status()
    rows = [
        {
            "citing_type": "loi",
            "citing_id": slug,
            "cited_type": "far",
            "cited_id": c["section"],
            "label": ",".join(c["paragraphs"]) if c["paragraphs"] else None,
        }
        for c in citations
        if c["resolved"]
    ]
    if not rows:
        return
    requests.post(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows,
        timeout=15,
    )


def log_scraper_run(run: dict) -> None:
    # Never existed before -- confirmed in the 2026-08-23 scraper-automation
    # audit: this scraper had zero scraper_runs columns of its own (unlike
    # far/aim/pcg/ad, each with a dedicated column set) and never logged a
    # run at all, so even a real, successful weekly sync left no queryable
    # trail. See sync/migrations_scraper_runs_loi_cfr49_columns.sql for the
    # new loi_* columns this writes into.
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=run,
            timeout=10,
        )
        if not r.ok:
            log.error(f"log_scraper_run: insert failed ({r.status_code}): {r.text[:500]}")
    except Exception as e:
        log.error(f"log_scraper_run: insert raised: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--limit", type=int, default=5)
    args = ap.parse_args()

    if not DRS_JWT:
        log.error("DRS_JWT must be set (see this file's header comment for how to capture one).")
        # Was a bare `return` -- confirmed live 2026-08-23, the first-ever
        # scheduled run of this script (weekly-loi-sync.yml, manually
        # dispatched to verify it before its real Monday cron): the DRS_JWT
        # repo secret was never actually set, this branch fired, and the
        # script exited 0 having done NOTHING -- which `sync_loi.sh`'s
        # `set -euo pipefail` cannot catch (bash only sees a clean exit),
        # so steps 2-4 ran against stale data and the whole workflow
        # reported "success". A missing required credential must fail
        # loudly, not silently no-op.
        sys.exit(1)
    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.")
        sys.exit(1)

    known_far_sections = fetch_known_far_sections() if SUPABASE_URL and SUPABASE_KEY else None
    if known_far_sections:
        log.info(f"Loaded {len(known_far_sections)} known FAR sections for citation validation.")

    run_record = {
        "mode": args.mode,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    try:
        count = 0
        ok = 0
        errors = 0
        for hit in iter_all_search_hits():
            if args.mode == "test" and count >= args.limit:
                break
            count += 1
            doc_unique_id = hit["docUniqueId"]
            try:
                result = process_one(hit, args.mode, known_far_sections)
            except DrsAuthExpired:
                raise
            except Exception as e:
                log.warning(f"  [{count}] {doc_unique_id} — failed: {e}")
                errors += 1
                continue

            if result is None:
                errors += 1
                continue
            ok += 1
            resolved = [c for c in result["_citations"] if c["resolved"]]
            hist = [c for c in result["_citations"] if not c["resolved"]]
            log.info(
                f"  [{count}] {result['slug']} — {result.get('year')} — "
                f"{len(resolved)} FAR link(s){f', {len(hist)} historical' if hist else ''}"
            )
            time.sleep(0.2)

        log.info(f"\nDone. {ok} processed, {errors} error(s), mode={args.mode}.")
        if args.mode == "full":
            run_record.update({
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "status": "success" if errors == 0 else "partial",
                "loi_total": count,
                "loi_added": ok,
                "loi_errors": errors,
            })
            log_scraper_run(run_record)
    except DrsAuthExpired as e:
        log.error(f"\n{e}")
        # This is the one failure mode a silent scraper_runs gap would hide
        # completely -- a real, known-recurring blocker (RC's own captured
        # DRS_JWT expires) where the scheduled workflow would otherwise just
        # go quiet with zero trail of WHY. Log it as a failed run before
        # exiting so the audit trail shows an attempt was made, not nothing.
        if args.mode == "full":
            run_record.update({
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "status": "failed",
                "error_details": {"error": str(e)},
            })
            log_scraper_run(run_record)
        sys.exit(1)


if __name__ == "__main__":
    main()
