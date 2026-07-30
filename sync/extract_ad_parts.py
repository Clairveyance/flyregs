#!/usr/bin/env python3
"""
AD Parts/Components Extraction
========================================
Extracts named parts/components (engines, propellers, avionics, specific
appliances -- anything an AD keys to by PART rather than by airframe
make/model) from airworthiness_directives.applicability text, and writes
them into ad_parts / ad_part_mentions.

Deliberately bounded scope, per flyregs_decisions.md's "AD Compliance-
Tracking Scope Decision": this catalog only ever contains parts that have
actually been named in a real AD's applicability text -- NOT an attempt at
a universal parts database for every aircraft. Confirmed via real sample
data before this was built (see project_flyregs_state.md, 2026-07-26):
AD 2018-02-04 ("AWI mufflers... installed on but not limited to" a list of
airframes) is the exact real-world shape this is meant to catch -- a part-
keyed AD a pure airframe-model match would miss.

Uses Claude Haiku (cheap, fast, this is straightforward extraction, not a
task that needs Opus-level reasoning) via the Anthropic API. COSTS REAL
MONEY per run against the full corpus -- per this project's standing rule
(never run a paid extraction pass without asking first, see
memory/feedback_ask_before_vision.md), do NOT run --mode full without
explicit go-ahead. --mode test runs against a small --limit sample with no
DB writes, safe to run anytime to sanity-check the prompt/parsing.

Modes:
  test    first N ADs only (default 10), prints extracted parts, no DB writes
  full    every AD with real applicability text -- upserts ad_parts
          (dedup on lower(name)+component_type) and ad_part_mentions

--touched-file scopes `full` mode to just the AD numbers in that file (one
per line, same format ad_scraper.py's own --touched-out produces) instead
of the whole corpus -- this is what the weekly AD sync actually uses, since
a normal week only touches a handful of ADs (trivial cost, safe to run
unattended) versus the one-time full-corpus backfill (real cost, needs
explicit go-ahead first -- see this file's own module docstring above).

Usage:
  python3 extract_ad_parts.py --mode test --limit 10
  python3 extract_ad_parts.py --mode full
  python3 extract_ad_parts.py --mode full --touched-file=/tmp/touched.txt

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

VALID_TYPES = {"engine", "propeller", "avionics", "airframe", "appliance", "other"}

PROMPT = """You are extracting NAMED PARTS/COMPONENTS from an FAA Airworthiness Directive's applicability text.

