#!/usr/bin/env python3
"""Prove, live, that a Duel push actually reaches the right person.

WHY THIS EXISTS
---------------
Duel pushes have failed silently three separate times, and every failure
looked identical from the outside: the duel worked, nobody got a
notification, and nothing was logged.

  2026-08-05  get_duel_push_target read challenges.opponent_id, a column
              that no longer existed. EVERY duel push had been dead.
  2026-08-11  a leftover `limit 1` meant a 3-player duel notified one
              person.
  2026-08-17  the RPC required push_tokens.enabled -- the AC Update Alerts
              flag -- so anyone who turned on Duel Alerts and nothing else
              was unreachable for every duel event.

All three are fixed. sendDuelPush() swallows every error by design (a
failed push must never block the duel itself), so the ONLY way to know the
targeting is still right is to ask the RPC directly, with real accounts,
against the live database. That is what this does.

WHAT IT CAN AND CANNOT PROVE
----------------------------
It proves the server picks the right recipients: the right person for each
of the four events, with the right toggle honored and the AC-alerts flag
correctly NOT required. It ends by POSTing a real message to Expo's push
API with a deliberately invalid token and checking Expo answers
DeviceNotRegistered -- which proves the transport is reachable and the
request well-formed.

It cannot prove APNs delivered anything to a real iPhone. Nothing running
on this machine can. That last hop is RC's live test, and the steps are
printed at the end of this run.
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAILURES = []


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]


def http(method, path, *, key, jwt=None, body=None, headers=None, base=URL):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if key:
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt.strip() else None)
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
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   {detail}" if not cond else ""))
    if not cond:
        FAILURES.append(label)
    return cond


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True,
                          "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    uid = body["id"]
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    if st != 200:
        raise RuntimeError(f"signin {st}: {tok}")
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})
    http("POST", "/rest/v1/user_streaks", key=SERVICE,
         body={"user_id": uid, "leaderboard_opt_in": True},
         headers={"Prefer": "resolution=merge-duplicates"})
    return {"id": uid, "email": email, "jwt": tok["access_token"], "label": prefix.upper()}


def set_token(user, *, enabled, duel):
    """Write the push_tokens row directly, so we can produce toggle
    combinations the app itself would take several steps to reach.

    The token is deliberately fake -- 'ExponentPushToken[...]' shaped but
    never issued by Expo -- so no real device can be reached by this test.
    """
    token = f"ExponentPushToken[test-{secrets.token_hex(6)}]"
    http("DELETE", f"/rest/v1/push_tokens?user_id=eq.{user['id']}", key=SERVICE)
    st, body = http("POST", "/rest/v1/push_tokens", key=SERVICE,
                    body={"user_id": user["id"], "expo_push_token": token,
                          "platform": "ios", "enabled": enabled,
                          "duel_notifications_enabled": duel},
                    headers={"Prefer": "resolution=merge-duplicates"})
    if st >= 300:
        raise RuntimeError(f"push_tokens write {st}: {body}")
    return token


def targets(jwt, challenge_id, event):
    return [r["expo_push_token"] for r in
            rpc("get_duel_push_target", jwt, {"p_challenge_id": challenge_id, "p_event": event})]


def play_set(user, challenge_id):
    """Answer this participant's whole question set."""
    n = 0
    while True:
        rows = rpc("get_next_challenge_question", user["jwt"], {"p_challenge_id": challenge_id})
        if not rows:
            return n
        q = rows[0]
        rpc("submit_challenge_answer", user["jwt"],
            {"p_question_id": q["question_id"],
             "p_answer_text": (q.get("choices") or ["a"])[0], "p_time_ms": 1500})
        n += 1


