#!/usr/bin/env python3
"""
Full-page Vision figure scan for scanned/OCR ACs with no reliable native
PDF text layer -- the text-search-based locator (llm_locate_missing_figures.py)
structurally can't work here since there's nothing to search. Built for the
3-doc residual (38-1, 20-30B, 20-68B) found while closing out BB-062: these
are genuine scans, a different problem class than the other 179 (which are
normal digitally-parsed PDFs).

Renders every page (reusing cached PNGs under scratch/ocr_rebuild/<doc>/pages/
if present, e.g. 38-1's leftover from the earlier pdf_text Vision rebuild),
asks Vision once per page whether it contains a real figure/table, and adds
a row for each one found. Never touches pdf_text.

Usage: python3 scripts/llm_scan_scanned_doc_figures.py --doc=38-1
"""
from __future__ import annotations
import argparse
import base64
import os
import re
import sys
from pathlib import Path

import anthropic
import fitz
import requests

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import SUPABASE_URL, HEADERS, slugify

MODEL = "claude-sonnet-5"
RENDER_DPI = 150
SCRATCH_ROOT = Path(__file__).resolve().parent.parent / "scratch" / "ocr_rebuild"

SCAN_PROMPT = """This is one page of an FAA Advisory Circular (a scanned document). Look at the actual page image.

Does this page contain a REAL figure, table, chart, or diagram with its own caption -- not just body text? If yes, respond in exactly this format (one line):
LABEL: <exact caption, e.g. "Figure 6-1. Corrosion Cell Diagram" or "Table 5.1. Inspection Intervals">

If there are multiple distinct figures/tables on this page, list each on its own line in that format.
If this page has no real figure/table (just body text, a title page, table of contents, etc.), respond with exactly: NONE
"""


def load_env_file(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_anthropic_client():
    env = load_env_file(os.path.join(os.path.dirname(__file__), "..", ".env.anthropic"))
    return anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])


LABEL_LINE_RE = re.compile(r"^LABEL:\s*(.+)$", re.MULTILINE)
CAPTION_LABEL_RE = re.compile(r"^(Figure|Table)\s+([A-Za-z]{0,3}\d+[A-Za-z]?(?:[-.·]\d+[A-Za-z]?)?)\.?\s*(.*)$", re.IGNORECASE)


def normalize_label(kind, num):
    return f"{kind.title()} {num.replace('·', '-')}"


def scan_page(client, png_bytes: bytes):
    b64 = base64.standard_b64encode(png_bytes).decode("utf-8")
    message = client.messages.create(
        model=MODEL, max_tokens=400,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": SCAN_PROMPT},
        ]}],
    )
    text = "".join(b.text for b in message.content if b.type == "text").strip()
    if text.upper() == "NONE":
        return []
    results = []
    for line in LABEL_LINE_RE.findall(text):
        m = CAPTION_LABEL_RE.match(line.strip())
        if m:
            kind, num, _rest = m.groups()
            results.append((normalize_label(kind, num), line.strip()))
    return results


def existing_labels(ac_id: str) -> set:
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=label", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return {r["label"] for r in resp.json()}


def upload_png(doc_num: str, label: str, png_bytes: bytes) -> str:
    fname = f"{re.sub(r'[^a-zA-Z0-9-_.]', '_', doc_num)}/{slugify(label)}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/ac-figures/{fname}"
    resp = requests.put(url, headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"}, data=png_bytes, timeout=60)
    resp.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/ac-figures/{fname}"


def insert_figure_row(row: dict):
    resp = requests.post(f"{SUPABASE_URL}/rest/v1/ac_figures", headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"}, json=row, timeout=30)
    resp.raise_for_status()


def get_page_png(doc_num: str, pdf_bytes: bytes, page_1indexed: int) -> bytes:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", doc_num)
    cached = SCRATCH_ROOT / safe / "pages" / f"page_{page_1indexed:03d}.png"
    if cached.exists():
        return cached.read_bytes()
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pix = doc[page_1indexed - 1].get_pixmap(dpi=RENDER_DPI)
    png = pix.tobytes("png")
    doc.close()
    return png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    resp = requests.get(f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{args.doc}&select=id,document_number,pdf_url_cached,pdf_url_faa", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        print(f"{args.doc}: not found")
        return
    ac = rows[0]
    pdf_url = ac.get("pdf_url_cached") or ac.get("pdf_url_faa")
    pdf_bytes = requests.get(pdf_url, timeout=60).content
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    npages = doc.page_count
    doc.close()

    existing = existing_labels(ac["id"])
    print(f"{args.doc}: {npages} pages, {len(existing)} existing figure row(s)")

    client = None if args.dry_run else get_anthropic_client()
    added = 0
    sort_order = 1000
    for p in range(1, npages + 1):
        png = get_page_png(args.doc, pdf_bytes, p)
        if args.dry_run:
            print(f"  p{p}: [DRY RUN] would scan")
            continue
        try:
            found = scan_page(client, png)
        except Exception as e:
            print(f"  p{p}: ERROR {e}")
            continue
        for label, caption in found:
            if label in existing:
                print(f"  p{p}: {label} -- already have a row, skipping")
                continue
            image_url = upload_png(args.doc, label, png)
            insert_figure_row({
                "ac_id": ac["id"], "label": label, "caption": caption,
                "page": p, "image_url": image_url, "sort_order": sort_order,
            })
            sort_order += 1
            existing.add(label)
            added += 1
            print(f"  p{p}: ADDED {label} -- \"{caption}\"")

    print(f"\n{args.doc}: done. {added} new figure(s)/table(s) added. {npages} Vision call(s) made ({'dry run' if args.dry_run else 'real'}).")


if __name__ == "__main__":
    main()
