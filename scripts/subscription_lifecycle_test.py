#!/usr/bin/env python3
"""Purchase, lapse, and a RevenueCat outage — driven end to end, no device.

RC, 2026-09-18: "if you can't do simple purchase, restore, lapse, retry, etc
through xcode, then it's useless. you've been creating/running sandboxed
accounts for months during this app dev."

He was right and the previous answer was too broad. Tapping the actual Buy
button needs StoreKit, which needs TestFlight or a device -- that half is what
his testers do. But *tapping Buy is not what grants a tier in this app.* The
RevenueCat webhook does, and every state that follows a purchase -- renewal,
cancellation, expiry, Apple's billing-retry grace period -- arrives the same
way. All of it is reachable from here with the RevenueCat V2 key and the
webhook secret, both of which have been sitting in .env for months.

The design under test (revenuecat-webhook/index.ts) is deliberately NOT a
state machine over RC's event taxonomy: an event is only a pointer meaning
"re-check this customer", and the function then re-fetches the truth from
RevenueCat V2. That makes every lifecycle event the same code path, and makes
the three cases below the ones that actually matter:

  1. GRANT      entitlement live at RevenueCat -> user_entitlements says paid
  2. LAPSE      entitlement revoked           -> user_entitlements says free
  3. OUTAGE     RevenueCat has no record      -> user_entitlements UNTOUCHED,
                                                 and the call asks to be retried

Case 3 is the one that has already cost real money. It used to fall through
and write false/false/false, which stripped RC's own Premium tier in B42 -- a
404 means "no customer record at all", not "no entitlements", and a real lapse
answers 200 with an empty list instead. This test pins that behaviour down so
it cannot regress.

Disposable account, deleted at the end. Read-only on the corpus.

Usage: python3 scripts/subscription_lifecycle_test.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (                                    # noqa: E402
    http, check, make_user, delete_user, URL, SERVICE, FAILURES,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RC_PROJECT = "proj477ce0a7"
ENT_PREMIUM = "entl9a4cd81bee"
FOREVER_MS = 2082787200000


def env_val(fname, key):
    with open(os.path.join(ROOT, fname)) as f:
        for line in f:
            line = line.strip()
            if line.startswith(f"{key}="):
                return line.split("=", 1)[1]
    raise RuntimeError(f"{key} not found in {fname}")


def rc(method, path, body=None):
    key = env_val(".env.revenuecat", "REVENUECAT_SECRET_KEY")
    req = urllib.request.Request(
        f"https://api.revenuecat.com/v2{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def send_webhook(uid, event_type):
    """What RevenueCat POSTs to the edge function for a lifecycle event."""
    secret = env_val(".env.revenuecat.webhook", "RC_WEBHOOK_SECRET")
    body = {"event": {
        "id": f"evt-test-{event_type}-{int(time.time()*1000)}",
        "type": event_type,
        "app_user_id": uid,
        "product_id": "com.clairveyance.flyregs.premium_monthly",
        "entitlement_ids": ["premium"],
        "period_type": "NORMAL",
        "environment": "SANDBOX",
        "event_timestamp_ms": int(time.time() * 1000),
    }}
    req = urllib.request.Request(
        f"{URL}/functions/v1/revenuecat-webhook",
        data=json.dumps(body).encode(),
        headers={"Authorization": secret, "Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def tier_of(uid):
    st, rows = http("GET", f"/rest/v1/user_entitlements?user_id=eq.{uid}"
                           f"&select=is_pro,is_premium,is_unlocked", key=SERVICE)
    return (rows or [{}])[0]


def main():
    user = make_user("sublc")
    uid = user["id"]
    created_rc = False
    try:
        base = tier_of(uid)
        check("a brand-new account starts on the free tier",
              base.get("is_premium") is False and base.get("is_pro") is False, str(base))

        print("\n=== 1. PURCHASE -- the entitlement goes live, the webhook fires ===")
        st, b = rc("POST", f"/projects/{RC_PROJECT}/customers", {"id": uid})
        check("RevenueCat customer created (what opening the app as this user does)",
              st in (200, 201, 409), f"HTTP {st}: {b}")
        created_rc = st in (200, 201)
        st, b = rc("POST", f"/projects/{RC_PROJECT}/customers/{uid}/actions/grant_entitlement",
                   {"entitlement_id": ENT_PREMIUM, "expires_at": FOREVER_MS})
        check("Premium entitlement granted at RevenueCat", st in (200, 201), f"HTTP {st}: {b}")

        st, b = send_webhook(uid, "INITIAL_PURCHASE")
        check("the webhook accepted the purchase event", st < 300, f"HTTP {st}: {b}")
        time.sleep(1.5)
        after = tier_of(uid)
        check("the account is now PREMIUM in the app's own table",
              after.get("is_premium") is True, str(after))

        print("\n=== 2. LAPSE -- the entitlement is revoked ===")
        # revoke_granted_entitlement, not revoke_entitlement -- the latter 404s.
        # Probed live against the V2 API rather than guessed.
        st, b = rc("POST", f"/projects/{RC_PROJECT}/customers/{uid}/actions/revoke_granted_entitlement",
                   {"entitlement_id": ENT_PREMIUM})
        check("Premium revoked at RevenueCat", st in (200, 201), f"HTTP {st}: {b}")
        st, b = send_webhook(uid, "EXPIRATION")
        check("the webhook accepted the expiry event", st < 300, f"HTTP {st}: {b}")
        time.sleep(1.5)
        after = tier_of(uid)
        check("the account is back to free -- a lapse really does downgrade",
              after.get("is_premium") is False, str(after))

        print("\n=== 3. OUTAGE -- the case that stripped RC's own tier in B42 ===")
        # Put the account back on Premium in the app's own table, then delete the
        # RevenueCat customer so a re-fetch 404s, and fire an event anyway. A 404
        # means "no customer record at all", NOT "no entitlements" -- a real lapse
        # answers 200 with an empty list, which case 2 above already proved. The
        # webhook must leave the row alone rather than write false/false/false.
        http("POST", "/rest/v1/user_entitlements", key=SERVICE,
             body={"user_id": uid, "is_premium": True},
             headers={"Prefer": "resolution=merge-duplicates"})
        st, b = rc("DELETE", f"/projects/{RC_PROJECT}/customers/{uid}")
        check("RevenueCat customer record removed (simulating the 404)",
              st in (200, 202, 204), f"HTTP {st}: {b}")
        created_rc = False
        st, b = send_webhook(uid, "BILLING_ISSUE")
        # A 5xx here is CORRECT and is the whole point: RevenueCat retries 5xx,
        # so the function is asking to be called again once RevenueCat is
        # readable. The two wrong answers would be 2xx -- silently accepting an
        # event it could not act on, so the retry never comes -- or acting on it
        # anyway and downgrading. The first draft of this test asserted 2xx and
        # was simply wrong about the contract.
        check("the webhook asks to be RETRIED rather than silently accepting an "
              "event it could not act on", st >= 500, f"HTTP {st}: {b}")
        time.sleep(1.5)
        after = tier_of(uid)
        check("A PAYING SUBSCRIBER IS NOT DOWNGRADED when RevenueCat cannot be "
              "read -- the B42 bug stays fixed",
              after.get("is_premium") is True, str(after))

        print("\n=== 4. The event was logged for analytics either way ===")
        st, rows = http("GET", f"/rest/v1/subscription_events?app_user_id=eq.{uid}"
                               f"&select=event_type&order=event_timestamp.desc", key=SERVICE)
        types = [r["event_type"] for r in (rows or [])]
        check("all three lifecycle events were recorded",
              {"INITIAL_PURCHASE", "EXPIRATION", "BILLING_ISSUE"} <= set(types), str(types))

    finally:
        if created_rc:
            rc("DELETE", f"/projects/{RC_PROJECT}/customers/{uid}")
        http("DELETE", f"/rest/v1/subscription_events?app_user_id=eq.{uid}", key=SERVICE)
        delete_user(uid)
        print("\n  NOTE  disposable account deleted")

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("Purchase grants, lapse downgrades, and an outage never strips a payer.")


if __name__ == "__main__":
    main()
