"""Extracts every real CFR section's full text from the official Title 14
annual-edition PDF volumes (govinfo.gov), keyed by section number.

Real section headings are reliably distinguishable from inline cross-
references ("...as required by § 61.3(b)...") by font: genuine headings
render in bold NewCenturySchlbk-Bold (flags=20) as their own span with
nothing else on it, cross-references render in the regular body font
(MIonic, flags=4), and the running page-header ("§ 61.3" repeated at the
top of the page to show what's on it) renders in AvantGarde-Demi. Confirmed
live across multiple volumes/pages before relying on it.

A section's full text is everything between its own heading and the next
heading, walking blocks in document order across page boundaries (a
section can span multiple pages). Includes trailing amendment/citation
history ("[Docket ..., FR ..., Amdt. ...]") that eCFR's own body_text does
NOT carry — expected, this is used for similarity comparison, not treated
as a byte-exact match target.

Usage: python3 build_far_pdf_sections.py vol1.pdf vol2.pdf vol3.pdf
"""
from __future__ import annotations

import json
import re
import sys

import fitz

HEADING_RE = re.compile(r"^§\s*(\d+[a-zA-Z]?\.\d+[a-zA-Z0-9\-]*)$")


def is_real_heading_span(span: dict) -> str | None:
    if span["font"] != "NewCenturySchlbk-Bold" or span["flags"] != 20:
        return None
    m = HEADING_RE.match(span["text"].strip())
    return m.group(1) if m else None


def extract_volume(path: str) -> dict:
    doc = fitz.open(path)
    # Walk every block, in document order, across the whole volume. Record
    # each block's plain text plus whether it STARTS a new section (its
    # first span is a real heading).
    entries: list[tuple[str | None, str]] = []  # (new_section_or_None, block_text)
    for page in doc:
        d = page.get_text("dict")
        for block in d["blocks"]:
            lines = block.get("lines")
            if not lines:
                continue
            block_text_parts = []
            starts_section = None
            first_span_seen = False
            for line in lines:
                for span in line["spans"]:
                    if not first_span_seen:
                        starts_section = is_real_heading_span(span)
                        first_span_seen = True
                    block_text_parts.append(span["text"])
                block_text_parts.append("\n")
            block_text = "".join(block_text_parts).strip()
            if block_text:
                entries.append((starts_section, block_text))

    sections: dict[str, str] = {}
    current_section = None
    current_parts: list[str] = []
    for starts_section, block_text in entries:
        if starts_section:
            if current_section and current_parts:
                sections[current_section] = "\n".join(current_parts).strip()
            current_section = starts_section
            current_parts = [block_text]
        elif current_section:
            current_parts.append(block_text)
    if current_section and current_parts:
        sections[current_section] = "\n".join(current_parts).strip()
    return sections


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 build_far_pdf_sections.py vol1.pdf [vol2.pdf ...]")
        sys.exit(1)

    all_sections: dict[str, dict] = {}
    for path in sys.argv[1:]:
        print(f"Extracting {path}...")
        sections = extract_volume(path)
        print(f"  {len(sections)} sections found")
        for sec_num, text in sections.items():
            if sec_num not in all_sections:
                all_sections[sec_num] = {"volume": path, "text": text}

    print(f"\nTotal distinct sections across all volumes: {len(all_sections)}")
    with open("far_pdf_sections.json", "w") as f:
        json.dump(all_sections, f, indent=1)
    print("Wrote far_pdf_sections.json")


if __name__ == "__main__":
    main()
