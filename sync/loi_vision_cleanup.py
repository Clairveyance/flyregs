#!/usr/bin/env python3
"""
LOI Vision Cleanup — targeted OCR-corruption fix
========================================
Confirmed live (2026-07-29): unlike the AC pipeline's vision-recovery gate
(which detects EXTRACTION FAILURE -- near-empty pages from a flattened
PDF), the LOI corpus's problem is different: text extracts fine by volume
(avg ~2,584 chars/page, well above any "thin page" floor) but is
character-level GARBLED from the scan/OCR pass itself -- e.g. "Departm:ent",
"Fda:rat Aviation Administtatlon", "Sut'ject:". A char-count-based gate
would never catch this. This module builds the equivalent cost-reduction
gate for THIS failure mode: three independent regex signatures for the
garbling pattern, scored per 1,000 chars so document length doesn't skew
the signal.

Confirmed live scanning all 1,055 LOIs (free -- runs against body_text
already in the DB, no API calls): 153 documents (14.5%) flag, not the
whole corpus. Est. ~366 pages -> ~$4-9 at the AC pipeline's own measured
$0.012/page rate. Authorized by the user 2026-07-29 after that estimate.

Whole-document (not per-page) vision re-transcription is used per flagged
doc -- LOIs average 2.4 pages, so page-level surgical targeting (worthwhile
for a 50-page AC) adds complexity for negligible savings here.

After a body_text rewrite, citation extraction is re-run on the CLEAN text
and document_citations rewritten (delete-then-insert, same pattern as
loi_scraper.py) -- clean text may resolve citations the OCR-tolerant
extractor still couldn't recover from heavily garbled originals.

Usage:
  python3 loi_vision_cleanup.py --scan-only          # just report the flagged count, no spend
  python3 loi_vision_cleanup.py --dry-run --limit 3  # process 3 flagged docs, no DB writes
  python3 loi_vision_cleanup.py                      # full run against all flagged docs
  python3 loi_vision_cleanup.py --verify-sample 30   # spot-check N *unflagged* docs for misses
"""
from __future__ import annotations

import argparse
import base64
import logging
import os
import re
import sys
import time

import fitz  # PyMuPDF
import requests

sys.path.insert(0, os.path.dirname(__file__))
from loi_citation_extract import extract_far_citations

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

VISION_MODEL = "claude-sonnet-5"
VISION_RENDER_DPI = 150
VISION_EST_COST_PER_PAGE = 0.012
# Same philosophy as faa_scraper.py's VISION_MAX_PAGES_PER_RUN -- an
# independent hard stop so an unanticipated bug (e.g. every doc flagging)
# can't spend real money unbounded. 153 flagged docs * ~2.4 pages ~= 367 --
# 500 leaves headroom without being a blank check.
VISION_MAX_PAGES_PER_RUN = 500

MIDWORD_PUNCT_RE = re.compile(r'[a-zA-Z][:;>][a-zA-Z]')
DIGIT_MIDWORD_RE = re.compile(r'\b\w*ll\w*tt\w*\b|\b[A-Za-z]{2,}\d[A-Za-z]{2,}\b')
SPACED_DIGIT_RE = re.compile(r'\b\d\s+[a-zA-Z]\s*[\.\,]\s*\d')

VISION_TRANSCRIBE_PROMPT = """You are transcribing one page of an FAA Chief Counsel Legal Interpretation letter whose existing OCR text layer is corrupted (character-level garbling from the original scan) -- a regulatory document where exact wording, citation numbers, and punctuation matter.

Rules:
1. Transcribe the text EXACTLY as it appears on the page. Do not modernize spelling, do not "fix" grammar, do not paraphrase.
2. Preserve citation numbers, section symbols (§), and paragraph markers exactly as printed.
3. Preserve the document's own structure: letterhead, addressee block, salutation, body paragraphs, signature block.
4. If part of the page is genuinely illegible even to you, write [illegible] at that exact spot rather than guessing.
5. Output ONLY the transcription itself -- no preamble, no commentary.
"""


def is_garbled(text: str) -> tuple[bool, float]:
    if not text:
        return False, 0.0
    n = len(text) / 1000
    midword = len(MIDWORD_PUNCT_RE.findall(text))
    digit = len(DIGIT_MIDWORD_RE.findall(text))
    spaced = len(SPACED_DIGIT_RE.findall(text))
    rate = (midword + digit) / n
    spaced_rate = spaced / n
    return (rate > 0.5 or spaced_rate > 0.3), max(rate, spaced_rate)


def fetch_all_lois() -> list[dict]:
    out, offset = [], 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/legal_interpretations",
            headers=HEADERS,
            params={"select": "id,slug,title,body_text,pdf_url_cached", "limit": 1000, "offset": offset},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def fetch_known_far_sections() -> set[str]:
    sections: set[str] = set()
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/far_sections",
            headers=HEADERS,
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


