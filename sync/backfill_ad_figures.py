#!/usr/bin/env python3
"""Backfills ad_figures: renders full-page images for the SPECIFIC pages of
an AD's source PDF that contain a real embedded graphic the text-only
pipeline couldn't capture -- not the whole document, and not every AD
that merely mentions "Table N" in prose.

v3 (2026-08-02) -- two real bugs found live and fixed in this version:

1. v1 rendered every page of any candidate AD. RC caught the real cost:
   most of an AD's pages are plain prose already fully captured in
   body_text, and showing them as "Tables & Figures" thumbnails reads as
   broken padding, not a real gap being filled.

2. v2 tried to fix that using body_text's own literal "[[Page NNNN]]"
   Federal Register page-break markers to compute an exact page_index per
   mention, counting markers before each match. Also wrong, for two
   independent reasons RC's own live testing surfaced:

   a. body_text's first character is NOT page_index 0 of the real PDF --
      the scraper strips the administrative preamble (docket number,
      DEPARTMENT OF TRANSPORTATION header, SUMMARY/DATES/ADDRESSES
      boilerplate) before storing body_text, and that preamble can span
      several real PDF pages with zero page-break markers of their own
      inside body_text. A naive "0 markers before this match = page 0"
      undercounted by exactly that many stripped pages every time.
      Fixed by anchoring from the END instead: the LAST marker's segment
      reliably extends to the real PDF's last page (nothing gets
      stripped from the end), so `offset = total_pdf_pages - num_markers
      - 1` gives the correct page_index for the "before any marker"
      segment, and every subsequent marker-segment is offset+1 from
      there. Verified against two independent real ADs by rendering
      every page and visually confirming the formula's predicted page
      actually contains the cited content, not an adjacent one.

   b. Bare "Table N" / "Figure N" mentions are NOT a reliable signal that
      real embedded content exists in THIS AD's own PDF at all -- most
      "Table N" mentions turn out to be prose citations to a table
      inside an EXTERNAL, incorporated-by-reference document (a GE/
      Boeing service bulletin, not the AD itself), with zero visual
      content anywhere in the AD's own PDF to render. The one reliable
      signal that real, unrepresentable visual content exists in the
      AD's OWN pdf_url is the literal "[GRAPHIC]" marker -- that only
      appears where the FAA's own PDF-to-text extraction hit something
      it couldn't linearize into text, i.e. a real embedded image. A
      "Table N" mention with no GRAPHIC nearby means the data is either
      external (nothing to render) or already fully readable as plain
      text in body_text (rendering it as an image too would be
      redundant, not a gap). Narrowed candidate detection to [GRAPHIC]
      only.

Safe to re-run: skips any ad_number that already has rows in ad_figures.

Usage: python3 sync/backfill_ad_figures.py [--limit N]
"""
import argparse
import os
import re
import time

import fitz
import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
KEY = SCRAPER["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
BUCKET = "reg-tf-images"

GRAPHIC_RE = re.compile(r"\[GRAPHIC\]")
PAGE_MARKER_RE = re.compile(r"\[\[Page\s+\d+\]\]")


def pages_with_graphics(body: str, total_pdf_pages: int) -> set[int]:
    """Maps every [GRAPHIC] mention to its real page_index. Anchors from
    the end of the document (see module docstring, point 2a) since the
    scraped body_text's own start doesn't correspond to the real PDF's
    page 0 -- preamble pages get stripped before body_text begins, but
    nothing gets stripped from the end, so the LAST marker segment
    reliably maps to the real last page."""
    markers = [m.start() for m in PAGE_MARKER_RE.finditer(body)]
    offset = total_pdf_pages - len(markers) - 1
    pages = set()
    for m in GRAPHIC_RE.finditer(body):
        count = sum(1 for pos in markers if pos < m.start())
        page_idx = offset + count
        if 0 <= page_idx < total_pdf_pages:
            pages.add(page_idx)
    return pages


def fetch_candidates():
    """Only ADs whose body_text contains a literal [GRAPHIC] marker --
    see module docstring, point 2b, for why bare "Table N"/"Figure N"
    mentions alone are not a reliable signal of real embedded content."""
    out = []
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/airworthiness_directives", headers=HEADERS,
            params={"select": "ad_number,pdf_url,body_text", "limit": 1000, "offset": offset},
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        for row in batch:
            body = row.get("body_text") or ""
            if row.get("pdf_url") and "[GRAPHIC]" in body:
                out.append({"ad_number": row["ad_number"], "pdf_url": row["pdf_url"], "body_text": body})
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def fetch_already_done():
    done = set()
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/ad_figures", headers=HEADERS,
            params={"select": "ad_number", "limit": 1000, "offset": offset}, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        done.update(row["ad_number"] for row in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return done


def upload_png(ad_number, page_idx, png_bytes):
    fname = f"ad/{ad_number}/page-{page_idx}.png"
    r = requests.put(
        f"{URL}/storage/v1/object/{BUCKET}/{fname}",
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes, timeout=60,
    )
    r.raise_for_status()
    return f"{URL}/storage/v1/object/public/{BUCKET}/{fname}"


def process_one(ad_number, pdf_url, body_text):
    resp = requests.get(pdf_url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    doc = fitz.open(stream=resp.content, filetype="pdf")
    pages = pages_with_graphics(body_text, doc.page_count)
    rows = []
    for i in sorted(pages):
        pix = doc[i].get_pixmap(dpi=150)
        png = pix.tobytes("png")
        image_url = upload_png(ad_number, i, png)
        rows.append({"ad_number": ad_number, "page_index": i, "image_url": image_url, "sort_order": i})
    doc.close()
    if rows:
        r = requests.post(
            f"{URL}/rest/v1/ad_figures",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            json=rows, timeout=30,
        )
        r.raise_for_status()
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="process at most N candidate ADs (for testing)")
    args = ap.parse_args()

    candidates = fetch_candidates()
    done = fetch_already_done()
    todo = [c for c in candidates if c["ad_number"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(candidates)} candidate ADs (real [GRAPHIC] content), {len(done)} already done, {len(todo)} to process this run", flush=True)

    ok, empty, failed = 0, 0, []
    for i, c in enumerate(todo):
        try:
            n = process_one(c["ad_number"], c["pdf_url"], c["body_text"])
            if n:
                ok += 1
            else:
                empty += 1  # GRAPHIC present but offset math found no valid in-range page -- rare, worth knowing about
            print(f"[{i + 1}/{len(todo)}] {c['ad_number']}: {n} page(s)", flush=True)
        except Exception as e:
            failed.append((c["ad_number"], str(e)))
            print(f"[{i + 1}/{len(todo)}] {c['ad_number']}: FAILED - {e}", flush=True)
        time.sleep(0.5)  # polite pacing against govinfo.gov

    print(f"\nDone: {ok} succeeded, {empty} matched but resolved to zero pages, {len(failed)} failed", flush=True)
    if failed:
        print("Failed ADs:")
        for ad_number, err in failed:
            print(f"  {ad_number}: {err}")


if __name__ == "__main__":
    main()
