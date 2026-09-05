#!/usr/bin/env python3
"""Does "Show my stats" ACTUALLY hide your ratings, coins and streak?

RC reported the toggle as broken on 2026-09-05. The client half of that was a
`?? true` default in getStatsVisible. The SERVER half, found in the same
sweep, was worse: user_coins and user_profile_ratings both carried
`USING (true) TO authenticated`, so every user's ratings and coin list were
one plain HTTP request away for anyone who could sign up -- while the toggle's
own copy promised those exact fields stayed private.

This test is the proof, run the way an attacker would: a brand-new FREE
account with nothing but the app's public key, reading the tables directly
rather than through any RPC or screen.

  * with stats_visible = true  -> the rows are visible  (the feature works)
  * with stats_visible = false -> the rows are GONE     (the toggle works)
  * your own rows are always visible either way         (no self-lockout)

Usage:  python3 scripts/profile_privacy_gate_test.py
"""
import json
import os
import secrets
import sys
import time
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
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
FAILURES = []


def http(method, path, *, key, jwt=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"]}


def rows_for(jwt, table, target_id):
    st, rows = http("GET", f"/rest/v1/{table}?user_id=eq.{target_id}&select=user_id", key=ANON, jwt=jwt)
    return st, len(rows or [])


def main():
    subject = make_user("privSubject")   # the person with something to hide
    snooper = make_user("privSnooper")   # a brand-new FREE account, no relationship
    try:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        http("POST", "/rest/v1/user_profile_ratings", key=SERVICE,
             body={"user_id": subject["id"], "rating_code": "COMM"})
        http("POST", "/rest/v1/user_coins", key=SERVICE,
             body={"user_id": subject["id"], "coin_code": "first_duel", "earned_at": now})
        http("POST", "/rest/v1/user_streaks", key=SERVICE,
             headers={"Prefer": "resolution=merge-duplicates"},
             body={"user_id": subject["id"], "stats_visible": True})

        print("=== stats_visible = TRUE (the feature must still work) ===")
        for table in ("user_profile_ratings", "user_coins", "user_streaks"):
            st, n = rows_for(snooper["jwt"], table, subject["id"])
            check(f"a stranger CAN see {table} while stats are shown", st == 200 and n >= 1, f"{st} {n} rows")

        print("\n=== stats_visible = FALSE (the toggle must actually hide it) ===")
        http("PATCH", f"/rest/v1/user_streaks?user_id=eq.{subject['id']}", key=SERVICE,
             body={"stats_visible": False})
        for table in ("user_profile_ratings", "user_coins", "user_streaks"):
            st, n = rows_for(snooper["jwt"], table, subject["id"])
            check(f"a stranger CANNOT see {table} once stats are hidden", st == 200 and n == 0, f"{st} {n} rows")

        print("\n=== the owner never loses sight of their own ===")
        for table in ("user_profile_ratings", "user_coins", "user_streaks"):
            st, n = rows_for(subject["jwt"], table, subject["id"])
            check(f"the owner still reads their own {table}", st == 200 and n >= 1, f"{st} {n} rows")

        print("\n=== a whole-table scrape returns nothing but your own rows ===")
        for table in ("user_profile_ratings", "user_coins"):
            st, rows = http("GET", f"/rest/v1/{table}?select=user_id&limit=500", key=ANON, jwt=snooper["jwt"])
            leaked = {r["user_id"] for r in (rows or []) if r["user_id"] != snooper["id"]}
            # Rows belonging to users who have deliberately left stats ON are
            # not a leak -- that is the feature. Only the hidden subject must
            # be absent.
            check(f"{table}: the hidden user is absent from a full scrape",
                  subject["id"] not in leaked, f"{len(leaked)} other users returned, subject present")

        print("\n=== control: user_duel_stats (fixed 2026-09-03, must stay fixed) ===")
        st, rows = http("GET", "/rest/v1/user_duel_stats?select=user_id&limit=500", key=ANON, jwt=snooper["jwt"])
        others = {r["user_id"] for r in (rows or []) if r["user_id"] != snooper["id"]}
        check("a free account still scrapes no duel records", not others, f"{len(others)} rows")
    finally:
        for u in (subject, snooper):
            http("DELETE", f"/rest/v1/user_profile_ratings?user_id=eq.{u['id']}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_coins?user_id=eq.{u['id']}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_streaks?user_id=eq.{u['id']}", key=SERVICE)
            http("DELETE", f"/auth/v1/admin/users/{u['id']}", key=SERVICE)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("profile privacy gate: Show my stats really does hide ratings, coins and streak")


if __name__ == "__main__":
    main()
