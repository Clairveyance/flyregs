#!/usr/bin/env python3
"""Corpus-wide search for a table-header/data column-count mismatch --
RC, real device, 2026-08-31: "check 93.123. it looks like some data is
missing from the chart. it has several columns but no ref as to what
those numbers mean."

Root cause (see far_scraper.py's/cfr49_scraper.py's/aim_scraper.py's own
_render_table() comments): a table-flattening bug used to drop any EMPTY
cell from a row before joining it into pipe-delimited text -- correct for a
row that's genuinely, entirely empty, wrong for a row with a real but
BLANK leading cell (a common CFR/AIM convention when row labels, like the
93.123 JFK table's hour values, are self-evident without a column name).
Dropping that one cell shifts every later header left by one position out
of alignment with its data columns. Fixed at the source (2026-08-31); this
script finds every section ALREADY IN THE DATABASE from before that fix,
by comparing each header row's cell count against the very next data row's
cell count in the same table block.

A second, more severe sibling bug was found investigating the same report:
far_scraper.py's and cfr49_scraper.py's own copy of the TABLE_HEADER_MARK
constant was an empty string, not the real U+E000 marker aim_scraper.py
correctly uses -- meaning no FAR or CFR49 table has ever carried an
explicit header marker at all. This script also reports, per table, whether
a real header line exists (marked with U+E000) so that gap is visible too.

Usage: python3 scripts/audit_table_header_alignment.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from author_fact_deck import mgmt_sql

TABLE_HEADER_MARK = chr(0xE000)

SOURCES = [
    ("far_sections", "section_number"),
    ("aim_paragraphs", "paragraph_number"),
    ("cfr49_sections", "section_number"),
]


def cell_count(line: str) -> int:
    return len([c for c in line.split(" | ")])


def find_table_blocks(body_text: str) -> list[list[str]]:
    """A table block is a maximal run of consecutive pipe-delimited lines
    (a genuine "Col A | Col B" line, not a paragraph that merely contains
    a stray ' | ' inside prose -- real table lines from _render_table are
    ALWAYS full lines, one row per line, so this is unambiguous here)."""
    lines = body_text.split("\n")
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        stripped = line.lstrip(TABLE_HEADER_MARK)
        if " | " in stripped:
            current.append(line)
        else:
            if len(current) >= 2:
                blocks.append(current)
            current = []
    if len(current) >= 2:
        blocks.append(current)
    return blocks


def analyze_block(block: list[str]) -> dict | None:
    """Returns a finding dict if this block's header row has FEWER cells
    than the data rows beneath it, else None. Only checks the case that
    matches the confirmed bug (header short by exactly the leading-blank-
    cell shape) -- a header with MORE cells than data is a different (or
    non-) issue, not this one, and not flagged here.

    A real U+E000-marked header line is used when present (AIM, 43/49
    tables). far_sections and cfr49_sections have ZERO marked headers at
    all -- the same root bug this script exists to find also means the
    marker itself was never written for either source (see this script's
    own module docstring) -- so for those, and for the 6 unmarked AIM
    tables, the first line of the block is the only candidate a reader
    would treat as the header anyway, and is used as one here too."""
    header_line = None
    data_lines = []
    for line in block:
        if line.startswith(TABLE_HEADER_MARK):
            header_line = line[len(TABLE_HEADER_MARK):]
        elif header_line is None and not data_lines:
            # First unmarked line of the block -- the fallback candidate
            # header when no real U+E000 mark exists anywhere in it.
            header_line = line
        else:
            data_lines.append(line)
    if header_line is None or not data_lines:
        return None
    header_cells = cell_count(header_line)
    data_cell_counts = [cell_count(d) for d in data_lines]
    # Flag only when EVERY data row has the same, larger count -- a mixed
    # or inconsistent shape is a different problem this script isn't
    # trying to diagnose, and flagging it here would be a guess.
    if all(c == data_cell_counts[0] for c in data_cell_counts) and data_cell_counts[0] > header_cells:
        return {
            "header": header_line,
            "header_cells": header_cells,
            "data_cells": data_cell_counts[0],
            "sample_row": data_lines[0],
        }
    return None


def main():
    total_findings = 0
    for table, id_col in SOURCES:
        rows = mgmt_sql(f"select {id_col} as id, body_text from {table} where body_text like '%|%'")
        has_marker = mgmt_sql(
            f"select count(*) as n from {table} where body_text like '%' || chr(57344) || '%'"
        )[0]["n"]
        print(f"\n=== {table} ({len(rows)} sections/paragraphs with a '|' present, "
              f"{has_marker} contain a real U+E000 header mark) ===")
        findings_here = 0
        for row in rows:
            blocks = find_table_blocks(row["body_text"])
            for block in blocks:
                finding = analyze_block(block)
                if finding:
                    findings_here += 1
                    total_findings += 1
                    print(f"  {row['id']}: header has {finding['header_cells']} cell(s) "
                          f"(\"{finding['header']}\"), but every data row has "
                          f"{finding['data_cells']} -- e.g. \"{finding['sample_row']}\"")
        if findings_here == 0:
            print("  none found")

    print(f"\n{'='*70}\nTOTAL misaligned table(s) found: {total_findings}")
    return total_findings


if __name__ == "__main__":
    sys.exit(0 if main() >= 0 else 1)
