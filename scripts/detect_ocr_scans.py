#!/usr/bin/env python3
"""
DRY RUN ONLY — scans every AC's source PDF for the "HiddenHorzOCR" font
signature (and similar known OCR-layer font names). This is a reliable,
mechanical fingerprint: Adobe Acrobat's "searchable image"/ClearScan OCR
feature (and similar tools) embeds an invisible text layer under this exact
font name over a scanned raster image — its presence means the document's
extractable text was machine-guessed from a scan, not a real digital text
layer, so any garbling in it (AC 00-31A: "OESCRtPTION", "Hfgh frequency
Omnfdirectfonal Radfo Range") is inherent OCR misreading of old paper, not a
FlyRegs extraction bug. Confirmed via PyMuPDF get_fonts() + verifying real
embedded raster images are present alongside it.

This scan exists to get an honest denominator — how many ACs in the catalog
are affected — rather than guessing from garbled-text heuristics.

Usage:
  python3 scripts/detect_ocr_scans.py                # full corpus scan
  python3 scripts/detect_ocr_scans.py --doc=00-31A    # one AC, verbose
"""

import argparse
import io
import json
import os

import fitz
import requests

SCRAPER_ENV = os.path.join(os.path.dirname(__file__), "..", ".env.scraper")

OCR_FONT_NAMES = {"HiddenHorzOCR", "HiddenVertOCR", "GlyphLessFont"}


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


def is_ocr_scan(pdf_bytes: bytes) -> tuple[bool, int]:
    """Returns (has_ocr_font, pages_checked_with_ocr_font)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    ocr_pages = 0
    # Checking every page of a 700-page AC would be slow; the OCR font is
    # embedded in the shared resource dict, so it reliably shows up within
    # the first several pages of an affected document.
    for page in doc[: min(10, len(doc))]:
        fonts = {f[3] for f in page.get_fonts()}
        if fonts & OCR_FONT_NAMES:
            ocr_pages += 1
    doc.close()
    return ocr_pages > 0, ocr_pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Inspect a single AC by document_number, verbose output")
    args = ap.parse_args()

    if args.doc:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?document_number=eq.{args.doc}&select=document_number,pdf_url_cached",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"No AC found for {args.doc}")
            return
        ac = rows[0]
        pdf_bytes = requests.get(ac["pdf_url_cached"], timeout=60).content
        has_ocr, pages = is_ocr_scan(pdf_bytes)
        print(f"{ac['document_number']}: OCR-scan signature = {has_ocr} ({pages} of first 10 pages)")
        return

    acs = []
    page_size = 50
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=document_number,pdf_url_cached&pdf_url_cached=not.is.null"
            f"&order=document_number.asc&limit={page_size}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        acs.extend(batch)
        offset += page_size
    print(f"Scanning {len(acs)} ACs...")

    affected = []
    for n, ac in enumerate(acs):
        try:
            pdf_bytes = requests.get(ac["pdf_url_cached"], timeout=60).content
            has_ocr, pages = is_ocr_scan(pdf_bytes)
        except Exception as e:
            print(f"[{n}] {ac['document_number']}: ERROR {e}")
            continue
        if has_ocr:
            affected.append(ac["document_number"])
        if n % 50 == 0:
            print(f"  ...{n}/{len(acs)} scanned, {len(affected)} OCR-scanned so far")

    report = {"acs_scanned": len(acs), "acs_affected": len(affected), "affected": affected}
    out_path = os.path.join(os.path.dirname(__file__), "..", "ocr_scans_report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nDone. {len(affected)} ACs are OCR-scanned sources.")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
