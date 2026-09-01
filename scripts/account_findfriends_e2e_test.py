#!/usr/bin/env python3
"""E2E test for the agent's slice of the all-app function-test sweep
(2026-08-16): Account notification toggles + Find Friends contact-match +
Duel-notification/accept tier boundary.

Reuses tier_matrix_test.py's ensure_user pattern (real accounts, real
entitlement rows, real JWTs) rather than the web ?tier= stub, which the
server has never heard of. Every RPC called here is the exact one the real
client code calls (contactMatch.ts's match_contacts_by_email /
lookup_user_by_callsign, challenges.ts's respond_to_challenge).

Usage: python3 scripts/account_findfriends_e2e_test.py
"""
import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}

FAILURES = []


def call(url, data=None, headers=None, method=None):
    r = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                               headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try: return e.code, json.loads(body)
        except Exception: return e.code, body[:300]


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  {detail}" if not cond else ""))
    if not cond:
        FAILURES.append(f"{label} {detail}")
    return cond


TIERS = {
    "free":    dict(is_pro=False, is_premium=False, is_unlocked=False),
    "plus":    dict(is_pro=False, is_premium=False, is_unlocked=True),
    "pro":     dict(is_pro=True,  is_premium=False, is_unlocked=True),
    "premium": dict(is_pro=True,  is_premium=True,  is_unlocked=True),
}


def make_user(tag):
    email = f"aff-{tag}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    st, out = call(f"{URL}/auth/v1/admin/users", {"email": email, "password": "Ff!" + secrets.token_urlsafe(8),
                                                  "email_confirm": True}, SVC)
    if st not in (200, 201):
        raise RuntimeError(f"create user {st}: {out}")
    uid = out["id"]
    _, link = call(f"{URL}/auth/v1/admin/generate_link", {"type": "magiclink", "email": email}, SVC)
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
    _, sess = call(f"{URL}/auth/v1/verify", {"type": "magiclink", "token_hash": th},
                   {"apikey": ANON, "Content-Type": "application/json"})
    return {"id": uid, "email": email, "jwt": sess["access_token"]}


def set_tier(uid, tier):
    call(f"{URL}/rest/v1/user_entitlements", {"user_id": uid, **TIERS[tier],
         "updated_at": "2026-08-16T00:00:00Z"},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})


def set_callsign(u, callsign):
    st, body = call(f"{URL}/rest/v1/rpc/set_callsign", {"p_callsign": callsign},
                    {"apikey": ANON, "Authorization": f"Bearer {u['jwt']}", "Content-Type": "application/json"})
    return st, body


def opt_in_leaderboard(uid):
    call(f"{URL}/rest/v1/user_streaks?on_conflict=user_id", {"user_id": uid, "leaderboard_opt_in": True},
         {**SVC, "Prefer": "resolution=merge-duplicates"})


def rpc(u, fn, params):
    return call(f"{URL}/rest/v1/rpc/{fn}", params,
               {"apikey": ANON, "Authorization": f"Bearer {u['jwt']}", "Content-Type": "application/json"})


def delete_user(uid):
    call(f"{URL}/auth/v1/admin/users/{uid}", method="DELETE", headers=SVC)


def email_hash(email):
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


# ─────────────────────────────────────────────────────────────────────────
# 1. Find Friends contact-match: has_pro_access() gate on match_contacts_by_email
# ─────────────────────────────────────────────────────────────────────────
def test_find_friends_contact_match():
    print("\n=== Find Friends: match_contacts_by_email tier gate (live main, not cached notes) ===")
    users = {}
    try:
        for tier in TIERS:
            u = make_user(f"ff{tier}")
            set_tier(u["id"], tier)
            cs = f"FFTest{tier.capitalize()}{secrets.token_hex(2)}"
            st, body = set_callsign(u, cs)
            # 2xx, not exactly 200: set_callsign RETURNS VOID, so PostgREST
            # answers a successful call with 204 No Content. Asserting == 200
            # made this fail on success, which is worse than not testing it --
            # a permanently-red check trains you to ignore the suite.
            check(f"{tier}: set_callsign succeeded", 200 <= st < 300, f"HTTP {st} {body}")
            u["callsign"] = cs
            opt_in_leaderboard(u["id"])
            users[tier] = u

        target = users["premium"]
        target_hash = email_hash(target["email"])

        for tier, u in users.items():
            st, body = rpc(u, "match_contacts_by_email", {"p_email_hashes": [target_hash]})
            if tier in ("free", "plus"):
                check(f"{tier} caller: match_contacts_by_email is BLOCKED server-side (has_pro_access gate)",
                      st >= 400, f"HTTP {st} {body}")
            else:
                found = isinstance(body, list) and any(r.get("callsign") == target["callsign"] for r in body)
                check(f"{tier} caller: match_contacts_by_email returns the real match",
                      st == 200 and found, f"HTTP {st} {body}")

        # opt-out must hide the match even from a Pro caller
        call(f"{URL}/rest/v1/user_streaks?user_id=eq.{target['id']}", {"leaderboard_opt_in": False},
             {**SVC, "Prefer": "return=minimal"}, method="PATCH")
        st, body = rpc(users["pro"], "match_contacts_by_email", {"p_email_hashes": [target_hash]})
        found = isinstance(body, list) and any(r.get("callsign") == target["callsign"] for r in body)
        check("Pro caller: opted-OUT user is NOT returned as a match (leaderboard_opt_in respected)",
              st == 200 and not found, f"HTTP {st} {body}")

        # lookup_user_by_callsign (Ready Room "search by callsign" / invite RPCs).
        # NOT open to any tier -- that comment was stale. migrations_fix_lookup_
        # callsign_anon_access.sql (2026-08-18) added an internal has_pro_access()
        # check because the RPC had EXECUTE granted to PUBLIC/anon with no internal
        # gate at all, so anyone holding just the public anon key could resolve a
        # guessed Callsign to that user's real internal user_id. That gate is
        # deliberate and correct, and it costs nothing functionally: every caller
        # of this RPC (folder invite, aircraft invite, Duels opponent search,
        # Ready Room) is already Pro+ or Premium-only. So a FREE caller resolving
        # nothing is the expected, desired outcome -- assert that instead.
        st, body = rpc(users["free"], "lookup_user_by_callsign", {"p_callsign": users["premium"]["callsign"]})
        resolved = isinstance(body, list) and body and body[0].get("out_user_id") == users["premium"]["id"]
        check("lookup_user_by_callsign correctly returns NOTHING for a Free caller (Pro+ gate, 2026-08-18 anon-lookup fix)",
              st == 200 and not resolved, f"HTTP {st} {body}")
    finally:
        for u in users.values():
            delete_user(u["id"])


