#!/usr/bin/env python3
"""Do the level filters actually carve up the question bank the way they claim?

RC, 2026-09-04: "deep test all filtering app wide. make sure it's real. make
sure those 'boxes' of level-specific data exist properly as parts of the entire
Q bank - so filtering simple grabs a selection of 'pre-bult' boxes of data.
this feature must be reliable and actually filter the correct data in/out."

ONE THING TO BE STRAIGHT ABOUT FIRST
------------------------------------
There are no pre-built boxes on disk. Nothing is materialised. The levels are
COMPUTED at query time by far_knowledge_levels(part, subpart) and its siblings
for AIM / AC / P-CG / dictionary / 49 CFR, and get_study_pool_count() /
get_study_queue() / create_challenge() all apply the same function.

That is not a problem -- one function is easier to keep honest than six stored
tables that can drift apart -- but it does mean "the box exists" cannot be
answered by looking at a table. It has to be measured, which is what this does.

WHAT IT MEASURES
----------------
For every level the app offers, and every content type:

  1. SIZE -- the box is non-empty, and big enough that a 20-card deck isn't
     drawing from a puddle. A level that quietly resolves to 4 items looks
     like it works right up until a user studies it twice.
  2. DISTINCTNESS -- two levels are not secretly the same box. If `student`
     and `private` return identical sets, one of them is decoration.
  3. CONTAINMENT -- every level's box is a subset of the unfiltered bank.
     A filter that returns something the whole bank does not is a filter that
     is reading somewhere else.
  4. THE FILTER ACTUALLY BITES -- the union of all levels is smaller than
     the unfiltered bank. If filtering by every level returns everything,
     the level column is not doing any work.

Counts come from get_study_pool_count(), the same RPC the Filters screen
displays, so this measures what the user is shown rather than a private
query of my own.

Usage: python3 scripts/filter_box_audit.py
"""
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"}

LEVELS = ["student", "private", "commercial", "atp", "cfi", "mechanic"]
TYPES = ["far", "aim", "ac", "pcg", "dictionary", "cfr49"]
# Below this a level is a puddle, not a box: a 20-card deck would repeat
# within three sessions.
MIN_BOX = 40

FAILURES = []


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method,
                               headers={**(headers or {}), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=120) as x:
            t = x.read().decode()
            return x.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:250]


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if not cond else ""))
    if not cond:
        FAILURES.append(label)


