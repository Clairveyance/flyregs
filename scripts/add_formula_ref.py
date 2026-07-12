#!/usr/bin/env python3
"""Flags one page of an AC as containing a formula too complex/structurally
lost for our OCR+parser pipeline to reliably reproduce as text (nested
fractions, summations, trig functions, square roots) -- lets a reader jump
straight to the real page image instead of trusting a possibly-wrong
transcription.

Deliberately separate from ac_figures / scripts/extract_figures.py (Figures &
Tables): different table (ac_formula_refs), different Storage bucket
(ac-formula-refs), different UI component (FormulaRefViewer.tsx). This never
touches the T&F extraction/display pipeline. See flyregs_parser.md's
"Zero-text ACs" section for why this can't be a reliable automated heuristic
-- populated manually, one page at a time, whenever a complex formula is
found during quality review (started with AC 38-1, 2026-07-11).

Usage:
  python3 scripts/add_formula_ref.py <document_number> <page_number> "<label>" ["<note>"]

Example:
  python3 scripts/add_formula_ref.py 38-1 42 "Earth radius at test latitude (A3-1.2)" \\
    "Nested square root of a ratio of squared trig terms -- OCR flattened the layout entirely"
"""
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
HEADERS = {
    "apikey": ENV["SUPABASE_SERVICE_KEY"],
    "Authorization": f"Bearer {ENV['SUPABASE_SERVICE_KEY']}",
}


def slugify(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    doc_num = sys.argv[1]
    page = int(sys.argv[2])
    label = sys.argv[3]
    note = sys.argv[4] if len(sys.argv) > 4 else None

    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars"
        f"?document_number=eq.{doc_num}&select=id,pdf_url_cached,pdf_url_faa",
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        print(f"AC {doc_num} not found.")
        sys.exit(1)
    ac_id = rows[0]["id"]
    pdf_url = rows[0]["pdf_url_cached"] or rows[0]["pdf_url_faa"]
    if not pdf_url:
        print(f"AC {doc_num} has no PDF URL.")
        sys.exit(1)

    pdf_resp = requests.get(pdf_url, timeout=60)
    pdf_resp.raise_for_status()
    doc = fitz.open(stream=pdf_resp.content, filetype="pdf")
    if page < 1 or page > len(doc):
        print(f"Page {page} out of range (AC has {len(doc)} pages).")
        sys.exit(1)
    pix = doc[page - 1].get_pixmap(dpi=150)
    png_bytes = pix.tobytes("png")
    doc.close()

    fname = f"{re.sub(r'[^a-zA-Z0-9-_.]', '_', doc_num)}/{slugify(label)}.png"
    upload_resp = requests.put(
        f"{SUPABASE_URL}/storage/v1/object/ac-formula-refs/{fname}",
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes, timeout=60,
    )
    upload_resp.raise_for_status()
    image_url = f"{SUPABASE_URL}/storage/v1/object/public/ac-formula-refs/{fname}"

    insert_resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/ac_formula_refs",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=representation"},
        json={"ac_id": ac_id, "page": page, "label": label, "note": note, "image_url": image_url},
        timeout=30,
    )
    insert_resp.raise_for_status()
    print(f"Added formula ref for {doc_num} page {page}: {label}")
    print(f"  image: {image_url}")


if __name__ == "__main__":
    main()
