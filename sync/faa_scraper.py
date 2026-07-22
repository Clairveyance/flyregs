#!/usr/bin/env python3
"""
FAA Advisory Circular Scraper
==============================
Fetches all active ACs from FAA.gov, pulls metadata + PDFs, stores in Supabase.

Modes:
  test          first 5 ACs, no DB writes — use this to verify setup
  full          initial run — all ~689 ACs
  incremental   weekly run — only new or updated ACs

Usage:
  python faa_scraper.py --mode test
  python faa_scraper.py --mode full
  python faa_scraper.py --mode incremental

Environment variables required for full/incremental:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import csv
import io
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Optional

import requests
from bs4 import BeautifulSoup

# ──────────────────────────────────────────────────────────────────────────────
#  Config
# ──────────────────────────────────────────────────────────────────────────────

FAA_CSV_URL = (
    "https://www.faa.gov/regulations_policies/advisory_circulars/"
    "index.cfm/go/document.exportAll/statusID/2"
)
FAA_LIST_BASE = (
    "https://www.faa.gov/regulations_policies/advisory_circulars/"
    "index.cfm/go/document.list/"
)
FAA_DOC_INFO_BASE = (
    "https://www.faa.gov/regulations_policies/advisory_circulars/"
    "index.cfm/go/document.information/documentID/"
)
FAA_PDF_BASE = "https://www.faa.gov/documentLibrary/media/Advisory_Circular"
FAA_HOST = "https://www.faa.gov"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
STORAGE_BUCKET = "advisory-circulars"

# Be polite — one request every ~0.75s per host
REQUEST_DELAY = 0.75
REQUEST_TIMEOUT = 30
PDF_TIMEOUT = 90

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("faa_scraper")


# ──────────────────────────────────────────────────────────────────────────────
#  HTTP session
# ──────────────────────────────────────────────────────────────────────────────

FAA_HOME_URL = "https://www.faa.gov/regulations_policies/advisory_circulars/"

def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    # Warm up: visit the AC index page first so FAA's ColdFusion server
    # issues a session cookie before we hit the CSV export endpoint.
    try:
        log.info("Warming up FAA session …")
        s.get(FAA_HOME_URL, timeout=REQUEST_TIMEOUT)
    except Exception as e:
        log.warning(f"Session warm-up failed (continuing anyway): {e}")
    return s


# ──────────────────────────────────────────────────────────────────────────────
#  Step 1: Download master CSV
# ──────────────────────────────────────────────────────────────────────────────

def fetch_csv(session: requests.Session) -> list[dict]:
    """
    Download the official FAA AC CSV index.
    Returns list of dicts with keys: CHANGENUMBER, DATE, DOCUMENTNUMBER, OFFICE, TITLE
    """
    log.info("Fetching FAA AC CSV export …")
    resp = session.get(
        FAA_CSV_URL,
        timeout=REQUEST_TIMEOUT,
        headers={"Referer": FAA_HOME_URL},
    )
    resp.raise_for_status()

    # The CSV is clean UTF-8 with a BOM sometimes
    text = resp.text.lstrip("﻿")
    reader = csv.DictReader(io.StringIO(text))
    rows = [r for r in reader if r.get("DOCUMENTNUMBER", "").strip()]
    log.info(f"  → {len(rows)} active ACs")
    return rows


# ──────────────────────────────────────────────────────────────────────────────
#  Step 2: Parse AC number helpers
# ──────────────────────────────────────────────────────────────────────────────

def parse_series(doc_num: str) -> str:
    """
    Extract the series prefix for categorization.
    "20-73A"       → "20"
    "150/5320-12C" → "150"
    "61-65E"       → "61"
    "00-6B"        → "00"
    "437.55-1"     → "437"
    """
    m = re.match(r"^(\d+)", doc_num)
    return m.group(1) if m else "00"


def pdf_url_candidates(doc_num: str) -> list[str]:
    """
    Return candidate PDF URLs to try, in priority order.
    FAA's typical pattern: AC_{number}.pdf, but 150/xxxx uses _ or - for the slash.
    """
    slug_slash = doc_num.replace("/", "_")   # most common: 150_5320-12C
    slug_dash  = doc_num.replace("/", "-")   # fallback:    150-5320-12C
    slug_pct   = doc_num.replace("/", "%2F") # URL-encoded: rare
    slug_raw   = doc_num                     # no slash — works for 20-73A directly

    seen = []
    candidates = []
    for slug in [slug_slash, slug_dash, slug_pct, slug_raw]:
        url = f"{FAA_PDF_BASE}/AC_{slug}.pdf"
        if url not in seen:
            candidates.append(url)
            seen.append(url)
    return candidates


def resolve_pdf_url(
    doc_num: str,
    session: requests.Session,
    canonical: Optional[str] = None,
) -> Optional[str]:
    """Try each candidate PDF URL; return the first that resolves."""
    candidates = []
    if canonical:
        candidates.append(canonical)
    candidates.extend(pdf_url_candidates(doc_num))

    for url in candidates:
        try:
            r = session.head(url, timeout=15, allow_redirects=True)
            ct = r.headers.get("content-type", "")
            if r.status_code == 200 and ("pdf" in ct.lower() or url.lower().endswith(".pdf")):
                return url
        except requests.RequestException:
            pass
    return None


# ──────────────────────────────────────────────────────────────────────────────
#  Step 3: Fetch detail page (description, documentID, cancels list)
# ──────────────────────────────────────────────────────────────────────────────

def fetch_detail(doc_num: str, session: requests.Session) -> dict:
    """
    Search for this AC on the FAA list page, then scrape its detail page.

    Returns:
        document_id: int | None      FAA's internal numeric ID
        description: str | None      Plain-text AC description
        pdf_url:     str | None      Canonical PDF URL from detail page
        cancels:     list[str]       AC numbers this one supersedes
    """
    result = {"document_id": None, "description": None, "pdf_url": None, "cancels": []}

    try:
        # Search the list page for this AC number
        search_url = f"{FAA_LIST_BASE}?q={requests.utils.quote(doc_num)}"
        time.sleep(REQUEST_DELAY)
        resp = session.get(search_url, timeout=REQUEST_TIMEOUT)
        soup = BeautifulSoup(resp.text, "html.parser")

        # Find the link to the detail page.
        # Links look like: .../document.information/documentID/22031
        detail_href = _find_detail_href(soup, doc_num)

        if not detail_href:
            log.debug(f"    No detail link found for {doc_num} — skipping detail fetch")
            return result

        # Extract documentID from URL
        m = re.search(r"documentID/(\d+)", detail_href)
        if m:
            result["document_id"] = int(m.group(1))

        # Make absolute
        if not detail_href.startswith("http"):
            detail_href = FAA_HOST + detail_href

        time.sleep(REQUEST_DELAY)
        detail_resp = session.get(detail_href, timeout=REQUEST_TIMEOUT)
        detail_soup = BeautifulSoup(detail_resp.text, "html.parser")

        result["description"] = _extract_description(detail_soup)
        result["pdf_url"]     = _extract_pdf_url(detail_soup)
        result["cancels"]     = _extract_cancels(detail_soup)

    except Exception as e:
        log.warning(f"    Detail fetch failed for {doc_num}: {e}")

    return result


def _find_detail_href(soup: BeautifulSoup, doc_num: str) -> Optional[str]:
    """Find the href of the detail page link for doc_num on a list page."""
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if "document.information/documentID" not in href:
            continue
        # Prefer links whose text contains the AC number
        link_text = a.get_text(strip=True)
        if doc_num.upper() in link_text.upper():
            return href
        # Also match if the context row's text contains the AC number
        row = a.find_parent("tr") or a.find_parent("li") or a.find_parent("div")
        if row and doc_num.upper() in row.get_text(strip=True).upper():
            return href

    # Fallback: first documentID link on the page (result is search result for this AC)
    first = soup.find("a", href=lambda h: h and "document.information/documentID" in h)
    return first["href"] if first else None


def _extract_description(soup: BeautifulSoup) -> Optional[str]:
    """
    Pull the Description field from an FAA AC detail page.
    FAA uses a definition-list or table layout; we try both patterns.
    """
    # Pattern A: <dt>Description</dt><dd>...</dd>
    for dt in soup.find_all(["dt", "th"]):
        if "description" in dt.get_text(strip=True).lower():
            dd = dt.find_next_sibling(["dd", "td"])
            if dd:
                text = dd.get_text(separator=" ", strip=True)
                if len(text) > 30:
                    return text[:3000]

    # Pattern B: look for "Description" as a heading, grab following paragraph
    for tag in soup.find_all(["h2", "h3", "h4", "strong", "b", "label"]):
        if tag.get_text(strip=True).lower() in ("description",):
            nxt = tag.find_next(["p", "div", "span"])
            if nxt:
                text = nxt.get_text(separator=" ", strip=True)
                if len(text) > 30:
                    return text[:3000]

    # Pattern C: regex over full page text
    full = soup.get_text(separator="\n")
    m = re.search(
        r"Description\s*\n+(.+?)(?:\n\n|\nContent\b|\nCancels\b|\nStatus\b)",
        full, re.DOTALL | re.IGNORECASE
    )
    if m:
        desc = m.group(1).strip()
        if len(desc) > 30:
            return desc[:3000]

    return None


def _extract_pdf_url(soup: BeautifulSoup) -> Optional[str]:
    """
    Find the canonical PDF link on the detail page.

    FAA uses two distinct URL patterns:
      Standard series:  /documentLibrary/media/Advisory_Circular/AC_20-73A.pdf
      150-series:       /documentLibrary/media/advisory_circular/150-5320-12C/150_5320_12c.PDF
    Must use case-insensitive match for both.
    """
    for a in soup.find_all("a", href=True):
        href = a["href"]
        href_lower = href.lower()
        if ".pdf" in href_lower and "advisory_circular" in href_lower:
            return href if href.startswith("http") else FAA_HOST + href
    return None


def _extract_cancels(soup: BeautifulSoup) -> list[str]:
    """Extract the list of AC numbers that this AC supersedes."""
    cancels = []
    # Look for a "Cancels" section with a table
    for text_node in soup.find_all(string=re.compile(r"\bCancels\b", re.I)):
        parent = text_node.parent
        table = parent.find_next("table") if parent else None
        if not table:
            continue
        for row in table.find_all("tr")[1:]:  # skip header
            cells = row.find_all("td")
            if cells:
                num = cells[0].get_text(strip=True)
                if num and re.match(r"[\d]", num):
                    cancels.append(num)
        break
    return cancels


# ──────────────────────────────────────────────────────────────────────────────
#  Step 4: Download PDF
# ──────────────────────────────────────────────────────────────────────────────

def download_pdf(url: str, session: requests.Session) -> Optional[bytes]:
    """Download PDF bytes. Returns None if download fails or file is tiny."""
    try:
        resp = session.get(url, timeout=PDF_TIMEOUT)
        if resp.status_code == 200 and len(resp.content) > 2048:
            return resp.content
        log.debug(f"    PDF bad response: {resp.status_code} / {len(resp.content)} bytes")
    except requests.RequestException as e:
        log.warning(f"    PDF download error: {e}")
    return None


# ──────────────────────────────────────────────────────────────────────────────
#  Step 5: Extract text from PDF (for full-text search)
# ──────────────────────────────────────────────────────────────────────────────

def extract_pdf_text(pdf_bytes: bytes) -> Optional[str]:
    """Extract plain text from PDF bytes using pypdf."""
    pages, _ = extract_pdf_pages(pdf_bytes)
    if pages is None:
        return None
    full = "\n".join(pages).strip()
    return full[:500_000] if full else None  # cap at 500K chars


def extract_pdf_pages(pdf_bytes: bytes) -> tuple[Optional[list[str]], int]:
    """
    Same extraction as extract_pdf_text, but returns the per-page text list
    (so a caller can spot which specific pages came back empty/near-empty)
    alongside the total page count. Returns (None, 0) on a hard read failure.
    """
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        pages = []
        for page in reader.pages:
            t = page.extract_text()
            pages.append(t or "")
        return pages, len(reader.pages)
    except Exception as e:
        log.debug(f"    PDF text extraction error: {e}")
        return None, 0


# ──────────────────────────────────────────────────────────────────────────────
#  Vision recovery — flattened/signed PDFs with a broken or missing text layer
# ──────────────────────────────────────────────────────────────────────────────
# A modern, digitally-signed AC can have its real text layer flattened to
# vector paths during signing (confirmed on AC 38-1, 2026-07 — a 2023 AC with
# ZERO extractable characters despite being a clean, modern, legible PDF).
# Old scanned originals are a separate, closed, one-time-fixed problem (see
# OCR_SCANNED_ACS in ocrScannedACs.ts) -- THIS is the one that can recur on
# any future AC, since it's caused by the signing/publishing process, not the
# document's age. Detection piggybacks on the extraction pypdf already does
# for every AC (zero extra cost for the ~99% of ACs that are healthy); the
# expensive part (Claude vision) only ever runs on the specific pages that
# fail the health check, never a whole-corpus or blanket pass.
VISION_MIN_CHARS_PER_PAGE = 300  # a healthy dense regulatory page runs ~2,500-3,500
VISION_MODEL = "claude-sonnet-5"
VISION_RENDER_DPI = 150
# Very rough, for the recovery log only -- not exact billing. Based on
# measured per-page vision-transcription cost during the OCR-scanned-doc
# rebuild (2026-07-13): ~2,700 image tokens + ~300 prompt tokens in, ~300-800
# tokens out, at Sonnet 5's $2/$10 per-MTok introductory rate.
VISION_EST_COST_PER_PAGE = 0.012

# Hard circuit breaker — independent of every other safeguard above (the
# systemic-pattern gate, incremental-mode's small new/updated-only scope).
# If something we haven't anticipated ever makes many documents look broken
# in the same run (a pypdf regression, a bad --full run, anything), this
# stops spending real money once total recovered pages in THIS PROCESS
# cross the cap, rather than silently ballooning. 200 pages is roughly
# $2.40-$4.80 worst case (see VISION_EST_COST_PER_PAGE) -- generous enough
# to never interfere with a normal week (historically 0-2 documents, tens
# of pages at most) but nowhere near what a real corpus-wide problem would
# need. Once tripped, remaining candidates just keep their thin/pypdf text
# (same as if ANTHROPIC_API_KEY were unset) and a clear warning is logged —
# this is a loud failure requiring a human to look, never a silent one.
VISION_MAX_PAGES_PER_RUN = 200
_vision_pages_recovered_this_run = 0
_vision_circuit_tripped = False

# Set whenever something this run genuinely needs a human to look at: the
# circuit breaker tripping, or an individual page's vision recovery call
# erroring out. Checked at the end of main() -- causes a non-zero exit so
# the GitHub Actions run itself shows as failed (visible via `gh run list`),
# rather than these warnings only ever existing as text buried in a CI log
# nobody is guaranteed to read. See sync.sh's header for the full alerting story.
_needs_human_attention = False

VISION_TRANSCRIBE_PROMPT = """You are transcribing one page of an FAA Advisory Circular whose normal text extraction failed on this page (likely a flattened/signed PDF) -- a regulatory document where exact wording, numbering, and punctuation matter.

