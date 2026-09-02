#!/usr/bin/env python3
"""Corpus-wide search relevance eval. NO LLM, NO paid API -- pure SQL.

RC, 2026-09-01: "i search for 'private pilot knowledge test' and it can't find
61.35, 61.103 and 61.105. these are the actual regs that describe these reqs,
and they're not even listed!... FR MUST be the reliable source to find relevant
regs to any search you put in. That is THE main selling point of the app."
And: "you need to create and use hundreds of diff real world examples and build
a testing scenario to fix how this system works."

Two case sets, deliberately:

  CURATED  -- hand-written queries a real pilot would type, each with the
              section(s) that genuinely answer them. These are the ones that
              matter; they encode intent, not vocabulary.

  DERIVED  -- generated from the corpus itself: for every section, take its own
              title's content words as the query. A search engine that cannot
              return a section when handed that section's own subject is broken
              by definition, and this scales to hundreds of cases for free.

Metrics: recall@k (is the right reg anywhere in the first k?) and MRR (how high
was the first correct hit -- 1.0 means top slot). Recall matters most here: RC's
complaint is that the right regs are ABSENT, not merely low.

Usage:
  python3 scripts/search_relevance_eval.py            # curated + 300 derived
  python3 scripts/search_relevance_eval.py --derived 0  # curated only
  python3 scripts/search_relevance_eval.py --verbose    # show every miss
"""
from __future__ import annotations
import argparse, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from author_fact_deck import mgmt_sql

# ── Curated: real questions, and the regs that actually answer them ──────────
# Every expectation was checked against the section's real title/content, not
# guessed. A case passes if ANY of its expected sections appears in the top-k.
CURATED: list[tuple[str, list[str]]] = [
    ("private pilot knowledge test",            ["61.35", "61.103", "61.105"]),
    ("private pilot aeronautical knowledge",    ["61.105", "61.103"]),
    ("knowledge test passing grade",            ["61.35"]),
    ("private pilot flight experience",         ["61.109", "61.103"]),
    ("private pilot eligibility",               ["61.103"]),
    ("commercial pilot aeronautical knowledge", ["61.125"]),
    ("commercial pilot flight time",            ["61.129"]),
    ("instrument rating requirements",          ["61.65"]),
    ("recent flight experience passengers",     ["61.57"]),
    ("night currency",                          ["61.57"]),
    ("flight review",                           ["61.56"]),
    ("instrument proficiency check",            ["61.57"]),
    ("medical certificate duration",            ["61.23"]),
    ("basicmed requirements",                   ["61.113", "68.3", "61.23"]),
    ("student pilot solo requirements",         ["61.87"]),
    ("student pilot cross country",             ["61.93"]),
    ("logging pilot in command time",           ["61.51"]),
    ("logging flight time",                     ["61.51"]),
    ("carrying passengers for compensation",    ["61.113"]),
    ("high performance endorsement",            ["61.31"]),
    ("complex airplane endorsement",            ["61.31"]),
    ("tailwheel endorsement",                   ["61.31"]),
    ("type rating required",                    ["61.31"]),
    ("second in command qualifications",        ["61.55"]),
    ("flight instructor privileges",            ["61.193", "61.413"]),
    ("flight instructor renewal",               ["61.197"]),
    ("preflight action required",               ["91.103"]),
    ("preflight information runway lengths",    ["91.103"]),
    ("right of way rules",                      ["91.113"]),
    ("minimum safe altitudes",                  ["91.119"]),
    ("VFR weather minimums",                    ["91.155"]),
    ("basic VFR weather minimums",              ["91.155"]),
    ("special VFR",                             ["91.157"]),
    ("VFR cruising altitude",                   ["91.159"]),
    ("fuel requirements VFR",                   ["91.151"]),
    ("IFR fuel requirements",                   ["91.167"]),
    ("supplemental oxygen requirements",        ["91.211"]),
    ("oxygen above 12500 feet",                 ["91.211"]),
    ("transponder requirements",                ["91.215"]),
    ("ADS-B out requirements",                  ["91.225"]),
    ("altimeter setting procedures",            ["91.121"]),
    ("alcohol eight hours bottle to throttle",  ["91.17"]),
    ("careless and reckless operation",         ["91.13"]),
    ("emergency deviation from rules",          ["91.3"]),
    ("responsibility of pilot in command",      ["91.3"]),
    ("seat belts required",                     ["91.107"]),
    ("dropping objects from aircraft",          ["91.15"]),
    ("aerobatic flight limitations",            ["91.303"]),
    ("parachute requirements",                  ["91.307"]),
    ("formation flight",                        ["91.111"]),
    ("towing gliders",                          ["91.309"]),
    ("ATC clearance required class B",          ["91.131"]),
    ("class C airspace requirements",           ["91.130"]),
    ("class D airspace communications",         ["91.129"]),
    ("mode c veil",                             ["91.215"]),
    ("temporary flight restrictions",           ["91.137"]),
    ("annual inspection required",              ["91.409"]),
    ("100 hour inspection",                     ["91.409"]),
    ("altimeter and static system tests",       ["91.411"]),
    ("transponder inspection 24 months",        ["91.413"]),
    ("ELT battery requirements",                ["91.207"]),
    ("inoperative instruments and equipment",   ["91.213"]),
    ("maintenance records required",            ["91.417"]),
    ("preventive maintenance by pilot",         ["43.3", "91.403"]),
    ("airworthiness directives compliance",     ["39.7", "91.403"]),
    ("who may perform maintenance",             ["43.3"]),
    ("return to service after maintenance",     ["43.7", "91.407"]),
    ("experimental aircraft operating limits",  ["91.319"]),
    ("light sport aircraft privileges",         ["61.315"]),
    ("sport pilot medical",                     ["61.303", "61.23"]),
    ("required documents on board aircraft",    ["91.9", "91.203"]),
    ("airworthiness certificate display",       ["91.203"]),
    ("registration requirements",               ["47.3"]),
    ("accident notification NTSB",              ["830.5", "830.15"]),
    ("definition of accident",                  ["830.2"]),
    ("drug and alcohol testing",                ["91.17", "120.105"]),
    ("part 135 duty time limits",               ["135.267"]),
    ("part 135 VFR weather minimums",           ["135.205"]),
    ("part 121 flight time limitations",        ["121.471"]),
    ("hazardous materials training",            ["121.1005"]),
    ("emergency locator transmitter",           ["91.207"]),
    ("portable electronic devices",             ["91.21"]),
    ("truth in leasing",                        ["91.23"]),
    ("civil aircraft flight manual",            ["91.9"]),
    ("supplemental type certificate",           ["21.113"]),
    ("weight and balance",                      ["91.9", "23.2005"]),
    ("noise limits",                            ["36.1"]),
    ("ultralight vehicles",                     ["103.1"]),
    ("moored balloon kite unmanned rocket",     ["101.1"]),
    ("small unmanned aircraft operations",      ["107.1"]),
    ("remote pilot certificate",                ["107.61"]),
    ("waiver of part 107 rules",                ["107.200"]),
    ("night operations part 107",               ["107.29"]),
    ("operations over people",                  ["107.39"]),
]