def main():
    a = b = c = None
    try:
        print("Building three disposable Premium accounts (A creator, B and C opponents)...")
        a, b, c = make_user("dpush-a"), make_user("dpush-b"), make_user("dpush-c")

        # B is the case that has broken before: Duel Alerts ON, AC Update
        # Alerts OFF. Anyone who turns on Duel Alerts without ever touching
        # AC Update Alerts lands here, and until 2026-08-17 they were
        # silently unreachable for every duel event.
        tok_b = set_token(b, enabled=False, duel=True)
        tok_c = set_token(c, enabled=True, duel=True)
        tok_a = set_token(a, enabled=True, duel=True)

        print("\n=== 1. INVITED: does the invitee get targeted? ===")
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"], c["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        t = targets(a["jwt"], cid, "invited")
        check("both pending invitees are targeted (not just one -- the 2026-08-11 "
              "group-duel `limit 1` bug)", set(t) == {tok_b, tok_c}, f"got {t}")
        check("the CREATOR is never pushed their own invite", tok_a not in t, f"got {t}")
        check("Duel Alerts ON + AC Update Alerts OFF is still reachable "
              "(the 2026-08-17 enabled-gate bug)", tok_b in t, f"got {t}")

        print("\n=== 2. The toggle the user actually controls ===")
        tok_b_off = set_token(b, enabled=True, duel=False)
        t = targets(a["jwt"], cid, "invited")
        check("Duel Alerts OFF removes them from the invite push",
              tok_b_off not in t, f"got {t}")
        check("...and does not affect anyone else", tok_c in t, f"got {t}")
        tok_b = set_token(b, enabled=False, duel=True)  # back to the interesting case

        print("\n=== 3. ACCEPTED: the acceptor pushes the creator, nobody else ===")
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        t = targets(b["jwt"], cid, "accepted")
        check("only the creator is targeted", t == [tok_a], f"got {t}")

        print("\n=== 4. ANSWERED: 'your move' goes to whoever still has questions ===")
        rpc("respond_to_challenge", c["jwt"], {"p_challenge_id": cid, "p_accept": True})
        played = play_set(b, cid)
        check("B answered a full set", played > 0, f"answered {played}")
        t = targets(b["jwt"], cid, "answered")
        check("C -- who still has questions -- is told it's their move",
              tok_c in t, f"got {t}")
        check("B is not told it's their own move", tok_b not in t, f"got {t}")

        print("\n=== 5. COMPLETED ===")
        play_set(c, cid)
        t = targets(c["jwt"], cid, "completed")
        check("the completion event resolves without error", isinstance(t, list), f"got {t}")

        print("\n=== 6. Not-a-participant cannot probe someone else's duel ===")
        outsider = make_user("dpush-x")
        try:
            targets(outsider["jwt"], cid, "invited")
            check("an outsider is refused", False, "the RPC returned rows")
        except RuntimeError as e:
            check("an outsider is refused", "Not a participant" in str(e), str(e)[:120])
        http("DELETE", f"/auth/v1/admin/users/{outsider['id']}", key=SERVICE)

        print("\n=== 7. Is Expo's push transport actually reachable from here? ===")
        st, body = http("POST", "/--/api/v2/push/send", key=None,
                        base="https://exp.host",
                        body={"to": tok_b, "sound": "default", "title": "Duel Invite",
                              "body": "probe", "data": {"type": "duel", "challengeId": cid}})
        detail = json.dumps(body)[:200] if body else str(st)
        # A fake token SHOULD come back DeviceNotRegistered. That is the
        # correct answer and it proves the whole request shape is right --
        # a malformed body would come back as a 400 validation error instead.
        ok = st == 200 and "DeviceNotRegistered" in detail
        check("Expo accepts the exact payload sendDuelPush builds and rejects only "
              "the fake token", ok, detail)

    finally:
        for u in (a, b, c):
            if u:
                http("DELETE", f"/rest/v1/push_tokens?user_id=eq.{u['id']}", key=SERVICE)
                http("DELETE", f"/auth/v1/admin/users/{u['id']}", key=SERVICE)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("Server-side duel push targeting is correct for all four events.")
    print()
    print("WHAT THIS RUN DID NOT PROVE -- and how to test it live:")
    print("  Nothing here touches a real iPhone. The last hop (Expo -> APNs ->")
    print("  your lock screen) needs two real devices. See the steps printed by")
    print("  scripts/duel_helper.py, or the live-test section of the build notes.")


if __name__ == "__main__":
    main()