def recover_via_vision(pdf_bytes: bytes, slug: str, client) -> str | None:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages_text = []
    for i in range(len(doc)):
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
            pages_text.append(text)
        except Exception as e:
            log.warning(f"    Vision failed for {slug} page {i + 1}: {e}")
            return None
    return "\n".join(pages_text)


def write_citations(loi_id: str, slug: str, citations: list[dict]) -> None:
    requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.loi", "citing_id": f"eq.{slug}"},
        timeout=15,
    )
    rows = [
        {"citing_type": "loi", "citing_id": slug, "cited_type": "far", "cited_id": c["section"],
         "label": ",".join(c["paragraphs"]) if c["paragraphs"] else None}
        for c in citations if c["resolved"]
    ]
    if not rows:
        return
    requests.post(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows, timeout=15,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan-only", action="store_true", help="Report flagged count/cost estimate, no spend")
    ap.add_argument("--dry-run", action="store_true", help="Process flagged docs but don't write to DB")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--verify-sample", type=int, default=None, help="Spot-check N unflagged docs, report if any look garbled anyway")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL / SUPABASE_SERVICE_KEY must be set.")
        return

    lois = fetch_all_lois()
    log.info(f"Loaded {len(lois)} LOIs.")

    flagged = []
    unflagged = []
    for r in lois:
        bad, rate = is_garbled(r.get("body_text") or "")
        (flagged if bad else unflagged).append((r, rate))

    log.info(f"Flagged: {len(flagged)} ({len(flagged)/len(lois)*100:.1f}%)  Unflagged: {len(unflagged)}")

    if args.verify_sample:
        import random
        sample = random.sample(unflagged, min(args.verify_sample, len(unflagged)))
        log.info(f"Spot-checking {len(sample)} UNFLAGGED docs for missed corruption...")
        for r, rate in sample:
            log.info(f"  {r['slug']}: rate={rate:.3f} (below threshold — should be clean)")
        return

    if args.scan_only:
        est_pages = sum(1 for _ in flagged) * 2.39
        log.info(f"Est pages: {est_pages:.0f}  Est cost: ${est_pages * VISION_EST_COST_PER_PAGE:.2f}")
        return

    if not ANTHROPIC_API_KEY:
        log.error("ANTHROPIC_API_KEY must be set to run vision recovery.")
        return

    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    known_far = fetch_known_far_sections()

    todo = flagged[:args.limit] if args.limit else flagged
    log.info(f"Processing {len(todo)} flagged docs...")

    pages_used = 0
    ok = 0
    errors = 0
    for i, (row, rate) in enumerate(todo, 1):
        slug = row["slug"]
        pdf_url = row.get("pdf_url_cached")
        if not pdf_url:
            log.warning(f"  [{i}] {slug}: no cached PDF URL, skipping")
            errors += 1
            continue
        try:
            pdf_resp = requests.get(pdf_url, timeout=30)
            pdf_resp.raise_for_status()
            pdf_bytes = pdf_resp.content
            page_count = fitz.open(stream=pdf_bytes, filetype="pdf").page_count

            if pages_used + page_count > VISION_MAX_PAGES_PER_RUN:
                log.warning(f"  [{i}] {slug}: would exceed {VISION_MAX_PAGES_PER_RUN}-page circuit breaker "
                            f"({pages_used} used already). Stopping run — rerun to continue.")
                break

            new_text = recover_via_vision(pdf_bytes, slug, client)
            if new_text is None:
                errors += 1
                continue
            pages_used += page_count

            still_bad, new_rate = is_garbled(new_text)
            citations = extract_far_citations(new_text, known_far)

            if args.dry_run:
                log.info(f"  [{i}] {slug}: {page_count}p, rate {rate:.2f}->{new_rate:.2f}"
                         f"{' STILL FLAGGED' if still_bad else ' clean'} (dry-run, no write)")
                ok += 1
                continue

            requests.patch(
                f"{SUPABASE_URL}/rest/v1/legal_interpretations",
                headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
                params={"id": f"eq.{row['id']}"},
                json={"body_text": new_text, "text_quality": "poor" if still_bad else "ocr"},
                timeout=30,
            )
            write_citations(row["id"], slug, citations)
            ok += 1
            log.info(f"  [{i}] {slug}: {page_count}p, rate {rate:.2f}->{new_rate:.2f}"
                     f"{' STILL FLAGGED after vision' if still_bad else ' clean'} "
                     f"({len([c for c in citations if c['resolved']])} FAR links)")
            time.sleep(0.3)
        except Exception as e:
            log.warning(f"  [{i}] {slug}: failed — {e}")
            errors += 1

    log.info(f"\nDone. {ok} processed, {errors} error(s), {pages_used} vision pages "
             f"(~${pages_used * VISION_EST_COST_PER_PAGE:.2f}).")


if __name__ == "__main__":
    main()