Rules:
1. Transcribe the text EXACTLY as it appears. Do not modernize spelling, do not "fix" grammar, do not paraphrase.
2. Preserve the document's own structure markers exactly as printed: section numbers, letter items, numbered sub-items, headings.
3. If the page is (or contains) a figure, chart, diagram, or table: do NOT write a narrative description of the image. Transcribe ONLY the literal printed text that appears on it -- the caption/title, axis labels, column/row headers, and any callout or legend text -- in natural reading order. Do not describe layout, shapes, lines, or spatial relationships.
4. For an equation or formula, transcribe it as accurately as you can, preserving the actual mathematical structure using plain-text or LaTeX-like notation. Do not simplify beyond what's needed to represent it in text.
5. If part of the page is genuinely illegible even to you, write [illegible] at that exact spot rather than guessing.
6. Output ONLY the transcription itself -- no preamble, no commentary.
"""


VISION_THIN_PAGE_FRACTION = 0.5  # systemic failure, not just a chart-heavy doc


def needs_vision_recovery(pages: list[str]) -> list[int]:
    """
    Returns the 0-indexed page numbers to recover via vision, or [] if this
    document doesn't need it at all. A single sparse page is NOT enough to
    trigger anything -- a real chart/figure page in a perfectly healthy
    modern AC often extracts almost no text on its own (the chart is an
    image; only its caption is real text), and confirmed via a real test
    (AC 20-191, healthy) that flags exactly this false-positive pattern if
    checked page-by-page alone: 6 of 151 pages under the per-page floor,
    every one of them a legitimate figure/appendix-chart page, not a
    flattening problem. The actual failure mode (AC 38-1) was systemic --
    EVERY page came back empty -- so recovery only triggers when the
    problem looks systemic: either the whole document is starved of text on
    average, or a clear majority of pages are thin. Only the pages that are
    actually thin get recovered even when the whole-document check fires --
    this stays as surgical as the trigger allows.
    """
    if not pages:
        return []
    total_chars = sum(len(t.strip()) for t in pages)
    avg_chars_per_page = total_chars / len(pages)
    thin_pages = [i for i, t in enumerate(pages) if len(t.strip()) < VISION_MIN_CHARS_PER_PAGE]
    thin_fraction = len(thin_pages) / len(pages)

    if avg_chars_per_page < VISION_MIN_CHARS_PER_PAGE or thin_fraction > VISION_THIN_PAGE_FRACTION:
        return thin_pages
    return []


def recover_pages_via_vision(pdf_bytes: bytes, page_indices: list[int], doc_num: str) -> dict[int, str]:
    """
    Renders just the flagged pages and transcribes each via Claude vision.
    Returns {page_index: recovered_text}. Any page that errors is simply
    omitted (caller keeps whatever pypdf already had for it, which is
    whatever thin/empty text triggered the flag in the first place).
    """
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        log.warning(f"    ANTHROPIC_API_KEY not set — skipping vision recovery for {doc_num}")
        return {}

    import base64
    import fitz  # PyMuPDF
    import anthropic

    client = anthropic.Anthropic(api_key=anthropic_key)
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    recovered = {}

    for i in page_indices:
        try:
            page = doc[i]
            pix = page.get_pixmap(dpi=VISION_RENDER_DPI)
            png_bytes = pix.tobytes("png")
            b64 = base64.standard_b64encode(png_bytes).decode("utf-8")
            message = client.messages.create(
                model=VISION_MODEL,
                max_tokens=4096,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                        {"type": "text", "text": VISION_TRANSCRIBE_PROMPT},
                    ],
                }],
            )
            text = "".join(b.text for b in message.content if b.type == "text")
            recovered[i] = text
        except Exception as e:
            global _needs_human_attention
            _needs_human_attention = True
            log.warning(f"    Vision recovery failed for {doc_num} page {i + 1}: {e}")

    return recovered


def log_vision_recovery(doc_num: str, page_count: int, reason: str, chars_before: int, chars_after: int) -> None:
    """Best-effort — a failure here never blocks the actual content fix."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        payload = {
            "document_number": doc_num,
            "page_count": page_count,
            "reason": reason,
            "chars_before": chars_before,
            "chars_after": chars_after,
            "est_cost_usd": round(page_count * VISION_EST_COST_PER_PAGE, 4),
        }
        requests.post(
            f"{SUPABASE_URL}/rest/v1/vision_recovery_log",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            data=json.dumps(payload),
            timeout=REQUEST_TIMEOUT,
        )
    except Exception as e:
        log.debug(f"    Failed to log vision recovery for {doc_num}: {e}")



