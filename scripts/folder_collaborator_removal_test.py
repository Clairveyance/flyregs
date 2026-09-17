#!/usr/bin/env python3
"""What happens when the OWNER REMOVES a collaborator -- the one sharing path
nothing covered.

RC, 2026-09-17, naming sharing as the app's worst pain area:

  "All of the ways the users send and receive group invites in folders, a/c,
   etc. Way of adding r/w perms, removing them, how bookmarks and folders and
   highlights respond to those perms, where they stay or go depending on who
   sent them and what perms exist between the group."

WHAT WAS ALREADY COVERED, AND WHAT WAS NOT.  folder_collab_matrix_test covers
read/write both directions, downgrade to read_only, and the collaborator
LEAVING voluntarily (`left_at = now()`).  readonly_folder_pathway_test covers
the read_only/read_write/revoked contract.  shared_folder_highlights_e2e_test
covers highlights across a downgrade.

None of them remove anybody.  Leaving and being removed are DIFFERENT code
paths: leaving sets `left_at` and keeps the row; removeCollaborator()
(sharedFolders.ts) hard-DELETEs the row and then conditionally retires the
folder's share link.  Everything below is about that second path.

THE TWO QUESTIONS THAT MATTER, and they pull in opposite directions:

  1. Does the removed person's CONTENT stay with the owner?  It must.  This is
     the data-loss shape this project keeps re-finding -- permission removed,
     data removed with it.  Their items, notes, highlights and bookmarks were
     filed into someone else's folder and belong to that folder now.

  2. Does the removed person's ACCESS actually end -- including the way back
     in?  removeCollaborator retires the folder-wide share link only when the
     removed row had NO invite_token (an open-link joiner).  A person invited
     by Callsign HAS one, so their removal leaves `share_token` live by
     design, on the stated reasoning that the owner may still be circulating
     that link to other people.  The exposure that creates is checked here
     rather than assumed, in both its forms:

       (a) can the removed person re-enter through the still-live link, and
       (b) if they can, at what collab_mode?  join_shared_folder's ON CONFLICT
           deliberately does NOT overwrite collab_mode -- but a removed row is
           a fresh INSERT, not a conflict, so it takes the folder's DEFAULT.
           If a person was individually downgraded to read_only and then
           removed, rejoining would hand them the folder default (read_write).
           Removal would end in MORE privilege than the downgrade did.

Two disposable Premium accounts + one for the link-joiner mirror, all deleted
at the end.  Read-only on the corpus.

Usage: python3 scripts/folder_collaborator_removal_test.py
"""
import secrets
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (                                    # noqa: E402
    http, rpc, check, make_user, delete_user, grant_premium,
    URL, ANON, SERVICE, FAILURES,
)

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def items_in(jwt, folder_id):
    st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                           f"&deleted=eq.false&select=id,item_id,item_type",
                    key=ANON, jwt=jwt)
    return rows or []


def collab_rows(folder_id):
    st, rows = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                           f"&select=user_id,collab_mode,invite_token,left_at,accepted_at",
                    key=SERVICE)
    return rows or []


def share_token_of(folder_id):
    st, rows = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=share_token",
                    key=SERVICE)
    return (rows or [{}])[0].get("share_token")


def remove_collaborator(owner_jwt, folder_id, user_id):
    """Exactly what src/lib/sharedFolders.ts removeCollaborator() does: read the
    row's invite_token, SOFT-remove the row (left_at ends access, removed_at
    says the owner did it rather than the person leaving), then retire the
    folder's share link ONLY if that person had no personal invite token."""
    st, rows = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                           f"&user_id=eq.{user_id}&select=invite_token",
                    key=ANON, jwt=owner_jwt)
    row = (rows or [None])[0]
    st_del, body = http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                                 f"&user_id=eq.{user_id}", key=ANON, jwt=owner_jwt,
                        body={"left_at": NOW, "removed_at": NOW})
    if not (200 <= st_del < 300):
        raise RuntimeError(f"remove -> HTTP {st_del}: {body}")
    if row is not None and not row.get("invite_token"):
        http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON,
             jwt=owner_jwt, body={"share_token": None})
    return st_del


def rpc_raw(fn, jwt, params):
    """Like rpc() but hands back the status instead of raising, so a refusal
    can be asserted on."""
    return http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params)


