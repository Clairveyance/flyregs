#!/usr/bin/env python3
"""
Review queue for AD parts flagged as a possible-but-uncertain duplicate
during extraction (sync/extract_ad_parts.py's upsert_part(), fuzzy tier).

These rows are already status='pending_review' -- invisible to real users
via the existing ad_parts_read_active RLS policy (which requires
status='active'), so leaving them unreviewed for a while is safe, not an
active bug. This script is how a human actually closes the loop: for each
pending row, re-queries find_ad_part_match live (never trusts a stale
snapshot -- the candidate it was originally flagged against may since have
been renamed, merged, or deleted) and shows the two names side by side for
a real decision.

Read-only by default (--list). Actions require the specific verb:
  --merge <pending_id> <target_id>   same real part -- record the pending
                                      row's name as an alias on the target,
                                      re-point any ad_part_mentions it
                                      already picked up, delete the pending
                                      row.
  --promote <pending_id>             different real part after all --
                                      activate it as its own catalog entry.
  --reject <pending_id>              neither (bad extraction, junk) --
                                      delete it and its mentions.

Usage:
  python3 scripts/review_pending_ad_parts.py --list
  python3 scripts/review_pending_ad_parts.py --merge <pending_id> <target_id>
  python3 scripts/review_pending_ad_parts.py --promote <pending_id>
  python3 scripts/review_pending_ad_parts.py --reject <pending_id>
"""
from __future__ import annotations

import argparse
import os
import sys

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")


def headers():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY (source .env.scraper first)", file=sys.stderr)
        sys.exit(1)
    return {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def list_pending():
    h = headers()
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/ad_parts",
        headers=h,
        params={"select": "id,name,component_type,manufacturer,created_at", "status": "eq.pending_review", "order": "created_at.desc"},
        timeout=15,
    )
    resp.raise_for_status()
    pending = resp.json()
    if not pending:
        print("No parts pending review.")
        return
    print(f"{len(pending)} part(s) pending review:\n")
    for p in pending:
        match = requests.post(
            f"{SUPABASE_URL}/rest/v1/rpc/find_ad_part_match",
            headers=h,
            json={"p_name": p["name"], "p_component_type": p["component_type"]},
            timeout=15,
        )
        candidate = match.json() if match.status_code < 400 else []
        # The pending row itself may now show up as its own "exact" match if
        # nothing else does -- exclude it.
        candidate = [c for c in candidate if c["id"] != p["id"]]
        print(f"  {p['id']}  [{p['component_type']}]  \"{p['name']}\"  ({p.get('manufacturer') or 'no manufacturer'})")
        if candidate:
            c = candidate[0]
            print(f"    ~ current best match: \"{c['name']}\" (id={c['id']}, similarity={c['similarity']:.2f})")
        else:
            print(f"    ~ no current candidate match (the part it was flagged against may since be gone)")
        print()
    print("Actions:")
    print("  --merge <pending_id> <target_id>   same part -- alias + re-link mentions, delete pending row")
    print("  --promote <pending_id>             different part -- activate as its own entry")
    print("  --reject <pending_id>              bad extraction -- delete it")


def merge(pending_id: str, target_id: str):
    h = headers()
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                         params={"select": "id,name", "id": f"eq.{pending_id}"}, timeout=15)
    rows = resp.json()
    if not rows:
        print(f"No pending part with id {pending_id}", file=sys.stderr)
        sys.exit(1)
    pending_name = rows[0]["name"]

    tgt = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                        params={"select": "id,name,aliases", "id": f"eq.{target_id}"}, timeout=15)
    trows = tgt.json()
    if not trows:
        print(f"No target part with id {target_id}", file=sys.stderr)
        sys.exit(1)
    aliases = trows[0].get("aliases") or []
    if pending_name not in aliases:
        aliases = aliases + [pending_name]
    requests.patch(f"{SUPABASE_URL}/rest/v1/ad_parts", headers={**h, "Prefer": "return=minimal"},
                    params={"id": f"eq.{target_id}"}, json={"aliases": aliases}, timeout=15)

    # Re-point any ad_part_mentions the pending row already picked up onto
    # the real target -- merge-on-conflict so a mention that already exists
    # on the target for the same AD doesn't collide.
    mentions = requests.get(f"{SUPABASE_URL}/rest/v1/ad_part_mentions", headers=h,
                             params={"select": "ad_number", "part_id": f"eq.{pending_id}"}, timeout=15)
    relink_failures = []
    for m in mentions.json():
        rl = requests.post(f"{SUPABASE_URL}/rest/v1/ad_part_mentions",
                            headers={**h, "Prefer": "resolution=merge-duplicates,return=minimal"},
                            params={"on_conflict": "ad_number,part_id"},
                            json={"ad_number": m["ad_number"], "part_id": target_id}, timeout=15)
        if rl.status_code >= 400:
            relink_failures.append((m["ad_number"], rl.status_code, rl.text[:200]))
    if relink_failures:
        print(f"ABORTED: {len(relink_failures)} mention(s) failed to re-link -- NOT deleting the pending part or its "
              f"mentions, so nothing is lost. Alias was already recorded on the target; fix the cause below and re-run:",
              file=sys.stderr)
        for ad_number, code, text in relink_failures:
            print(f"  {ad_number}: {code} {text}", file=sys.stderr)
        sys.exit(1)
    requests.delete(f"{SUPABASE_URL}/rest/v1/ad_part_mentions", headers=h,
                     params={"part_id": f"eq.{pending_id}"}, timeout=15)
    requests.delete(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h, params={"id": f"eq.{pending_id}"}, timeout=15)
    print(f"Merged '{pending_name}' into '{trows[0]['name']}' ({target_id}); alias recorded, mentions re-linked, pending row deleted.")


def promote(pending_id: str):
    h = headers()
    resp = requests.patch(f"{SUPABASE_URL}/rest/v1/ad_parts", headers={**h, "Prefer": "return=representation"},
                           params={"id": f"eq.{pending_id}"}, json={"status": "active"}, timeout=15)
    rows = resp.json() if resp.status_code < 400 else []
    if not rows:
        print(f"No pending part with id {pending_id}", file=sys.stderr)
        sys.exit(1)
    print(f"Promoted '{rows[0]['name']}' to status=active -- now a real, independent catalog entry.")


def reject(pending_id: str):
    h = headers()
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                         params={"select": "id,name", "id": f"eq.{pending_id}"}, timeout=15)
    rows = resp.json()
    if not rows:
        print(f"No pending part with id {pending_id}", file=sys.stderr)
        sys.exit(1)
    requests.delete(f"{SUPABASE_URL}/rest/v1/ad_part_mentions", headers=h,
                     params={"part_id": f"eq.{pending_id}"}, timeout=15)
    requests.delete(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h, params={"id": f"eq.{pending_id}"}, timeout=15)
    print(f"Rejected and deleted '{rows[0]['name']}' ({pending_id}).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--merge", nargs=2, metavar=("PENDING_ID", "TARGET_ID"))
    ap.add_argument("--promote", metavar="PENDING_ID")
    ap.add_argument("--reject", metavar="PENDING_ID")
    args = ap.parse_args()

    if args.merge:
        merge(*args.merge)
    elif args.promote:
        promote(args.promote)
    elif args.reject:
        reject(args.reject)
    else:
        list_pending()


if __name__ == "__main__":
    main()
