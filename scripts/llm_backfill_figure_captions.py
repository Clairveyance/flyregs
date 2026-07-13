#!/usr/bin/env python3
"""
Backfills the `caption` column on `ac_figures` rows where extract_figures.py's
bold-first-span heuristic failed to find a real caption (230 rows across 45
ACs as of 2026-07-13 -- see flyregs_build_bugs.md). Uses the same Claude
vision technique validated during the OCR-scanned-doc pdf_text rebuild, but
touches a completely different table/column -- does NOT touch pdf_text,
pdf_blocks, or pdf_blocks_version, so it carries none of the false
"AC updated" signal risk that rebuild had to work around.

Only 9 of the 45 affected ACs overlap with OCR_SCANNED_ACS -- the rest are
ordinary digital PDFs where extract_figures.py's caption heuristic (requires
the caption's first text span to be bold) simply didn't match, e.g. an
ALL-CAPS-but-not-bold caption or a caption split across a page break.

Usage:
    python3 scripts/llm_backfill_figure_captions.py [ac_id ...]

With no arguments, processes every ac_figures row with caption IS NULL.
"""
from __future__ import annotations

import base64
import json
import re
import sys
import urllib.request
from pathlib import Path
from urllib.parse import quote

import fitz  # PyMuPDF
import anthropic

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
SCRATCH_DIR = AC_APP_DIR / "scratch" / "caption_backfill"

MODEL = "claude-sonnet-5"
RENDER_DPI = 150

CAPTION_PROMPT = """This is one page of an FAA Advisory Circular. It contains a figure or table labeled "{label}".

Find the exact printed caption/title for "{label}" on this page -- the short line of text that names it (e.g. "FIGURE 2. ANTICOLLISION LIGHT OBSTRUCTIONS" or "TABLE 3-1. WEIGHT LIMITS"). Respond with ONLY that caption text, exactly as printed (correct any obvious OCR-type misreads, but do not paraphrase or add anything). If there are multiple figures/tables on the page, make sure you return the caption for "{label}" specifically, not a different one. If you cannot find a real caption for "{label}" on this page at all, respond with exactly: NONE
"""


def load_env_file(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
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


def get_supabase_creds():
    env = load_env_file(AC_APP_DIR / ".env.scraper")
    return env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]


def get_anthropic_key():
    return load_env_file(AC_APP_DIR / ".env.anthropic")["ANTHROPIC_API_KEY"]


def sb_get(supabase_url, service_key, path):
    req = urllib.request.Request(f"{supabase_url}{path}", headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    })
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def sb_patch(supabase_url, service_key, table, row_id, payload):
    url = f"{supabase_url}/rest/v1/{table}?id=eq.{row_id}"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()


def get_null_caption_rows(supabase_url, service_key, ac_ids_filter=None):
    rows = sb_get(supabase_url, service_key,
                  "/rest/v1/ac_figures?select=id,ac_id,label,page&caption=is.null")
    if ac_ids_filter:
        rows = [r for r in rows if r["ac_id"] in ac_ids_filter]
    return rows


def get_ac_pdf_url(supabase_url, service_key, ac_id):
    rows = sb_get(supabase_url, service_key,
                  f"/rest/v1/advisory_circulars?id=eq.{ac_id}&select=document_number,pdf_url_cached,pdf_url_faa")
    row = rows[0]
    return row["document_number"], row.get("pdf_url_cached") or row["pdf_url_faa"]


def render_page(pdf_path: Path, page_num_1indexed: int, out_path: Path):
    doc = fitz.open(pdf_path)
    page = doc[page_num_1indexed - 1]
    pix = page.get_pixmap(dpi=RENDER_DPI)
    pix.save(out_path)


def get_caption(client: anthropic.Anthropic, image_path: Path, label: str) -> str | None:
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    message = client.messages.create(
        model=MODEL,
        max_tokens=300,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": CAPTION_PROMPT.format(label=label)},
                ],
            }
        ],
    )
    text = "".join(block.text for block in message.content if block.type == "text").strip()
    return None if text.upper() == "NONE" else text


def main():
    ac_ids_filter = set(sys.argv[1:]) or None
    supabase_url, service_key = get_supabase_creds()
    client = anthropic.Anthropic(api_key=get_anthropic_key())

    rows = get_null_caption_rows(supabase_url, service_key, ac_ids_filter)
    print(f"{len(rows)} rows to process")

    by_ac = {}
    for r in rows:
        by_ac.setdefault(r["ac_id"], []).append(r)

    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    found, still_none, errors = 0, 0, 0

    for ac_id, ac_rows in by_ac.items():
        doc_number, pdf_url = get_ac_pdf_url(supabase_url, service_key, ac_id)
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", doc_number)
        print(f"\n=== {doc_number} ({len(ac_rows)} figure(s)/table(s) missing captions) ===")

        work_dir = SCRATCH_DIR / safe_name
        work_dir.mkdir(parents=True, exist_ok=True)
        pdf_path = work_dir / f"{safe_name}.pdf"
        try:
            urllib.request.urlretrieve(pdf_url, pdf_path)
        except Exception as e:
            print(f"  SKIP whole doc -- could not download PDF: {e}")
            errors += len(ac_rows)
            continue

        for r in ac_rows:
            label = r["label"]
            page_num = r["page"]
            img_path = work_dir / f"page_{page_num:03d}.png"
            try:
                if not img_path.exists():
                    render_page(pdf_path, page_num, img_path)
                caption = get_caption(client, img_path, label)
            except Exception as e:
                print(f"  {label} (p{page_num}): ERROR {e}")
                errors += 1
                continue

            if caption:
                sb_patch(supabase_url, service_key, "ac_figures", r["id"], {"caption": caption})
                print(f"  {label} (p{page_num}): \"{caption}\"")
                found += 1
            else:
                print(f"  {label} (p{page_num}): no caption found, left null")
                still_none += 1

    print(f"\n{'='*60}")
    print(f"Captions found and written: {found}")
    print(f"Still no caption (genuinely uncaptioned): {still_none}")
    print(f"Errors: {errors}")


if __name__ == "__main__":
    main()