def try_join(jwt, token):
    st, body = http("POST", "/rest/v1/rpc/join_shared_folder", key=ANON, jwt=jwt,
                    body={"p_token": token})
    return st, body


def main():
    owner = make_user("frmA")
    mate = make_user("frmB")
    linker = make_user("frmC")
    for u in (owner, mate, linker):
        grant_premium(u["id"])

    ac_id = None
    mate_callsign = "RMV" + secrets.token_hex(3).upper()
    http("POST", "/rest/v1/callsign_registry", key=SERVICE,
         body={"user_id": mate["id"], "callsign": mate_callsign,
               "callsign_lower": mate_callsign.lower()},
         headers={"Prefer": "resolution=merge-duplicates"})
    folder_id = "frm-" + secrets.token_hex(6)
    link_token = secrets.token_urlsafe(9)
    invite_token = secrets.token_urlsafe(9)
    mate_note = f"{folder_id}-n-mate"
    mate_hl = f"{folder_id}-hl-mate"

    try:
        print("=== SETUP: owner shares a folder read/write, invites by Callsign ===")
        st, _ = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                     body={"id": folder_id, "user_id": owner["id"],
                           "name": "Removal Test", "share_token": link_token,
                           "collab_mode": "read_write", "deleted": False,
                           "created_at": NOW, "updated_at": NOW})
        check("owner pushed the folder", st < 300, f"HTTP {st}")

        # A targeted Callsign invite -- the row carries a personal invite_token,
        # which is the branch that leaves share_token alive on removal.
        http("POST", "/rest/v1/folder_collaborators", key=SERVICE,
             body={"folder_id": folder_id, "owner_id": owner["id"],
                   "user_id": mate["id"], "collab_mode": "read_write",
                   "invite_token": invite_token})
        st, body = try_join(mate["jwt"], invite_token)
        check("invited collaborator joined via their personal invite", st < 300,
              f"HTTP {st}: {body}")

        print("\n=== 1. The collaborator fills the folder while they have read/write ===")
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-mate", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "far", "item_id": "91.157",
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=mate["jwt"],
             body={"id": mate_note, "user_id": mate["id"], "title": "Guest note",
                   "body": "written by the guest", "linked_ac": None,
                   "deleted": False, "updated_at": NOW})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-matenote", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "note", "item_id": mate_note,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        # A highlight is a synced_bookmarks row with block_* set, filed into the
        # folder by its synthetic id -- same shape the matrix test uses.
        rpc("push_bookmark", mate["jwt"], {
            "p_id": mate_hl, "p_document_number": "91.157", "p_title": "§ 91.157",
            "p_date_issued": None, "p_office": None, "p_subject_series": None,
            "p_saved_at": NOW, "p_item_type": "far", "p_ac_id": "91.157",
            "p_block_kind": "para", "p_block_label": None,
            "p_block_snippet": "guest's passage", "p_block_text": "guest's passage"})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-{mate_hl}", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "far", "item_id": mate_hl,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        owner_ids = [i["item_id"] for i in items_in(owner["jwt"], folder_id)]
        check("owner sees all three things the guest filed",
              {"91.157", mate_note, mate_hl} <= set(owner_ids), str(owner_ids))

        print("\n=== 2. Owner individually downgrades the guest to read-only ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{mate['id']}", key=ANON, jwt=owner["jwt"],
             body={"collab_mode": "read_only"})
        time.sleep(0.4)
        st, _ = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                     body={"id": f"{folder_id}-i-blocked", "user_id": mate["id"],
                           "folder_id": folder_id, "item_type": "far", "item_id": "91.159",
                           "deleted": False, "added_at": NOW, "updated_at": NOW})
        check("downgraded guest can no longer file into the folder", st >= 400,
              f"HTTP {st}")
        modes = [r["collab_mode"] for r in collab_rows(folder_id)
                 if r["user_id"] == mate["id"]]
        check("the guest's stored role really is read_only now",
              modes == ["read_only"], str(modes))

        print("\n=== 3. Owner REMOVES the guest ===")
        remove_collaborator(owner["jwt"], folder_id, mate["id"])
        time.sleep(0.4)
        check("the collaborator no longer counts as an active member",
              not any(r["user_id"] == mate["id"] and r["left_at"] is None
                      for r in collab_rows(folder_id)),
              str(collab_rows(folder_id)))
        st, roster = http("POST", "/rest/v1/rpc/get_folder_collaborators", key=ANON,
                          jwt=owner["jwt"], body={"p_folder_id": folder_id})
        check("the removed person is gone from the owner's roster entirely -- "
              "NOT shown under 'LEFT THE FOLDER', which they did not do",
              not any(r["out_user_id"] == mate["id"] for r in (roster or [])),
              str(roster))
        check("the removed guest can no longer read the folder's items",
              items_in(mate["jwt"], folder_id) == [],
              str(items_in(mate["jwt"], folder_id)))
        st, rows = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=id,name",
                        key=ANON, jwt=mate["jwt"])
        check("the removed guest can no longer read the folder itself",
              not rows, str(rows))

        print("\n=== 4. ...and their CONTENT stays with the owner (data-loss check) ===")
        owner_ids = [i["item_id"] for i in items_in(owner["jwt"], folder_id)]
        check("the guest's filed item survives the removal",
              "91.157" in owner_ids, str(owner_ids))
        check("the guest's note survives the removal, still in the folder",
              mate_note in owner_ids, str(owner_ids))
        check("the guest's highlight survives the removal",
              mate_hl in owner_ids, str(owner_ids))
        st, rows = http("GET", f"/rest/v1/synced_notes?id=eq.{mate_note}&select=body",
                        key=ANON, jwt=owner["jwt"])
        check("the owner can still READ the guest's note body after removal",
              (rows or [{}])[0].get("body") == "written by the guest", str(rows))
        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{mate_hl}"
                               f"&select=block_text", key=ANON, jwt=owner["jwt"])
        check("the owner can still read the guest's highlight text after removal",
              (rows or [{}])[0].get("block_text") == "guest's passage", str(rows))

        print("\n=== 5. Can the removed guest get BACK IN? ===")
        st, body = try_join(mate["jwt"], invite_token)
        check("the removed guest's personal invite link is dead", st >= 400,
              f"HTTP {st}: {body}")

        st, body = http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                                 f"&user_id=eq.{mate['id']}", key=ANON, jwt=mate["jwt"],
                        body={"removed_at": None, "left_at": None})
        st2, rows = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                                f"&user_id=eq.{mate['id']}&select=removed_at", key=SERVICE)
        check("the removed guest cannot un-remove themselves",
              (rows or [{}])[0].get("removed_at") is not None,
              f"PATCH HTTP {st}: {body}; row now {rows}")

        live_link = share_token_of(folder_id)
        check("NOTE: the folder-wide share link is still live after removing a "
              "personally-invited collaborator (by design -- others may hold it)",
              live_link == link_token, f"share_token={live_link!r}")

        st, body = try_join(mate["jwt"], link_token)
        rejoined = st < 300
        check("the removed guest CANNOT walk back in through the folder-wide link",
              not rejoined, f"HTTP {st}: {body}")
        if rejoined:
            back = [r["collab_mode"] for r in collab_rows(folder_id)
                    if r["user_id"] == mate["id"]]
            check("...and if they do get back in, they must NOT land above the "
                  "read_only they were downgraded to",
                  back == ["read_only"],
                  f"rejoined at {back} after being removed while read_only")

        print("\n=== 5b. The owner can always invite a removed person BACK ===")
        reinvite = secrets.token_urlsafe(9)
        st, body = rpc_raw("invite_folder_collaborator", owner["jwt"], {
            "p_folder_id": folder_id, "p_callsign": mate_callsign, "p_token": reinvite})
        check("owner can re-invite the person they removed", st < 300, f"HTTP {st}: {body}")
        st, body = try_join(mate["jwt"], reinvite)
        check("the re-invited person can join again", st < 300, f"HTTP {st}: {body}")
        st, rows = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                                f"&user_id=eq.{mate['id']}&select=removed_at,left_at,collab_mode",
                        key=SERVICE)
        check("re-joining clears the removal marker",
              (rows or [{}])[0].get("removed_at") is None, str(rows))

        print("\n=== 6. MIRROR: removing someone who joined via the open link ===")
        # Re-arm a link so the mirror runs on a known-live token even if step 5
        # left it alone.
        http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON,
             jwt=owner["jwt"], body={"share_token": link_token})
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                       f"&user_id=eq.{mate['id']}", key=SERVICE)
        st, body = try_join(linker["jwt"], link_token)
        check("an open-link joiner gets in", st < 300, f"HTTP {st}: {body}")
        modes = [r["collab_mode"] for r in collab_rows(folder_id)
                 if r["user_id"] == linker["id"]]
        check("an open-link joiner lands at the folder's default role",
              modes == ["read_write"], str(modes))
        remove_collaborator(owner["jwt"], folder_id, linker["id"])
        time.sleep(0.4)
        check("removing an open-link joiner DOES retire the folder's share link",
              share_token_of(folder_id) is None,
              f"share_token={share_token_of(folder_id)!r}")
        st, body = try_join(linker["jwt"], link_token)
        check("...so the removed open-link joiner cannot rejoin", st >= 400,
              f"HTTP {st}: {body}")


        print("\n=== 7. AIRCRAFT: the same removal, on the other shared surface ===")
        # aircraftSharing.removeCollaborator is a copy of the folder one (its
        # own comment says so), so the rejoin exposure should copy too. The
        # content half does NOT apply here: everything on an aircraft hangs off
        # user_aircraft, which the OWNER owns outright, so nothing of the
        # guest's can become unreadable to them.
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        body={"user_id": owner["id"], "make": "Piper", "model": "PA-28",
                              "type_designator": "P28A", "nickname": "Removal Test Bird"},
                        headers={"Prefer": "return=representation"})
        ac_id = (body or [{}])[0].get("id")
        check("aircraft created", bool(ac_id), f"HTTP {st}: {body}")
        ac_code = secrets.token_urlsafe(12)
        ac_invite = secrets.token_urlsafe(12)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": ac_code, "share_code_role": "editor"})
        http("POST", "/rest/v1/aircraft_collaborators", key=SERVICE,
             body={"aircraft_id": ac_id, "owner_id": owner["id"], "user_id": mate["id"],
                   "role": "editor", "invite_token": ac_invite})
        st, body = http("POST", "/rest/v1/rpc/join_shared_aircraft", key=ANON,
                        jwt=mate["jwt"], body={"p_code": ac_invite})
        check("aircraft guest joined via their personal invite", st < 300, f"HTTP {st}: {body}")

        # Demote to viewer, then remove -- same order as the folder case.
        rpc("update_aircraft_collaborator_role", owner["jwt"],
            {"p_aircraft_id": ac_id, "p_user_id": mate["id"], "p_role": "viewer"})
        st, rows = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                               f"&user_id=eq.{mate['id']}&select=role", key=SERVICE)
        check("aircraft guest is demoted to viewer",
              [r["role"] for r in (rows or [])] == ["viewer"], str(rows))

        # Same soft removal aircraftSharing.removeCollaborator now performs.
        http("PATCH", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                      f"&user_id=eq.{mate['id']}", key=ANON, jwt=owner["jwt"],
             body={"left_at": NOW, "removed_at": NOW})
        time.sleep(0.4)
        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{ac_id}&select=id",
                        key=ANON, jwt=mate["jwt"])
        check("the removed aircraft guest loses access", not rows, str(rows))

        st, body = http("POST", "/rest/v1/rpc/join_shared_aircraft", key=ANON,
                        jwt=mate["jwt"], body={"p_code": ac_code})
        ac_rejoined = st < 300
        check("the removed aircraft guest CANNOT walk back in through the share code",
              not ac_rejoined, f"HTTP {st}: {body}")
        if ac_rejoined:
            st, rows = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}"
                                   f"&user_id=eq.{mate['id']}&select=role", key=SERVICE)
            check("...and if they do, they must NOT land above the viewer they "
                  "were demoted to",
                  [r["role"] for r in (rows or [])] == ["viewer"],
                  f"rejoined as {[r['role'] for r in (rows or [])]} after removal while viewer")

    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_notes?id=eq.{mate_note}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_bookmarks?id=eq.{mate_hl}", key=SERVICE)
        http("DELETE", f"/rest/v1/callsign_registry?user_id=eq.{mate['id']}", key=SERVICE)
        if ac_id:
            http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=SERVICE)
        for u in (owner, mate, linker):
            delete_user(u["id"])
        print("\n  NOTE  disposable accounts deleted")

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("Removing a collaborator ends their access and keeps their work.")


if __name__ == "__main__":
    main()
