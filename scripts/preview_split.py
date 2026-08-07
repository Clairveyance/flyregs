#!/usr/bin/env python3
"""Task #375 helper: for one doc, find the single oversized block and show
where each candidate bare Appendix/Chapter heading falls inside its raw
pdf_text, with surrounding context, so a real split point can be confirmed
by reading the actual extracted text before building an override. Read-only.
Usage: python3 preview_split.py <doc_number>
"""
import re
import subprocess
import json
import os
import sys

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app"
MGMT_API = f"{BASE}/ac-app/scripts/supabase_mgmt_api.py"

CH = re.compile(r"^(?:CHAPTER|Chapter)\s+[0-9IVXLC]+\.\s*.*$")
APPX = re.compile(r"^(?:APPENDIX|Appendix)\s+[0-9A-Z]+\.\s*.*$")
CAND_APPX = re.compile(r"^\s*(?:APPENDIX|Appendix)\s+[0-9A-Z]+\b")
CAND_CH = re.compile(r"^\s*(?:CHAPTER|Chapter)\s+[0-9IVXLC]+\b")
STOPWORDS_END = {
    'of', 'is', 'for', 'the', 'this', 'that', 'to', 'and', 'or', 'when',
    'with', 'in', 'a', 'an', 'as', 'provides', 'includes', 'only', 'one',
}
CLEAN_TITLE = re.compile(r"^\s*[:.\-—–,]?\s*[A-Z0-9][\w \-,'&()/\"]{0,75}$")


def sql_query(query: str):
    result = subprocess.run(["python3", MGMT_API, "query", query], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main():
    doc = sys.argv[1]
    rows = sql_query(f"SELECT pdf_text FROM advisory_circulars WHERE document_number = '{doc}'")
    text = rows[0]["pdf_text"]
    lines = text.split("\n")

    print(f"=== {doc}: {len(lines)} lines, {len(text)} chars ===\n")

    for i, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line:
            continue
        m = CAND_APPX.match(line) or CAND_CH.match(line)
        if not m:
            continue
        if APPX.match(line) or CH.match(line):
            continue
        remainder = line[m.end():]
        last_word = re.sub(r"[^\w]", "", remainder.split()[-1]).lower() if remainder.split() else ""
        if not CLEAN_TITLE.match(remainder if remainder.strip() else " X"):
            continue
        if last_word in STOPWORDS_END:
            continue
        if "," in remainder[:3]:
            continue
        # Print context: 2 lines before, the line itself, 3 lines after
        print(f"--- line {i} ---")
        for j in range(max(0, i - 2), min(len(lines), i + 4)):
            marker = ">>> " if j == i else "    "
            print(f"{marker}{lines[j].strip()[:110]}")
        print()


if __name__ == "__main__":
    main()
