#!/usr/bin/env python3
"""One-off helper for task #365's per-doc overrides: given a doc number and
a list of short raw-text anchors, finds which real PDF page each anchor
falls on and renders that page to a PNG for Vision review. Read-only
(downloads the PDF, never writes to the DB).

Usage: python3 scripts/find_and_render_pages.py <document_number> "<anchor1>" "<anchor2>" ...
"""
import sys
import os
import re
import requests
import fitz

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import SUPABASE_URL, HEADERS


def main():
    doc_num = sys.argv[1]
    anchors = sys.argv[2:]
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{doc_num}&select=id,pdf_url_cached,pdf_url_faa",
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        print(f"{doc_num} not found")
        return
    pdf_url = rows[0].get("pdf_url_cached") or rows[0].get("pdf_url_faa")
    pdf_bytes = requests.get(pdf_url, timeout=60).content
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    out_dir = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/fb0fe8d6-07c8-499c-a30e-658ec34c05a2/scratchpad/ac_pages"
    os.makedirs(out_dir, exist_ok=True)

    for anchor in anchors:
        found_page = None
        for i, page in enumerate(doc):
            text = page.get_text()
            norm = re.sub(r"\s+", " ", text)
            if re.sub(r"\s+", " ", anchor) in norm:
                found_page = i
                break
        if found_page is None:
            print(f"NOT FOUND: {anchor!r}")
            continue
        pix = doc[found_page].get_pixmap(dpi=150)
        safe = re.sub(r"[^a-zA-Z0-9]", "_", anchor)[:40]
        out_path = os.path.join(out_dir, f"{re.sub(r'[^a-zA-Z0-9]', '_', doc_num)}_p{found_page+1}_{safe}.png")
        pix.save(out_path)
        print(f"{anchor!r} -> page {found_page+1} (0-indexed {found_page}) -> {out_path}")
    doc.close()


if __name__ == "__main__":
    main()