# ─────────────────────────────────────────────────────────────────────────
# 2. push_tokens: client-side-only gate check -- does writing the opt-in
#    columns directly (bypassing account.tsx's tier check) succeed at the
#    table level regardless of tier? (Expected: yes, RLS only scopes by
#    user_id -- the real backstop is the sender scripts' entitlement filter,
#    verified by static code read of tier-cap.mjs already; this proves the
#    table itself has no tier check, i.e. confirms which layer is doing the
#    gating.)
# ─────────────────────────────────────────────────────────────────────────
def test_push_tokens_table_write():
    print("\n=== push_tokens: direct-write reachability by tier (documents which layer gates) ===")
    u = make_user("pushfree")
    set_tier(u["id"], "free")
    try:
        H = {"apikey": ANON, "Authorization": f"Bearer {u['jwt']}", "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=representation"}
        st, body = call(f"{URL}/rest/v1/push_tokens", {
            "user_id": u["id"], "expo_push_token": f"ExponentPushToken[test-{secrets.token_hex(4)}]",
            "platform": "ios", "enabled": False, "reg_of_day_enabled": True,
            "word_of_day_enabled": True, "duel_notifications_enabled": True,
        }, H)
        check("Free-tier account CAN write reg_of_day_enabled/word_of_day_enabled/duel_notifications_enabled=true "
              "directly to push_tokens (no server-side tier check on the table itself -- "
              "the real backstop is send-reg-of-day.mjs/send-word-of-day.mjs's canReceiveProPush/"
              "canReceivePlusPush entitlement filter, confirmed present by code read; account.tsx's "
              "hasProAccess/hasPlusAccess checks are UI-only)",
              st in (200, 201), f"HTTP {st} {body}")
    finally:
        delete_user(u["id"])


# ─────────────────────────────────────────────────────────────────────────
# 3. Duel accept + notification-toggle tier boundary: respond_to_challenge
#    with p_accept=true against a non-Premium recipient. Re-verifies
#    gotcha_duel_accept_missing_client_paywall.md's server claim live,
#    fresh, on main, not from the note.
# ─────────────────────────────────────────────────────────────────────────
def test_duel_accept_premium_gate():
    print("\n=== Duel accept: respond_to_challenge server-side Premium gate (live, not from notes) ===")
    creator = make_user("duelcreator")
    set_tier(creator["id"], "premium")
    recipient = make_user("duelrecip")
    set_tier(recipient["id"], "pro")  # Pro, NOT Premium
    try:
        call(f"{URL}/rest/v1/user_streaks?on_conflict=user_id", {"user_id": creator["id"], "leaderboard_opt_in": True},
             {**SVC, "Prefer": "resolution=merge-duplicates"})
        call(f"{URL}/rest/v1/user_streaks?on_conflict=user_id", {"user_id": recipient["id"], "leaderboard_opt_in": True},
             {**SVC, "Prefer": "resolution=merge-duplicates"})
        st, cid = rpc(creator, "create_challenge", {
            "p_opponent_ids": [recipient["id"]], "p_question_count": 3,
        })
        check("Premium creator can create_challenge", st == 200, f"HTTP {st} {cid}")
        st, body = rpc(recipient, "respond_to_challenge", {"p_challenge_id": cid, "p_accept": True})
        check("Pro (non-Premium) recipient's ACCEPT is rejected server-side, not just client-hidden",
              st >= 400, f"HTTP {st} {body}")
        st, body = rpc(recipient, "respond_to_challenge", {"p_challenge_id": cid, "p_accept": False})
        check("Pro (non-Premium) recipient's DECLINE still works (tier-free per design)",
              st == 200, f"HTTP {st} {body}")
    finally:
        delete_user(creator["id"])
        delete_user(recipient["id"])


if __name__ == "__main__":
    test_find_friends_contact_match()
    test_push_tokens_table_write()
    test_duel_accept_premium_gate()
    print("\n================ SUMMARY ================")
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All checks passed.")
    raise SystemExit(1 if FAILURES else 0)
