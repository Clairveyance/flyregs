#!/usr/bin/env python3
"""A GROUP -- one owner and three other people at once, at different access
levels, changing independently.

RC, 2026-09-17: "All of the ways the users send and receive group invites in
folders, a/c, etc... what perms exist between the group."

Everything that existed tested TWO people. Two people cannot catch the whole
class of bug that matters here, because with two people every question has the
same answer for "the collaborator" and "all collaborators":

  * BB-077 moved access onto the PERSON (folder_collaborators.collab_mode)
    rather than the folder. With one guest, a change that wrongly wrote the
    folder-wide default looks identical to a change that wrote the person's
    row. With three, it is obvious -- demoting one demotes everybody.
  * Removing one person must not disturb the other two, or their work.
  * A pending invitee (sent, not yet accepted) must have NOTHING until they
    accept, while the accepted members carry on around them.

And the question two-person tests cannot even ask:

  * CAN A GUEST GROW THE GROUP?  A read/write collaborator who can invite more
    people is adding members to somebody else's folder without the owner. Both
    invite RPCs must refuse anyone who is not the owner. Checked on both
    surfaces, including the "editor" aircraft role, which is the most
    privileged non-owner there is.

Four disposable Premium accounts, deleted at the end. Read-only on the corpus.

Usage: python3 scripts/group_share_matrix_test.py
"""
import secrets
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (                                    # noqa: E402
    http, rpc, check, make_user, delete_user, grant_premium,
    ANON, SERVICE, FAILURES,
)

NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def items_seen_by(jwt, folder_id):
    st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                           f"&deleted=eq.false&select=item_id", key=ANON, jwt=jwt)
    return sorted(r["item_id"] for r in (rows or []))


def try_file(user, folder_id, item_id):
    st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=user["jwt"],
                    body={"id": f"{folder_id}-{user['label']}-{item_id}",
                          "user_id": user["id"], "folder_id": folder_id,
                          "item_type": "far", "item_id": item_id, "deleted": False,
                          "added_at": NOW, "updated_at": NOW})
    return st


def mode_of(folder_id, uid):
    st, rows = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                           f"&user_id=eq.{uid}&select=collab_mode,left_at,removed_at",
                    key=SERVICE)
    return (rows or [{}])[0]


