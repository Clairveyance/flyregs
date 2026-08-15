#!/usr/bin/env python3
"""
Batch triage for the ad_parts pending_review queue, built after the
2026-08-14 full re-scan left ~659 rows queued (expected -- re-scanning
ADs that were already processed once means the same real part is often
re-extracted with slightly different wording than before, and the fuzzy-
dedup safety net correctly holds anything uncertain for review rather
than silently auto-merging or silently treating it as new).

Reuses scripts/review_pending_ad_parts.py's own `merge()` exactly (same
safe alias-record + re-link-mentions + delete-pending sequence, re-queries
find_ad_part_match live rather than trusting a stale snapshot) -- this
script's only addition is deciding WHICH pending rows are confident enough
to merge automatically vs. which genuinely need a human.

Threshold: only auto-merges at similarity >= 0.85 (well above the base
0.5 fuzzy-review floor) AND matching component_type -- conservative on
purpose, since a wrong auto-merge would silently conflate two different
real parts. Everything below that stays queued, untouched, exactly as
before this script ran (still invisible to real users via
ad_parts_read_active's status='active' requirement).

DO NOT RUN --apply ON THIS AS-IS. Dry-run on the real 2026-08-14 queue
(659 rows) found 187 candidates at sim>=0.85, but manually reading a
15-row sample turned up 2 clear FALSE POSITIVES even at that raised bar:
"CFM56-3 Engine with 73-tooth or 41-tooth gearshaft" vs "CFM56-7B Engine
with..." (sim=0.91 -- DIFFERENT real engine models, the shared 40+
character suffix inflates trigram similarity despite the model number
itself, the only part that actually matters, being different) and a
"Main Rotor Shaft... S6135-20640-002" vs "...-001" pair (different P/N
suffix, likely a genuinely different specific part). Pure trigram string
similarity cannot distinguish "same part, reworded" from "different
part, nearly-identical surrounding text" when the ONLY differing token is
itself the model/part-number -- exactly the detail this catalog's whole
design is supposed to be precise about. A real fix needs to specifically
extract and compare the differing token(s) between the two names (does it
look like a P/N or model designator -- alphanumeric, contains digits --
vs. plain prose wording) rather than trusting an aggregate score, and
that logic doesn't exist yet. Left at dry-run only; the 659 pending rows
are unresolved but harmless (RLS-invisible to real users) -- flagged for
a real fix, not run blind. See PROJECT_NOTES/flyregs_pending.md,
2026-08-14 AD re-scan section.

Usage:
  python3 batch_resolve_pending_review.py --dry-run   (default)
  python3 batch_resolve_pending_review.py --apply

Environment variables required: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
from __future__ import annotations

import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from review_pending_ad_parts import merge  # noqa: E402

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
AUTO_MERGE_THRESHOLD = 0.85


def headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    h = headers()
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                         params={"select": "id,name,component_type,manufacturer", "status": "eq.pending_review"})
    pending = resp.json()
    print(f"{len(pending)} pending_review rows")

    auto_merge_candidates = []
    needs_human = []
    no_candidate = []

    for p in pending:
        match = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/find_ad_part_match", headers=h,
                               json={"p_name": p["name"], "p_component_type": p["component_type"]})
        candidates = [c for c in (match.json() if match.status_code < 400 else []) if c["id"] != p["id"]]
        if not candidates:
            no_candidate.append(p)
            continue
        best = candidates[0]
        if best["similarity"] >= AUTO_MERGE_THRESHOLD:
            auto_merge_candidates.append((p, best))
        else:
            needs_human.append((p, best))

    print(f"  auto-merge candidates (sim >= {AUTO_MERGE_THRESHOLD}): {len(auto_merge_candidates)}")
    print(f"  needs human review (sim < {AUTO_MERGE_THRESHOLD}): {len(needs_human)}")
    print(f"  no live candidate match at all (flagged-against part since gone): {len(no_candidate)}")

    if not args.apply:
        print("\nDRY RUN -- nothing merged. Sample of auto-merge candidates:")
        for p, best in auto_merge_candidates[:15]:
            print(f"    '{p['name']}' -> '{best['name']}' (sim={best['similarity']:.2f})")
        return

    merged = 0
    for p, best in auto_merge_candidates:
        try:
            merge(p["id"], best["id"])
            merged += 1
        except SystemExit:
            print(f"  SKIPPED (merge() aborted safely): {p['name']}")
    print(f"\nAuto-merged {merged} of {len(auto_merge_candidates)} high-confidence rows.")
    print(f"{len(needs_human) + len(no_candidate)} rows left in pending_review for manual triage.")


if __name__ == "__main__":
    main()
