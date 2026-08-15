#!/usr/bin/env python3
"""
Third pass on the ad_parts pending_review queue -- continuing after v2
(107 rows resolved via similarity>=0.85 + matching designator tokens).

Found while reviewing what's left: 93 of the remaining 552 rows have
similarity BELOW the 0.85 threshold (so v2 correctly skipped them) but
their designator tokens (P/N or model number) match EXACTLY anyway --
just heavily reworded prose around that token pulls the overall trigram
score down (abbreviation expansion like "HPT" <-> "High-Pressure
Turbine", "PN" <-> "P/N" <-> "Part Number", added/dropped manufacturer
prefix, reordering). A real manufacturer's part number is specifically
designed to be a unique identifier within its own catalog -- two
DIFFERENT real parts sharing the exact same full alphanumeric P/N string
is far less likely than two DESCRIPTIONS of the same part diverging in
wording enough to tank a trigram score. For this domain, an exact
designator-token match is a STRONGER identity signal than aggregate text
similarity, not a weaker one -- v2's threshold was calibrated for the
"similarity alone" case; this pass trusts the token match instead, with
no similarity floor at all.

Sample manually read in full before writing this script (all 93, not a
subset) -- every one confirmed as the same real part, just reworded:
'High-pressure turbine 1st-stage disk, P/N 30G5701' -> 'High-Pressure
Turbine 1st-Stage Hub, P/N 30G5701' (sim=0.84); 'Life Jacket P/N
210225-2' -> 'Safran Aerosystems life jacket P/N 210225-2' (sim=0.56,
manufacturer name added); 'PW150A High-Pressure Centrifugal Impeller
(P/N 3049127-01)' -> 'PW150A Turboprop Engine with HP Centrifugal
Impeller P/N 3049127-01' (sim=0.54, engine-with-part vs part-alone
phrasing, same P/N). See PROJECT_NOTES/flyregs_pending.md for the full
review trail.

Same safety posture as v2: requires the designator-token SET to be
non-empty AND identical (not just overlapping) -- a pure-prose pair with
no P/N/model number anywhere gets no signal from this pass at all and
stays in pending_review for v2/human review to handle.

Usage:
  python3 batch_resolve_pending_review_v3.py --dry-run   (default)
  python3 batch_resolve_pending_review_v3.py --apply

Environment variables required: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
from __future__ import annotations

import argparse
import os
import re
import sys

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from review_pending_ad_parts import merge  # noqa: E402

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
SIMILARITY_FLOOR_HANDLED_BY_V2 = 0.85


def headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def designator_tokens(name: str) -> set[str]:
    raw = re.split(r"[\s,;()]+", name)
    return {t.strip(".,;:").upper() for t in raw if re.search(r"\d", t) and len(t.strip(".,;:")) > 1}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    h = headers()
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                         params={"select": "id,name,component_type,manufacturer", "status": "eq.pending_review"})
    pending = resp.json()
    print(f"{len(pending)} pending_review rows remaining")

    auto_merge = []
    skipped_no_candidate = 0
    skipped_below_v2_and_no_token_match = 0

    for p in pending:
        match = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/find_ad_part_match", headers=h,
                               json={"p_name": p["name"], "p_component_type": p["component_type"]})
        candidates = [c for c in (match.json() if match.status_code < 400 else []) if c["id"] != p["id"]]
        if not candidates:
            skipped_no_candidate += 1
            continue
        best = candidates[0]
        if best["similarity"] >= SIMILARITY_FLOOR_HANDLED_BY_V2:
            continue  # v2's job, not this script's -- already resolved or already correctly blocked there
        p_tokens = designator_tokens(p["name"])
        c_tokens = designator_tokens(best["name"])
        if p_tokens and p_tokens == c_tokens:
            auto_merge.append((p, best))
        else:
            skipped_below_v2_and_no_token_match += 1

    print(f"  auto-merge (similarity < 0.85 BUT designator tokens match exactly): {len(auto_merge)}")
    print(f"  left for v2/human review (below threshold, no exact token match): {skipped_below_v2_and_no_token_match}")
    print(f"  no live candidate at all: {skipped_no_candidate}")

    if not args.apply:
        print(f"\nDRY RUN -- nothing merged. Full list ({len(auto_merge)}):")
        for p, best in auto_merge:
            print(f"    '{p['name']}' -> '{best['name']}' (sim={best['similarity']:.2f})")
        return

    merged = 0
    for p, best in auto_merge:
        try:
            merge(p["id"], best["id"])
            merged += 1
        except SystemExit:
            print(f"  SKIPPED (merge() aborted safely): {p['name']}")
    print(f"\nAuto-merged {merged} of {len(auto_merge)} rows.")


if __name__ == "__main__":
    main()
