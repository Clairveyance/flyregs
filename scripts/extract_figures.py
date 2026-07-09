#!/usr/bin/env python3
"""
Extracts Figures & Tables from each AC's cached PDF into the ac_figures
table + ac-figures Storage bucket.

Why page-render instead of embedded-image extraction: many "figures" in FAA
ACs are vector-drawn charts or plain-text tables, not raster images — a
PyMuPDF get_images() pass on a real AC (20-191, 151 pages) only caught 17
embedded raster images total and missed every table entirely. Rendering the
matched page itself (150dpi PNG) captures figures, tables, and vector charts
identically and reliably, since it's just a snapshot of what's really there.

Caption detection: FAA ACs consistently start a figure/table's caption line
with the label itself ("Figure C-6 Maximum Error...", "Table C-5 Malfunction
..."), whereas inline cross-references read as prose ("...shown in Figure
3-1 above" — the label is never the first token on its line). Matching only
at the start of a stripped line is therefore a strong filter against false
positives from ordinary body-text references.

Usage:
  python3 scripts/extract_figures.py --doc=20-191     # one AC, prints what it found
  python3 scripts/extract_figures.py --all            # full catalog backfill
  python3 scripts/extract_figures.py --all --limit=20 # first 20 unprocessed ACs
"""

import argparse
import io
import os
import re
import sys

import fitz  # PyMuPDF
import requests

sys.path.insert(0, os.path.dirname(__file__))

SCRAPER_ENV = os.path.join(os.path.dirname(__file__), "..", ".env.scraper")


def load_env(path: str) -> dict:
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env(SCRAPER_ENV)
SUPABASE_URL = ENV["SUPABASE_URL"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

CAPTION_RE = re.compile(
    r"^(Figure|Table)\s+([A-Za-z]{0,3}\d+[A-Za-z]?(?:[-.]\d+[A-Za-z]?)?)\.?\s*(.*)$"
)


TOC_DOT_LEADER_RE = re.compile(r"\.{3,}")  # "....... C-9" — a List of Figures/Tables entry
BOLD_FLAG = 1 << 4  # PyMuPDF span flags bit for bold


def find_captions(pdf_bytes: bytes):
    """Yields (page_1indexed, label, caption) for each detected caption line.

    Two filters, both discovered empirically against a real AC (20-191):

    1. Skip "List of Figures"/"List of Tables" front-matter entries — they
       match the same "Figure X-Y ..." line shape as a real caption, but are
       followed by dot-leaders + a page reference (e.g. "....... C-9"), which
       a real in-body caption never has.

    2. Require the line's first text span to be bold. A real caption is
       consistently bold in these documents ("Figure C-6 Maximum Error...",
       confirmed via get_text("dict") span flags), while an inline prose
       reference to the same label ("...see Table C-5. If additional...")
       is plain text — even when it coincidentally starts a wrapped line.
       Without this, wrapped body text that happens to start a line with
       "Figure C-8 illustrates..." or "Table C-5 and Table C-6 give..."
       gets mistaken for a caption.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    seen_labels = set()
    for i, page in enumerate(doc):
        d = page.get_text("dict")
        for block in d["blocks"]:
            for line in block.get("lines", []):
                spans = line["spans"]
                if not spans:
                    continue
                text = "".join(s["text"] for s in spans).strip()
                if not text or TOC_DOT_LEADER_RE.search(text):
                    continue
                m = CAPTION_RE.match(text)
                if not m:
                    continue
                if not (spans[0]["flags"] & BOLD_FLAG):
                    continue
                kind, num, rest = m.groups()
                label = f"{kind} {num}"
                if label in seen_labels:
                    continue  # keep only the first (definition) occurrence
                seen_labels.add(label)
                yield (i + 1, label, rest.strip() or None)
    doc.close()


def render_page(pdf_bytes: bytes, page_1indexed: int) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[page_1indexed - 1]
    pix = page.get_pixmap(dpi=150)
    png_bytes = pix.tobytes("png")
    doc.close()
    return png_bytes


def slugify(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


def upload_png(doc_num: str, label: str, png_bytes: bytes) -> str:
    fname = f"{re.sub(r'[^a-zA-Z0-9-_.]', '_', doc_num)}/{slugify(label)}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/ac-figures/{fname}"
    resp = requests.put(
        url,
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes,
        timeout=60,
    )
    resp.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/ac-figures/{fname}"


def already_processed(ac_id: str) -> bool:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=id&limit=1",
        headers=HEADERS,
        timeout=30,
    )
    resp.raise_for_status()
    return len(resp.json()) > 0


def insert_figure_rows(rows: list):
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/ac_figures",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def process_ac(ac_id: str, doc_num: str, pdf_url: str, dry_run: bool = False) -> int:
    pdf_resp = requests.get(pdf_url, timeout=60)
    pdf_resp.raise_for_status()
    pdf_bytes = pdf_resp.content

    captions = list(find_captions(pdf_bytes))
    if not captions:
        return 0

    # Render each distinct page only once even if it has multiple captions.
    page_pngs = {}
    rows = []
    for order, (page, label, caption) in enumerate(captions):
        if dry_run:
            print(f"    p{page}: {label} — {caption or '(no caption text)'}")
            continue
        if page not in page_pngs:
            page_pngs[page] = render_page(pdf_bytes, page)
        image_url = upload_png(doc_num, label, page_pngs[page])
        rows.append(
            {
                "ac_id": ac_id,
                "label": label,
                "caption": caption,
                "page": page,
                "image_url": image_url,
                "sort_order": order,
            }
        )
    if not dry_run:
        insert_figure_rows(rows)
    return len(captions)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Process a single AC by document_number (dry run, no writes)")
    ap.add_argument("--all", action="store_true", help="Backfill all ACs with a cached PDF")
    ap.add_argument("--limit", type=int, default=None, help="Limit how many ACs to process with --all")
    args = ap.parse_args()

    if args.doc:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{args.doc}&select=id,document_number,pdf_url_cached",
            headers=HEADERS,
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"No AC found for document_number={args.doc}")
            return
        ac = rows[0]
        print(f"{ac['document_number']} (dry run — no DB/storage writes):")
        n = process_ac(ac["id"], ac["document_number"], ac["pdf_url_cached"], dry_run=True)
        print(f"  {n} caption(s) found")
        return

    if args.all:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?pdf_url_cached=not.is.null&select=id,document_number,pdf_url_cached"
            f"&order=document_number.asc",
            headers=HEADERS,
            timeout=60,
        )
        resp.raise_for_status()
        acs = resp.json()
        print(f"{len(acs)} ACs have a cached PDF")

        processed = 0
        total_figures = 0
        for ac in acs:
            if args.limit and processed >= args.limit:
                break
            if already_processed(ac["id"]):
                continue
            try:
                n = process_ac(ac["id"], ac["document_number"], ac["pdf_url_cached"])
                total_figures += n
                processed += 1
                print(f"[{processed}] {ac['document_number']}: {n} figure(s)/table(s)")
            except Exception as e:
                print(f"[{processed}] {ac['document_number']}: ERROR {e}")
        print(f"\nDone. Processed {processed} ACs, {total_figures} figures/tables total.")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
