#!/usr/bin/env python3
"""
Targeted Vision recovery for the 179-doc missing-figures backlog (BB-062),
built to be MUCH cheaper than transcribing every page. Reuses
extract_figures.py's proven line-start-anchored caption regex (a real
caption always starts its own line, per that script's own validated
finding), but drops its bold/ALL-CAPS requirement -- that requirement
existed only to distinguish a real caption from a coincidental line-start
match, and here Vision does that job instead by actually looking at the
candidate page, which is strictly more reliable than a styling heuristic.

Per doc: one full text/layout scan (free, PyMuPDF only) finds every
line-start "Figure N"/"Table N" occurrence and its page. Any label not
already in ac_figures gets exactly ONE Vision call on that one page --
confirm it's real, get the caption, upload the image, insert the row.
A label appearing at line-start on multiple pages only costs one call per
distinct page actually tried (stops at the first page Vision confirms).

This intentionally does NOT touch pdf_text or any doc already fully
covered -- purely additive to ac_figures, same safety property as
backfill_missing_figures_free.py.

Usage:
  python3 scripts/llm_locate_missing_figures.py --docs-file=path [--dry-run]
  python3 scripts/llm_locate_missing_figures.py --doc=20-191 [--dry-run]
"""
from __future__ import annotations

import argparse
import base64
import os
import re
import sys

import anthropic
import fitz
import requests

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import (
    SUPABASE_URL, HEADERS, normalize_label, slugify, TOC_DOT_LEADER_RE,
)

MODEL = "claude-sonnet-5"
RENDER_DPI = 150

# Same shape as extract_figures.py's CAPTION_RE, minus the bold/ALL-CAPS gate
# -- Vision verifies realness instead of a styling heuristic.
CANDIDATE_RE = re.compile(
    r"^(Figure|Table)\s+([A-Za-z]{0,3}\d+[A-Za-z]?(?:[-.·]\d+[A-Za-z]?)?)\.?\s*(.*)$",
    re.IGNORECASE,
)

CAPTION_PROMPT = """This is one page of an FAA Advisory Circular. Text extraction found what looks like a figure/table caption starting with "{label}" on this page.

Look at the actual page image. Is there a REAL figure, table, chart, or diagram on this page labeled "{label}" -- not just a text mention or cross-reference in a sentence? If yes, respond with ONLY the exact printed caption text for it (e.g. "FIGURE 2. ANTICOLLISION LIGHT OBSTRUCTIONS" or "TABLE 3-1. WEIGHT LIMITS"), correcting any obvious OCR-type misreads but not paraphrasing. If this is just prose referencing "{label}" with no actual figure/table content on this page, respond with exactly: NONE
"""


def load_env_file(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def get_anthropic_client():
    env = load_env_file(os.path.join(os.path.dirname(__file__), "..", ".env.anthropic"))
    return anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])


