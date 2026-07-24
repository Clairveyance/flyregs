#!/usr/bin/env python3
"""
Backfills aim_figures with real, cached page-images from the official AIM
PDF — same proven whole-page-render approach as
ac-app/scripts/extract_figures.py uses for ACs (see that file's docstring
for the full reasoning: rendering the whole page is more reliable than
trying to crop to a detected bounding box).

Two things this fixes, both confirmed live and directly reported by the
user:
  1. FIG entries whose HTML-sourced image_url is wrong — the FAA's own
     HTML for AIM 6-2-6 literally repeats the same <img src> across 7
     different captions ("Short Delay", "Drop Message", "Do Not Land
     Here"... all pointing at the same file). Re-pointed to a real,
     individually-correct page render instead.
  2. TBL entries (bare HTML <table> tables, currently only ever rendered
     as flattened pipe-text inside body_text, with no aim_figures row of
     their own at all) now get one, so they're viewable as a real page
     image via the same tap-to-view flow figures already have.

Matches AIM's own figure/table CAPTION text (not the FAA HTML's often-
duplicated LABEL, e.g. all of "FIG 6-2-6a".."FIG 6-2-6q") against
aim_pdf_pages.json's title-keyed lookup (built by build_aim_pdf_pages.py)
to find the right PDF page, independent of the two editions' different
numbering.

Usage:
  python backfill_aim_pdf_images.py --dry-run     # report only, no writes
  python backfill_aim_pdf_images.py                # do it for real
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

import fitz  # PyMuPDF
import requests

# Same convention as aim_scraper.py: read from the process environment
# rather than parsing .env.scraper directly, so this script works
# identically whether invoked locally (after `source .env.scraper`, same as
# sync_aim.sh does) or from GitHub Actions (where the workflow writes
# .env.scraper from repo secrets and sync_aim.sh sources it the same way).
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

BUCKET = "reg-tf-images"

# A handful of figures have NO usable caption text at all in the FAA's HTML
# source (confirmed live by checking the raw HTML: the <figcaption> is
# empty, or the "caption" is really just the image's own filename) — these
# can never be found via the normal title-lookup pass above, so they're
# hardcoded here instead. Every one was confirmed live against the PDF:
#   - FIG 5-4-9b/c/d: uncaptioned RNAV-approach diagram sub-panels sharing
#     the same PDF page as their captioned sibling FIG 5-4-9a (page 425).
#   - appendix_1 IMG 1-4: fragments of the single-page "Bird/Other Wildlife
#     Strike Report" scanned form (PDF page 720).
#   - appendix_4 IMG 2: the FAA Form 7233-4 continuation page (PDF page
#     750) — its own PDF caption text has no overlap with page 1's, so it
#     can't title-match either.
# Every scraper full-run resets these figures' image_url back to the raw
# (often duplicated/wrong) FAA HTML source, since the scraper has no way to
# know about the PDF page mapping — this pass re-applies the fix every time
# so it can't silently regress the way a one-off manual patch would.
KNOWN_UNCAPTIONED_FIGURES = {
    ("5-4-9", "FIG 5-4-9b"): 425,
    ("5-4-9", "FIG 5-4-9c"): 425,
    ("5-4-9", "FIG 5-4-9d"): 425,
    ("appendix_1", "IMG 1"): 720,
    ("appendix_1", "IMG 2"): 720,
    ("appendix_1", "IMG 3"): 720,
    ("appendix_1", "IMG 4"): 720,
    ("appendix_4", "IMG 2"): 750,
}


def normalize_title(title: str) -> str:
    # See build_aim_pdf_pages.py's identical helper for why — PDF text
    # extraction uses a real minus sign / en-dash where the HTML source
    # has a plain hyphen, and that silent difference broke otherwise
    # perfect title matches.
    t = re.sub(r"[‐‑‒–—−]", "-", title)
    t = re.sub(r"[‘’‛]", "'", t)
    return re.sub(r"\s+", " ", t.strip().lower())


def render_page(doc: fitz.Document, page_idx: int) -> bytes:
    page = doc[page_idx]
    pix = page.get_pixmap(dpi=150)
    return pix.tobytes("png")


def upload_png(page_idx: int, png_bytes: bytes) -> str:
    fname = f"aim/page-{page_idx:04d}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{fname}"
    resp = requests.put(
        url,
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes,
        timeout=60,
    )
    resp.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{fname}"


def fetch_existing_figures() -> list[dict]:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/aim_figures?select=id,paragraph_number,label,caption,image_url",
        headers=HEADERS,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def fetch_tbl_blocks_missing_figures(existing_captions_by_paragraph: dict) -> list[dict]:
    """Every TBL-captioned block in aim_paragraphs.body_text that has no
    aim_figures row at all yet (bare HTML <table> tables, previously only
    ever rendered as flattened text).

    "Already have" is checked by CAPTION, not by the bare "TBL X-X-X"
    label -- confirmed live as a real bug: multiple genuinely distinct
    tables in one paragraph all share that bare label (see
    _disambiguate_figure_labels()'s a/b/c suffixing in aim_scraper.py), so
    the row that actually exists in aim_figures is "TBL 1-1-17a", never
    the bare "TBL 1-1-17" this function used to compare against. That
    exact-match check could never succeed, so every re-run treated
    already-created tables as still-missing and tried to re-insert them
    under FRESH a/b/c suffixes -- a real 409 conflict against the rows
    the previous run already created. Caption text doesn't get suffixed
    and is what a table's real identity actually is here, so it's the
    reliable "have we already made this one" signal."""
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/aim_paragraphs?select=paragraph_number,body_text&body_text=not.is.null",
        headers=HEADERS,
        timeout=60,
    )
    resp.raise_for_status()
    out = []
    for row in resp.json():
        bt = row["body_text"] or ""
        for block in bt.split("\n\n"):
            lines = block.split("\n")
            first = lines[0].strip() if lines else ""
            m = re.match(r"^TBL\s+([\d\-]+)\.?\s*(.*)$", first)
            if not m:
                continue
            tbl_label = f"TBL {m.group(1)}"
            title = m.group(2).strip()
            if not title:
                continue
            has_piped = any(" | " in l for l in lines)
            if not has_piped:
                continue
            already_have = title in existing_captions_by_paragraph.get(row["paragraph_number"], [])
            if already_have:
                continue
            out.append({"paragraph_number": row["paragraph_number"], "label": tbl_label, "caption": title})
    return out


def update_figure_image(fig_id: str, image_url: str) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/aim_figures?id=eq.{fig_id}",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"image_url": image_url},
        timeout=30,
    )
    resp.raise_for_status()


def insert_new_figures(rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/aim_figures",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pdf", default="aim_full.pdf")
    args = ap.parse_args()

    # CWD-relative, not SCRIPT_DIR-relative — matches build_aim_pdf_pages.py,
    # which always writes aim_pdf_pages.json to CWD. sync_aim.sh runs both
    # scripts from the repo root, so this only works when invoked that way
    # (consistent with how sync.sh runs every AC step from the repo root).
    with open("aim_pdf_pages.json") as f:
        pdf_pages: dict = json.load(f)

    pdf_doc = fitz.open(args.pdf)
    page_png_cache: dict[int, bytes] = {}
    page_url_cache: dict[int, str] = {}

    def cached_image_for_page(page_idx: int) -> str:
        if page_idx not in page_url_cache:
            if page_idx not in page_png_cache:
                page_png_cache[page_idx] = render_page(pdf_doc, page_idx)
            page_url_cache[page_idx] = upload_png(page_idx, page_png_cache[page_idx])
        return page_url_cache[page_idx]

    existing = fetch_existing_figures()
    existing_captions_by_paragraph: dict[str, list[str]] = {}
    for f in existing:
        existing_captions_by_paragraph.setdefault(f["paragraph_number"], []).append(f["caption"])

    updated = 0
    unmatched_existing = []
    for fig in existing:
        title = normalize_title(fig["caption"] or "")
        match = pdf_pages.get(title)
        if not match:
            unmatched_existing.append(fig)
            continue
        new_url = f"[dry-run page {match['page']}]" if args.dry_run else cached_image_for_page(match["page"])
        if not args.dry_run:
            update_figure_image(fig["id"], new_url)
        updated += 1

    tbl_blocks = fetch_tbl_blocks_missing_figures(existing_captions_by_paragraph)
    new_rows = []
    unmatched_tbl = []
    for i, blk in enumerate(tbl_blocks):
        title = normalize_title(blk["caption"])
        match = pdf_pages.get(title)
        if not match:
            unmatched_tbl.append(blk["caption"])
            continue
        new_url = f"[dry-run page {match['page']}]" if args.dry_run else cached_image_for_page(match["page"])
        new_rows.append({
            "paragraph_number": blk["paragraph_number"],
            "label": blk["label"],
            "caption": blk["caption"],
            "image_url": new_url,
            "sort_order": i,
        })

    # Same disambiguation aim_scraper.py's _disambiguate_figure_labels()
    # already applies to FIG entries — multiple genuinely distinct tables
    # in one AIM paragraph all get the SAME synthetic "TBL X-X-X" label
    # (the HTML source numbers a table by its containing paragraph, not
    # individually), which caused a real 409 conflict on insert here: two
    # different tables, same (paragraph_number, label). Confirmed live
    # (paragraph 1-1-17 alone has "GPS IFR Equipment Classes/Categories"
    # AND "GPS Approval Required/Authorized Use" both wanting "TBL 1-1-17").
    groups: dict[tuple, list[dict]] = {}
    for row in new_rows:
        groups.setdefault((row["paragraph_number"], row["label"]), []).append(row)
    for (_, label), group in groups.items():
        if len(group) > 1:
            for i, row in enumerate(group):
                row["label"] = f"{label}{chr(ord('a') + i)}"

    if not args.dry_run:
        insert_new_figures(new_rows)

    known_fixed = 0
    for fig in existing:
        page_idx = KNOWN_UNCAPTIONED_FIGURES.get((fig["paragraph_number"], fig["label"]))
        if page_idx is None:
            continue
        new_url = f"[dry-run page {page_idx}]" if args.dry_run else cached_image_for_page(page_idx)
        if not args.dry_run:
            update_figure_image(fig["id"], new_url)
        known_fixed += 1

    still_unmatched = [
        f for f in unmatched_existing
        if (f["paragraph_number"], f["label"]) not in KNOWN_UNCAPTIONED_FIGURES
    ]
    print(f"Existing FIG entries: {len(existing)}, matched+re-pointed: {updated}, hardcoded-fix: {known_fixed}, unmatched: {len(still_unmatched)}")
    print(f"TBL blocks with no prior figure row: {len(tbl_blocks)}, matched+created: {len(new_rows)}, unmatched: {len(unmatched_tbl)}")
    print(f"Distinct PDF pages rendered: {len(page_png_cache)}")
    if still_unmatched:
        print("\nSample unmatched FIG captions:")
        for f in still_unmatched[:10]:
            print(" -", repr(f["caption"]), "|", f["paragraph_number"], "|", f["label"])
    if unmatched_tbl:
        print("\nSample unmatched TBL captions:")
        for c in unmatched_tbl[:10]:
            print(" -", repr(c))


if __name__ == "__main__":
    main()