def content_words(title: str) -> list[str]:
    t = re.sub(r"^§\s*\S+\s*", "", title or "")
    t = re.sub(r"[^A-Za-z0-9 ]", " ", t)
    stop = {"and","or","of","for","the","a","an","to","in","on","by","with","from",
            "general","other","requirements","required","rules","operating","use"}
    return [w for w in t.lower().split() if len(w) > 2 and w not in stop]


def build_derived(n: int) -> list[tuple[str, list[str]]]:
    """A section's own title, as a query, must return that section."""
    rows = mgmt_sql(f"""select section_number, title from far_sections
        where title is not null and length(title) > 18
          and title !~* 'reserved' and body_text is not null
        order by md5(section_number) limit {n}""")
    out = []
    for r in rows:
        words = content_words(r["title"])[:4]
        if len(words) >= 2:
            out.append((" ".join(words), [r["section_number"]]))
    return out


def run_case(query: str, expected: list[str], k: int) -> tuple[bool, int | None]:
    q = query.replace("'", "''")
    rows = mgmt_sql(f"select section_number from search_far('{q}', {k})")
    got = [r["section_number"] for r in rows]
    for i, s in enumerate(got, 1):
        if s in expected:
            return True, i
    return False, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--derived", type=int, default=300)
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    sets = [("CURATED", CURATED)]
    if args.derived:
        sets.append(("DERIVED (title-as-query)", build_derived(args.derived)))

    overall_hit = overall_n = 0
    for name, cases in sets:
        hits = 0
        rr = 0.0
        misses = []
        for query, expected in cases:
            ok, pos = run_case(query, expected, args.k)
            if ok:
                hits += 1
                rr += 1.0 / pos
            else:
                misses.append((query, expected))
        n = len(cases)
        overall_hit += hits; overall_n += n
        print(f"\n=== {name}: {n} cases ===")
        print(f"  recall@{args.k}: {hits}/{n} = {hits/n*100:.1f}%")
        print(f"  MRR:        {rr/n:.3f}")
        if misses:
            print(f"  MISSES ({len(misses)}):")
            for qy, exp in (misses if args.verbose else misses[:15]):
                print(f"    {qy!r:<48} expected any of {exp}")
            if not args.verbose and len(misses) > 15:
                print(f"    ... and {len(misses)-15} more (use --verbose)")

    print(f"\n=== OVERALL recall@{args.k}: {overall_hit}/{overall_n} = {overall_hit/overall_n*100:.1f}% ===")
    return 0


if __name__ == "__main__":
    sys.exit(main())