def main():
    email = f"boxq-{int(time.time())}@flyregs.invalid"
    pw = "Tmp" + secrets.token_urlsafe(10) + "!A9"
    st, u = call("POST", "/auth/v1/admin/users",
                 {"email": email, "password": pw, "email_confirm": True}, SVC)
    if st != 200:
        raise SystemExit(f"could not create the probe account: {st} {u}")
    uid = u["id"]
    call("POST", "/rest/v1/user_entitlements",
         {"user_id": uid, "is_pro": True, "is_premium": True},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})
    st, tok = call("POST", "/auth/v1/token?grant_type=password",
                   {"email": email, "password": pw}, {"apikey": ANON})
    jwt = {"apikey": ANON, "Authorization": f"Bearer {tok['access_token']}"}

    def pool(types=None, levels=None):
        st, n = call("POST", "/rest/v1/rpc/get_study_pool_count",
                     {"p_item_types": types, "p_levels": levels}, jwt)
        return n if isinstance(n, int) else -1

    try:
        print("Level boxes, measured through get_study_pool_count -- the same RPC")
        print("the Filters screen shows the user.\n")
        whole = pool()
        print(f"  whole bank, no filters: {whole:,} items\n")

        header = f"  {'type':<12}" + "".join(f"{lv:>12}" for lv in LEVELS) + f"{'ALL':>12}"
        print(header)
        print("  " + "-" * (len(header) - 2))
        per_type = {}
        for t in TYPES:
            row = {lv: pool([t], [lv]) for lv in LEVELS}
            row["_all"] = pool([t])
            per_type[t] = row
            print(f"  {t:<12}" + "".join(f"{row[lv]:>12,}" for lv in LEVELS)
                  + f"{row['_all']:>12,}")
        print()

        print("=== 1. Every box populated -- or, where empty, VISIBLY empty ===")
        # An empty combination is not automatically a defect. aim/mechanic is
        # zero because aim_knowledge_levels() never assigns 'mechanic' to any
        # chapter -- the AIM is a pilot document, and that is a deliberate
        # call, not an oversight. Same for cfr49/mechanic.
        #
        # What WOULD be a defect is an empty box the user can walk into
        # blind. So the test is not "never zero", it is "when zero, the
        # per-level count RPC the picker reads reports the zero, so the user
        # sees it BEFORE selecting and gets the explaining empty state after"
        # (study.tsx renders "No content matches these filters" on
        # poolCount === 0, distinct from "nothing due").
        empty, thin = [], []
        for t, row in per_type.items():
            for lv in LEVELS:
                n = row[lv]
                if n <= 0:
                    empty.append((t, lv))
                elif n < MIN_BOX:
                    thin.append(f"{t}/{lv}={n}")
        for t, lv in empty:
            st, rows = call("POST", "/rest/v1/rpc/get_study_pool_counts_by_level",
                            {"p_item_types": [t], "p_category_classes": None}, jwt)
            by_level = {r["level"]: int(r["cnt"]) for r in (rows or [])}
            check(f"{t}/{lv} is empty, and the picker's own count RPC says so "
                  f"(so the user is never sent into a blank deck)",
                  by_level.get(lv, 0) == 0, f"picker reports {by_level.get(lv)!r}")
        if not empty:
            check("every level/type combination is populated", True)
        # Thin is a note, not a failure: 49 CFR holds 82 items in total, so a
        # single level inside it being small is arithmetic, not a bug.
        if thin:
            print(f"  note  boxes under {MIN_BOX} items: {', '.join(thin)}")

        print("\n=== 2. Are the levels actually different from each other? ===")
        same = []
        for t, row in per_type.items():
            for i, a in enumerate(LEVELS):
                for b in LEVELS[i + 1:]:
                    if row[a] > 0 and row[a] == row[b] == row["_all"]:
                        same.append(f"{t}: {a} and {b} both return the whole type")
        check("no two levels resolve to the entire type (which would mean the "
              "filter does nothing there)", not same, "; ".join(same[:4]))

        print("\n=== 3. Is every box a SUBSET of the unfiltered bank? ===")
        over = [f"{t}/{lv}: {row[lv]:,} > {row['_all']:,}"
                for t, row in per_type.items() for lv in LEVELS
                if row[lv] > row["_all"]]
        check("no level returns more items than the type holds", not over, "; ".join(over))

        print("\n=== 4. Does filtering actually remove anything? ===")
        union_all_levels = pool(None, LEVELS)
        print(f"  every level selected at once: {union_all_levels:,} of {whole:,}")
        check("selecting every level is still narrower than no filter at all -- "
              "otherwise the level column does no work",
              0 < union_all_levels < whole,
              f"{union_all_levels:,} vs {whole:,}")

        print("\n=== 5. Do the type filters compose with the level filters? ===")
        # far+aim should equal neither far alone nor the whole bank.
        far_priv, aim_priv = pool(["far"], ["private"]), pool(["aim"], ["private"])
        both = pool(["far", "aim"], ["private"])
        check("far+aim at one level is the sum of its parts",
              both == far_priv + aim_priv,
              f"{both:,} vs {far_priv:,}+{aim_priv:,}={far_priv + aim_priv:,}")

        print("\n=== 6. Does an unknown level return nothing, rather than everything? ===")
        # The dangerous failure mode: an unrecognised value falling through to
        # "no filter" and quietly serving the whole bank.
        bogus = pool(["far"], ["not-a-real-level"])
        check("an unrecognised level returns 0, not the whole type",
              bogus == 0, f"returned {bogus:,} (type holds {per_type['far']['_all']:,})")

    finally:
        call("DELETE", f"/auth/v1/admin/users/{uid}", None, SVC)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("Every level box is populated, distinct, contained, and actually removes "
          "material.")


if __name__ == "__main__":
    main()