The goal: find specific parts, appliances, engines, propellers, or avionics equipment this AD is keyed to -- NOT the aircraft make/model itself (that's tracked separately). Many ADs apply to a whole airframe type; those should return an empty list. Some ADs are keyed to a specific part regardless of what it's installed on (e.g. "AWI mufflers... installed on but not limited to the airplanes listed...") -- those are exactly what to extract.

Applicability text:
---
{text}
---

Return ONLY a JSON array (no other text), one object per distinct named part/component actually mentioned, each shaped like:
{{"name": "<short part name, e.g. 'AWI Mufflers' or 'Lycoming O-360 Engine'>", "component_type": "<one of: engine, propeller, avionics, airframe, appliance, other>", "manufacturer": "<manufacturer name or null>"}}

If no specific part is named (the AD just applies to the airframe/model generally), return an empty array: []
"""


def anthropic_extract(text: str) -> list[dict]:
    resp = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": ANTHROPIC_MODEL,
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": PROMPT.format(text=text[:4000])}],
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    raw = data["content"][0]["text"].strip()
    # Model sometimes wraps in a ```json fence despite instructions -- strip if present.
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.startswith("json"):
            raw = raw[4:]
    try:
        parts = json.loads(raw)
    except json.JSONDecodeError:
        log.warning(f"  Could not parse model output as JSON, skipping: {raw[:200]}")
        return []
    out = []
    for p in parts if isinstance(parts, list) else []:
        name = (p.get("name") or "").strip()
        ctype = p.get("component_type") or "other"
        if ctype not in VALID_TYPES:
            ctype = "other"
        if name:
            out.append({"name": name, "component_type": ctype, "manufacturer": p.get("manufacturer") or None})
    return out


def fetch_ads_with_applicability(limit: int | None = None, ad_numbers: list[str] | None = None) -> list[dict]:
    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    out = []

    if ad_numbers is not None:
        # Scoped fetch (weekly incremental use) -- batched to stay well
        # under any URL-length limit, same pattern as revision_log.py.
        for i in range(0, len(ad_numbers), 150):
            chunk = ad_numbers[i:i + 150]
            in_list = ",".join(f'"{n}"' for n in chunk)
            resp = requests.get(
                f"{SUPABASE_URL}/rest/v1/airworthiness_directives",
                headers=headers,
                params={"select": "ad_number,applicability", "applicability": "not.is.null", "ad_number": f"in.({in_list})"},
                timeout=30,
            )
            resp.raise_for_status()
            out.extend(resp.json())
        return out

    offset = 0
    page = 200
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives",
            headers=headers,
            params={
                "select": "ad_number,applicability",
                "applicability": "not.is.null",
                "limit": page,
                "offset": offset,
            },
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


def upsert_part(headers: dict, name: str, component_type: str, manufacturer: str | None) -> str | None:
    """Upsert into ad_parts (dedup on lower(name)+component_type), return the part id."""
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/ad_parts",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=representation"},
        params={"on_conflict": "name,component_type"},
        json={"name": name, "component_type": component_type, "manufacturer": manufacturer, "source": "extracted", "status": "active"},
        timeout=15,
    )
    if resp.status_code >= 400:
        # unique index is on lower(name), plain on_conflict "name,component_type"
        # won't match it exactly -- fall back to a lookup-then-insert.
        lookup = requests.get(
            f"{SUPABASE_URL}/rest/v1/ad_parts",
            headers=headers,
            params={"select": "id", "name": f"eq.{name}", "component_type": f"eq.{component_type}"},
            timeout=15,
        )
        rows = lookup.json() if lookup.status_code < 400 else []
        if rows:
            return rows[0]["id"]
        ins = requests.post(
            f"{SUPABASE_URL}/rest/v1/ad_parts",
            headers={**headers, "Prefer": "return=representation"},
            json={"name": name, "component_type": component_type, "manufacturer": manufacturer, "source": "extracted", "status": "active"},
            timeout=15,
        )
        if ins.status_code >= 400:
            log.warning(f"  Could not insert part '{name}': {ins.text[:200]}")
            return None
        return ins.json()[0]["id"]
    rows = resp.json()
    return rows[0]["id"] if rows else None


def link_mention(headers: dict, ad_number: str, part_id: str) -> None:
    requests.post(
        f"{SUPABASE_URL}/rest/v1/ad_part_mentions",
        headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
        params={"on_conflict": "ad_number,part_id"},
        json={"ad_number": ad_number, "part_id": part_id},
        timeout=15,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "full"], default="test")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--touched-file", default=None, help="scope --mode full to just these AD numbers (one per line) instead of the whole corpus")
    args = ap.parse_args()

    if not ANTHROPIC_API_KEY:
        log.error("ANTHROPIC_API_KEY must be set.")
        return
    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.")
        return

    touched_ad_numbers = None
    if args.touched_file:
        if not os.path.exists(args.touched_file):
            log.info(f"Touched-file {args.touched_file} not found — nothing to extract.")
            return
        with open(args.touched_file) as f:
            touched_ad_numbers = [ln.strip() for ln in f if ln.strip()]
        if not touched_ad_numbers:
            log.info("Touched-file is empty — no ADs changed this run, nothing to extract.")
            return

    ads = fetch_ads_with_applicability(
        limit=args.limit if args.mode == "test" else None,
        ad_numbers=touched_ad_numbers,
    )
    log.info(f"{'TEST' if args.mode == 'test' else 'FULL'} mode — scanning {len(ads)} ADs for named parts...")

    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
    total_parts_found = 0
    total_mentions = 0

    for i, ad in enumerate(ads, 1):
        text = ad.get("applicability") or ""
        if not text.strip():
            continue
        try:
            parts = anthropic_extract(text)
        except requests.exceptions.RequestException as e:
            log.warning(f"  [{i}/{len(ads)}] {ad['ad_number']}: API call failed: {e}")
            continue

        if parts:
            log.info(f"  [{i}/{len(ads)}] AD {ad['ad_number']}: {[p['name'] for p in parts]}")
            total_parts_found += len(parts)

        if args.mode == "full":
            for p in parts:
                part_id = upsert_part(headers, p["name"], p["component_type"], p["manufacturer"])
                if part_id:
                    link_mention(headers, ad["ad_number"], part_id)
                    total_mentions += 1

        time.sleep(0.05)  # light pacing, not strictly required but polite

    log.info(f"\nDone. {total_parts_found} part mention(s) found across {len(ads)} ADs scanned.")
    if args.mode == "full":
        log.info(f"{total_mentions} ad_part_mentions row(s) written.")
    else:
        log.info("Dry run (test mode) — no DB writes.")


if __name__ == "__main__":
    main()
