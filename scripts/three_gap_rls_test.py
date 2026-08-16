#!/usr/bin/env python3
"""Live-verify (not just policy-read) whether the 3 flagged-but-untested
RLS gaps from the B34 readiness tier-gate audit are real:

1. synced_folders: SELECT is ownership-only, no folder_visible_cap()
   awareness -- does a downgraded user still see over-cap folders via a
   direct table read?
2. user_aircraft_reminders: SELECT checks has_pro_access() but not
   per-aircraft is_aircraft_visible() -- does a user downgraded from
   Premium to Pro (cap 1) still see reminders tied to their now-hidden
   2nd/3rd aircraft?
3. user_ad_notifications: SELECT is ownership-only, no tier/cap check at
   all -- does a user downgraded to Free/Plus (cap 0, aircraft fully
   hidden) still see AD notifications for their now-inaccessible aircraft?

Usage: python3 scripts/three_gap_rls_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import make_user, delete_user, rpc, http, check, note, FAILURES, NOTES, SERVICE, ANON


def main():
    print("=== 3-gap RLS live verification ===")
    u = make_user("gapA")
    created = [u]
    try:
        # ---------- 1. synced_folders ----------
        print("\n--- synced_folders ---")
        folder_ids = []
        for i in range(3):
            fid = f"gap-folder-{u['id']}-{i}"
            import datetime
            now = datetime.datetime.now(datetime.timezone.utc).isoformat()
            st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=u["jwt"],
                             body={"id": fid, "user_id": u["id"], "name": f"Folder {i}",
                                   "created_at": now, "updated_at": now},
                             headers={"Prefer": "return=representation"})
            if st >= 300:
                raise RuntimeError(f"insert folder {i}: HTTP {st}: {body}")
            folder_ids.append(fid)
        note(f"created 3 folders as Premium: {folder_ids}")

        st, direct = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("Premium: direct folder query sees all 3", len(direct) == 3, str(direct))

        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": False, "is_pro": True})
        note("downgraded to Pro (folder cap=3, same as before -- no change expected)")
        st, direct_pro = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("Pro (cap still 3): still sees all 3 -- no regression expected here", len(direct_pro) == 3, str(direct_pro))

        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": False, "is_pro": False})
        note("downgraded to Free/Plus (folder cap=0)")
        st, direct_free = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        gap1 = len(direct_free) == 3
        check("GAP CHECK: Free (cap=0) -- does direct query STILL show all 3? (gap if true)",
              not gap1, f"direct query returned {len(direct_free)} rows at cap=0: {direct_free}")
        NOTES.append(f"synced_folders gap {'CONFIRMED REAL' if gap1 else 'not reproducible'}: at cap=0 direct query returned {len(direct_free)}/3")

        # restore for cleanup
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": True, "is_pro": False})

    finally:
        pass  # keep u alive for the next 2 sections

    try:
        # ---------- 2. user_aircraft_reminders ----------
        print("\n--- user_aircraft_reminders ---")
        aircraft_ids = []
        for i in range(2):
            st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=u["jwt"],
                             body={"user_id": u["id"], "make": "Cessna", "model": f"172-r{i}"},
                             headers={"Prefer": "return=representation"})
            if st >= 300:
                raise RuntimeError(f"insert aircraft {i}: HTTP {st}: {body}")
            aircraft_ids.append(body[0]["id"])
        note(f"created 2 aircraft as Premium: {aircraft_ids}")

        reminder_ids = []
        for i, aid in enumerate(aircraft_ids):
            st, body = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=u["jwt"],
                             body={"user_id": u["id"], "user_aircraft_id": aid, "title": f"Reminder {i}", "due_date": "2026-12-01"},
                             headers={"Prefer": "return=representation"})
            if st >= 300:
                raise RuntimeError(f"insert reminder {i}: HTTP {st}: {body}")
            reminder_ids.append(body[0]["id"])
        note(f"created 1 reminder per aircraft: {reminder_ids}")

        st, direct = http("GET", f"/rest/v1/user_aircraft_reminders?select=id,user_aircraft_id&user_id=eq.{u['id']}",
                           key=ANON, jwt=u["jwt"])
        check("Premium: direct reminders query sees both", len(direct) == 2, str(direct))

        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": False, "is_pro": True})
        note("downgraded to Pro (aircraft cap=1 -- aircraft_ids[1] should now be hidden)")

        st, aircraft_after = http("GET", f"/rest/v1/user_aircraft?select=id&user_id=eq.{u['id']}", key=ANON, jwt=u["jwt"])
        check("sanity: aircraft #2 correctly hidden by the already-fixed user_aircraft policy",
              len(aircraft_after) == 1, str(aircraft_after))

        st, reminders_after = http("GET", f"/rest/v1/user_aircraft_reminders?select=id,user_aircraft_id&user_id=eq.{u['id']}",
                                    key=ANON, jwt=u["jwt"])
        gap2 = len(reminders_after) == 2
        check("GAP CHECK: Pro -- does reminder for the now-HIDDEN aircraft still show up? (gap if true)",
              not gap2, f"reminders query returned {len(reminders_after)}/2 rows: {reminders_after}")
        NOTES.append(f"user_aircraft_reminders gap {'CONFIRMED REAL' if gap2 else 'not reproducible'}: at Pro (cap=1) reminders query returned {len(reminders_after)}/2")

        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": True, "is_pro": False})

    finally:
        pass

    try:
        # ---------- 3. user_ad_notifications ----------
        print("\n--- user_ad_notifications ---")
        # aircraft_ids[0] and [1] from above already exist, both Cessna 172s
        # likely to have real applicable ADs -- backfill both.
        for aid in aircraft_ids:
            rpc("backfill_aircraft_ad_notifications", u["jwt"], {"p_user_aircraft_id": aid})

        st, notif_before = http("GET", f"/rest/v1/user_ad_notifications?select=id,user_aircraft_id&user_id=eq.{u['id']}",
                                 key=ANON, jwt=u["jwt"])
        note(f"AD notifications created across both aircraft (Premium): {len(notif_before)} rows, "
             f"aircraft breakdown: {sorted(set(r['user_aircraft_id'] for r in notif_before))}")
        has_notifs_for_both = len(set(r["user_aircraft_id"] for r in notif_before)) == 2
        if not has_notifs_for_both:
            note("WARNING: one of the 2 test aircraft got zero applicable ADs -- gap check below may be inconclusive")

        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{u['id']}", key=SERVICE,
             body={"is_premium": False, "is_pro": False})
        note("downgraded to Free/Plus (aircraft cap=0 -- BOTH aircraft now hidden)")

        st, notif_after = http("GET", f"/rest/v1/user_ad_notifications?select=id,user_aircraft_id&user_id=eq.{u['id']}",
                                key=ANON, jwt=u["jwt"])
        gap3 = len(notif_after) == len(notif_before) and len(notif_before) > 0
        check("GAP CHECK: Free (cap=0, no aircraft visible) -- do AD notifications for hidden aircraft still show? (gap if true)",
              not gap3, f"notif query returned {len(notif_after)}/{len(notif_before)} rows: {notif_after}")
        NOTES.append(f"user_ad_notifications gap {'CONFIRMED REAL' if gap3 else 'not reproducible'}: at cap=0 notif query returned {len(notif_after)}/{len(notif_before)}")

    finally:
        delete_user(u["id"])

    print("\n================ SUMMARY ================")
    if FAILURES:
        print(f"{len(FAILURES)} GAP(S) CONFIRMED REAL (or check failed):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("No gaps reproducible.")
    for n in NOTES:
        print(f"  note: {n}")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
