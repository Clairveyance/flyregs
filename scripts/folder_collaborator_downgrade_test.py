#!/usr/bin/env python3
"""Live verification that shared-folder access re-checks LIVE entitlement on
every request, not just at accept time -- part of the 2026-08-18 "more full
gating checks" sweep, re-testing the known bug class: "folder sharing never
re-checked a collaborator's live entitlement after they initially accepted
an invite (so if a collaborator's OWN subscription lapsed, they kept read/
write access to a shared folder indefinitely)."

has_folder_access() (the function underlying every synced_folder_items/
synced_notes/synced_bookmarks RLS policy for collaborators, plus
folder_collaborators-derived UI) checks BOTH the collaborator's AND the
owner's live is_premium on every call:

  and exists (select 1 from user_entitlements ue where ue.user_id = fc.user_id and ue.is_premium = true)
  and exists (select 1 from user_entitlements ue where ue.user_id = fc.owner_id and ue.is_premium = true)

This is a plain SQL function evaluated fresh as part of each RLS check --
there is no caching layer in front of it -- so in principle a downgrade
should take effect on the collaborator's very next request, no re-login or
token refresh required. This script proves that live in both directions:
(1) collaborator downgrades mid-session -> loses access immediately,
(2) owner downgrades mid-session -> collaborator loses access immediately
too, even though the collaborator's OWN entitlement never changed.

Usage: python3 scripts/folder_collaborator_downgrade_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (
    http, rpc, check, make_user, delete_user, grant_premium, URL, ANON, SERVICE, NOW, FAILURES,
)
import secrets


def set_premium(uid, value):
    http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{uid}", key=SERVICE,
         body={"is_premium": value})


def main():
    print("=== Shared-folder access re-checks LIVE entitlement on every request ===")
    owner = make_user("dcOwn")
    mate = make_user("dcMate")
    created = [owner, mate]
    folder_id = "dcap-" + secrets.token_hex(6)
    token = secrets.token_urlsafe(9)
    try:
        grant_premium(owner["id"])
        grant_premium(mate["id"])

        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                        body={"id": folder_id, "user_id": owner["id"], "name": "Downgrade Test",
                              "deleted": False, "created_at": NOW, "updated_at": NOW},
                        headers={"Prefer": "return=representation"})
        check("owner (Premium) creates the folder", st < 300, f"HTTP {st}: {body}")

        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
                        body={"id": f"{folder_id}-item", "user_id": owner["id"], "folder_id": folder_id,
                              "item_type": "far", "item_id": "91.3", "deleted": False,
                              "added_at": NOW, "updated_at": NOW})
        check("owner adds an item to the folder", st < 300, f"HTTP {st}: {body}")

        http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}",
             key=ANON, jwt=owner["jwt"], body={"share_token": token})
        joined = rpc("join_shared_folder", mate["jwt"], {"p_token": token})
        check("mate (Premium) joins by token", bool(joined), str(joined))

        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&select=item_id",
                        key=ANON, jwt=mate["jwt"])
        check("mate can read the folder's items right after joining", bool(rows), str(rows))

        print("\n--- (1) COLLABORATOR's own Premium lapses mid-session ---")
        set_premium(mate["id"], False)
        st, ue = http("GET", f"/rest/v1/user_entitlements?user_id=eq.{mate['id']}&select=is_premium", key=SERVICE)
        check("mate's entitlement is now non-Premium (live DB state)",
              ue and ue[0]["is_premium"] is False, str(ue))

        # No re-login, no new JWT -- same token as the read that worked
        # above. If this still returns rows, the collaborator's initial
        # accept-time Premium check is being cached/never re-verified.
        st, rows_after = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&select=item_id",
                              key=ANON, jwt=mate["jwt"])
        check("mate's NEXT REQUEST (same JWT, no re-login) is immediately denied "
              "the folder's items after their own Premium lapses",
              not rows_after, f"{len(rows_after or [])} rows still visible: {rows_after}")

        st, folder_rows = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=id",
                               key=ANON, jwt=mate["jwt"])
        check("mate can no longer even see the shared folder row itself",
              not folder_rows, str(folder_rows))

        # Collaborator write access should be gone too (editors_manage_
        # shared_folder_items also routes through has_folder_access).
        st, write_resp = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                              body={"id": f"{folder_id}-mate-lapsed", "user_id": mate["id"],
                                    "folder_id": folder_id, "item_type": "far", "item_id": "91.7",
                                    "deleted": False, "added_at": NOW, "updated_at": NOW})
        st2, chk = http("GET", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-mate-lapsed&select=id", key=SERVICE)
        check("lapsed mate cannot write into the shared folder either",
              not chk, f"HTTP {st}, row present: {chk}")

        # Restore mate to Premium -- access should come right back (this
        # isn't a one-way ban, confirming the check is a live boolean, not a
        # one-time revocation flag).
        set_premium(mate["id"], True)
        st, rows_restored = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&select=item_id",
                                 key=ANON, jwt=mate["jwt"])
        check("re-upgrading mate immediately restores access, same JWT, no re-login",
              bool(rows_restored), str(rows_restored))

        print("\n--- (2) OWNER's Premium lapses mid-session (collaborator's own tier unchanged) ---")
        set_premium(owner["id"], False)
        st, ue2 = http("GET", f"/rest/v1/user_entitlements?user_id=eq.{owner['id']}&select=is_premium", key=SERVICE)
        check("owner's entitlement is now non-Premium (live DB state)",
              ue2 and ue2[0]["is_premium"] is False, str(ue2))

        st, rows_owner_lapsed = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&select=item_id",
                                     key=ANON, jwt=mate["jwt"])
        check("mate (still Premium themselves) loses access when the OWNER's "
              "Premium lapses -- sharing requires BOTH sides live, not just the joiner",
              not rows_owner_lapsed, f"{len(rows_owner_lapsed or [])} rows still visible")

        set_premium(owner["id"], True)
        st, rows_owner_restored = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&select=item_id",
                                       key=ANON, jwt=mate["jwt"])
        check("restoring the owner's Premium immediately restores the collaborator's access",
              bool(rows_owner_restored), str(rows_owner_restored))

    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        for u in created:
            delete_user(u["id"])
        print("\n" + "=" * 66)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All shared-folder live-entitlement checks passed.")


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