# Populated with every doc_number that actually got a vision recovery this
# process — written out at the end of a run (see --vision-recovered-out) so
# the workflow can auto-append them to OCR_SCANNED_ACS without needing to
# re-derive the list from Supabase.
_vision_recovered_docs_this_run: list[str] = []


def extract_pdf_text_with_recovery(pdf_bytes: bytes, doc_num: str) -> Optional[str]:
    """
    Normal pypdf extraction, then a cheap per-page health check. Only the
    specific pages that fail it (usually zero, sometimes all of them if the
    whole PDF was flattened) get an actual Claude vision call — never a
    blanket pass. Guarded by a hard circuit breaker
    (VISION_MAX_PAGES_PER_RUN) independent of the health check itself, so a
    problem this check didn't anticipate still can't run away unbounded.
    """
    global _vision_pages_recovered_this_run, _vision_circuit_tripped, _needs_human_attention

    pages, page_count = extract_pdf_pages(pdf_bytes)
    if pages is None or page_count == 0:
        return None

    flagged = needs_vision_recovery(pages)
    if not flagged:
        full = "\n".join(pages).strip()
        return full[:500_000] if full else None

    chars_before = sum(len(t) for t in pages)
    reason = "zero_text" if chars_before == 0 else "low_chars_per_page"

    if _vision_circuit_tripped:
        log.warning(f"    {doc_num}: {len(flagged)} page(s) need vision recovery, but the circuit "
                     f"breaker already tripped this run ({_vision_pages_recovered_this_run}/{VISION_MAX_PAGES_PER_RUN} "
                     f"pages) — leaving this doc's thin text as-is. Check vision_recovery_log and rerun manually.")
        full = "\n".join(pages).strip()
        return full[:500_000] if full else None

    if _vision_pages_recovered_this_run + len(flagged) > VISION_MAX_PAGES_PER_RUN:
        _vision_circuit_tripped = True
        _needs_human_attention = True
        log.warning(f"    CIRCUIT BREAKER TRIPPED: recovering {doc_num}'s {len(flagged)} page(s) would "
                     f"exceed the {VISION_MAX_PAGES_PER_RUN}-page/run cap ({_vision_pages_recovered_this_run} "
                     f"already used). Skipping vision recovery for this and any further doc this run — "
                     f"this needs a human to look before running again.")
        full = "\n".join(pages).strip()
        return full[:500_000] if full else None

    log.info(f"    {doc_num}: {len(flagged)}/{page_count} page(s) below text-health threshold ({reason}) — recovering via vision")

    recovered = recover_pages_via_vision(pdf_bytes, flagged, doc_num)
    _vision_pages_recovered_this_run += len(recovered)
    if recovered:
        _vision_recovered_docs_this_run.append(doc_num)
    for i, text in recovered.items():
        pages[i] = text

    full = "\n".join(pages).strip()
    chars_after = len(full)
    log_vision_recovery(doc_num, page_count, reason, chars_before, chars_after)

    return full[:500_000] if full else None


