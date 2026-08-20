#!/usr/bin/env python3
"""SmartSearch relevance benchmark.

Asks the question a pilot actually asks, and checks whether the reg that
answers it comes back — and how near the top.

Each case lists the documents that SHOULD be found. `top` is the strictest
bar (must be the #1 hit); `within` allows a position. Anything not found at
all is the worst failure: the user has no path to the answer.

Usage:
  python3 scripts/smartsearch_bench.py            # run the suite
  python3 scripts/smartsearch_bench.py "query"    # ad-hoc, show top 10
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]


def rpc(fn, params):
    req = urllib.request.Request(
        f"{URL}/rest/v1/rpc/{fn}", data=json.dumps(params).encode(), method="POST")
    req.add_header("apikey", SERVICE)
    req.add_header("Authorization", f"Bearer {SERVICE}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode() or "[]")
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:300]}


# (query, [(type, id, strictness)]) — strictness: 'top' | int (within N)
CASES = [
    ("VFR cloud clearance requirements", [("far", "91.155", "top")]),
    ("vfr cloud",                        [("far", "91.155", "top")]),
    ("cloud clearance",                  [("far", "91.155", 3)]),
    ("basic VFR weather minimums",       [("far", "91.155", "top")]),
    ("how far from clouds must I stay",  [("far", "91.155", 5)]),
    ("class c radio",                    [("far", "91.130", 5), ("aim", "3-2-4", 5)]),
    ("entering class c",                 [("far", "91.130", 5), ("aim", "3-2-4", 5)]),
    ("class charlie communication requirements", [("far", "91.130", 5)]),
    ("preflight action",                 [("far", "91.103", "top")]),
    ("what must I check before a flight", [("far", "91.103", 5)]),
    ("oxygen requirements",              [("far", "91.211", 3)]),
    ("when do I need supplemental oxygen", [("far", "91.211", 5)]),
    ("night currency",                   [("far", "61.57", 5)]),
    ("three takeoffs and landings",      [("far", "61.57", 5)]),
    ("minimum safe altitude",            [("far", "91.119", 3)]),
    ("how low can I fly over a city",    [("far", "91.119", 5)]),
    ("transponder requirements",         [("far", "91.215", 3)]),
    ("right of way rules",               [("far", "91.113", 3)]),
    ("alcohol 8 hours",                  [("far", "91.17", 5)]),
    ("medical certificate duration",     [("far", "61.23", 5)]),

    # ---- REGRESSION: the concept anchors must not hijack these ----------
    # Each of these is a query whose correct answer is a NICHE part, i.e.
    # exactly the documents the anchors demote for the general case. If an
    # anchor fires here it has over-reached.
    ("propeller clearance",              [("far", "25.925", 5)]),
    ("rotor blade clearance",            [("far", "27.661", 5)]),
    ("ultralight visibility",            [("far", "103.23", 5)]),
    ("parachute jump visibility",        [("far", "105.17", 5)]),
    ("tail rotor guard ground clearance", [("far", "27.411", 5)]),
    ("emergency locator transmitter",    [("far", "91.207", 5)]),

    # ---- RC-flagged 2026-08-20: "search must find relevant topics and get
    # them up front... this process IS the app" ---------------------------
    ("certification",                    [("ac", "61-65K", "top")]),
    ("endorsements",                     [("ac", "61-65K", "top")]),
]

TYPE_FN = {
    "far": ("search_far", "section_number"),
    "aim": ("search_aim", "paragraph_number"),
    "pcg": ("search_pcg", "term"),
    "ac":  ("search_acs", "document_number"),
}


def positions(query, typ, want_id, limit=25):
    fn, col = TYPE_FN[typ]
    rows = rpc(fn, {"query": query, "result_limit": limit})
    if isinstance(rows, dict):
        return None, f"ERROR {rows.get('error')}", []
    ids = [str(r.get(col)) for r in rows]
    pos = ids.index(want_id) + 1 if want_id in ids else None
    return pos, None, ids


def main():
    if len(sys.argv) > 1:
        q = sys.argv[1]
        for typ in ("far", "aim", "pcg", "ac"):
            fn, col = TYPE_FN[typ]
            rows = rpc(fn, {"query": q, "result_limit": 10})
            if isinstance(rows, dict):
                print(f"{typ}: ERROR {rows}")
                continue
            print(f"\n{typ.upper()} — {len(rows)} hits")
            for i, r in enumerate(rows[:10], 1):
                label = str(r.get(col))
                title = (r.get("title") or r.get("subject_heading") or "")[:58]
                print(f"  {i:2}. {label:16} {title}")
        return

    passed = failed = 0
    print(f"{'query':44} {'want':16} {'pos':>5}  verdict")
    print("-" * 82)
    for query, wants in CASES:
        for typ, want_id, strict in wants:
            pos, err, ids = positions(query, typ, want_id)
            if err:
                verdict, ok = err, False
            elif pos is None:
                verdict, ok = "NOT FOUND in top 25", False
            elif strict == "top":
                ok = pos == 1
                verdict = "top hit" if ok else f"wanted #1, got #{pos}"
            else:
                ok = pos <= strict
                verdict = f"within {strict}" if ok else f"wanted <= #{strict}, got #{pos}"
            passed, failed = (passed + 1, failed) if ok else (passed, failed + 1)
            mark = "PASS" if ok else "FAIL"
            shown = f"{typ}:{want_id}"
            print(f"{query[:44]:44} {shown:16} {str(pos or '-'):>5}  {mark}  {verdict}")
    total = passed + failed
    print("-" * 82)
    print(f"{passed}/{total} passed  ({failed} failing)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
