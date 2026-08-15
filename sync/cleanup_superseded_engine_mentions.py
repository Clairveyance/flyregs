#!/usr/bin/env python3
"""
One-off cleanup for the 2026-08-14 AD full re-scan's biggest finding.

The re-scan (hardened 3-guardrail prompt) systematically supersedes a
pre-guardrail pattern found live in `ad_part_mentions`: hundreds of ADs had
a bare ENGINE MODEL (e.g. "PW1133G-JM Turbofan Engine") stored as a "part"
mention, when the AD's own real applicability text is actually scoped to
that engine model WITH a specific named component installed (e.g. "...with
low-pressure turbine 3rd-stage blades, P/N 5387343... installed"). This is
structurally the exact same overbroad-parent-system mistake as the original
G1000/GSA-9000 incident (gotcha_ad_equipment_match_overbroad_parent_part.md)
-- the engine model is the scoping condition, the named component is the
real narrow culprit -- just recurring at scale because the guardrail rules
that fixed it for new extractions didn't exist yet when this older data was
written.

Verified before writing this script, not assumed:
- 15 real samples (not just the first few found) checked directly against
  the live airworthiness_directives.applicability text -- 15/15 confirmed
  the "[engine model] with [specific part] installed" shape.
- Cross-referenced all 429 distinct superseded-engine-name parts against
  user_aircraft_equipment: ZERO currently have any real aircraft logged
  against them, so this is a pure data-quality/latent-risk cleanup, not an
  active-incident fix -- no urgency-driven rush, but also nothing to lose
  by cleaning it up now while the evidence is fresh.
- Deliberately scoped to the "engine-like" 532 of 589 total disagreements
  (old name contains engine/turbofan/turboshaft/turboprop/reciprocating) --
  the remaining 57 "other shape" disagreements (torque tools, PMA parts,
  modification numbers, bare Trent variant names without "Engine" in the
  string) don't fit this confirmed pattern and are NOT touched here; they
  need individual review, tracked separately.

Only deletes the specific (ad_number, part_id) MENTION -- never the
underlying ad_parts catalog row itself, since that same part/engine-model
NAME may be correctly, legitimately referenced by a completely different
AD where no narrower part was ever found (a genuinely engine-model-wide
AD is a real, valid shape this catalog also needs to support).

Usage:
  python3 cleanup_superseded_engine_mentions.py --dry-run   (default, no writes)
  python3 cleanup_superseded_engine_mentions.py --apply

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
ENGINE_WORDS = ("engine", "turbofan", "turboshaft", "turboprop", "reciprocating")


def parse_disagreements(diff_log_path: str) -> list[dict]:
    out = []
    pattern = re.compile(r"^  \? ([\w-]+): stored '(.+)' vs fresh")
    with open(diff_log_path) as f:
        for line in f:
            m = pattern.match(line)
            if m:
                out.append({"ad_number": m.group(1), "old_name": m.group(2)})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--diff-log", required=True)
    ap.add_argument("--apply", action="store_true", help="actually delete; default is dry-run")
    args = ap.parse_args()

    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

    disagreements = parse_disagreements(args.diff_log)
    engine_like = [d for d in disagreements if any(w in d["old_name"].lower() for w in ENGINE_WORDS)]
    print(f"{len(disagreements)} total disagreements, {len(engine_like)} engine-like (in scope), "
          f"{len(disagreements) - len(engine_like)} other-shape (NOT touched, needs separate review)")

    # Resolve names -> part ids by fetching the whole active catalog once
    # (robust against special characters in part names that would break a
    # PostgREST `or=` filter string).
    all_parts, offset = [], 0
    while True:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                          params={"select": "id,name", "limit": 1000, "offset": offset})
        batch = r.json()
        all_parts.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    name_to_id = {p["name"]: p["id"] for p in all_parts}

    to_delete = []
    unresolved = []
    for d in engine_like:
        pid = name_to_id.get(d["old_name"])
        if pid:
            to_delete.append({"ad_number": d["ad_number"], "part_id": pid, "name": d["old_name"]})
        else:
            unresolved.append(d)

    print(f"resolved {len(to_delete)} (ad_number, part_id) mention pairs to remove")
    if unresolved:
        print(f"WARNING: {len(unresolved)} disagreements had no matching part name (name changed since the diff ran?) -- skipped, not deleted")
        for u in unresolved[:10]:
            print("  unresolved:", u)

    if not args.apply:
        print("\nDRY RUN -- nothing deleted. Re-run with --apply to actually remove these mentions.")
        with open("sync/superseded_engine_mentions_preview.json", "w") as f:
            json.dump(to_delete, f, indent=2)
        print("Full list written to sync/superseded_engine_mentions_preview.json for review.")
        return

    deleted = 0
    failed = []
    for row in to_delete:
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/ad_part_mentions",
            headers=h,
            params={"ad_number": f"eq.{row['ad_number']}", "part_id": f"eq.{row['part_id']}"},
        )
        if resp.status_code in (200, 204):
            deleted += 1
        else:
            failed.append({**row, "status": resp.status_code, "body": resp.text[:200]})

    print(f"\nDeleted {deleted} of {len(to_delete)} superseded mention rows.")
    if failed:
        print(f"{len(failed)} failed:")
        for f_ in failed[:10]:
            print(" ", f_)


if __name__ == "__main__":
    main()
