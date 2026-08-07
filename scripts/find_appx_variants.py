#!/usr/bin/env python3
"""One-off investigation for task #365/#369: catalog the real Appendix-heading
text shapes across the 91 thin-parse docs that don't match acFormat.ts's
existing APPX regex, so a new pattern can be derived from real corpus text
instead of guessed from a single example. Read-only, no DB writes."""
import re
import subprocess
import json
import sys
import os

APPX = re.compile(r"^(?:APPENDIX|Appendix)\s+[0-9A-Z]+\.\s*.*$")
CANDIDATE = re.compile(r"^\s*(?:APPENDIX|Appendix)\s+[0-9A-Z]+\b")


def sql_query(query: str):
    result = subprocess.run(
        ["python3", os.path.join(os.path.dirname(__file__), "supabase_mgmt_api.py"), "query", query],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def main():
    docs = []
    with open(os.path.join(os.path.dirname(__file__), "..", "..", "PROJECT_NOTES", "flyregs_thin_parse_backlog.txt")) as f:
        for line in f.readlines()[2:]:
            parts = line.split(None, 4)
            if parts:
                docs.append(parts[0])

    print(f"{len(docs)} docs to check\n")
    doc_list_sql = ",".join(f"'{d}'" for d in docs)
    rows = sql_query(f"SELECT document_number, pdf_text FROM advisory_circulars WHERE document_number IN ({doc_list_sql})")

    misses = {}
    for row in rows:
        doc = row["document_number"]
        text = row["pdf_text"] or ""
        for line in text.split("\n"):
            line = line.strip()
            if CANDIDATE.match(line) and not APPX.match(line):
                misses.setdefault(doc, []).append(line[:100])

    total = sum(len(v) for v in misses.values())
    print(f"{len(misses)} docs have a candidate Appendix line that MISSES the current regex ({total} lines total)\n")
    for doc, lines in list(misses.items())[:40]:
        print(f"--- {doc} ---")
        for l in lines[:5]:
            print(f"  {l!r}")


if __name__ == "__main__":
    main()