# ──────────────────────────────────────────────────────────────────────────────
#  Step 6: Supabase helpers
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


def upsert_ac(record: dict) -> bool:
    """
    Upsert a single AC record into Supabase.
    Returns True on success.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {record['document_number']}")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars",
            headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            json=record,
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  Supabase upsert failed ({record.get('document_number')}): {e}")
        return False


def upload_pdf(pdf_bytes: bytes, doc_num: str) -> Optional[str]:
    """
    Upload PDF to Supabase Storage bucket 'advisory-circulars'.
    Returns the public URL, or None on failure.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upload PDF for {doc_num}")
        return f"dry-run/AC_{doc_num}.pdf"

    # Sanitize filename
    fname = re.sub(r"[^a-zA-Z0-9\-_.]", "_", doc_num) + ".pdf"
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
    except Exception as e:
        log.error(f"  Storage upload failed ({doc_num}): {e}")
    return None


def get_existing_ac_map() -> dict[str, str]:
    """
    Fetch all stored AC records from Supabase.
    Returns {document_number: updated_at_iso_string}.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {}
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars",
            headers=_supa_headers(),
            params={"select": "document_number,updated_at", "limit": 2000},
            timeout=30,
        )
        resp.raise_for_status()
        return {r["document_number"]: r["updated_at"] for r in resp.json()}
    except Exception as e:
        log.error(f"Failed to load existing ACs from Supabase: {e}")
        return {}


def mark_cancelled_acs(active_doc_nums: set) -> int:
    """
    Reconciliation step — runs at the end of every scrape.

    Finds any ACs stored in the DB with status='active' that are NOT in the
    current FAA active feed (statusID/2), and marks them 'cancelled'.

    This is how superseded ACs (e.g. 61-65J after 61-65K ships) get flipped
    automatically without waiting for a manual fix.

    Returns the count of rows updated.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 0
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars",
            headers=_supa_headers(),
            params={"select": "document_number", "status": "eq.active", "limit": 2000},
            timeout=30,
        )
        resp.raise_for_status()
        db_active = {r["document_number"] for r in resp.json()}
    except Exception as e:
        log.error(f"Reconciliation: failed to fetch active ACs from DB: {e}")
        return 0

    to_cancel = db_active - active_doc_nums
    if not to_cancel:
        log.info("Reconciliation: all DB active ACs confirmed in FAA feed — nothing to cancel.")
        return 0

    log.warning(
        f"Reconciliation: {len(to_cancel)} ACs no longer in FAA active feed — "
        f"marking cancelled: {sorted(to_cancel)}"
    )
    cancelled_count = 0
    now = datetime.now(timezone.utc).isoformat()
    for doc_num in sorted(to_cancel):
        try:
            r = requests.patch(
                f"{SUPABASE_URL}/rest/v1/advisory_circulars",
                headers=_supa_headers({"Prefer": "return=minimal"}),
                params={"document_number": f"eq.{doc_num}"},
                json={"status": "cancelled", "last_scraped_at": now},
                timeout=15,
            )
            r.raise_for_status()
            cancelled_count += 1
            log.info(f"  ✓ Marked cancelled: {doc_num}")
        except Exception as e:
            log.error(f"  ✗ Failed to cancel {doc_num}: {e}")

    return cancelled_count


