#!/usr/bin/env python3
"""Batch triage for task #375 (91 thin-parse ACs). For each doc, scan the
real pdf_text for lines that LOOK like a heading (bare Appendix/Chapter, a
numbered "N. Title" line, an ALL-CAPS line) but don't match any of the
parser's actual heading regexes -- these are the most likely cause of a
swallowed block. Read-only, no DB writes. Classifies each doc into a bucket
so the per-doc Vision-review effort only goes where it's actually needed."""
import re
import subprocess
import json
import os

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app"
DOCS_FILE = f"{BASE}/PROJECT_NOTES/flyregs_thin_parse_backlog.txt"
MGMT_API = f"{BASE}/ac-app/scripts/supabase_mgmt_api.py"

# Mirror acFormat.ts's real regexes exactly.
CH = re.compile(r"^(?:CHAPTER|Chapter)\s+[0-9IVXLC]+\.\s*.*$")
APPX = re.compile(r"^(?:APPENDIX|Appendix)\s+[0-9A-Z]+\.\s*.*$")
SEC = re.compile(r"^(\d{1,3}-\d{1,3}\.)\s+(.+)$")
NUMSEC = re.compile(r"^(\d+\.)\s+([A-Z].{2,90})$")

# Broader "looks like a heading" candidates -- deliberately loose on the
# prefix, then filtered hard on what follows. The earlier reverted general-
# parser attempt (task #369) proved a loose prefix match alone is USELESS --
# it can't tell "Appendix A" (a real heading) from "Appendix A of this AC
# provides..." (a citation-list mention) using single-line context, and
# promoting the latter corrupted 90 unrelated docs for only 7 real fixes.
# This filter requires what follows the number to look like a CLEAN TITLE
# (nothing, or a colon/dash + a short capitalized phrase with no trailing
# stopword) -- the same shape the parser's own real regexes already demand
# via a mandatory period, just relaxed to also allow a colon/dash/bare line.
CAND_APPX = re.compile(r"^\s*(?:APPENDIX|Appendix)\s+[0-9A-Z]+\b")
CAND_CH = re.compile(r"^\s*(?:CHAPTER|Chapter)\s+[0-9IVXLC]+\b")
STOPWORDS_END = {
    'of', 'is', 'for', 'the', 'this', 'that', 'to', 'and', 'or', 'when',
    'with', 'in', 'a', 'an', 'as', 'provides', 'includes', 'only', 'one',
    'not', 'if', 'it', 'was', 'were', 'be', 'are', 'test.', 'test', 'i',
    '=', '3', 'considered', 'from', 'divided', 'by', 'nvpm', 'co,', 'h',
}
CLEAN_TITLE = re.compile(r"^\s*[:.\-—–,]?\s*[A-Z0-9][\w \-,'&()/\"]{0,75}$")


def sql_query(query: str):
    result = subprocess.run(
        ["python3", MGMT_API, "query", query],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def main():
    docs = []
    with open(DOCS_FILE) as f:
        for line in f.readlines()[2:]:
            parts = line.split(None, 4)
            if parts:
                docs.append(parts[0])

    print(f"{len(docs)} docs to triage\n")
    doc_list_sql = ",".join(f"'{d}'" for d in docs)
    rows = sql_query(f"SELECT document_number, pdf_text FROM advisory_circulars WHERE document_number IN ({doc_list_sql})")
    by_doc = {r["document_number"]: r["pdf_text"] or "" for r in rows}

    results = []
    for doc in docs:
        text = by_doc.get(doc, "")
        if not text:
            results.append((doc, "NO_TEXT", []))
            continue
        misses = []
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            m = CAND_APPX.match(line) or CAND_CH.match(line)
            if not m:
                continue
            kind = "APPX" if line[:3].upper() == "APP" else "CH"
            if APPX.match(line) or CH.match(line):
                continue  # already a real heading match, not a miss
            remainder = line[m.end():]
            last_word = re.sub(r"[^\w]", "", remainder.split()[-1]).lower() if remainder.split() else ""
            if not CLEAN_TITLE.match(remainder if remainder.strip() else " X"):
                continue
            if last_word in STOPWORDS_END:
                continue
            if "," in remainder[:3]:  # comma right after the number = cross-ref
                continue
            misses.append((kind, line[:90]))
        results.append((doc, "SCANNED", misses))

    print("=== Docs with bare/near-miss Appendix or Chapter headings (prime override candidates) ===")
    for doc, status, misses in results:
        if misses:
            print(f"\n--- {doc} ({len(misses)} misses) ---")
            for kind, sample in misses[:6]:
                print(f"  [{kind}] {sample!r}")

    print("\n\n=== Docs with ZERO near-miss candidates (need Vision/manual review) ===")
    zero = [doc for doc, status, misses in results if status == "SCANNED" and not misses]
    for doc in zero:
        print(f"  {doc}")


if __name__ == "__main__":
    main()