def main():
    owner = make_user("grpO")
    writer = make_user("grpW")     # read_write
    reader = make_user("grpR")     # read_only
    pending = make_user("grpP")    # invited, never accepts
    people = [owner, writer, reader, pending]
    for u in people:
        grant_premium(u["id"])

    folder_id = "grp-" + secrets.token_hex(6)
    link = secrets.token_urlsafe(9)
    ac_id = None
    callsigns = {}

    try:
        print("=== SETUP: one folder, three other people, three different states ===")
        http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
             body={"id": folder_id, "user_id": owner["id"], "name": "Group Test",
                   "share_token": link, "collab_mode": "read_write",
                   "deleted": False, "created_at": NOW, "updated_at": NOW})
        for u in (writer, reader, pending):
            cs = "GRP" + secrets.token_hex(3).upper()
            callsigns[u["id"]] = cs
            http("POST", "/rest/v1/callsign_registry", key=SERVICE,
                 body={"user_id": u["id"], "callsign": cs},
                 headers={"Prefer": "resolution=merge-duplicates"})

        for u in (writer, reader, pending):
            tok = secrets.token_urlsafe(9)
            st, body = http("POST", "/rest/v1/rpc/invite_folder_collaborator", key=ANON,
                            jwt=owner["jwt"], body={"p_folder_id": folder_id,
                                                    "p_callsign": callsigns[u["id"]],
                                                    "p_token": tok})
            check(f"owner invited {u['label']}", st < 300, f"HTTP {st}: {body}")
            u["invite"] = tok
        for u in (writer, reader):
            st, body = http("POST", "/rest/v1/rpc/join_shared_folder", key=ANON,
                            jwt=u["jwt"], body={"p_token": u["invite"]})
            check(f"{u['label']} accepted", st < 300, f"HTTP {st}: {body}")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{reader['id']}", key=ANON, jwt=owner["jwt"],
             body={"collab_mode": "read_only"})

        print("\n=== 1. Each person gets THEIR OWN level, not the folder's ===")
        check("the read/write member can file", try_file(writer, folder_id, "91.155") < 300)
        check("the read-only member CANNOT file", try_file(reader, folder_id, "91.157") >= 400)
        check("the pending invitee cannot file", try_file(pending, folder_id, "91.159") >= 400)
        check("the pending invitee sees NOTHING until they accept",
              items_seen_by(pending["jwt"], folder_id) == [],
              str(items_seen_by(pending["jwt"], folder_id)))
        check("the read-only member CAN read what the writer filed",
              "91.155" in items_seen_by(reader["jwt"], folder_id),
              str(items_seen_by(reader["jwt"], folder_id)))
        check("the owner sees it too",
              "91.155" in items_seen_by(owner["jwt"], folder_id))

        print("\n=== 2. A GUEST CANNOT GROW THE GROUP ===")
        outsider_cs = callsigns[pending["id"]]
        st, body = http("POST", "/rest/v1/rpc/invite_folder_collaborator", key=ANON,
                        jwt=writer["jwt"], body={"p_folder_id": folder_id,
                                                 "p_callsign": outsider_cs,
                                                 "p_token": secrets.token_urlsafe(9)})
        check("a read/write collaborator cannot invite anyone else to the folder",
              st >= 400, f"HTTP {st}: {body}")
        st, body = http("POST", "/rest/v1/rpc/set_share_token", key=ANON, jwt=writer["jwt"],
                        body={"p_folder_id": folder_id, "p_token": secrets.token_urlsafe(9)})
        check("...nor mint a share link for it",
              st >= 400 or st == 404, f"HTTP {st}: {body}")

        print("\n=== 3. Changing ONE person leaves the others alone ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{writer['id']}", key=ANON, jwt=owner["jwt"],
             body={"collab_mode": "read_only"})
        time.sleep(0.4)
        check("the demoted member can no longer file",
              try_file(writer, folder_id, "91.161") >= 400)
        check("...and the folder's own default was NOT rewritten",
              (http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=collab_mode",
                    key=SERVICE)[1] or [{}])[0].get("collab_mode") == "read_write")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{writer['id']}", key=ANON, jwt=owner["jwt"],
             body={"collab_mode": "read_write"})
        time.sleep(0.4)
        check("promoting them back restores writing",
              try_file(writer, folder_id, "91.163") < 300)
        check("the read-only member is STILL read-only through all of that",
              mode_of(folder_id, reader["id"]).get("collab_mode") == "read_only",
              str(mode_of(folder_id, reader["id"])))

        print("\n=== 4. Removing ONE person leaves the others -- and their work ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{reader['id']}", key=ANON, jwt=owner["jwt"],
             body={"left_at": NOW, "removed_at": NOW})
        time.sleep(0.4)
        check("the removed member loses access",
              items_seen_by(reader["jwt"], folder_id) == [],
              str(items_seen_by(reader["jwt"], folder_id)))
        check("the OTHER member still has full access",
              "91.155" in items_seen_by(writer["jwt"], folder_id),
              str(items_seen_by(writer["jwt"], folder_id)))
        check("...and can still write",
              try_file(writer, folder_id, "91.167") < 300)
        check("the still-pending invitee is untouched by any of it",
              mode_of(folder_id, pending["id"]).get("removed_at") is None,
              str(mode_of(folder_id, pending["id"])))
        st, body = http("POST", "/rest/v1/rpc/join_shared_folder", key=ANON,
                        jwt=pending["jwt"], body={"p_token": pending["invite"]})
        check("the pending invitee can still accept afterwards", st < 300, f"HTTP {st}: {body}")
        check("...and then sees everything the group has filed",
              "91.155" in items_seen_by(pending["jwt"], folder_id),
              str(items_seen_by(pending["jwt"], folder_id)))

        print("\n=== 5. AIRCRAFT: a guest cannot grow that group either ===")
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        body={"user_id": owner["id"], "make": "Cessna", "model": "172S",
                              "type_designator": "C172", "nickname": "Group Bird"},
                        headers={"Prefer": "return=representation"})
        ac_id = (body or [{}])[0].get("id")
        check("aircraft created", bool(ac_id), f"HTTP {st}: {body}")
        code = secrets.token_urlsafe(12)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": code, "share_code_role": "editor"})
        st, body = http("POST", "/rest/v1/rpc/join_shared_aircraft", key=ANON,
                        jwt=writer["jwt"], body={"p_code": code})
        check("a member joined the aircraft as editor", st < 300, f"HTTP {st}: {body}")
        st, body = http("POST", "/rest/v1/rpc/invite_aircraft_collaborator", key=ANON,
                        jwt=writer["jwt"], body={"p_aircraft_id": ac_id,
                                                 "p_callsign": callsigns[pending["id"]],
                                                 "p_role": "editor",
                                                 "p_token": secrets.token_urlsafe(9)})
        check("an EDITOR -- the most privileged non-owner -- still cannot invite "
              "anyone to the aircraft", st >= 400, f"HTTP {st}: {body}")
        st, body = http("POST", "/rest/v1/rpc/update_aircraft_collaborator_role", key=ANON,
                        jwt=writer["jwt"], body={"p_aircraft_id": ac_id,
                                                 "p_user_id": writer["id"],
                                                 "p_role": "editor"})
        check("...nor change anybody's role", st >= 400, f"HTTP {st}: {body}")

    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        if ac_id:
            http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{ac_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{ac_id}", key=SERVICE)
        for u in people:
            http("DELETE", f"/rest/v1/callsign_registry?user_id=eq.{u['id']}", key=SERVICE)
            delete_user(u["id"])
        print("\n  NOTE  disposable accounts deleted")

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("A group of four holds together: per-person access, independent changes.")


if __name__ == "__main__":
    main()
