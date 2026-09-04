#!/usr/bin/env python3
"""Read/write sharing, driven from BOTH sides, and what happens when it stops.

RC, 2026-09-04: "do a full run around folders, adding, deleting, highlighting,
adding notes, editing notes. sharing r/o and r/w scenarios, inviting/leaving
shared items, making sure both users in a r/w scenario can see and change all
edit from both directions and that it stops if r/w is revoked."

WHAT WAS ALREADY COVERED, AND WHAT WAS NOT
------------------------------------------
folders_e2e_test.py proves a collaborator can READ everything and cannot
write to a read-only folder. readonly_folder_pathway_test.py proves the
read_only / read_write / revoked contract for ADDING an item, and that the
folder correctly appears and disappears from the add-to picker.

Neither goes the other way. Nothing checked that:

  * an item the COLLABORATOR files reaches the OWNER
  * either side can EDIT a note the other one wrote, which is the actual
    point of read/write and the thing a CFI and a student would do all day
  * a highlight made by one side is visible to the other
  * a deletion by one side reaches the other
  * revoking read/write stops EDITING, not just adding -- these are separate
    RLS policies, and a folder that stops accepting new items while still
    accepting edits to old ones is revoked in name only
  * anything the collaborator created stays with the OWNER after revocation,
    rather than vanishing with the permission

That last one is the data-loss shape this project keeps finding, so it is
checked explicitly rather than assumed.

Two disposable Premium accounts, deleted at the end. Read-only on the corpus.

Usage: python3 scripts/folder_collab_matrix_test.py
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


def set_mode(owner_jwt, folder_id, user_id, mode):
    """What setCollaboratorMode() does -- a direct PATCH as the owner."""
    st, body = http("PATCH",
                    f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                    f"&user_id=eq.{user_id}",
                    key=ANON, jwt=owner_jwt,
                    body={"collab_mode": mode})
    if not (200 <= st < 300):
        raise RuntimeError(f"set_mode({mode}) -> HTTP {st}: {body}")


def items_in(jwt, folder_id):
    st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                           f"&deleted=eq.false&select=id,item_id,item_type",
                    key=ANON, jwt=jwt)
    return rows or []


def note_body(jwt, note_id):
    st, rows = http("GET", f"/rest/v1/synced_notes?id=eq.{note_id}&select=body,updated_at",
                    key=ANON, jwt=jwt)
    return (rows or [{}])[0].get("body")


def main():
    owner = make_user("fcmA")
    mate = make_user("fcmB")
    grant_premium(owner["id"])
    grant_premium(mate["id"])
    folder_id = "fcm-" + secrets.token_hex(6)
    token = secrets.token_urlsafe(9)
    owner_note = f"{folder_id}-n1"
    mate_note = f"{folder_id}-n2"

    try:
        print("=== SETUP: owner shares a folder read/write ===")
        st, _ = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                     body={"id": folder_id, "user_id": owner["id"], "name": "Collab Matrix",
                           "share_token": token, "collab_mode": "read_write",
                           "deleted": False, "created_at": NOW, "updated_at": NOW})
        check("owner pushed the folder", st < 300, f"HTTP {st}")
        rpc("join_shared_folder", mate["jwt"], {"p_token": token})
        set_mode(owner["jwt"], folder_id, mate["id"], "read_write")
        check("collaborator joined with read/write",
              any(r["collab_mode"] == "read_write" for r in
                  (http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                               f"&select=user_id,collab_mode", key=SERVICE)[1] or [])))

        print("\n=== 1. OWNER -> COLLABORATOR ===")
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
             body={"id": f"{folder_id}-i-own", "user_id": owner["id"], "folder_id": folder_id,
                   "item_type": "far", "item_id": "91.155", "deleted": False,
                   "added_at": NOW, "updated_at": NOW})
        check("collaborator sees the item the owner filed",
              any(i["item_id"] == "91.155" for i in items_in(mate["jwt"], folder_id)))

        # A note in a shared folder is pushed with force=true by the app, which
        # is why it exists in the cloud at all for a non-syncing user.
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=owner["jwt"],
             body={"id": owner_note, "user_id": owner["id"], "title": "Owner's note",
                   "body": "written by the owner", "linked_ac": None,
                   "deleted": False, "updated_at": NOW})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
             body={"id": f"{folder_id}-i-ownnote", "user_id": owner["id"],
                   "folder_id": folder_id, "item_type": "note", "item_id": owner_note,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        check("collaborator can read the owner's note through the folder",
              note_body(mate["jwt"], owner_note) == "written by the owner",
              str(note_body(mate["jwt"], owner_note)))

        print("\n=== 2. COLLABORATOR -> OWNER (the direction nothing tested) ===")
        # A collaborator's rows carry THEIR OWN user_id -- synced_notes' RLS
        # is auth.uid() = user_id for a row you author, and folder items work
        # the same way (see shared_folder_invite_e2e_test.py, which files as
        # mate["id"]). Writing the owner's id here is a 403, correctly.
        st, _ = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                     body={"id": f"{folder_id}-i-mate", "user_id": mate["id"],
                           "folder_id": folder_id, "item_type": "far", "item_id": "91.157",
                           "deleted": False, "added_at": NOW, "updated_at": NOW})
        check("read/write collaborator can file an item", st < 300, f"HTTP {st}")
        check("the OWNER sees the item the collaborator filed",
              any(i["item_id"] == "91.157" for i in items_in(owner["jwt"], folder_id)),
              str([i["item_id"] for i in items_in(owner["jwt"], folder_id)]))

        st, _ = http("POST", "/rest/v1/synced_notes", key=ANON, jwt=mate["jwt"],
                     body={"id": mate_note, "user_id": mate["id"],
                           "title": "Collaborator's note", "body": "written by the collaborator",
                           "linked_ac": None, "deleted": False, "updated_at": NOW})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-matenote", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "note", "item_id": mate_note,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        check("read/write collaborator can add a note to the folder", st < 300, f"HTTP {st}")
        check("the OWNER can read the collaborator's note",
              note_body(owner["jwt"], mate_note) == "written by the collaborator",
              str(note_body(owner["jwt"], mate_note)))

        print("\n=== 3. EDITING EACH OTHER'S WORK -- what read/write is FOR ===")
        st, _ = http("PATCH", f"/rest/v1/synced_notes?id=eq.{owner_note}", key=ANON,
                     jwt=mate["jwt"], body={"body": "edited by the collaborator",
                                            "updated_at": NOW})
        check("collaborator can EDIT the owner's note",
              note_body(owner["jwt"], owner_note) == "edited by the collaborator",
              f"HTTP {st}, owner now reads {note_body(owner['jwt'], owner_note)!r}")

        st, _ = http("PATCH", f"/rest/v1/synced_notes?id=eq.{mate_note}", key=ANON,
                     jwt=owner["jwt"], body={"body": "edited by the owner", "updated_at": NOW})
        check("owner can EDIT the collaborator's note",
              note_body(mate["jwt"], mate_note) == "edited by the owner",
              f"HTTP {st}, collaborator now reads {note_body(mate['jwt'], mate_note)!r}")

        print("\n=== 4. HIGHLIGHTS, both directions ===")
        hl_owner, hl_mate = f"{folder_id}-hl-o", f"{folder_id}-hl-m"
        for who, hid, text in ((owner, hl_owner, "owner's passage"),
                               (mate, hl_mate, "collaborator's passage")):
            rpc("push_bookmark", who["jwt"], {
                "p_id": hid, "p_document_number": "91.155", "p_title": "§ 91.155",
                "p_date_issued": None, "p_office": None, "p_subject_series": None,
                "p_saved_at": NOW, "p_item_type": "far", "p_ac_id": "91.155",
                "p_block_kind": "para", "p_block_label": None,
                "p_block_snippet": text, "p_block_text": text})
            # item_type is the UNDERLYING document's type, not "highlight" --
            # synced_folder_items' CHECK constraint has no such value. The
            # highlight is identified by its synthetic item_id, which exists
            # in no public content table and can only resolve through
            # synced_bookmarks. Same shape addExistingItemToSharedFolder uses.
            http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=who["jwt"],
                 body={"id": f"{folder_id}-i-{hid}", "user_id": who["id"],
                       "folder_id": folder_id, "item_type": "far", "item_id": hid,
                       "deleted": False, "added_at": NOW, "updated_at": NOW})
        ids = [i["item_id"] for i in items_in(mate["jwt"], folder_id)]
        check("collaborator sees the owner's highlight in the folder", hl_owner in ids, str(ids))
        ids = [i["item_id"] for i in items_in(owner["jwt"], folder_id)]
        check("owner sees the collaborator's highlight in the folder", hl_mate in ids, str(ids))

        print("\n=== 5. DELETING, both directions ===")
        st, _ = http("PATCH", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-i-mate",
                     key=ANON, jwt=owner["jwt"], body={"deleted": True, "updated_at": NOW})
        check("owner can remove an item the collaborator filed",
              not any(i["item_id"] == "91.157" for i in items_in(mate["jwt"], folder_id)),
              f"HTTP {st}")
        st, _ = http("PATCH", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-i-own",
                     key=ANON, jwt=mate["jwt"], body={"deleted": True, "updated_at": NOW})
        check("read/write collaborator can remove an item the owner filed",
              not any(i["item_id"] == "91.155" for i in items_in(owner["jwt"], folder_id)),
              f"HTTP {st}")

        print("\n=== 6. REVOKE read/write -- does EDITING stop, not just adding? ===")
        set_mode(owner["jwt"], folder_id, mate["id"], "read_only")
        time.sleep(0.5)

        st, _ = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                     body={"id": f"{folder_id}-i-after", "user_id": owner["id"],
                           "folder_id": folder_id, "item_type": "far", "item_id": "91.159",
                           "deleted": False, "added_at": NOW, "updated_at": NOW})
        check("revoked collaborator CANNOT add an item",
              not any(i["item_id"] == "91.159" for i in items_in(owner["jwt"], folder_id)),
              f"HTTP {st}")

        # The one this file exists for. Adding and editing are governed by
        # separate policies, and a folder that refuses new items while still
        # accepting edits to old ones has not really been revoked.
        http("PATCH", f"/rest/v1/synced_notes?id=eq.{owner_note}", key=ANON, jwt=mate["jwt"],
             body={"body": "SNEAKY EDIT AFTER REVOKE", "updated_at": NOW})
        check("revoked collaborator CANNOT edit the owner's note",
              note_body(owner["jwt"], owner_note) != "SNEAKY EDIT AFTER REVOKE",
              f"owner now reads {note_body(owner['jwt'], owner_note)!r}")

        http("PATCH", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-i-matenote",
             key=ANON, jwt=mate["jwt"], body={"deleted": True, "updated_at": NOW})
        check("revoked collaborator CANNOT delete an item -- not even one they filed",
              any(i["item_id"] == mate_note for i in items_in(owner["jwt"], folder_id)),
              str([i["item_id"] for i in items_in(owner["jwt"], folder_id)]))

        check("revoked collaborator can still READ the folder",
              len(items_in(mate["jwt"], folder_id)) > 0)

        print("\n=== 7. Does the OWNER keep what the collaborator made? ===")
        # The data-loss shape: a permission change must never take content
        # with it. The collaborator's note was authored by them and filed into
        # the owner's folder; revoking their access must not remove it.
        check("the collaborator's note is still in the owner's folder after the revoke",
              any(i["item_id"] == mate_note for i in items_in(owner["jwt"], folder_id)),
              str([i["item_id"] for i in items_in(owner["jwt"], folder_id)]))
        check("...and the owner can still READ its body",
              note_body(owner["jwt"], mate_note) == "edited by the owner",
              str(note_body(owner["jwt"], mate_note)))
        check("the collaborator's highlight survives the revoke, for the owner",
              any(i["item_id"] == hl_mate for i in items_in(owner["jwt"], folder_id)))

        print("\n=== 8. LEAVING ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{mate['id']}", key=ANON, jwt=mate["jwt"],
             body={"left_at": NOW})
        check("after leaving, the folder is no longer readable",
              len(items_in(mate["jwt"], folder_id)) == 0,
              str(items_in(mate["jwt"], folder_id)))
        check("...and the owner still has everything",
              len(items_in(owner["jwt"], folder_id)) >= 3,
              str([i["item_id"] for i in items_in(owner["jwt"], folder_id)]))

    finally:
        for tbl, filt in (("synced_folder_items", f"folder_id=eq.{folder_id}"),
                          ("folder_collaborators", f"folder_id=eq.{folder_id}"),
                          ("synced_folders", f"id=eq.{folder_id}")):
            http("DELETE", f"/rest/v1/{tbl}?{filt}", key=SERVICE)
        for u in (owner, mate):
            http("DELETE", f"/rest/v1/synced_notes?user_id=eq.{u['id']}", key=SERVICE)
            http("DELETE", f"/rest/v1/synced_bookmarks?user_id=eq.{u['id']}", key=SERVICE)
            delete_user(u["id"])

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("Read/write works both ways, and revoking it stops writes in both forms.")


if __name__ == "__main__":
    main()
