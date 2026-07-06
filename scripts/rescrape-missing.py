#!/usr/bin/env python3
"""
Targeted re-scrape for ACs that are missing pdf_text.
Downloads their cached PDFs, extracts text with pypdf, and writes back to DB.
Run from the ac-app/ directory:  python scripts/rescrape-missing.py

After this, run the backfill to compute pdf_blocks:
  node scripts/backfill-blocks.mjs
"""
import io
import os
import re
import sys
from typing import Optional
import requests
import pypdf

# ── Load credentials ──────────────────────────────────────────────────────────
env_path = os.path.join(os.path.dirname(__file__), "../../.env.scraper")
if not os.path.exists(env_path):
    print("ERROR: ../.env.scraper not found"); sys.exit(1)

_env: dict[str, str] = {}
with open(env_path) as f:
    for line in f:
        m = re.match(r"^\s*(?:export\s+)?(\w+)=(.+)", line)
        if m:
            _env[m.group(1)] = m.group(2).strip().strip("\"'")

SUPABASE_URL = _env.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = _env.get("SUPABASE_SERVICE_KEY", "")
if not SUPABASE_URL or not SERVICE_KEY:
    print("ERROR: missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); sys.exit(1)

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
    "Prefer":        "return=minimal",
}

# ── Targets ───────────────────────────────────────────────────────────────────
TARGETS = ["38-1", "60-22"]

# ── Helpers ───────────────────────────────────────────────────────────────────
def fetch_row(doc_num: str) -> Optional[dict]:
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars",
        params={
            "select": "id,document_number,pdf_url_cached,pdf_url_faa",
            "document_number": f"eq.{doc_num}",
            "limit": "1",
        },
        headers=HEADERS,
        timeout=10,
    )
    r.raise_for_status()
    rows = r.json()
    return rows[0] if rows else None

def extract_text(pdf_bytes: bytes) -> Optional[str]:
    try:
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        parts = [page.extract_text() for page in reader.pages if page.extract_text()]
        full = "\n".join(parts).strip()
        return full[:500_000] if full else None
    except Exception as e:
        print(f"    pypdf error: {e}")
        return None

def save_text(row_id: str, text: str) -> None:
    import json
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars",
        params={"id": f"eq.{row_id}"},
        headers=HEADERS,
        data=json.dumps({"pdf_text": text}),
        timeout=15,
    )
    r.raise_for_status()

# ── Main ──────────────────────────────────────────────────────────────────────
session = requests.Session()
session.headers.update({"User-Agent": "FlyRegs-rescrape/1.0"})

for doc_num in TARGETS:
    print(f"\n── {doc_num} ──")
    row = fetch_row(doc_num)
    if not row:
        print(f"  NOT FOUND in DB"); continue

    url = row.get("pdf_url_cached") or row.get("pdf_url_faa")
    if not url:
        print(f"  No PDF URL available — skipping"); continue

    print(f"  Downloading from {url} …")
    try:
        resp = session.get(url, timeout=60)
        resp.raise_for_status()
    except Exception as e:
        print(f"  Download failed: {e}"); continue

    text = extract_text(resp.content)
    if not text:
        print(f"  No text extracted"); continue

    print(f"  Extracted {len(text):,} chars — saving …")
    save_text(row["id"], text)
    print(f"  ✓ Saved")

print("\nDone. Now run:  node scripts/backfill-blocks.mjs")