def log_scraper_run(run: dict) -> None:
    """Write a scraper_runs record to Supabase."""
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
        pass  # Non-critical


# ──────────────────────────────────────────────────────────────────────────────
#  Core: process one AC
# ──────────────────────────────────────────────────────────────────────────────

def process_ac(
    row: dict,
    session: requests.Session,
    fetch_detail_page: bool = True,
    download_pdfs: bool = True,
) -> Optional[dict]:
    """
    Process a single CSV row into a Supabase-ready record.
    Returns None if the row is malformed.
    """
    doc_num = row.get("DOCUMENTNUMBER", "").strip()
    if not doc_num:
        return None

    title       = row.get("TITLE", "").strip()
    office      = row.get("OFFICE", "").strip()
    raw_date    = row.get("DATE", "").strip()
    raw_change  = row.get("CHANGENUMBER", "0").strip()

    # Parse date
    date_issued = None
    if raw_date:
        try:
            date_issued = (
                datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                .date().isoformat()
            )
        except ValueError:
            pass

    change_number = 0
    try:
        change_number = int(raw_change)
    except ValueError:
        pass

    record: dict = {
        "document_number": doc_num,
        "title":           title,
        "date_issued":     date_issued,
        "office":          office,
        "change_number":   change_number,
        "status":          "active",
        "subject_series":  parse_series(doc_num),
        "description":     None,
        "document_id":     None,
        "cancels":         [],
        "pdf_url_faa":     None,
        "pdf_url_cached":  None,
        "pdf_size_bytes":  None,
        "pdf_text":        None,
        "last_scraped_at": datetime.now(timezone.utc).isoformat(),
    }

    # ── Detail page ──────────────────────────────────────────────────────────
    canonical_pdf = None
    if fetch_detail_page:
        detail = fetch_detail(doc_num, session)
        record["description"] = detail["description"]
        record["document_id"] = detail["document_id"]
        record["cancels"]     = detail["cancels"]
        canonical_pdf         = detail["pdf_url"]

    # ── PDF URL ──────────────────────────────────────────────────────────────
    pdf_url = resolve_pdf_url(doc_num, session, canonical_pdf)
    record["pdf_url_faa"] = pdf_url

    if not pdf_url:
        log.warning(f"  ✗ No valid PDF URL for {doc_num}")

    # ── PDF download ─────────────────────────────────────────────────────────
    if download_pdfs and pdf_url:
        time.sleep(REQUEST_DELAY)
        pdf_bytes = download_pdf(pdf_url, session)
        if pdf_bytes:
            record["pdf_size_bytes"] = len(pdf_bytes)
            record["pdf_text"]       = extract_pdf_text_with_recovery(pdf_bytes, doc_num)
            cached_url               = upload_pdf(pdf_bytes, doc_num)
            record["pdf_url_cached"] = cached_url
            size_kb = len(pdf_bytes) // 1024
            text_len = len(record["pdf_text"] or "")
            log.info(f"  ✓ PDF {size_kb}KB | {text_len:,} chars text")
            # Clear parsed blocks — triggers re-parsing and OCR fixes on next sync
            if record["pdf_text"]:
                record["pdf_blocks_version"] = None
        else:
            log.warning(f"  ✗ PDF download failed for {doc_num}")

    return record


