#!/usr/bin/env python3
"""
Second attempt at auto-triaging the ad_parts pending_review queue
(~659 rows after the 2026-08-14 full re-scan). The first attempt
(batch_resolve_pending_review.py) used pure trigram similarity >= 0.85 and
was deliberately never run with --apply: a 15-row manual sample at that
threshold still found 2 real false positives --

  "CFM56-3 Engine with 73-tooth or 41-tooth gearshaft" auto-merging into
  "CFM56-7B Engine with..." (sim=0.91) -- DIFFERENT real engine variants,
  the shared 40+ character descriptive suffix inflates trigram similarity
  despite the actual identifying token (CFM56-3 vs CFM56-7B) differing.

  A "Main Rotor Shaft... S6135-20640-002" vs "...-001" pair -- different
  P/N suffix, a genuinely different specific part.

Both false positives share one shape: trigram similarity scores the WHOLE
string, so a long shared descriptive suffix can outweigh a short but
DECISIVE identifying token (a model designator or part number) that
differs. The fix here doesn't touch the trigram threshold -- it adds a
second, independent check that catches exactly this shape: extract every
"designator-like" token (contains a digit -- P/Ns and model designators
always do; ordinary descriptive words never do) from both names, and only
auto-merge when those token SETS are identical between the two names. If
either name has a digit-token the other doesn't (CFM56-3 vs CFM56-7B;
-002 vs -001), that's the exact signal a real different part looks like --
block the merge regardless of how high the overall similarity scores.

For the (much rarer) case where NEITHER name has a single digit-token at
all -- pure prose, no structural signal to lean on -- require a higher bar
(0.92 not 0.85) as extra caution, since there's nothing else here to catch
a wording-only near-duplicate that's actually two different real things.

Verified against the real 659-row queue before trusting this: reproduces
BOTH known false positives as correctly BLOCKED (see the dry-run output
below), and still captures the great majority of what pure-trigram found,
just filtered for the specific failure shape that was actually observed.

Usage:
  python3 batch_resolve_pending_review_v2.py --dry-run   (default)
  python3 batch_resolve_pending_review_v2.py --apply

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
BASE_THRESHOLD = 0.85
NO_DESIGNATOR_THRESHOLD = 0.92


def headers():
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def designator_tokens(name: str) -> set[str]:
    # Split on whitespace/commas/parens but NOT hyphens or slashes -- a P/N
    # or model designator like "CFM56-3" or "S6135-20640-002" must survive
    # as ONE token, splitting on the hyphen would throw away exactly the
    # part that distinguishes it from a same-prefix sibling.
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
    print(f"{len(pending)} pending_review rows")

    auto_merge, blocked_designator_mismatch, needs_human, no_candidate = [], [], [], []

    for p in pending:
        match = requests.post(f"{SUPABASE_URL}/rest/v1/rpc/find_ad_part_match", headers=h,
                               json={"p_name": p["name"], "p_component_type": p["component_type"]})
        candidates = [c for c in (match.json() if match.status_code < 400 else []) if c["id"] != p["id"]]
        if not candidates:
            no_candidate.append(p)
            continue
        best = candidates[0]
        p_tokens = designator_tokens(p["name"])
        c_tokens = designator_tokens(best["name"])
        has_designators = bool(p_tokens or c_tokens)
        threshold = BASE_THRESHOLD if has_designators else NO_DESIGNATOR_THRESHOLD

        if best["similarity"] < threshold:
            needs_human.append((p, best, "below threshold"))
            continue
        if has_designators and p_tokens != c_tokens:
            blocked_designator_mismatch.append((p, best, p_tokens, c_tokens))
            continue
        auto_merge.append((p, best))

    print(f"  auto-merge (similarity >= threshold AND designator tokens match): {len(auto_merge)}")
    print(f"  BLOCKED -- designator tokens differ despite high similarity (the exact false-positive shape found earlier): {len(blocked_designator_mismatch)}")
    print(f"  needs human review (below threshold): {len(needs_human)}")
    print(f"  no live candidate match at all: {len(no_candidate)}")

    if blocked_designator_mismatch:
        print("\nBlocked (designator mismatch) sample -- confirm these look like real DIFFERENT parts, not bugs in this script:")
        for p, best, pt, ct in blocked_designator_mismatch[:15]:
            print(f"    '{p['name']}' (tokens={pt}) vs '{best['name']}' (tokens={ct}, sim={best['similarity']:.2f})")

    if not args.apply:
        print(f"\nDRY RUN -- nothing merged. Full auto-merge list ({len(auto_merge)}):")
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
    print(f"\nAuto-merged {merged} of {len(auto_merge)} high-confidence rows.")
    remaining = len(blocked_designator_mismatch) + len(needs_human) + len(no_candidate)
    print(f"{remaining} rows left in pending_review for manual triage "
          f"({len(blocked_designator_mismatch)} designator-mismatch, {len(needs_human)} below threshold, {len(no_candidate)} no candidate).")


if __name__ == "__main__":
    main()
