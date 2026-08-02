#!/usr/bin/env python3
"""Backfills ad_figures: renders full-page images for every AD whose
body_text references a Table/Figure, or contains a literal [GRAPHIC]
placeholder (an embedded image the text-only extraction pipeline never
captured). Mirrors backfill_aim_pdf_images.py's approach, but simpler --
each AD is its own short (2-10 page), self-contained PDF, unlike AIM's one
giant combined PDF, so there's no figure-to-page resolution problem to
solve. Just render every page of a candidate AD's PDF and let the user
page through the (short) document as images, same "Tables & Figures"
browsing pattern AC/AIM already use.

Safe to re-run: skips any ad_number that already has rows in ad_figures.

Usage: python3 sync/backfill_ad_figures.py [--limit N]
"""
import argparse
import os
import re
import time

import fitz
import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
KEY = SCRAPER["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
BUCKET = "reg-tf-images"

CANDIDATE_RE = re.compile(r"\bTable\s+\d|\bFigure\s+\d|\[GRAPHIC\]")


def fetch_candidates():
    out = []
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/airworthiness_directives", headers=HEADERS,
            params={"select": "ad_number,pdf_url,body_text", "limit": 1000, "offset": offset},
            timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        for row in batch:
            body = row.get("body_text") or ""
            if row.get("pdf_url") and CANDIDATE_RE.search(body):
                out.append({"ad_number": row["ad_number"], "pdf_url": row["pdf_url"]})
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def fetch_already_done():
    done = set()
    offset = 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/ad_figures", headers=HEADERS,
            params={"select": "ad_number", "limit": 1000, "offset": offset}, timeout=30,
        )
        r.raise_for_status()
        batch = r.json()
        done.update(row["ad_number"] for row in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return done


def upload_png(ad_number, page_idx, png_bytes):
    fname = f"ad/{ad_number}/page-{page_idx}.png"
    r = requests.put(
        f"{URL}/storage/v1/object/{BUCKET}/{fname}",
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes, timeout=60,
    )
    r.raise_for_status()
    return f"{URL}/storage/v1/object/public/{BUCKET}/{fname}"


def process_one(ad_number, pdf_url):
    resp = requests.get(pdf_url, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    doc = fitz.open(stream=resp.content, filetype="pdf")
    rows = []
    for i in range(doc.page_count):
        pix = doc[i].get_pixmap(dpi=150)
        png = pix.tobytes("png")
        image_url = upload_png(ad_number, i, png)
        rows.append({"ad_number": ad_number, "page_index": i, "image_url": image_url, "sort_order": i})
    doc.close()
    if rows:
        r = requests.post(
            f"{URL}/rest/v1/ad_figures",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"},
            json=rows, timeout=30,
        )
        r.raise_for_status()
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="process at most N candidate ADs (for testing)")
    args = ap.parse_args()

    candidates = fetch_candidates()
    done = fetch_already_done()
    todo = [c for c in candidates if c["ad_number"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(candidates)} candidate ADs, {len(done)} already done, {len(todo)} to process this run")

    ok, failed = 0, []
    for i, c in enumerate(todo):
        try:
            n = process_one(c["ad_number"], c["pdf_url"])
            ok += 1
            print(f"[{i + 1}/{len(todo)}] {c['ad_number']}: {n} pages")
        except Exception as e:
            failed.append((c["ad_number"], str(e)))
            print(f"[{i + 1}/{len(todo)}] {c['ad_number']}: FAILED - {e}")
        time.sleep(0.5)  # polite pacing against govinfo.gov

    print(f"\nDone: {ok} succeeded, {len(failed)} failed")
    if failed:
        print("Failed ADs:")
        for ad_number, err in failed:
            print(f"  {ad_number}: {err}")


if __name__ == "__main__":
    main()