# ──────────────────────────────────────────────────────────────────────────────
#  Run modes
# ──────────────────────────────────────────────────────────────────────────────

def run_test(session: requests.Session, n: int = 5):
    """Quick smoke test — first n ACs, no DB writes."""
    log.info(f"TEST MODE — processing first {n} ACs (no DB writes)")
    rows = fetch_csv(session)

    for row in rows[:n]:
        doc_num = row.get("DOCUMENTNUMBER", "?").strip()
        log.info(f"\n{'─'*50}")
        log.info(f"AC: {doc_num}")
        rec = process_ac(row, session, fetch_detail_page=True, download_pdfs=False)
        if rec:
            log.info(f"  Title:       {rec['title']}")
            log.info(f"  Date:        {rec['date_issued']}")
            log.info(f"  Series:      {rec['subject_series']}")
            log.info(f"  PDF URL:     {rec['pdf_url_faa']}")
            log.info(f"  Doc ID:      {rec['document_id']}")
            log.info(f"  Description: {(rec['description'] or 'N/A')[:120]}")
            log.info(f"  Cancels:     {rec['cancels'] or 'none'}")


def run_full(session: requests.Session):
    """Initial full scrape — all ACs."""
    log.info("=" * 60)
    log.info("FULL SCRAPE — all ACs")
    log.info("=" * 60)

    run_record = {
        "mode": "full",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    rows = fetch_csv(session)
    total = len(rows)
    added = updated = errors = 0
    error_details = []

    existing = get_existing_ac_map()

    for i, row in enumerate(rows, 1):
        doc_num = row.get("DOCUMENTNUMBER", "?").strip()
        log.info(f"[{i}/{total}] {doc_num}")
        try:
            rec = process_ac(row, session, fetch_detail_page=True, download_pdfs=True)
            if rec:
                if upsert_ac(rec):
                    if doc_num in existing:
                        updated += 1
                    else:
                        added += 1
                else:
                    errors += 1
        except Exception as e:
            log.error(f"  ✗ Exception: {e}")
            errors += 1
            error_details.append({"ac": doc_num, "error": str(e)})

    # Reconciliation: mark any ACs no longer in FAA active feed as cancelled
    active_doc_nums = {row.get("DOCUMENTNUMBER", "").strip() for row in rows}
    cancelled = mark_cancelled_acs(active_doc_nums)

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        "acs_total": total,
        "acs_added": added,
        "acs_updated": updated,
        "acs_cancelled": cancelled,
        "acs_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Added={added} Updated={updated} Cancelled={cancelled} Errors={errors}/{total}")


