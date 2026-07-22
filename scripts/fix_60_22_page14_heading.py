#!/usr/bin/env python3
"""
Fixes a real defect the column-split fallback introduced on AC 60-22 page 14:
the page's full-width chapter title ("CHAPTER 3. DEALING WITH HAZARDOUS
ATTITUDES") spans both columns, so cropping the page into left/right halves
cut the title in half -- the left half caught "CHAPTER 3. DEALING WITH", the
right half caught a stray "I" plus "HAZARDOUS ATTITUDES", and the running
page header ("AC 60- 22") ended up sandwiched between them out of order.

This reorders that one page's content in-place in pdf_text: merges the
title back into one line, drops the stray header/artifact between the two
column halves, and re-flows so the left column's content (items a-e) is
immediately followed by the right column's continuation, matching true
reading order. Does not touch any other page's content.
"""
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
TEXT_PATH = AC_APP_DIR / "scratch" / "ocr_rebuild" / "60-22" / "final_pdf_text_spliced.txt"

BROKEN = """CHAPTER 3. DEALING WITH

13. HAZARDOUS ATTITUDES. ADM addres-"""

FIXED = """CHAPTER 3. DEALING WITH HAZARDOUS ATTITUDES

13. HAZARDOUS ATTITUDES. ADM addres-"""

BROKEN_TAIL = """Chap 3
Par 13

AC 60- 22

I HAZARDOUS ATTITUDES

as being able"""

FIXED_TAIL = """Chap 3
Par 13

as being able"""


def main():
    text = TEXT_PATH.read_text()

    assert text.count(BROKEN) == 1, f"expected exactly 1 match for BROKEN, found {text.count(BROKEN)}"
    text = text.replace(BROKEN, FIXED)

    assert text.count(BROKEN_TAIL) == 1, f"expected exactly 1 match for BROKEN_TAIL, found {text.count(BROKEN_TAIL)}"
    text = text.replace(BROKEN_TAIL, FIXED_TAIL)

    TEXT_PATH.write_text(text)
    print(f"Fixed page 14 heading/ordering, wrote back to {TEXT_PATH}")


if __name__ == "__main__":
    main()
