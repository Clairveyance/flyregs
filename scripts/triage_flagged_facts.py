#!/usr/bin/env python3
"""
Triage the ~1,221 study_facts rows sitting at status='flagged' (rejected by
the question-bank verify pass) into:

  fixable      -- real, correct fact; just needs better distractors/phrasing.
                  Worth an Opus re-authoring pass.
  weak_source   -- the stored source_quote genuinely can't support a clean,
                  unambiguous question (e.g. a quote showing "(9) ..." used
                  to justify "9 total functions" -- the quote alone doesn't
                  establish that). No model fixes bad source material by
                  trying harder; not worth re-authoring.
  borderline    -- plausible either way; RC's call.

No rejection reason was ever stored at verify time, so this reclassifies
from scratch using only the already-stored short fields (question, answer,
source_quote, distractors) -- NOT the full original document text, which is
what keeps this cheap. Synchronous calls (not the Batches API) on purpose:
this is small enough (~1,221 items) that batch's multi-hour latency isn't
worth it, same reasoning the AD parts extraction run used for its own
Haiku-tier classification pass.

Usage:
    python3 scripts/triage_flagged_facts.py
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import threading
import time

import anthropic
import requests

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = "claude-haiku-4-5-20251001"
CONCURRENCY = 16


def load_env(path):
    out = {}
    for line in open(os.path.join(BASE, path)):
        line = line.strip()
        if line.startswith("export "):
            line = line[len("export "):]
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


SUPABASE = load_env(".env.scraper")
ANTH = load_env(".env.anthropic")
SUPABASE_URL = SUPABASE["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = SUPABASE["SUPABASE_SERVICE_KEY"]

client = anthropic.Anthropic(api_key=ANTH["ANTHROPIC_API_KEY"])

SYSTEM = """You are triaging rejected flashcard-style quiz facts for an aviation regulation study app. Each fact was auto-authored from a real regulatory source and then rejected by a separate verification pass, but WHY it was rejected was never recorded.

Given the question, answer, the short source quote it was grounded in, and (if present) its distractors, classify it into exactly one of:

- "fixable": the question and answer are real and correct given the quote, but something else is likely wrong -- missing/weak distractors, awkward phrasing, a minor formatting issue. A better authoring attempt on the SAME source material would likely produce a good fact.
- "weak_source": the quote itself cannot fully justify the question/answer -- e.g. it's an isolated list item used to claim a total count, a fragment missing necessary context, or the "fact" is really an inference the quote doesn't actually establish. No amount of re-authoring fixes this; the source material itself is insufficient.
- "borderline": genuinely unclear, could go either way.

Respond with ONLY a JSON object: {"verdict": "fixable"|"weak_source"|"borderline", "reason": "<one short sentence>"}"""

RESULTS_LOCK = threading.Lock()
RESULTS = []
IN_TOKENS = 0
OUT_TOKENS = 0
ERRORS = 0


def rest_get_all(path, select, extra_params=None):
    out, offset, page = [], 0, 1000
    headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
    while True:
        params = {"select": select, "offset": offset, "limit": page}
        if extra_params:
            params.update(extra_params)
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, params=params, timeout=30)
        r.raise_for_status()
        chunk = r.json()
        out.extend(chunk)
        if len(chunk) < page:
            break
        offset += page
    return out


def classify_one(row):
    global IN_TOKENS, OUT_TOKENS, ERRORS
    content = (
        f"QUESTION: {row['question']}\n"
        f"ANSWER: {row['answer']}\n"
        f"SOURCE_QUOTE: {row['source_quote']}\n"
        f"DISTRACTORS: {row['distractors'] if row['distractors'] else '(none -- authoring never produced any)'}"
    )
    try:
        resp = client.messages.create(
            model=MODEL, max_tokens=200, system=SYSTEM,
            messages=[{"role": "user", "content": content}],
        )
        text = next((b.text for b in resp.content if b.type == "text"), "")
        text = text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[len("json"):]
        parsed = json.loads(text.strip())
        verdict = parsed.get("verdict", "borderline")
        reason = parsed.get("reason", "")
        with RESULTS_LOCK:
            IN_TOKENS += resp.usage.input_tokens
            OUT_TOKENS += resp.usage.output_tokens
            RESULTS.append({
                "id": row["id"], "item_type": row["item_type"],
                "verdict": verdict, "reason": reason,
            })
    except Exception as e:
        with RESULTS_LOCK:
            ERRORS += 1
            RESULTS.append({
                "id": row["id"], "item_type": row["item_type"],
                "verdict": "borderline", "reason": f"triage call failed: {e}",
            })


def main():
    print("Fetching flagged facts...")
    rows = rest_get_all(
        "study_facts", "id,item_type,question,answer,source_quote,distractors",
        extra_params={"status": "eq.flagged"},
    )
    print(f"{len(rows)} flagged facts to triage, {CONCURRENCY} concurrent Haiku calls...")

    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futures = [ex.submit(classify_one, row) for row in rows]
        done = 0
        for _ in concurrent.futures.as_completed(futures):
            done += 1
            if done % 100 == 0:
                print(f"  ...{done}/{len(rows)} classified ({time.time()-t0:.0f}s elapsed)")

    elapsed = time.time() - t0
    cost = IN_TOKENS * 1.00 / 1e6 + OUT_TOKENS * 5.00 / 1e6  # Haiku 4.5 standard (non-batch) rate

    by_type_verdict = {}
    for r in RESULTS:
        key = (r["item_type"], r["verdict"])
        by_type_verdict[key] = by_type_verdict.get(key, 0) + 1

    print(f"\nDone in {elapsed:.0f}s. {ERRORS} call errors (marked borderline).")
    print(f"Real usage: {IN_TOKENS} input tokens, {OUT_TOKENS} output tokens, cost ${cost:.4f}")
    print("\nBy type x verdict:")
    for (t, v), n in sorted(by_type_verdict.items()):
        print(f"  {t:5s} {v:12s} {n}")

    totals = {}
    for r in RESULTS:
        totals[r["verdict"]] = totals.get(r["verdict"], 0) + 1
    print(f"\nTotals: {totals}")

    out_path = os.path.join(BASE, "scripts", "flagged_triage_results.json")
    with open(out_path, "w") as f:
        json.dump(RESULTS, f, indent=2)
    print(f"\nFull results written to {out_path}")


if __name__ == "__main__":
    main()