def run_incremental(session: requests.Session):
    """Weekly incremental — only process new or changed ACs."""
    log.info("=" * 60)
    log.info("INCREMENTAL SCRAPE")
    log.info("=" * 60)

    run_record = {
        "mode": "incremental",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    rows = fetch_csv(session)
    existing = get_existing_ac_map()

    # Identify new and updated ACs
    to_process = []
    for row in rows:
        doc_num = row.get("DOCUMENTNUMBER", "").strip()
        if not doc_num:
            continue
        if doc_num not in existing:
            to_process.append(("new", row))
            continue
        # Compare FAA date vs our stored updated_at
        raw_date = row.get("DATE", "").strip()
        if raw_date:
            try:
                faa_dt = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                stored_dt = datetime.fromisoformat(existing[doc_num])
                # Use date-only comparison to avoid timezone noise
                if faa_dt.date() > stored_dt.date():
                    to_process.append(("updated", row))
            except ValueError:
                pass

    new_count = sum(1 for t, _ in to_process if t == "new")
    upd_count = sum(1 for t, _ in to_process if t == "updated")
    log.info(f"New: {new_count}  |  Updated: {upd_count}  |  Total to process: {len(to_process)}")

    if not to_process:
        log.info("Nothing to do — all ACs are current.")
        run_record.update({
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "status": "success",
            "acs_total": len(rows),
            "acs_added": 0,
            "acs_updated": 0,
            "acs_errors": 0,
        })
        log_scraper_run(run_record)
        return

    added = updated = errors = 0
    error_details = []

    for i, (change_type, row) in enumerate(to_process, 1):
        doc_num = row.get("DOCUMENTNUMBER", "?").strip()
        log.info(f"[{i}/{len(to_process)}] {change_type.upper()}: {doc_num}")
        try:
            rec = process_ac(row, session, fetch_detail_page=True, download_pdfs=True)
            if rec and upsert_ac(rec):
                if change_type == "new":
                    added += 1
                else:
                    updated += 1
            else:
                errors += 1
        except Exception as e:
            log.error(f"  ✗ Exception: {e}")
            errors += 1
            error_details.append({"ac": doc_num, "error": str(e)})

    # Reconciliation: mark any ACs no longer in FAA active feed as cancelled
    active_doc_nums = {row.get("DOCUMENTNUMBER", "").strip() for row in rows}
    cancelled = mark_cancelled_acs(active_doc_nums)

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        "acs_total": len(rows),
        "acs_added": added,
        "acs_updated": updated,
        "acs_cancelled": cancelled,
        "acs_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Added={added} Updated={updated} Cancelled={cancelled} Errors={errors}")


