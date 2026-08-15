#!/usr/bin/env python3
"""
AD Parts Catalog -- Generic/Common-System Risk Classification
========================================

RC's "worse case" ask (2026-08-14): beyond re-running the extraction prompt
on new/re-scanned ADs, proactively sweep the EXISTING ad_parts catalog for
the exact failure pattern already found and fixed 4 times by hand
(gotcha_ad_equipment_match_overbroad_parent_part.md) -- a part name that
reads as a broad PARENT SYSTEM ("G1000 integrated avionics system",
"Autopilot") rather than the narrow specific component actually named in
the AD. Any such part, if a real user ever logs that generic name as
equipment, produces a false AD match regardless of their actual airframe.

This does NOT re-read AD applicability text (that's extract_ad_parts.py's
job, via --mode full). It classifies each of the ~3,300 already-extracted
CATALOG entries directly -- cheaper (one call per unique part, not per AD)
and catches the risk pattern proactively instead of waiting for a real
false-positive report.

FLAGS ONLY. Never deletes or modifies ad_parts -- same posture as the
extraction script's fuzzy-dedup review queue: a human confirms before
anything changes, this just tells you where to look, prioritized by
whether it's already live-risky (a real user currently has it logged).

Uses Claude Haiku (per RC's explicit 2026-08-14 instruction: "run the
worse-case AD re-scan on Haiku, see how it does" -- evaluating cheap-model
quality before considering the pricier Sonnet option this was originally
scoped against, see PROJECT_NOTES/flyregs_pending.md's 2026-08-14 entry).

Usage:
  python3 classify_ad_parts_generic_risk.py --mode test --limit 10
  python3 classify_ad_parts_generic_risk.py --mode full

Environment variables required:
  SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

# Batched (not one call per part) to keep this cheap -- the whole point is
# this is a much smaller ask than the full re-scan (~3,300 already-distinct
# names vs. 4,584 full applicability texts), and batching cuts call count
# roughly 15x on top of that.
BATCH_SIZE = 15

PROMPT = """You are reviewing a catalog of parts/components extracted from FAA Airworthiness Directives (ADs). Each AD's applicability was originally supposed to name only the NARROW, specific defective component -- but a known failure pattern (confirmed, already found and fixed 4 times in this exact catalog) is a part that's actually a BROAD PARENT SYSTEM instead: something installed on thousands of unrelated aircraft, which would falsely flag any of them if a real user ever logs that generic name as their own aircraft's equipment.

