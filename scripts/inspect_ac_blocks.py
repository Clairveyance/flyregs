#!/usr/bin/env python3
"""Fetch pdf_blocks for a doc and print each block's kind/label/title +
first/last ~80 chars of its text/body, with its index, so the exact block
containing a swallowed section can be located precisely. Read-only."""
import subprocess, json, sys

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app"
MGMT_API = f"{BASE}/ac-app/scripts/supabase_mgmt_api.py"


def sql_query(query: str):
    result = subprocess.run(["python3", MGMT_API, "query", query], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def main():
    doc = sys.argv[1]
    filt = sys.argv[2] if len(sys.argv) > 2 else None
    rows = sql_query(f"SELECT pdf_blocks FROM advisory_circulars WHERE document_number = '{doc}'")
    blocks = rows[0]["pdf_blocks"]
    for i, b in enumerate(blocks):
        kind = b.get("kind")
        if kind == "chapter":
            summary = b.get("text", "")
        elif kind == "section":
            summary = f"{b.get('label','')} {b.get('title','')} | body[:60]={b.get('body','')[:60]!r} len={len(b.get('body',''))}"
        elif kind == "item":
            summary = f"{b.get('label','')} {b.get('title','')} | body[:60]={b.get('body','')[:60]!r} len={len(b.get('body',''))}"
        else:
            summary = f"para[:60]={b.get('text','')[:60]!r} len={len(b.get('text',''))}"
        if filt and filt.lower() not in json.dumps(b).lower():
            continue
        print(f"[{i}] {kind}: {summary}")


if __name__ == "__main__":
    main()