# ──────────────────────────────────────────────────────────────────────────────
#  CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FAA Advisory Circular Scraper")
    parser.add_argument(
        "--mode",
        choices=["test", "full", "incremental"],
        default="test",
        help="test=smoke test (no writes), full=initial scrape, incremental=weekly update",
    )
    parser.add_argument(
        "--test-count",
        type=int,
        default=5,
        help="Number of ACs to process in test mode (default: 5)",
    )
    parser.add_argument(
        "--vision-recovered-out",
        default=None,
        help="Path to write doc_numbers that got a vision recovery this run, one per line "
             "(empty file if none) -- lets the workflow auto-append them to OCR_SCANNED_ACS",
    )
    args = parser.parse_args()

    if args.mode in ("full", "incremental"):
        if not SUPABASE_URL or not SUPABASE_KEY:
            log.error(
                "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full/incremental mode.\n"
                "Use --mode test to verify the scraper without DB credentials."
            )
            sys.exit(1)

    session = make_session()

    if args.mode == "test":
        run_test(session, n=args.test_count)
    elif args.mode == "full":
        run_full(session)
    elif args.mode == "incremental":
        run_incremental(session)

    if args.vision_recovered_out:
        with open(args.vision_recovered_out, "w") as f:
            for doc_num in _vision_recovered_docs_this_run:
                f.write(doc_num + "\n")

    if _needs_human_attention:
        log.error(
            "This run had a vision-recovery circuit-breaker trip or an individual page "
            "recovery failure -- see the warnings above. Exiting non-zero so the CI run "
            "itself shows as failed (check `gh run list`/`gh run view --log`), not just "
            "a warning buried in this log."
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
