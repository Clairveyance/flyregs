#!/usr/bin/env python3
"""
AIM PDF Table-Header Recovery
==============================
The FAA's HTML edition of the AIM (scraped by aim_scraper.py) genuinely
omits header text for some tables — confirmed by direct inspection: the
header <td> cells are empty in the raw HTML, the live browser-rendered
DOM, and there's no CSS ::before injection or hidden sibling carrying it.
This is a real gap in the FAA's own HTML export, not a scraping bug —
their PDF edition of the same content DOES have the header text.

This script extracts every table's header row(s) from the official AIM
PDF (a real text-layer document, not scanned — no OCR/Vision needed) via
PyMuPDF's structured table detection, and writes a lookup keyed by
normalized table TITLE (not TBL number — confirmed live that the PDF and
HTML editions number the same table differently, e.g. HTML's "TBL 2-1-8"
is the PDF's "TBL 2-1-1") to aim_pdf_table_headers.json.

aim_scraper.py loads this file and uses it to backfill a real header for
any table it finds with no <thead> of its own, instead of rendering that
table with no header at all.

Usage:
  python build_aim_pdf_headers.py <path-to-aim.pdf>
"""
from __future__ import annotations

import json
import re
import sys

import fitz  # PyMuPDF

CAPTION_RE = re.compile(r"^TBL\s+[\d\-−]+\s*\n(.+)$", re.DOTALL)


def normalize_title(title: str) -> str:
    # See build_aim_pdf_pages.py's identical helper for why — PDF text
    # extraction uses a real minus sign / en-dash where the HTML source
    # has a plain hyphen, and that silent difference broke otherwise
    # perfect title matches.
    t = re.sub(r"[‐‑‒–—−]", "-", title)
    t = re.sub(r"[‘’‛]", "'", t)
    return re.sub(r"\s+", " ", t.strip().lower())


def extract_header_rows(rows: list[list]) -> list[list[str]] | None:
    """Row 0 is always a header-row candidate (pymupdf's own detector
    already treats it that way). Row 1 is included too ONLY when it's
    sparsely filled — a real second header row (sub-column labels sitting
    under a merged/colspan cell, e.g. "3 Clicks"/"5 Clicks"/"7 Clicks"
    under "Intensity Step Selected...") leaves the already-labeled columns
    empty, whereas a genuine DATA row fills every column. A first version
    used "average cell text length" as the signal instead, which wrongly
    swallowed the table's first real data row too — short data values
    ("Off", "2", "High") are just as short as header labels, so length
    alone can't tell them apart; sparseness can."""
    if not rows or not any(rows[0]):
        return None
    header_rows = [rows[0]]
    if len(rows) > 1:
        second = rows[1]
        non_none = sum(1 for c in second if c)
        if 0 < non_none < len(second):
            header_rows.append(second)
    return header_rows


def merge_header_rows(header_rows: list[list]) -> list[str]:
    """Flattens 1-3 header rows into one row per column. A merged/colspan
    label in an earlier row (e.g. "Intensity Step Selected Per No. of Mike
    Clicks" spanning 3 columns) is combined with that column's own
    sub-label from a later row ("3 Clicks") rather than one silently
    overwriting the other — confirmed live this table shape is common
    (AIM light-signal/lighting-intensity tables)."""
    col_count = max(len(r) for r in header_rows)
    merged = []
    for ci in range(col_count):
        parts = []
        for r in header_rows:
            if ci < len(r) and r[ci]:
                val = r[ci].replace("\n", " ").strip()
                if val and (not parts or parts[-1] != val):
                    parts.append(val)
        merged.append(" — ".join(parts))
    return merged


def main():
    if len(sys.argv) < 2:
        print("Usage: python build_aim_pdf_headers.py <path-to-aim.pdf>")
        sys.exit(1)

    doc = fitz.open(sys.argv[1])
    lookup: dict[str, dict] = {}
    total_tables = 0

    for page_idx in range(doc.page_count):
        page = doc[page_idx]
        blocks = page.get_text("blocks")
        captions = []
        for b in blocks:
            x0, y0, x1, y1, text = b[0], b[1], b[2], b[3], b[4]
            m = CAPTION_RE.match(text.strip())
            if m:
                captions.append((y1, normalize_title(m.group(1))))

        if not captions:
            continue

        # Tried 'text' strategy (catches ~5x more raw tables per page than
        # the default 'lines', which requires visible ruled gridlines) —
        # rejected after checking live: even with the caption-proximity
        # filter below, it detected FEWER usable headers overall (9 vs 88),
        # because 'text' strategy's looser table-boundary detection also
        # throws off the header/data-row split heuristic below on tables it
        # does find. Default 'lines' strategy is lower-coverage but every
        # recovery from it has been checked and is correct — a smaller
        # verified-accurate set beats a larger noisier one for this.
        try:
            found = page.find_tables()
        except Exception as e:
            print(f"  page {page_idx}: find_tables failed: {e}")
            continue

        for table in found.tables:
            total_tables += 1
            table_y0 = table.bbox[1]
            # Closest caption strictly above this table's top edge.
            # Capped at 80pt — a real caption sits right above its table
            # (~7-30pt gap in every real example checked); anything farther
            # is almost certainly a coincidental match to some OTHER
            # caption higher up the page, not this table's own, and is
            # exactly the kind of false positive 'text' strategy risks
            # (see the comment on find_tables() above).
            candidates = [(table_y0 - cy1, title) for cy1, title in captions if 0 <= table_y0 - cy1 <= 80]
            if not candidates:
                continue
            candidates.sort()
            _, title = candidates[0]

            try:
                rows = table.extract()
            except Exception:
                continue
            header_rows = extract_header_rows(rows)
            if not header_rows:
                continue
            merged = merge_header_rows(header_rows)
            if not any(merged):
                continue

            lookup[title] = {
                "header": merged,
                "page": page_idx,
                "col_count": table.col_count,
            }

        if page_idx % 100 == 0:
            print(f"  ...page {page_idx}/{doc.page_count}, {len(lookup)} headers recovered so far")

    print(f"Done. {total_tables} tables scanned, {len(lookup)} distinct headers recovered.")
    with open("aim_pdf_table_headers.json", "w") as f:
        json.dump(lookup, f, indent=1)
    print("Wrote aim_pdf_table_headers.json")


if __name__ == "__main__":
    main()
