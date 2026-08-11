#!/usr/bin/env python3
"""Corpus-wide search-ranking gap sweep. For every FAR section (and
optionally AIM paragraph / P/CG term), searches for a normalized version of
the section's OWN TITLE and checks whether that section actually comes
back near the top of its own search results. A title is the closest thing
to "how a pilot would phrase the question" that exists for every single
row already, without needing to hand-write one question per section --
titles that don't retrieve their own section are real, provable ranking
failures, not guesses.

Built 2026-08-11 after RC flagged FAR 23.2120 ("Climb requirements")
ranking #7 for "what are the climb requirements for multi engine
airplanes?", behind six oxygen/engine-out sections that just share more
raw keywords -- asked for a corpus-wide sweep to find what else has the
same problem. See PROJECT_NOTES/flyregs_pending.md's 2026-08-11 entry and
memory/smartsearch_concept_anchors.md for the concept-anchor mechanism
this is meant to feed.

Usage: python3 scripts/search_anchor_gap_sweep.py [far|aim|pcg] [--limit N]
  (no args)  Runs FAR (the largest, most requirements-dense corpus).
  --limit N  Only test the first N sections (for a quick smoke test).
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {}
with open(os.path.join(BASE, ".env")) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        env[k] = v.strip('"')

SUPABASE_URL = env["EXPO_PUBLIC_SUPABASE_URL"]
ANON_KEY = env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
HEADERS = {"apikey": ANON_KEY, "Content-Type": "application/json"}

SEC_PREFIX_RE = re.compile(r"^§+\s*[\d.]+[A-Za-z]?(?:\s*[-–]\s*[\d.]+[A-Za-z]?)?\s*")


def clean_title(title):
    # Strip the leading "§ 23.2120 " citation prefix and trailing period --
    # a pilot asking a question doesn't say the section number, and a bare
    # question mark/period on the end doesn't change what's being searched.
    t = SEC_PREFIX_RE.sub("", title or "").strip()
    t = t.rstrip(".").strip()
    return t


def rest_get(path):
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}", headers=HEADERS)
    return json.loads(urllib.request.urlopen(req).read().decode())


def search(fn, query, limit=10):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn}",
        data=json.dumps({"query": query, "result_limit": limit}).encode(),
        headers=HEADERS, method="POST",
    )
    try:
        return json.loads(urllib.request.urlopen(req).read().decode())
    except urllib.error.HTTPError as e:
        return {"__error__": e.code, "__body__": e.read().decode()[:200]}


def fetch_all(table, select, extra=""):
    rows = []
    offset = 0
    page = 1000
    while True:
        batch = rest_get(f"{table}?select={select}{extra}&limit={page}&offset={offset}")
        if not batch:
            break
        rows.extend(batch)
        offset += page
        if len(batch) < page:
            break
    return rows


def run_far(limit=None):
    print("Fetching FAR sections...")
    rows = fetch_all("far_sections", "section_number,title,part")
    if limit:
        rows = rows[:limit]
    print(f"Testing {len(rows)} sections against their own title...\n")

    misses = []       # not in top 10 at all
    low_rank = []      # in top 10 but not top 3
    skipped = 0
    for i, r in enumerate(rows):
        title = clean_title(r["title"])
        # Skip titles too generic/short to mean anything as a standalone
        # query -- "Applicability.", "[Reserved]", "Definitions." etc.
        # would be false positives for every part that has one.
        if len(title.split()) < 3 or title.lower() in ("applicability", "definitions", "general", "[reserved]"):
            skipped += 1
            continue
        res = search("search_far", title, 10)
        if isinstance(res, dict):
            print(f"  ERROR on {r['section_number']}: {res}")
            continue
        rank = next((idx for idx, x in enumerate(res) if x.get("section_number") == r["section_number"]), None)
        if rank is None:
            misses.append((r["section_number"], title, res[0].get("section_number") if res else None, res[0].get("title") if res else None))
        elif rank >= 3:
            low_rank.append((r["section_number"], title, rank + 1))
        if (i + 1) % 200 == 0:
            print(f"  ...{i+1}/{len(rows)} tested, {len(misses)} misses so far")

    print(f"\n{skipped} sections skipped (title too generic to test standalone).")
    print(f"\n=== MISSES: own section not in top 10 at all ({len(misses)}) ===")
    for sec, title, top_sec, top_title in misses:
        print(f"  {sec} \"{title}\" -> top result instead: {top_sec} \"{top_title}\"")

    print(f"\n=== LOW RANK: in top 10 but not top 3 ({len(low_rank)}) ===")
    for sec, title, rank in sorted(low_rank, key=lambda x: -x[2])[:60]:
        print(f"  #{rank}  {sec} \"{title}\"")

    out = {
        "tested": len(rows) - skipped,
        "misses": [{"section": s, "title": t, "top_result": ts, "top_title": tt} for s, t, ts, tt in misses],
        "low_rank": [{"section": s, "title": t, "rank": r} for s, t, r in low_rank],
    }
    out_path = os.path.join(BASE, "scripts", "audit_reports", "search_anchor_gap_far.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nFull results written to {out_path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    limit = None
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]
    target = args[0] if args else "far"
    if target == "far":
        run_far(limit)
    else:
        print(f"Target {target!r} not implemented yet.")