def find_candidates(pdf_bytes: bytes):
    """Yields (page_1indexed, label, existing_first_seen) for every
    line-start Figure/Table match, bold or not. Unlike extract_figures.py,
    keeps EVERY occurrence (not just the first), since the first line-start
    hit for a label isn't always the real caption page (e.g. a "List of
    Figures" entry can itself start a line without a dot-leader if poorly
    formatted) -- candidates are tried in page order until Vision confirms
    one or they run out."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    for i, page in enumerate(doc):
        d = page.get_text("dict")
        for block in d["blocks"]:
            for line in block.get("lines", []):
                spans = line["spans"]
                if not spans:
                    continue
                text = "".join(s["text"] for s in spans).strip()
                if not text or TOC_DOT_LEADER_RE.search(text):
                    continue
                m = CANDIDATE_RE.match(text)
                if not m:
                    continue
                kind, num, _rest = m.groups()
                label = normalize_label(kind, num)
                yield (i + 1, label)
    doc.close()


def render_page(pdf_bytes: bytes, page_1indexed: int) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pix = doc[page_1indexed - 1].get_pixmap(dpi=RENDER_DPI)
    png_bytes = pix.tobytes("png")
    doc.close()
    return png_bytes


def upload_png(doc_num: str, label: str, png_bytes: bytes) -> str:
    fname = f"{re.sub(r'[^a-zA-Z0-9-_.]', '_', doc_num)}/{slugify(label)}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/ac-figures/{fname}"
    resp = requests.put(url, headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"}, data=png_bytes, timeout=60)
    resp.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/ac-figures/{fname}"


def get_caption(client, png_bytes: bytes, label: str) -> str | None:
    b64 = base64.standard_b64encode(png_bytes).decode("utf-8")
    message = client.messages.create(
        model=MODEL, max_tokens=300,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
            {"type": "text", "text": CAPTION_PROMPT.format(label=label)},
        ]}],
    )
    text = "".join(b.text for b in message.content if b.type == "text").strip()
    return None if text.upper() == "NONE" else text


def existing_labels(ac_id: str) -> set:
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=label", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    return {r["label"] for r in resp.json()}


def next_sort_order(ac_id: str) -> int:
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=sort_order&order=sort_order.desc&limit=1", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    rows = resp.json()
    return (rows[0]["sort_order"] + 1) if rows else 1000


def insert_figure_row(row: dict):
    resp = requests.post(f"{SUPABASE_URL}/rest/v1/ac_figures", headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"}, json=row, timeout=30)
    resp.raise_for_status()


def process_doc(client, ac_id: str, doc_num: str, pdf_url: str, dry_run: bool, stats: dict):
    pdf_resp = requests.get(pdf_url, timeout=60)
    pdf_resp.raise_for_status()
    pdf_bytes = pdf_resp.content

    existing = existing_labels(ac_id)
    candidates_by_label = {}
    for page, label in find_candidates(pdf_bytes):
        candidates_by_label.setdefault(label, []).append(page)

    new_labels = [l for l in candidates_by_label if l not in existing]
    if not new_labels:
        print(f"  {doc_num}: no new candidate labels found")
        return

    sort_order = next_sort_order(ac_id)
    resolved = 0
    vision_calls = 0
    for label in sorted(new_labels):
        pages = candidates_by_label[label]
        confirmed = False
        for page in pages:
            vision_calls += 1
            stats["vision_calls"] += 1
            if dry_run:
                print(f"    [DRY RUN] {label} candidate p{page} -- would call Vision")
                continue
            try:
                png = render_page(pdf_bytes, page)
                caption = get_caption(client, png, label)
            except Exception as e:
                print(f"    {label} p{page}: ERROR {e}")
                continue
            if caption:
                image_url = upload_png(doc_num, label, png)
                insert_figure_row({
                    "ac_id": ac_id, "label": label, "caption": caption,
                    "page": page, "image_url": image_url, "sort_order": sort_order,
                })
                sort_order += 1
                print(f"    {label} p{page}: CONFIRMED -- \"{caption}\"")
                confirmed = True
                resolved += 1
                stats["resolved"] += 1
                break
            else:
                print(f"    {label} p{page}: NONE (tried {len(pages)} candidate page(s) for this label)")
        if not confirmed and not dry_run:
            stats["unresolved"] += 1
    print(f"  {doc_num}: {len(new_labels)} new candidate label(s), {resolved} confirmed, {vision_calls} Vision call(s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs-file")
    ap.add_argument("--doc")
    ap.add_argument("--dry-run", action="store_true", help="Count candidates/calls without spending anything")
    args = ap.parse_args()

    if args.doc:
        doc_nums = [args.doc]
    elif args.docs_file:
        doc_nums = [s.strip() for s in open(args.docs_file).read().split("\n") if s.strip()]
    else:
        ap.error("need --doc or --docs-file")

    client = None if args.dry_run else get_anthropic_client()
    stats = {"vision_calls": 0, "resolved": 0, "unresolved": 0}

    for i, doc_num in enumerate(doc_nums):
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{doc_num}&select=id,document_number,pdf_url_cached,pdf_url_faa",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            print(f"[{i+1}/{len(doc_nums)}] {doc_num}: not found")
            continue
        ac = rows[0]
        pdf_url = ac.get("pdf_url_cached") or ac.get("pdf_url_faa")
        if not pdf_url:
            print(f"[{i+1}/{len(doc_nums)}] {doc_num}: no PDF URL")
            continue
        print(f"[{i+1}/{len(doc_nums)}] {doc_num}:")
        try:
            process_doc(client, ac["id"], doc_num, pdf_url, args.dry_run, stats)
        except Exception as e:
            print(f"  {doc_num}: ERROR {e}")

    print(f"\nDone. {stats['vision_calls']} Vision call(s) total, {stats['resolved']} figure(s)/table(s) confirmed and added, {stats['unresolved']} label(s) tried but never confirmed on any candidate page.")


if __name__ == "__main__":
    main()
