#!/usr/bin/env python3
"""Verify the synced_folders SELECT RLS cap fix has a genuine READ-side
backstop, not just a write-time (INSERT trigger) check -- part of the
2026-08-18 "more full gating checks" sweep, re-testing the known bug class:
"the folder count cap was only checked when CREATING a folder, with no
backstop on the READ side, so if entitlement changed after creation the
excess folders stayed fully visible/writable."

Mirrors aircraft_cap_rls_test.py's exact scenario for user_aircraft, applied
to synced_folders: create folders while entitled to sync (Pro, since
enforce_folder_cap()'s INSERT trigger is deliberately Pro-gated -- see
src/lib/folders.ts's PRO_FOLDER_CAP comment, base folder creation itself is
Plus but only reaches this DB trigger via the "Back up & sync" Pro feature),
downgrade to a lower cap, confirm a DIRECT table query now returns only the
in-cap folders (oldest-first) instead of all of them, then confirm
synced_folder_items for an over-cap folder are correctly locked out too, and
that upgrading back restores everything (nothing was deleted).

Usage: python3 scripts/folder_cap_rls_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import http, rpc, check, make_user, delete_user, URL, ANON, SERVICE, NOW, FAILURES
import secrets
import time


def set_tier(uid, *, is_premium=False, is_pro=False):
    http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{uid}", key=SERVICE,
         body={"is_premium": is_premium, "is_pro": is_pro})


def main():
    print("=== synced_folders cap RLS read-side backstop verification ===")
    u = make_user("fcapA")
    created = [u]
    folder_ids = []
    try:
        # Premium first (uncapped) so all 5 inserts succeed regardless of
        # enforce_folder_cap()'s numeric limit -- the cap itself is what
        # we're about to test on the READ side after downgrading.
        set_tier(u["id"], is_premium=True)

        for i in range(5):
            fid = f"fcap-{secrets.token_hex(4)}-{i}"
            # created_at strictly increasing so ranking (sort_order null on
            # all of these -> falls back to created_at, id) is deterministic.
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time())) + f".{i:03d}000Z"
            st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=u["jwt"],
                            body={"id": fid, "user_id": u["id"], "name": f"Folder {i}",
                                  "deleted": False, "created_at": ts, "updated_at": ts},
                            headers={"Prefer": "return=representation"})
            if st >= 300:
                raise RuntimeError(f"insert folder {i}: HTTP {st}: {body}")
            folder_ids.append(fid)
            st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=u["jwt"],
                            body={"id": f"{fid}-item", "user_id": u["id"], "folder_id": fid,
                                  "item_type": "far", "item_id": "91.3", "deleted": False,
                                  "added_at": NOW, "updated_at": NOW})
            if st >= 300:
                raise RuntimeError(f"insert item for folder {i}: HTTP {st}: {body}")

        st, direct = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}&deleted=eq.false",
                          key=ANON, jwt=u["jwt"])
        check("Premium: direct query sees all 5 folders", len(direct or []) == 5, str(direct))

        cap = rpc("folder_visible_cap", u["jwt"])
        check("Premium: folder_visible_cap() reports unlimited (huge int)", cap > 1000, str(cap))

        # Downgrade to Plus (is_unlocked only) -- cap should become 3
        # (PRO_FOLDER_CAP, shared by Plus/Pro).
        http("POST", "/rest/v1/user_entitlements", key=SERVICE,
             body={"user_id": u["id"], "is_premium": False, "is_pro": False, "is_unlocked": True},
             headers={"Prefer": "resolution=merge-duplicates"})
        note_cap = rpc("folder_visible_cap", u["jwt"])
        check("Plus: folder_visible_cap() reports 3", note_cap == 3, str(note_cap))

        st, direct_after = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}&deleted=eq.false",
                                key=ANON, jwt=u["jwt"])
        check("Plus: DIRECT query now correctly capped to 3 (was 5 before the fix)",
              len(direct_after or []) == 3, str(direct_after))

        visible_ids = {r["id"] for r in (direct_after or [])}
        check("the 3 still-visible folders are the OLDEST 3 (created first)",
              visible_ids == set(folder_ids[:3]), f"visible={visible_ids}, expected oldest 3={folder_ids[:3]}")

        # A locked-out (over-cap) folder's detail fetch should return EMPTY,
        # not full data -- mirrors my-aircraft/[id].tsx's own query shape
        # (aircraft_cap_rls_test.py's exact same check).
        st, locked_detail = http("GET", f"/rest/v1/synced_folders?select=id,name&id=eq.{folder_ids[4]}",
                                 key=ANON, jwt=u["jwt"])
        check("locked (over-cap) folder's own detail fetch returns EMPTY, not full data",
              locked_detail == [], str(locked_detail))

        # The child table (synced_folder_items) SELECT policy
        # (owners_synced_folder_items_select) is DELIBERATELY left
        # cap-unaware, per migrations_fix_folder_items_downgrade_cap.sql's
        # own header comment: "SELECT/DELETE stay untouched (a downgraded
        # user can still see and clean up items in a locked folder, same
        # 'don't block cleanup' reasoning as user_aircraft_reminders' own
        # comment)." INSERT/UPDATE (write) ARE cap-gated via
        # is_folder_visible() -- confirmed above and in the write-check
        # below. This is NOT re-tested as a pass/fail here since it's an
        # intentional, already-documented tradeoff, not the gap this script
        # is hunting for -- logged as a NOTE so this script's own output
        # keeps that distinction visible on every future re-run.
        st, locked_items = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_ids[4]}&select=item_id",
                                key=ANON, jwt=u["jwt"])
        print(f"  NOTE  over-cap folder's ITEMS remain directly SELECTable ({locked_items}) -- "
              f"intentional per migrations_fix_folder_items_downgrade_cap.sql, not a fresh gap")

        # A downgraded user must not be able to ADD to an over-cap folder
        # either (WITH CHECK on synced_folder_items via is_folder_visible()).
        st, write_resp = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=u["jwt"],
                              body={"id": f"{folder_ids[4]}-newitem", "user_id": u["id"],
                                    "folder_id": folder_ids[4], "item_type": "far", "item_id": "91.7",
                                    "deleted": False, "added_at": NOW, "updated_at": NOW})
        st2, chk = http("GET", f"/rest/v1/synced_folder_items?id=eq.{folder_ids[4]}-newitem&select=id", key=SERVICE)
        check("cannot add new items to an over-cap folder while downgraded",
              not chk, f"HTTP {st}, row present: {chk}")

        # Still-visible (in-cap) folder should read/write completely
        # normally.
        st, visible_detail = http("GET", f"/rest/v1/synced_folders?select=id,name&id=eq.{folder_ids[0]}",
                                  key=ANON, jwt=u["jwt"])
        check("still-visible (in-cap) folder's detail fetch still works",
              len(visible_detail or []) == 1, str(visible_detail))

        # Downgrade all the way to Free -- cap should become 0.
        http("POST", "/rest/v1/user_entitlements", key=SERVICE,
             body={"user_id": u["id"], "is_premium": False, "is_pro": False, "is_unlocked": False},
             headers={"Prefer": "resolution=merge-duplicates"})
        st, direct_free = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}&deleted=eq.false",
                               key=ANON, jwt=u["jwt"])
        check("Free: DIRECT query sees ZERO folders (Free has no folder access at all)",
              direct_free == [], str(direct_free))
        # Same question as the earlier "over-cap folder's ITEMS" check, but
        # at the Free tier specifically (0 entitlement, not just "one over
        # the Plus/Pro cap of 3") -- does a fully-Free, non-paying user
        # retain permanent direct read access to their own folder items via
        # synced_folder_items, even though the FOLDER container itself
        # (synced_folders) is correctly fully hidden at this tier?
        st, items_free = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_ids[0]}&select=item_id",
                              key=ANON, jwt=u["jwt"])
        print(f"  NOTE  Free tier (cap=0, zero paid entitlement): synced_folder_items direct "
              f"SELECT for a folder whose OWN container row is fully hidden returns: {items_free}")

        # Re-upgrade to Premium: nothing was deleted, everything reappears.
        set_tier(u["id"], is_premium=True)
        st, direct_restored = http("GET", f"/rest/v1/synced_folders?select=id&user_id=eq.{u['id']}&deleted=eq.false",
                                   key=ANON, jwt=u["jwt"])
        check("re-upgrading to Premium restores visibility to all 5 (data was never deleted)",
              len(direct_restored or []) == 5, str(direct_restored))
        st, items_restored = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_ids[4]}&select=item_id",
                                  key=ANON, jwt=u["jwt"])
        check("the over-cap folder's original item is intact after re-upgrading",
              bool(items_restored), str(items_restored))

    finally:
        for fid in folder_ids:
            http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{fid}", key=SERVICE)
            http("DELETE", f"/rest/v1/synced_folders?id=eq.{fid}", key=SERVICE)
        for u2 in created:
            delete_user(u2["id"])

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All folder-cap RLS checks passed.")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
