#!/usr/bin/env python3
"""
Fixes the page header/footer text leak documented in detect_header_leak.py:
strips the exact matched boilerplate ("{date} AC {own document_number}
[CHG N]") from pdf_text and collapses the surrounding whitespace, wherever
it appears. Anchored on the AC's own document_number, so false-positive
risk is very low — this template never legitimately appears as body prose.

Updates ONLY pdf_text — deliberately does NOT touch pdf_blocks_version.
Setting that to NULL is the scraper's specific signal for "the FAA published
a real revision" (see backfill-blocks.mjs's computeChangedIndices call),
which would make this internal cleanup pass show up as a false "UPD" badge
and What's New diff entry on all 652 ACs. Instead, run
scripts/reparse_blocks_silent.mjs afterward with the touched-doc-numbers
list this script writes — that regenerates pdf_blocks from the now-clean
pdf_text without going anywhere near pdf_blocks_version or the diff logic.

Modes:
  --doc=43-4B --dry-run     Show before/after for one AC, no writes
  --doc=43-4B               Apply to one AC for real
  --all --dry-run           Show a summary across the whole affected set, no writes
  --all --limit=10          Apply to the first N affected ACs (for staged rollout)
  --all                     Apply to every affected AC
"""

import argparse
import json
import os
import re

import requests

SCRAPER_ENV = os.path.join(os.path.dirname(__file__), "..", ".env.scraper")


def load_env(path: str) -> dict:
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env(SCRAPER_ENV)
SUPABASE_URL = ENV["SUPABASE_URL"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

DATE_RE = r"\d{1,2}/\d{1,2}/\d{2,4}"


def build_pattern(doc_num: str) -> re.Pattern:
    escaped = re.escape(doc_num)
    # Trailing page-locator: only the unambiguous "chapter-page" numeric
    # form (e.g. "1-2", "6-14") is safely strippable — a bare number alone,
    # or a roman numeral like "ii", is too easily confused with real body
    # content (a real "2", a real word "i"/"ii" is rare here but not
    # impossible), so those are left in place for a future, more careful pass.
    return re.compile(
        rf"\s*{DATE_RE}\s+AC\s+{escaped}(\s+CHG\s+\d+)?\s*(\d+-\d+\s*)?",
        re.IGNORECASE,
    )


def clean_text(doc_num: str, text: str) -> tuple[str, int]:
    pattern = build_pattern(doc_num)
    cleaned, n = pattern.subn(" ", text)
    # Collapse any resulting run of spaces (but preserve real paragraph
    # breaks — only touch horizontal whitespace runs, not newlines).
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned, n


def fetch_ac(doc_num: str) -> dict:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars"
        f"?document_number=eq.{doc_num}&select=id,document_number,pdf_text",
        headers=HEADERS, timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        raise SystemExit(f"No AC found for {doc_num}")
    return rows[0]


TOUCHED_PATH = os.path.join(os.path.dirname(__file__), "..", "header_leak_fixed_docs.json")


def update_ac(ac_id: str, cleaned_text: str):
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/advisory_circulars?id=eq.{ac_id}",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"pdf_text": cleaned_text},
        timeout=30,
    )
    resp.raise_for_status()


def record_touched(doc_nums: list):
    """Appends to the touched-doc-numbers list that
    scripts/reparse_blocks_silent.mjs consumes afterward to regenerate
    pdf_blocks from the now-clean pdf_text, without going anywhere near
    pdf_blocks_version or the diff/badge logic."""
    existing = []
    if os.path.exists(TOUCHED_PATH):
        with open(TOUCHED_PATH) as f:
            existing = json.load(f)
    merged = sorted(set(existing) | set(doc_nums))
    with open(TOUCHED_PATH, "w") as f:
        json.dump(merged, f, indent=2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="One AC by document_number")
    ap.add_argument("--all", action="store_true", help="All affected ACs")
    ap.add_argument("--dry-run", action="store_true", help="Show what would change, no writes")
    ap.add_argument("--limit", type=int, default=None, help="Cap how many ACs to apply with --all")
    args = ap.parse_args()

    if args.doc:
        ac = fetch_ac(args.doc)
        cleaned, n = clean_text(ac["document_number"], ac["pdf_text"] or "")
        verb = "would be removed" if args.dry_run else "removed"
        print(f"{ac['document_number']}: {n} occurrence(s) {verb}")
        if args.dry_run:
            # Show a small window around the first change for a quick sanity check
            pattern = build_pattern(ac["document_number"])
            m = pattern.search(ac["pdf_text"] or "")
            if m:
                s, e = m.span()
                print("\n--- before ---")
                print(repr((ac["pdf_text"] or "")[max(0, s - 60):e + 60]))
                # find the same spot in cleaned text by locating unique context
                before_ctx = (ac["pdf_text"] or "")[max(0, s - 30):s]
                idx = cleaned.find(before_ctx.strip()[-20:]) if before_ctx.strip() else -1
                print("\n--- after ---")
                if idx >= 0:
                    print(repr(cleaned[max(0, idx - 10):idx + 100]))
            return
        update_ac(ac["id"], cleaned)
        record_touched([ac["document_number"]])
        print("Applied. Run scripts/reparse_blocks_silent.mjs next to regenerate pdf_blocks.")
        return

    if args.all:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars"
            f"?select=id,document_number,pdf_text&pdf_text=not.is.null&order=document_number.asc",
            headers=HEADERS, timeout=60,
        )
        # paginate
        acs = []
        page_size = 50
        offset = 0
        while True:
            r = requests.get(
                f"{SUPABASE_URL}/rest/v1/advisory_circulars"
                f"?select=id,document_number,pdf_text&pdf_text=not.is.null"
                f"&order=document_number.asc&limit={page_size}&offset={offset}",
                headers=HEADERS, timeout=60,
            )
            r.raise_for_status()
            batch = r.json()
            if not batch:
                break
            acs.extend(batch)
            offset += page_size

        affected = 0
        total_removed = 0
        applied = 0
        applied_docs = []
        for ac in acs:
            cleaned, n = clean_text(ac["document_number"], ac["pdf_text"] or "")
            if n == 0:
                continue
            affected += 1
            total_removed += n
            if args.dry_run:
                continue
            if args.limit and applied >= args.limit:
                continue
            update_ac(ac["id"], cleaned)
            applied += 1
            applied_docs.append(ac["document_number"])
            print(f"[{applied}] {ac['document_number']}: cleaned {n} occurrence(s)")

        print(f"\n{'Would affect' if args.dry_run else 'Affected'} {affected} ACs, {total_removed} total occurrences")
        if not args.dry_run:
            record_touched(applied_docs)
            print(f"Applied to {applied} ACs. Run scripts/reparse_blocks_silent.mjs next to regenerate pdf_blocks.")
        return

    ap.print_help()


if __name__ == "__main__":
    main()
