"""What deleting your account does to work you left in OTHER people's folders.

Apple 5.1.1(v) requires real in-app deletion, so delete-account exists and is
careful about storage objects and stray identifiers. What nothing checks is the
SHARED side: every app table hangs off auth.users with ON DELETE CASCADE, so a
deletion reaches straight into folders the deleted person did not own.

Two directions, and they are not symmetrical.

A COLLABORATOR DELETES.  Their own notes and highlights going with them is
correct -- their data, their deletion. The question this test exists to answer
is what happens to the OWNER's folder around that hole:

  * the owner's own items, notes and highlights must survive untouched;
  * the folder itself must survive;
  * the roster must no longer list them;
  * and the one nobody would think of -- synced_folder_items rows are owned by
    WHOEVER FILED THEM, not by whoever wrote the underlying content. When a
    collaborator files the OWNER's note into the shared folder, that row is the
    COLLABORATOR's. Their deletion cascades it away, so the owner's own note
    silently leaves the owner's own folder. The note survives; its place in the
    folder does not.

THE OWNER DELETES.  The folder is theirs, so it goes, and everything in it goes
with it. What matters is that the collaborator lands somewhere sane rather than
on a dangling reference: no rows left pointing at nothing, and the shared-folder
list simply stops offering it.

Runs the REAL edge function with each user's own session, not a service-role
delete, so the deployed function is what is under test.

Usage: python3 scripts/account_deletion_shared_data_test.py
"""
import json
import secrets
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (                                    # noqa: E402
    http, check, make_user, delete_user, grant_premium,
    URL, ANON, SERVICE, FAILURES,
)

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def delete_account(jwt):
    """Exactly what the app's Delete Account button does."""
    req = urllib.request.Request(
        f"{URL}/functions/v1/delete-account", data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {jwt}", "apikey": ANON,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def items_in(folder_id, jwt=None):
    st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                           f"&deleted=eq.false&select=item_id",
                    key=SERVICE if jwt is None else ANON, jwt=jwt)
    return sorted(r["item_id"] for r in (rows or []))


def exists(table, q):
    st, rows = http("GET", f"/rest/v1/{table}?{q}&select=*", key=SERVICE)
    return bool(rows)


