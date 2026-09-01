#!/usr/bin/env python3
"""RC's read-only sharing spec, tested end to end (2026-09-01).

RC: "if owner gives r/o perm to recip, then ALL shared content should exist
only in that folder which was shared. shared content in that folder is
specific to that folder... when the recip went to put items into a folder,
and the popup comes up w the diff folders they have available to select from,
a read-only-access folder from an owner was still showing as an option to add
items to (which is effectively 'editing' that folder). Now, this IS allowed
and SHOULD happen IF that recip has read/write access, but if it's r/o, or if
r/w is revoked, then that shared folder should not be showing up in their
selectable list."

So the contract under test, in both directions and across a live flip:
  read_only   -> can READ the folder, CANNOT add items, folder must NOT be
                 offered as an "add to folder" target
  read_write  -> can read AND add, folder MUST be offered
  revoked     -> immediately back to the read_only contract

The picker's list is built client-side from getMyCollaborations() filtered to
collabMode === 'read_write' (FolderPicker.tsx). This test asserts the SERVER
side of that: what get_my_collaborations actually returns, and what RLS
actually permits -- so a client-side filter alone can never be the only thing
standing between a read-only collaborator and someone else's folder.

Read-only on the corpus; creates two disposable accounts and deletes them.
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (
    http, rpc, check, make_user, delete_user, grant_premium, URL, ANON, SERVICE, FAILURES,
)
import secrets


def set_mode(owner_jwt, folder_id, user_id, mode):
    """Exactly what setCollaboratorMode() does -- a direct PATCH as the owner,
    not an RPC. Using the app's real path matters: the owner's ability to do
    this at all is what guard_folder_collaborator_self_update permits."""
    st, body = http("PATCH",
                    f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}&user_id=eq.{user_id}",
                    key=ANON, jwt=owner_jwt, body={"collab_mode": mode})
    if not (200 <= st < 300):
        raise RuntimeError(f"set_mode({mode}) -> HTTP {st}: {body}")


def memberships(jwt):
    """The exact query getMyCollaborations() runs: this user's own
    folder_collaborators rows, per-person collab_mode (NOT the folder-wide
    default -- that distinction was itself the BB-077 bug)."""
    _, rows = http("GET", "/rest/v1/folder_collaborators?select=folder_id,collab_mode,left_at&left_at=is.null",
                   key=ANON, jwt=jwt)
    return rows if isinstance(rows, list) else []


def picker_targets(jwt):
    """What FolderPicker would offer -- it filters getMyCollaborations() to
    collabMode === 'read_write'. Asserting the SERVER side of that, so a
    client-side filter is never the only thing protecting the folder."""
    return {m["folder_id"] for m in memberships(jwt) if m.get("collab_mode") == "read_write"}


def can_add_item(jwt, user_id, folder_id):
    """A real folder-item insert shaped exactly like syncPush.ts's
    folderItemRow(): user_id INCLUDED. That field is not optional -- the
    2026-08-31 cross-account fix added `NEW.user_id = auth.uid()` to
    enforce_folder_item_access, so an insert omitting it is rejected for the
    WRONG reason and would make the read-only assertions pass falsely."""
    s, _ = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=jwt, body={
        "id": f"ro-test-{secrets.token_hex(6)}",
        "user_id": user_id,
        "folder_id": folder_id,
        "item_type": "far",
        "item_id": "91.3",
        "added_at": "now()",
        "deleted": False,
    })
    return 200 <= s < 300


def main():
    owner = mate = None
    try:
        owner = make_user("rofolder-owner")
        mate = make_user("rofolder-mate")
        grant_premium(owner["id"]); grant_premium(mate["id"])

        folder_id = f"rofolder-{secrets.token_hex(6)}"
        http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"], body={
            "id": folder_id, "user_id": owner["id"], "name": "Read-only pathway test",
            "sort_order": 0, "deleted": False,
            # created_at/updated_at are NOT NULL with no default on this table.
            "created_at": "now()", "updated_at": "now()",
        })
        rpc("invite_folder_collaborator_by_callsign", owner["jwt"],
            {"p_folder_id": folder_id, "p_callsign": mate["callsign"]}) if mate.get("callsign") else None
        # Direct add as the owner, so the test doesn't depend on the invite path
        http("POST", "/rest/v1/folder_collaborators", key=SERVICE, body={
            "folder_id": folder_id, "owner_id": owner["id"], "user_id": mate["id"],
            "collab_mode": "read_only", "accepted_at": "now()",
        })

        print("\n=== 1. READ-ONLY ===")
        check("read-only collaborator CAN read the shared folder",
              any(m["folder_id"] == folder_id for m in memberships(mate["jwt"])))
        check("read-only collaborator CANNOT add an item (server-enforced)",
              not can_add_item(mate["jwt"], mate["id"], folder_id))
        check("folder is NOT offered as an add-to target",
              folder_id not in picker_targets(mate["jwt"]))

        print("\n=== 2. UPGRADED TO READ/WRITE ===")
        set_mode(owner["jwt"], folder_id, mate["id"], "read_write")
        check("read/write collaborator CAN add an item",
              can_add_item(mate["jwt"], mate["id"], folder_id))
        check("folder IS now offered as an add-to target",
              folder_id in picker_targets(mate["jwt"]))

        print("\n=== 3. REVOKED BACK TO READ-ONLY ===")
        set_mode(owner["jwt"], folder_id, mate["id"], "read_only")
        check("after revoke, collaborator CANNOT add an item again",
              not can_add_item(mate["jwt"], mate["id"], folder_id))
        check("after revoke, folder DISAPPEARS from the add-to list",
              folder_id not in picker_targets(mate["jwt"]))

        print("\n=== 4. SHARED CONTENT STAYS IN ITS FOLDER ===")
        # A note the OWNER authored inside the shared folder must be tagged with
        # its real author when it reaches the collaborator, because the Notes
        # tab filters on exactly that (`notes.tsx: n.filter(x => !x.authorId)`).
        note_id = f"ronote{secrets.token_hex(6)}"
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=owner["jwt"], body={
            "id": note_id, "user_id": owner["id"], "title": "Owner note",
            "body": "in the shared folder", "deleted": False, "updated_at": "now()",
        })
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"], body={
            "id": f"roitem-{secrets.token_hex(6)}", "user_id": owner["id"],
            "folder_id": folder_id, "item_type": "note", "item_id": note_id,
            "added_at": "now()", "deleted": False,
        })
        s, rows = http("GET", f"/rest/v1/synced_notes?id=eq.{note_id}&select=id,user_id",
                       key=ANON, jwt=mate["jwt"])
        visible = isinstance(rows, list) and len(rows) == 1
        check("collaborator can read the shared note THROUGH the folder", visible)
        if visible:
            check("shared note carries the OWNER's user_id, so the Notes tab filters it out",
                  rows[0]["user_id"] == owner["id"],
                  f"user_id={rows[0]['user_id']} owner={owner['id']}")
    finally:
        for u in (owner, mate):
            if u: delete_user(u["id"])
        print("\n  NOTE  disposable accounts deleted")

    print(f"\n=== {'ALL PASSED' if not FAILURES else str(len(FAILURES)) + ' FAILURE(S)'} ===")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
