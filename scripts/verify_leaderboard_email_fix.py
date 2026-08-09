#!/usr/bin/env python3
"""One-off verification for sync/migrations_fix_leaderboard_email_exposure.sql --
creates a disposable account with NO display_name and NO Callsign, opts it into
the leaderboard, gives it enough activity to surface on all 3 boards, and checks
that display_label comes back as 'Pilot' rather than an email-derived string.

Usage:  python3 scripts/verify_leaderboard_email_fix.py
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


def rpc(fn, jwt, params=None):
    st, body = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300:
        raise RuntimeError(f"rpc {fn} -> HTTP {st}: {body}")
    return body


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")
    return cond


def main():
    email_local = f"leaderboard-nocallsign-{int(time.time())}-{secrets.token_hex(3)}"
    email = f"{email_local}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    uid = body["id"]
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    jwt = tok["access_token"]

    try:
        http("POST", "/rest/v1/user_streaks", key=SERVICE,
             body={"user_id": uid, "leaderboard_opt_in": True, "current_streak": 3},
             headers={"Prefer": "resolution=merge-duplicates"})

        http("POST", "/rest/v1/user_duel_stats", key=SERVICE,
             body={"user_id": uid, "wins": 5, "losses": 1, "ties": 0},
             headers={"Prefer": "resolution=merge-duplicates"})

        st, term = http("GET", "/rest/v1/pcg_terms?select=id&limit=1", key=SERVICE)
        term_id = term[0]["id"]
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        http("POST", "/rest/v1/study_progress", key=SERVICE,
             body={"user_id": uid, "item_type": "pcg_terms", "item_id": str(term_id),
                   "correct_streak": 3, "total_reviews": 5, "total_correct": 5,
                   "last_reviewed_at": now, "next_review_at": now},
             headers={"Prefer": "resolution=merge-duplicates"})

        print(f"Disposable account {email} (no display_name, no Callsign) set up.\n")

        duels = rpc("get_duels_leaderboard", jwt, {"p_limit": 50})
        mine = next((r for r in duels if r["user_id"] == uid), None)
        check("get_duels_leaderboard: account surfaces", mine is not None, str(duels))
        if mine:
            check("get_duels_leaderboard: display_label is 'Pilot', not email-derived",
                  mine["display_label"] == "Pilot", mine["display_label"])

        mastery = rpc("get_mastery_leaderboard", jwt, {"p_limit": 50})
        mine = next((r for r in mastery if r["user_id"] == uid), None)
        check("get_mastery_leaderboard: account surfaces", mine is not None, str(mastery))
        if mine:
            check("get_mastery_leaderboard: display_label is 'Pilot', not email-derived",
                  mine["display_label"] == "Pilot", mine["display_label"])

        ready = rpc("get_ready_room_leaderboard", jwt, {"p_limit": 20})
        mine = next((r for r in ready if r["user_id"] == uid), None)
        check("get_ready_room_leaderboard: account surfaces", mine is not None, str(ready))
        if mine:
            check("get_ready_room_leaderboard: display_label is 'Pilot', not email-derived",
                  mine["display_label"] == "Pilot", mine["display_label"])

    finally:
        http("DELETE", f"/rest/v1/user_duel_stats?user_id=eq.{uid}", key=SERVICE)
        http("DELETE", f"/rest/v1/study_progress?user_id=eq.{uid}", key=SERVICE)
        http("DELETE", f"/rest/v1/user_streaks?user_id=eq.{uid}", key=SERVICE)
        http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
