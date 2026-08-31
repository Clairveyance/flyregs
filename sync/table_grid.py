"""Shared table-grid expansion for every scraper that flattens an HTML/XML
<TABLE> into this app's pipe-delimited text format.

WHY THIS MODULE EXISTS (2026-08-31)
-----------------------------------
far_scraper.py, aim_scraper.py and cfr49_scraper.py each grew their OWN
independent copy of a `_render_table()` helper. That duplication is not a
style problem, it is the direct cause of two separate real bugs:

  * The empty-cell-dropping bug (`cells = [c for c in cells if c]`) had to
    be found and fixed three times, once per copy.
  * `_TABLE_HEADER_MARK` was silently an EMPTY STRING in far_scraper.py and
    cfr49_scraper.py while aim_scraper.py had the correct U+E000 -- so no
    FAR or 49 CFR table ever carried a real header marker at all, for the
    entire life of the feature, and nothing caught it.

So the shared, easy-to-get-wrong part lives here exactly once. Each scraper
still owns its own DOM walk (ElementTree for the eCFR XML, BeautifulSoup for
the AIM HTML) and passes plain (text, colspan, rowspan) tuples in.

WHAT IT FIXES
-------------
RC, real device: 14 CFR 26.5 rendered a 2-cell header over 5-cell data rows.
Root cause, confirmed against the live eCFR XML: real CFR tables use
`rowspan` and `colspan`, and every flattener ignored both --

    <TH rowspan="2"/><TH colspan="4">Applicable sections</TH>
    <TH>Subpart B</TH><TH>Subpart C</TH><TH>Subpart D</TH><TH>Subpart E</TH>
    <TD>Effective date of rule</TD><TD>December 10, 2007</TD>...

Emitting one cell per source cell gives rows of 2, 4 and 5 -- the header
columns no longer line up with the data underneath them, which is exactly
the "several columns but no ref as to what those numbers mean" the reader
sees. Expanding spans into a real occupancy grid makes every row the same
width, so headers sit over the data they actually label.
"""
from __future__ import annotations


def parse_span(raw) -> int:
    """A span attribute that is missing, blank, non-numeric or < 1 means 1.
    Real eCFR XML has been observed with all of these."""
    try:
        n = int(str(raw).strip())
    except (TypeError, ValueError):
        return 1
    return n if n >= 1 else 1


def expand_rows(rows: list[list[tuple[str, int, int]]], propagate: bool):
    """Expand rows of (text, colspan, rowspan) into a rectangular grid.

    Returns a list of (cells, source_cell_count) -- source_cell_count is how
    many cells the ORIGINAL row had, which the caller needs to recognise a
    full-width single-cell row (a footnote like `<TD colspan="5">1 As of the
    effective date...</TD>`, or a one-cell spanning <thead> row). Those must
    stay bare text: expanding them into pipes would turn a footnote into a
    bogus data row and break the client's footnote detection.

    `propagate` controls what the extra columns of a spanning cell contain:

      True  (HEADER rows) -- repeat the text across every column it covers.
            A group header genuinely labels each of its columns, so "Applicable
            sections" belongs over all four subpart columns; the client then
            merges the header rows per column into "Applicable sections —
            Subpart B EAPAS/FTS".
      False (DATA rows) -- only the first column carries the value, the rest
            are empty placeholders. Repeating a data value across columns
            would fabricate data that is not in the source, which is a far
            worse failure than an empty cell. Data Is King.
    """
    out: list[tuple[list[str], int]] = []
    carry: dict[int, list] = {}  # col -> [rows_remaining, text]
    for row in rows:
        line: dict[int, str] = {}
        # A cell with rowspan>1 from an earlier row still occupies its column
        # here. Place those first so this row's own cells flow around them --
        # without this, every row under a rowspan cell shifts one column left.
        for col in list(carry):
            remaining, text = carry[col]
            line[col] = text
            if remaining - 1 <= 0:
                del carry[col]
            else:
                carry[col] = [remaining - 1, text]
        col = 0
        for text, colspan, rowspan in row:
            while col in line:
                col += 1
            for k in range(colspan):
                value = text if (propagate or k == 0) else ""
                line[col + k] = value
                if rowspan > 1:
                    carry[col + k] = [rowspan - 1, value]
            col += colspan
        width = (max(line) + 1) if line else 0
        out.append(([line.get(i, "") for i in range(width)], len(row)))
    return out


def render_grid(header_rows, body_rows, header_mark: str) -> list[str]:
    """Render expanded header + body rows into this app's line format.

    Rows that are entirely empty are skipped (`any(cells)`) -- but an
    individual empty CELL is always preserved as a positional placeholder,
    which is the 93.123 fix: a blank leading corner cell over self-evident
    row labels is a real, common CFR convention, and dropping it shifts
    every real header left out of alignment with its data.
    """
    lines: list[str] = []
    for rows, propagate, mark in ((header_rows, True, header_mark), (body_rows, False, "")):
        for cells, n_source in expand_rows(rows, propagate):
            if not any(cells):
                continue
            lines.append(mark + (cells[0] if n_source == 1 else " | ".join(cells)))
    return lines