Real confirmed examples of the GENERIC/RISKY pattern (already found and removed from this catalog): "G1000 integrated avionics system" (should have been the specific "GSA 9000 yaw servo" instead), "Autopilot" alone with no manufacturer/model, "Garmin GFC 500 Autopilot System" (should have been the specific STC'd servo).

Real examples of the NARROW/SAFE pattern (correctly specific): "GSA 9000 Yaw Servo", "AWI Mufflers", "Hartzell HC-C2YK-1BF Propeller", "PW120 Turboprop Engine" (a specific engine MODEL, not just "engine").

For each part below, classify it:
- "generic" if the name is a broad system/category ANY of a common family could have (a bare avionics-suite name, "Autopilot" with no specific model, a generic engine/propeller FAMILY name with no model number, an appliance category with no manufacturer/model) -- these are the risky ones.
- "specific" if the name names an actual model/part number/manufacturer-specific component, even if it sounds broad at first glance (a real engine MODEL number, a real avionics box MODEL number, a named STC).

Parts (id -> name):
{parts_list}

Return ONLY a JSON array (no other text), one object per part in the SAME ORDER given, shaped like:
{{"id": "<the id given>", "classification": "generic" or "specific", "reason": "<one short phrase>"}}
"""


def anthropic_classify(parts: list[dict], usage_totals: dict) -> list[dict]:
    parts_list = "\n".join(f"{p['id']} -> {p['name']}" for p in parts)
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": 2048,
            "messages": [{"role": "user", "content": PROMPT.format(parts_list=parts_list)}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    usage = data.get("usage") or {}
    usage_totals["input_tokens"] += usage.get("input_tokens", 0)
    usage_totals["output_tokens"] += usage.get("output_tokens", 0)
    usage_totals["calls"] += 1
    raw = data["content"][0]["text"].strip()
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1 or end < start:
        log.warning(f"  No JSON array found, skipping batch: {raw[:200]}")
        return []
    try:
        return json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        log.warning(f"  Could not parse batch output as JSON: {raw[:200]}")
        return []


def fetch_active_parts(limit: int | None = None) -> list[dict]:
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    out = []
    offset = 0
    page = 1000
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/ad_parts",
            headers=headers,
            params={"select": "id,name,component_type", "status": "eq.active", "limit": page, "offset": offset},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if limit and len(out) >= limit:
            return out[:limit]
        if len(batch) < page:
            break
        offset += page
    return out


def fetch_live_equipment_part_ids() -> set[str]:
    """Which part_ids does at least one real user currently have logged as
    equipment -- the exact signal the original 4 manual fixes prioritized
    on (a flagged part with ZERO real aircraft is a latent risk; one WITH
    real aircraft logged is an active, live-matching risk right now)."""
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/user_aircraft_equipment",
        headers=headers,
        params={"select": "part_id"},
        timeout=30,
    )
    resp.raise_for_status()
    return {r["part_id"] for r in resp.json() if r.get("part_id")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--limit", type=int, default=30)
    args = ap.parse_args()

    if not ANTHROPIC_API_KEY:
        log.error("ANTHROPIC_API_KEY must be set.")
        return
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        return

    parts = fetch_active_parts(limit=args.limit if args.mode == "test" else None)
    log.info(f"{'TEST' if args.mode == 'test' else 'FULL'} mode -- classifying {len(parts)} active parts...")

    live_equipped = fetch_live_equipment_part_ids() if args.mode == "full" else set()

    usage_totals = {"input_tokens": 0, "output_tokens": 0, "calls": 0}
    flagged: list[dict] = []
    by_id = {p["id"]: p for p in parts}

    for i in range(0, len(parts), BATCH_SIZE):
        batch = parts[i:i + BATCH_SIZE]
        try:
            results = anthropic_classify(batch, usage_totals)
        except requests.exceptions.RequestException as e:
            log.warning(f"  Batch {i // BATCH_SIZE + 1} API call failed: {e}")
            continue
        for r in results:
            pid = r.get("id")
            if r.get("classification") == "generic" and pid in by_id:
                flagged.append({
                    "id": pid,
                    "name": by_id[pid]["name"],
                    "component_type": by_id[pid]["component_type"],
                    "reason": r.get("reason", ""),
                    "live_risk": pid in live_equipped,
                })
        log.info(f"  [{min(i + BATCH_SIZE, len(parts))}/{len(parts)}] classified, {len(flagged)} flagged so far")
        time.sleep(0.1)

    flagged.sort(key=lambda f: (not f["live_risk"], f["name"]))

    log.info(f"\nDone. {len(flagged)} of {len(parts)} parts flagged as generic/risky.")
    live_risk_count = sum(1 for f in flagged if f["live_risk"])
    log.info(f"  {live_risk_count} have a REAL aircraft currently logging them as equipment (live risk, review first).")
    log.info(f"  {len(flagged) - live_risk_count} are latent (no aircraft currently affected).")
    for f in flagged:
        tag = "LIVE RISK" if f["live_risk"] else "latent"
        log.info(f"  [{tag}] {f['name']} ({f['component_type']}) -- {f['reason']}")

    if args.mode == "full":
        out_path = "sync/ad_parts_generic_risk_flagged.json"
        with open(out_path, "w") as f:
            json.dump(flagged, f, indent=2)
        log.info(f"\nWritten to {out_path} for manual review. NOTHING in ad_parts was modified.")

    real_cost = (
        usage_totals["input_tokens"] / 1_000_000 * 1.00
        + usage_totals["output_tokens"] / 1_000_000 * 5.00
    )
    log.info(
        f"Real usage: {usage_totals['calls']} calls, {usage_totals['input_tokens']:,} input / "
        f"{usage_totals['output_tokens']:,} output tokens -> ~${real_cost:.2f} at Haiku 4.5 sync rate."
    )


if __name__ == "__main__":
    main()
