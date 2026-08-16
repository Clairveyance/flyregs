#!/usr/bin/env python3
"""Verify the user_aircraft SELECT RLS cap fix: insert 3 aircraft at
Premium, downgrade to Pro (cap=1), confirm a DIRECT table query now
returns only the 1 visible aircraft (matching get_fleet_summary()'s own
count) instead of all 3 -- this is the exact scenario the readiness-sweep
agent used to find the gap live.

Usage: python3 scripts/aircraft_cap_rls_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import make_user, delete_user, rpc, http, check, note, FAILURES, NOTES, SERVICE, ANON


def main():
    print("=== user_aircraft cap RLS fix verification ===")
    u = make_user("capA")
    created = [u]
    try:
        # make_user grants is_premium=true by default (see duel_e2e_test.py).
        # Insert as the user themselves (anon key + their own JWT), not the
        # service key -- enforce_aircraft_cap()'s trigger calls
        # fleet_visible_cap(), which reads auth.uid(). Under the service
        # key auth.uid() is null, which fleet_visible_cap() treats as
        # "not signed in" (cap 0) and every insert would be wrongly
        # rejected regardless of entitlement.
        aircraft_ids = []
        for i in range(3):
            st, body = http("POST", "/rest/v1/user_aircraft",
                             key=ANON, jwt=u["jwt"], body={"user_id": u["id"], "make": "Cessna", "model": f"172-{i}"},
                             headers={"Prefer": "return=representation"})
            if st >= 300:
                raise RuntimeError(f"insert aircraft {i}: HTTP {st}: {body}")
            aircraft_ids.append(body[0]["id"])
        note(f"inserted 3 aircraft as Premium: {aircraft_ids}")

        st, direct = http("GET", f"/rest/v1/user_aircraft?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("Premium: direct query sees all 3", len(direct) == 3, str(direct))

        summary = rpc("get_fleet_summary", u["jwt"])
        check("Premium: get_fleet_summary sees all 3", len(summary) == 3, str(summary))

        # Downgrade to Pro (cap = 1).
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": False, "is_pro": True})
        note("downgraded to Pro (cap=1)")

        st, direct_after = http("GET", f"/rest/v1/user_aircraft?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("Pro: DIRECT query now correctly capped to 1 (was 3 before the fix)",
              len(direct_after) == 1, str(direct_after))

        summary_after = rpc("get_fleet_summary", u["jwt"])
        check("Pro: get_fleet_summary still correctly capped to 1", len(summary_after) == 1, str(summary_after))

        if direct_after and summary_after:
            check("Both paths agree on WHICH aircraft is visible (the oldest one)",
                  direct_after[0]["id"] == summary_after[0]["out_aircraft_id"] == aircraft_ids[0],
                  f"direct={direct_after[0]['id']} summary={summary_after[0]['out_aircraft_id']} expected={aircraft_ids[0]}")

        # my-aircraft/[id].tsx's own query shape: a locked (2nd) aircraft
        # should now come back EMPTY via direct fetch, not full data.
        st, locked_detail = http("GET", f"/rest/v1/user_aircraft?select=id,make,model&id=eq.{aircraft_ids[1]}",
                                  key=ANON, jwt=u["jwt"])
        check("Locked (over-cap) aircraft detail fetch returns EMPTY, not full data",
              locked_detail == [], str(locked_detail))

        # The still-visible (oldest, rank 1) aircraft's detail fetch should
        # still work normally.
        st, visible_detail = http("GET", f"/rest/v1/user_aircraft?select=id,make,model&id=eq.{aircraft_ids[0]}",
                                   key=ANON, jwt=u["jwt"])
        check("Still-visible aircraft detail fetch still works", len(visible_detail) == 1, str(visible_detail))

        # Re-upgrade to Premium: everything should come back, nothing lost.
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": True, "is_pro": False})
        st, direct_restored = http("GET", f"/rest/v1/user_aircraft?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("Re-upgrading to Premium restores visibility to all 3 (data was never deleted)",
              len(direct_restored) == 3, str(direct_restored))

    finally:
        for u2 in created:
            delete_user(u2["id"])

    print("\n================ SUMMARY ================")
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All checks passed.")
    for n in NOTES:
        print(f"  note: {n}")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
