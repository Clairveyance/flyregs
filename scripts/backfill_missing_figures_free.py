#!/usr/bin/env python3
"""
Additive-only re-run of extract_figures.py's free (non-Vision) bold/allcaps
caption heuristic against the 179-doc missing-figures backlog (BB-062).

Why this exists: extract_figures.py --all skips a doc entirely if it already
has ANY ac_figures row (already_processed() check) -- so a doc with, say, 3
of its 5 real figures captured never got re-scanned for the other 2. 122 of
the 179 backlog docs are in exactly that state. This script re-runs the same
detection logic (imported directly, not reimplemented) but only INSERTS
labels that don't already have a row -- it never deletes or touches existing
rows, unlike extract_figures.py --docs-file (which force-deletes first).

Zero Anthropic API cost -- pure PyMuPDF text/layout detection, same as
extract_figures.py's normal path. Run this BEFORE spending anything on
Vision for the residual gap, since whatever it recovers here is free.

Usage: python3 scripts/backfill_missing_figures_free.py --docs-file=path
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import (
    SUPABASE_URL, HEADERS, find_captions, render_page, upload_png,
    insert_figure_rows,
)
import requests


def existing_labels(ac_id: str) -> set:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=label",
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    return {r["label"] for r in resp.json()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs-file", required=True)
    args = ap.parse_args()

    doc_nums = [s.strip() for s in open(args.docs_file).read().split("\n") if s.strip()]
    print(f"Additive free-heuristic re-scan: {len(doc_nums)} doc(s)")

    total_added = 0
    total_still_missing = 0
    per_doc_results = []
    for i, doc_num in enumerate(doc_nums):
        try:
            resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/advisory_circulars"
                f"?document_number=eq.{doc_num}&select=id,document_number,pdf_url_cached,pdf_url_faa",
                headers=HEADERS, timeout=30,
            )
            resp.raise_for_status()
            rows = resp.json()
            if not rows:
                print(f"  {doc_num}: not found, skipping")
                continue
            ac = rows[0]
            pdf_url = ac.get("pdf_url_cached") or ac.get("pdf_url_faa")
            if not pdf_url:
                print(f"  {doc_num}: no PDF URL, skipping")
                continue

            existing = existing_labels(ac["id"])
            pdf_resp = requests.get(pdf_url, timeout=60)
            pdf_resp.raise_for_status()
            pdf_bytes = pdf_resp.content

            captions = list(find_captions(pdf_bytes))
            new_rows = []
            page_pngs = {}
            sort_order = 1000  # keep new rows after any existing ones, order doesn't matter much
            for page, label, caption in captions:
                if label in existing:
                    continue
                if page not in page_pngs:
                    page_pngs[page] = render_page(pdf_bytes, page)
                image_url = upload_png(doc_num, label, page_pngs[page])
                new_rows.append({
                    "ac_id": ac["id"], "label": label, "caption": caption,
                    "page": page, "image_url": image_url, "sort_order": sort_order,
                })
                sort_order += 1

            if new_rows:
                insert_figure_rows(new_rows)
            total_added += len(new_rows)
            per_doc_results.append((doc_num, len(new_rows)))
            print(f"[{i+1}/{len(doc_nums)}] {doc_num}: +{len(new_rows)} new row(s) (heuristic found {len(captions)} total captions, {len(existing)} already existed)")
        except Exception as e:
            print(f"[{i+1}/{len(doc_nums)}] {doc_num}: ERROR {e}")

    print(f"\nDone. {total_added} new figure/table rows added across {len(doc_nums)} docs, $0 Anthropic API cost.")


if __name__ == "__main__":
    main()
