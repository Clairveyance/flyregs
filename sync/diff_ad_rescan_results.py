#!/usr/bin/env python3
"""
Before/after diff for the 2026-08-14 AD full re-scan (extract_ad_parts.py
--mode full, whole 4,584-AD corpus, hardened 3-guardrail prompt, run on
Haiku per RC's explicit go-ahead).

extract_ad_parts.py's own upsert logic only ever ADDS/merges -- it never
deletes a stale mention, even when the new prompt run would no longer
extract that same part for that AD. So "did the re-scan find and fix
anything" isn't visible from the DB alone; it has to be reconstructed by
comparing a pre-run snapshot against what's live now.

Usage:
  python3 diff_ad_rescan_results.py \
    --before /path/to/ad_mentions_before.json

Prints:
  - New (ad_number, part_name) mentions that didn't exist before the run
    (real new catches, or re-confirmations of what was already there).
  - Any AD whose pre-run mention set is no longer a subset of what the
    fresh extraction (per the run's own log) returned for that AD --
    i.e. the new, hardened prompt disagrees with a previously-stored
    mention. THESE are the ones worth a human look -- the new prompt may
    have correctly stopped extracting an overbroad/wrong part the old
    prompt got wrong (the exact class of bug this whole re-scan exists to
    catch), but the row is still sitting in ad_part_mentions until someone
    deletes it, same as the original 4 manual fixes.

Environment variables required: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
from __future__ import annotations

import argparse
import json
import os
import re

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def fetch_after() -> list[dict]:
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    out = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/ad_part_mentions",
            headers=headers,
            params={"select": "ad_number,ad_parts(name,component_type,status)", "limit": 1000, "offset": offset},
        )
        batch = r.json()
        if not batch:
            break
        out.extend(batch)
        offset += 1000
        if len(batch) < 1000:
            break
    return out


def parse_log_extractions(log_path: str) -> dict[str, list[str]]:
    """Reconstruct what the FRESH run actually extracted per AD, straight
    from its own stdout log line: '  [i/N] AD <number>: [...]'. This is
    the run's own real output, not a re-derived guess."""
    pattern = re.compile(r"AD ([\w-]+): (\[.*\])\s*$")
    out: dict[str, list[str]] = {}
    with open(log_path) as f:
        for line in f:
            m = pattern.search(line)
            if not m:
                continue
            ad_number = m.group(1)
            try:
                names = eval(m.group(2), {"__builtins__": {}})  # noqa: S307 -- trusted, our own log format
            except Exception:
                continue
            out[ad_number] = names
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", required=True, help="path to the pre-run ad_mentions_before.json snapshot")
    ap.add_argument("--log", required=True, help="path to the full run's own stdout log")
    args = ap.parse_args()

    before_raw = json.load(open(args.before))
    before_pairs = set()
    for r in before_raw:
        p = r.get("ad_parts")
        if p:
            before_pairs.add((r["ad_number"], p["name"]))

    after_raw = fetch_after()
    after_pairs = set()
    for r in after_raw:
        p = r.get("ad_parts")
        if p:
            after_pairs.add((r["ad_number"], p["name"]))

    new_pairs = after_pairs - before_pairs
    print(f"Before: {len(before_pairs)} mentions. After: {len(after_pairs)} mentions.")
    print(f"New mentions added this run: {len(new_pairs)}")
    for ad, name in sorted(new_pairs):
        print(f"  + {ad}: {name}")

    extractions = parse_log_extractions(args.log)
    print(f"\nParsed {len(extractions)} ADs' fresh extraction results from the log.")

    # For every AD that HAD a mention before the run AND the run produced a
    # fresh result for it, check whether the old mention still appears in
    # what the new prompt just extracted. If not, the new prompt disagrees
    # with the stored data -- worth a look.
    before_by_ad: dict[str, set[str]] = {}
    for ad, name in before_pairs:
        before_by_ad.setdefault(ad, set()).add(name)

    disagreements = []
    for ad, old_names in before_by_ad.items():
        if ad not in extractions:
            continue  # this AD wasn't re-processed (shouldn't happen in a full run, but be safe)
        fresh_names = set(extractions[ad])
        missing = old_names - fresh_names
        # Exact-string mismatch is expected even for a fine match (minor
        # wording variance the dedup layer already handles) -- only flag
        # when NOTHING in the fresh set even loosely overlaps the old name
        # (no shared word), a stronger signal of a real disagreement.
        for m in missing:
            m_words = set(m.lower().split())
            if not any(m_words & set(f.lower().split()) for f in fresh_names):
                disagreements.append((ad, m, fresh_names))

    print(f"\nPotential disagreements (old stored mention has no wordoverlap with anything the fresh prompt extracted for that AD): {len(disagreements)}")
    for ad, old_name, fresh in disagreements:
        print(f"  ? {ad}: stored '{old_name}' vs fresh {sorted(fresh) or '[]'}")

    print("\nNothing was modified by this script -- read-only diff, for human triage.")


if __name__ == "__main__":
    main()
