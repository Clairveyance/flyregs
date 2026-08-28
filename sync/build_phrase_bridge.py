#!/usr/bin/env python3
"""One-time LLM pass: generate colloquial-phrasing bridges for FAA-defined
P/CG glossary terms, the systemic version of the manual TAA fix (RC, real
report: "technologically advanced aircraft" found nothing, even though the
FAA's own term -- "technically advanced airplane" -- was right there).

RC, 2026-08-27: "make SS better w/o any ongoing cost... IF you can make SS
justifiably better, and truly amazing, for a small LLM one time spend, then
we can discuss it... you need to find a way to make SS and all of our
search engines much more intelligent... for ALL things like what we found
today with TAA." This is that: instead of hand-adding one bridge entry per
bug report, run every one of the FAA's own 1,406 P/CG glossary terms
through an LLM once, generating the plain-English/colloquial ways a pilot
might actually phrase each one. Output feeds the SAME free, zero-runtime-
cost architecture searchBridge.ts/search_term_associations already use --
this only adds coverage, it doesn't add a query-time cost.

This is a TEST-BATCH script (--sample N) for RC to review real output
quality before committing to the full 1,406-term run. Test mode does NOT
write to the database -- it only prints/saves the generated bridges for
review, exactly like a --dry-run.

Usage:
  python3 sync/build_phrase_bridge.py --sample 50
"""
from __future__ import annotations

import argparse
import json
import logging
import os

import anthropic

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"
env = {}
with open(f"{BASE}/.env.anthropic") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()

client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

MODEL = "claude-sonnet-5"
TERMS_PER_CALL = 10  # keeps each prompt small/clear and lets us checkpoint progress

SYSTEM_PROMPT = """You help pilots find FAA regulatory content by bridging the gap between how \
a real pilot would casually phrase something and the FAA's own official defined term for that \
same concept.

For each FAA Pilot/Controller Glossary term given, generate the realistic colloquial, informal, \
or commonly-confused ways a pilot (student through ATP, not just an expert) might actually type \
or say that concept when searching -- NOT rewordings of the official definition, but genuinely \
DIFFERENT phrasings a real person would use instead of the official term.

Include, where genuinely applicable to that specific term:
- Common abbreviations or acronyms pilots actually use
- Plain-English descriptions of the same thing (how you'd explain it to a student, not the legal phrasing)
- Common near-miss phrasings people get slightly wrong (wrong word order, a swapped-in near-synonym)
- Colloquial pilot slang for the concept, if any exists

Do NOT invent a colloquial phrasing that doesn't genuinely correspond to the term -- if a term \
is already exactly how a pilot would say it (e.g. it's already plain English with no jargon gap), \
return an empty list for it rather than padding with weak/redundant entries. Precision matters \
more than volume -- a wrong bridge actively misleads search, an empty list is fine.

Return ONLY valid JSON, an array of objects, one per input term, in the same order given:
[{"term": "<the exact term as given>", "phrasings": ["<phrasing 1>", "<phrasing 2>", ...]}, ...]
No markdown fences, no commentary, just the JSON array."""


def build_batch_prompt(terms: list[dict]) -> str:
    lines = []
    for t in terms:
        defn = (t["definition"] or "").strip()
        if len(defn) > 500:
            defn = defn[:500] + "..."
        lines.append(f'- TERM: "{t["term"]}"\n  DEFINITION: {defn}')
    return "Generate colloquial phrasing bridges for these FAA P/CG terms:\n\n" + "\n\n".join(lines)


def generate_batch(terms: list[dict], retries: int = 2) -> list[dict]:
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = client.messages.create(
                model=MODEL,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": build_batch_prompt(terms)}],
            )
            text = next(b.text for b in resp.content if b.type == "text").strip()
            if text.startswith("```"):
                text = text.split("\n", 1)[1].rsplit("```", 1)[0]
            parsed = json.loads(text)
            return parsed, resp.usage
        except Exception as e:
            last_err = e
            log.warning(f"  batch attempt {attempt + 1} failed ({e}), {'retrying' if attempt < retries else 'giving up'}")
    raise last_err


def main():
    ap = argparse.ArgumentParser()
    SCRATCH = "/private/tmp/claude-501/-Users-rc-Local-Desktop-COWORK-Apps-AC-app/dda71396-47d8-4940-b2fe-bbaf460c155b/scratchpad"
    ap.add_argument("--sample", type=int, default=50, help="Run against the saved N-term sample, not the full corpus")
    ap.add_argument("--sample-file", default=f"{SCRATCH}/pcg_sample_50.json")
    ap.add_argument("--out", default=f"{SCRATCH}/phrase_bridge_test_output.json")
    args = ap.parse_args()

    with open(args.sample_file) as f:
        terms = json.load(f)[: args.sample]
    log.info(f"Loaded {len(terms)} terms for this run")

    # Resume support -- this is a ~40min unattended run over real API spend;
    # a transient failure partway through should pick back up, not silently
    # re-spend on terms already done. Keyed on term text (stable, matches
    # what's in the output already).
    results = []
    done_terms = set()
    if os.path.exists(args.out):
        with open(args.out) as f:
            results = json.load(f)
        done_terms = {r["term"] for r in results}
        log.info(f"Resuming: {len(done_terms)} terms already done from a prior run of {args.out}")
    terms = [t for t in terms if t["term"] not in done_terms]

    total_in, total_out = 0, 0
    for i in range(0, len(terms), TERMS_PER_CALL):
        chunk = terms[i : i + TERMS_PER_CALL]
        log.info(f"Batch {i // TERMS_PER_CALL + 1}/{-(-len(terms) // TERMS_PER_CALL)}: {[t['term'] for t in chunk]}")
        parsed, usage = generate_batch(chunk)
        results.extend(parsed)
        total_in += usage.input_tokens
        total_out += usage.output_tokens
        with open(args.out, "w") as f:
            json.dump(results, f, indent=2)

    n_with_bridges = sum(1 for r in results if r.get("phrasings"))
    n_total_phrasings = sum(len(r.get("phrasings", [])) for r in results)
    cost = (total_in / 1_000_000) * 3.00 + (total_out / 1_000_000) * 15.00

    log.info(f"Done. {len(results)} terms processed, {n_with_bridges} got at least one bridge, {n_total_phrasings} total phrasings.")
    log.info(f"Tokens: {total_in} in / {total_out} out. Cost estimate: ${cost:.4f}")
    log.info(f"Output saved to {args.out}")


if __name__ == "__main__":
    main()
