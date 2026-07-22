#!/usr/bin/env python3
"""
Replaces the 3 "[transcription failed for this page]" placeholders left in
AC 60-22's pdf_text (pages 3, 10, 14 -- see fix_60_22_blocked_pages.py and
fix_60_22_split_columns.py) with the actual hand-recovered transcriptions,
then writes the corrected pdf_text back to the DB. Placeholders are replaced
in document order (first occurrence = page 3, second = page 10, third =
page 14), matched by position, not by string search, since the placeholder
text is identical across all three.
"""
import json
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
WORK_DIR = AC_APP_DIR / "scratch" / "ocr_rebuild" / "60-22"

PLACEHOLDER = "[transcription failed for this page]"
PAGE_ORDER = [3, 10, 14]  # order these appear in the concatenated text


def load_env_file(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def main():
    text = (WORK_DIR / "final_pdf_text.txt").read_text()

    for page_num in PAGE_ORDER:
        fixed_path = WORK_DIR / f"page_{page_num:03d}_fixed.txt"
        if not fixed_path.exists():
            raise RuntimeError(f"Missing fixed transcription for page {page_num}: {fixed_path}")
        replacement = fixed_path.read_text().strip()
        idx = text.find(PLACEHOLDER)
        if idx == -1:
            raise RuntimeError(f"No more placeholders found, expected one for page {page_num}")
        text = text[:idx] + replacement + text[idx + len(PLACEHOLDER):]

    assert PLACEHOLDER not in text, "A placeholder is still present after splicing -- aborting"

    out_path = WORK_DIR / "final_pdf_text_spliced.txt"
    out_path.write_text(text)
    print(f"Spliced text written to {out_path} ({len(text)} chars)")

    env = load_env_file(AC_APP_DIR / ".env.scraper")
    supabase_url = env["SUPABASE_URL"]
    service_key = env["SUPABASE_SERVICE_KEY"]

    url = f"{supabase_url}/rest/v1/advisory_circulars?document_number=eq.60-22&select=id"
    req = urllib.request.Request(url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
    with urllib.request.urlopen(req) as resp:
        rows = json.load(resp)
    ac_id = rows[0]["id"]

    update_url = f"{supabase_url}/rest/v1/advisory_circulars?id=eq.{ac_id}"
    body = json.dumps({"pdf_text": text}).encode("utf-8")
    req = urllib.request.Request(update_url, data=body, method="PATCH", headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()
    print(f"Updated advisory_circulars.pdf_text for AC 60-22 (id={ac_id})")


if __name__ == "__main__":
    main()