def main():
    print("=== DIRECTION 1: a COLLABORATOR deletes their account ===")
    owner = make_user("delO")
    mate = make_user("delM")
    for u in (owner, mate):
        grant_premium(u["id"])
    folder_id = "del-" + secrets.token_hex(6)
    ac_id = None
    reminder_id = None
    compliance_id = None
    owner_note = f"{folder_id}-note-owner"
    mate_note = f"{folder_id}-note-mate"
    mate_hl = f"{folder_id}-hl-mate"

    try:
        http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
             body={"id": folder_id, "user_id": owner["id"], "name": "Deletion Test",
                   "share_token": secrets.token_urlsafe(9), "collab_mode": "read_write",
                   "deleted": False, "created_at": NOW, "updated_at": NOW})
        http("POST", "/rest/v1/folder_collaborators", key=SERVICE,
             body={"folder_id": folder_id, "owner_id": owner["id"], "user_id": mate["id"],
                   "collab_mode": "read_write", "joined_at": NOW, "accepted_at": NOW})

        # The owner's own work.
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=owner["jwt"],
             body={"id": owner_note, "user_id": owner["id"], "title": "Owner's note",
                   "body": "the owner wrote this", "linked_ac": None,
                   "deleted": False, "updated_at": NOW})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
             body={"id": f"{folder_id}-i-own", "user_id": owner["id"], "folder_id": folder_id,
                   "item_type": "far", "item_id": "91.155", "deleted": False,
                   "added_at": NOW, "updated_at": NOW})

        # The collaborator's own work.
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=mate["jwt"],
             body={"id": mate_note, "user_id": mate["id"], "title": "Guest's note",
                   "body": "the guest wrote this", "linked_ac": None,
                   "deleted": False, "updated_at": NOW})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-matenote", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "note", "item_id": mate_note,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})
        http("POST", "/rest/v1/rpc/push_bookmark", key=ANON, jwt=mate["jwt"],
             body={"p_id": mate_hl, "p_document_number": "91.157", "p_title": "§ 91.157",
                   "p_date_issued": None, "p_office": None, "p_subject_series": None,
                   "p_saved_at": NOW, "p_item_type": "far", "p_ac_id": "91.157",
                   "p_block_kind": "para", "p_block_label": None,
                   "p_block_snippet": "guest passage", "p_block_text": "guest passage"})

        # THE ONE NOBODY WOULD THINK OF: the collaborator files the OWNER's note
        # into the shared folder. The content is the owner's; the folder ENTRY
        # belongs to the collaborator.
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
             body={"id": f"{folder_id}-i-ownnote-by-mate", "user_id": mate["id"],
                   "folder_id": folder_id, "item_type": "note", "item_id": owner_note,
                   "deleted": False, "added_at": NOW, "updated_at": NOW})

        # THE SAME SHAPE ON THE AIRCRAFT SIDE: a collaborator adds a
        # maintenance reminder to somebody else's aircraft.
        st, acb = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                       body={"user_id": owner["id"], "make": "Cessna", "model": "172S",
                             "type_designator": "C172", "nickname": "Deletion Bird"},
                       headers={"Prefer": "return=representation"})
        ac_id = (acb or [{}])[0].get("id")
        http("POST", "/rest/v1/aircraft_collaborators", key=SERVICE,
             body={"aircraft_id": ac_id, "owner_id": owner["id"], "user_id": mate["id"],
                   "role": "editor", "joined_at": NOW, "accepted_at": NOW})
        st, rb = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=mate["jwt"],
                      body={"user_id": mate["id"], "user_aircraft_id": ac_id,
                            "title": "Oil change (filed by the guest)",
                            "due_date": "2027-01-01"},
                      headers={"Prefer": "return=representation"})
        reminder_id = (rb or [{}])[0].get("id")
        check("the guest added a maintenance reminder to the owner's aircraft",
              bool(reminder_id), f"HTTP {st}: {rb}")

        # AND THE HIGHEST-STAKES ONE: an AD compliance record. user_ad_notifications
        # carries complied_at/complied_by/complied_note -- an airworthiness record --
        # and hangs off BOTH the user (cascade) and someone else's aircraft.
        st, adrows = http("GET", "/rest/v1/airworthiness_directives?select=ad_number&limit=1",
                          key=SERVICE)
        ad_number = (adrows or [{}])[0].get("ad_number")
        st, cb = http("POST", "/rest/v1/user_ad_notifications", key=SERVICE,
                      body={"user_id": mate["id"], "user_aircraft_id": ac_id,
                            "ad_number": ad_number, "matched_via": "airframe",
                            "complied_at": NOW, "complied_by": mate["id"],
                            "complied_note": "signed off by the guest",
                            "compliance_kind": "one_time"},
                      headers={"Prefer": "return=representation"})
        compliance_id = (cb or [{}])[0].get("id")
        check("the guest marked an AD complied on the owner's aircraft",
              bool(compliance_id), f"HTTP {st}: {cb}")

        before = items_in(folder_id)
        check("the folder holds everything both people filed",
              {"91.155", mate_note, owner_note} <= set(before), str(before))

        st, body = delete_account(mate["jwt"])
        check("the collaborator's account deleted through the real function",
              st == 200, f"HTTP {st}: {body}")
        time.sleep(1.0)

        print("\n--- what the OWNER is left with ---")
        after = items_in(folder_id)
        check("the folder itself survives", exists("synced_folders", f"id=eq.{folder_id}"))
        check("the owner's own item survives", "91.155" in after, str(after))
        check("the owner's own note survives",
              exists("synced_notes", f"id=eq.{owner_note}"))
        check("the roster no longer lists the deleted person",
              not exists("folder_collaborators", f"user_id=eq.{mate['id']}"))
        check("the deleted person's own note is gone (correct -- their data)",
              not exists("synced_notes", f"id=eq.{mate_note}"))
        check("the deleted person's own highlight is gone (correct)",
              not exists("synced_bookmarks", f"id=eq.{mate_hl}"))
        check("THE OWNER'S OWN NOTE IS STILL IN THE OWNER'S OWN FOLDER, even "
              "though the collaborator was the one who filed it there",
              owner_note in after,
              f"folder now holds {after}; the note itself still exists: "
              f"{exists('synced_notes', f'id=eq.{owner_note}')}")
        check("THE AD COMPLIANCE RECORD the guest signed off on the owner's "
              "aircraft survives, and now belongs to the owner",
              exists("user_ad_notifications",
                     f"id=eq.{compliance_id}&user_id=eq.{owner['id']}"),
              str(http("GET", f"/rest/v1/user_ad_notifications?id=eq.{compliance_id}"
                              f"&select=user_id,complied_by,complied_note", key=SERVICE)[1]))
        check("...and it still records WHO actually complied, not the new owner",
              (http("GET", f"/rest/v1/user_ad_notifications?id=eq.{compliance_id}"
                           f"&select=complied_by", key=SERVICE)[1] or [{}])[0]
              .get("complied_by") == mate["id"],
              "complied_by must be a record of the person, not of the row's owner")
        check("THE MAINTENANCE REMINDER the guest added to the owner's aircraft "
              "survives, and now belongs to the owner",
              exists("user_aircraft_reminders",
                     f"id=eq.{reminder_id}&user_id=eq.{owner['id']}"),
              str(http("GET", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}"
                              f"&select=user_id,title", key=SERVICE)[1]))

        print("\n=== DIRECTION 2: the OWNER deletes their account ===")
        mate2 = make_user("delM2")
        grant_premium(mate2["id"])
        http("POST", "/rest/v1/folder_collaborators", key=SERVICE,
             body={"folder_id": folder_id, "owner_id": owner["id"], "user_id": mate2["id"],
                   "collab_mode": "read_write", "joined_at": NOW, "accepted_at": NOW})
        # What getMyCollaborations() actually does -- a direct read of the
        # memberships this user holds, not an RPC.
        st, rows = http("GET", f"/rest/v1/folder_collaborators?user_id=eq.{mate2['id']}"
                               f"&left_at=is.null&select=folder_id", key=ANON, jwt=mate2["jwt"])
        rows = rows if isinstance(rows, list) else []
        check("the collaborator can see the shared folder before the deletion",
              any(r.get("folder_id") == folder_id for r in rows), f"HTTP {st}: {rows}")

        st, body = delete_account(owner["jwt"])
        check("the owner's account deleted through the real function",
              st == 200, f"HTTP {st}: {body}")
        time.sleep(1.0)

        check("the folder is gone", not exists("synced_folders", f"id=eq.{folder_id}"))
        check("no membership rows are left dangling",
              not exists("folder_collaborators", f"folder_id=eq.{folder_id}"))
        check("no folder items are left dangling",
              not exists("synced_folder_items", f"folder_id=eq.{folder_id}"))
        st, rows = http("GET", f"/rest/v1/folder_collaborators?user_id=eq.{mate2['id']}"
                               f"&left_at=is.null&select=folder_id", key=ANON, jwt=mate2["jwt"])
        rows = rows if isinstance(rows, list) else []
        check("the collaborator's shared list no longer offers it, and the read "
              "still succeeds rather than erroring",
              st < 300 and not any(r.get("folder_id") == folder_id for r in rows),
              f"HTTP {st}: {rows}")
        delete_user(mate2["id"])

    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        for nid in (owner_note, mate_note):
            http("DELETE", f"/rest/v1/synced_notes?id=eq.{nid}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_bookmarks?id=eq.{mate_hl}", key=SERVICE)
        if ac_id:
            http("DELETE", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{ac_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{ac_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=SERVICE)
        for u in (owner, mate):
            delete_user(u["id"])
        print("\n  NOTE  disposable accounts deleted")

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("Deleting an account takes only that person's own work with it.")


if __name__ == "__main__":
    main()
