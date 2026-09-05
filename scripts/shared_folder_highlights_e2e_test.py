#!/usr/bin/env python3
"""Highlights inside SHARED folders: read-only vs read/write, both directions,
and what happens the moment access is downgraded or revoked.

RC, "Suggest a feature", 2026-09-05, stating the rule he wants:

  "Highlighting, editing, highlights, adding highlights, etc. are still not
   working at all inside shared folders. The way this has to be set up is that
   if the folder is read only then the owner can add highlights. If the folder
   is read/write access between the participants then everybody who has
   read/write access must be able to both see the other person's added
   highlights even after the folder has been shared. People should be able to
   add new highlights that everybody can see, and with read/write access all
   participants who have it should be able to edit, add, delete and change any
   highlights, and they must show up immediately on everybody's phone who is
   participating."

Each clause of that is a check below. Real user JWTs against the real project
so RLS and auth.uid() are genuinely exercised -- the tier gates in
has_folder_access() (which requires BOTH parties to hold Premium) included.

Usage:  python3 scripts/shared_folder_highlights_e2e_test.py
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
FAILURES = []


def http(method, path, *, key, jwt=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")
    return cond


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True,
                          "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    return {"id": body["id"], "jwt": tok["access_token"], "label": prefix}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


def grant_premium(uid):
    # has_folder_access() requires Premium on BOTH the collaborator and the
    # owner, so every participant in this test needs it or every write below
    # would fail for the wrong reason.
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def highlight_row(user_id, ac_id, snippet, text):
    """Shaped exactly like addHighlight() in src/lib/bookmarks.ts."""
    now = time.time()
    return {
        "id": f"{ac_id}-hl-{int(now*1000)}-{secrets.token_hex(3)}",
        "user_id": user_id,
        "item_type": "far",
        "ac_id": ac_id,
        "document_number": f"§ {ac_id}",
        "title": "Preflight action",
        "date_issued": None, "office": None, "subject_series": None,
        "block_kind": "section", "block_label": None,
        "block_snippet": snippet, "block_text": text,
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "deleted": False,
    }


def main():
    owner = make_user("hlOwner")
    mate = make_user("hlMate")
    for u in (owner, mate):
        grant_premium(u["id"])

    folder_id = f"hltest{secrets.token_hex(4)}"
    AC_ID = "91.103"
    try:
        mate_callsign = f"HLMATE{secrets.token_hex(2).upper()}"
        http("POST", "/rest/v1/callsign_registry", key=SERVICE,
             headers={"Prefer": "resolution=merge-duplicates"},
             body={"user_id": mate["id"], "callsign": mate_callsign})

        st, _ = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                     body={"id": folder_id, "user_id": owner["id"], "name": "Highlight test",
                           "collab_mode": "read_write", "deleted": False,
                           # synced_folders.created_at/updated_at are NOT NULL with no
                           # default -- the client always sends them (see folders.ts), so
                           # a test that omits them fails on the constraint, not on RLS.
                           "created_at": now_iso(), "updated_at": now_iso()})
        if not check("owner created a shared folder", st in (200, 201), str(st)):
            return

        print("\n=== OWNER ADDS A HIGHLIGHT (his own folder) ===")
        own_hl = highlight_row(owner["id"], AC_ID, "Each pilot in command shall...",
                               "Each pilot in command shall, before beginning a flight, become familiar with all available information concerning that flight.")
        st, _ = http("POST", "/rest/v1/synced_bookmarks", key=ANON, jwt=owner["jwt"], body=own_hl)
        check("owner can create the highlight bookmark", st in (200, 201), str(st))
        st, _ = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
                     body={"id": secrets.token_hex(8), "user_id": owner["id"], "folder_id": folder_id,
                           "item_type": "far", "item_id": own_hl["id"], "deleted": False,
                           "added_at": now_iso(), "updated_at": now_iso()})
        check("owner can put it in the folder", st in (200, 201), str(st))

        print("\n=== READ-ONLY COLLABORATOR ===")
        st, _ = http("POST", "/rest/v1/folder_collaborators", key=SERVICE,
                     body={"folder_id": folder_id, "owner_id": owner["id"], "user_id": mate["id"],
                           "collab_mode": "read_only", "invite_token": secrets.token_hex(8),
                           "accepted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        check("read-only invite accepted", st in (200, 201), str(st))

        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}&select=id,block_text",
                        key=ANON, jwt=mate["jwt"])
        check("RO collaborator SEES the owner's highlight", st == 200 and len(rows or []) == 1, f"{st} {rows}")
        check("RO collaborator gets the highlighted TEXT, not just a pointer",
              bool(rows) and bool(rows[0].get("block_text")), str(rows))

        mate_hl = highlight_row(mate["id"], AC_ID, "become familiar with all available",
                                "become familiar with all available information concerning that flight")
        http("POST", "/rest/v1/synced_bookmarks", key=ANON, jwt=mate["jwt"], body=mate_hl)
        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"id": secrets.token_hex(8), "user_id": mate["id"], "folder_id": folder_id,
                              "item_type": "far", "item_id": mate_hl["id"], "deleted": False,
                              "added_at": now_iso(), "updated_at": now_iso()})
        check("RO collaborator CANNOT add a highlight to the folder", st >= 400, f"{st} {body}")

        st, body = http("PATCH", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}",
                        key=ANON, jwt=mate["jwt"], headers={"Prefer": "return=representation"},
                        body={"block_snippet": "RO EDIT ATTEMPT"})
        # PostgREST answers an RLS-filtered UPDATE with 200 and ZERO rows, not
        # an error -- so "did it fail" has to be measured by what came back.
        check("RO collaborator CANNOT edit the owner's highlight",
              st >= 400 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

        print("\n=== UPGRADE TO READ/WRITE ===")
        st, _ = http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}&user_id=eq.{mate['id']}",
                     key=SERVICE, body={"collab_mode": "read_write"})
        check("upgraded to read_write", st in (200, 204), str(st))

        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"id": secrets.token_hex(8), "user_id": mate["id"], "folder_id": folder_id,
                              "item_type": "far", "item_id": mate_hl["id"], "deleted": False,
                              "added_at": now_iso(), "updated_at": now_iso()})
        check("RW collaborator CAN add their own highlight", st in (200, 201), f"{st} {body}")

        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{mate_hl['id']}&select=id,block_text",
                        key=ANON, jwt=owner["jwt"])
        check("OWNER sees the collaborator's highlight", st == 200 and len(rows or []) == 1, f"{st} {rows}")

        st, body = http("PATCH", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}",
                        key=ANON, jwt=mate["jwt"], headers={"Prefer": "return=representation"},
                        body={"block_snippet": "RW EDIT"})
        check("RW collaborator CAN edit the owner's highlight",
              st in (200, 204) and isinstance(body, list) and len(body) == 1, f"{st} {body}")

        st, body = http("PATCH", f"/rest/v1/synced_bookmarks?id=eq.{mate_hl['id']}",
                        key=ANON, jwt=owner["jwt"], headers={"Prefer": "return=representation"},
                        body={"block_snippet": "OWNER EDIT"})
        check("OWNER can edit the collaborator's highlight",
              st in (200, 204) and isinstance(body, list) and len(body) == 1, f"{st} {body}")

        print("\n=== get_shared_highlights() -- what a document screen asks ===")
        st, rows = http("POST", "/rest/v1/rpc/get_shared_highlights", key=ANON, jwt=owner["jwt"],
                        body={"p_item_type": "far", "p_ac_id": AC_ID})
        mine = [r for r in (rows or []) if r["id"] == mate_hl["id"]]
        check("owner's doc screen is offered the collaborator's highlight",
              st == 200 and len(mine) == 1, f"{st} {rows}")
        check("...with the passage text needed to render it",
              bool(mine) and bool(mine[0].get("block_text")), str(mine))
        check("...marked editable (owner of a read_write folder)",
              bool(mine) and mine[0].get("can_edit") is True, str(mine))
        # The label is what the long-press menu prints ("Remove <name>'s
        # Highlight"). callsign_registry has RLS on with ZERO policies, so a
        # SECURITY INVOKER function cannot read it and this silently degrades
        # to the fallback word for everyone -- checked explicitly because a
        # wrong-but-plausible label is exactly the kind of thing that ships.
        check("...labelled with the collaborator's real callsign, not the fallback",
              bool(mine) and mine[0].get("owner_label") == mate_callsign,
              f"got {mine[0].get('owner_label') if mine else None!r}, expected {mate_callsign!r}")
        check("...and NOT carrying the caller's own highlight back to them",
              all(r["id"] != own_hl["id"] for r in (rows or [])), str(rows))

        st, rows = http("POST", "/rest/v1/rpc/get_shared_highlights", key=ANON, jwt=mate["jwt"],
                        body={"p_item_type": "far", "p_ac_id": AC_ID})
        theirs = [r for r in (rows or []) if r["id"] == own_hl["id"]]
        check("collaborator's doc screen is offered the owner's highlight",
              st == 200 and len(theirs) == 1, f"{st} {rows}")
        check("...marked editable while they hold read_write",
              bool(theirs) and theirs[0].get("can_edit") is True, str(theirs))

        print("\n=== REVOKE BACK TO READ-ONLY ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}&user_id=eq.{mate['id']}",
             key=SERVICE, body={"collab_mode": "read_only"})
        st, body = http("PATCH", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}",
                        key=ANON, jwt=mate["jwt"], headers={"Prefer": "return=representation"},
                        body={"block_snippet": "AFTER REVOKE"})
        check("editing STOPS the moment read/write is revoked",
              st >= 400 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")
        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}&select=id",
                        key=ANON, jwt=mate["jwt"])
        check("...but reading still works at read-only", st == 200 and len(rows or []) == 1, f"{st} {rows}")
        st, rows = http("POST", "/rest/v1/rpc/get_shared_highlights", key=ANON, jwt=mate["jwt"],
                        body={"p_item_type": "far", "p_ac_id": AC_ID})
        theirs = [r for r in (rows or []) if r["id"] == own_hl["id"]]
        check("a read-only viewer still SEES it but is told they cannot edit",
              len(theirs) == 1 and theirs[0].get("can_edit") is False, str(theirs))

        print("\n=== LEAVE THE FOLDER ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}&user_id=eq.{mate['id']}",
             key=SERVICE, body={"left_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}&select=id",
                        key=ANON, jwt=mate["jwt"])
        check("a departed collaborator can no longer read the highlight",
              st == 200 and len(rows or []) == 0, f"{st} {rows}")
        st, rows = http("POST", "/rest/v1/rpc/get_shared_highlights", key=ANON, jwt=mate["jwt"],
                        body={"p_item_type": "far", "p_ac_id": AC_ID})
        check("...and the RPC returns nothing to them either",
              st == 200 and not rows, f"{st} {rows}")

        print("\n=== TIER GATE ===")
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}&user_id=eq.{mate['id']}",
             key=SERVICE, body={"left_at": None, "collab_mode": "read_write"})
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{mate['id']}", key=SERVICE,
             body={"is_premium": False})
        st, rows = http("GET", f"/rest/v1/synced_bookmarks?id=eq.{own_hl['id']}&select=id",
                        key=ANON, jwt=mate["jwt"])
        check("a collaborator who loses Premium loses shared-folder access",
              st == 200 and len(rows or []) == 0, f"{st} {rows}")
    finally:
        http("DELETE", f"/rest/v1/callsign_registry?user_id=in.({owner['id']},{mate['id']})", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_bookmarks?ac_id=eq.{AC_ID}&user_id=in.({owner['id']},{mate['id']})", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        delete_user(owner["id"])
        delete_user(mate["id"])

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("shared-folder highlights: all checks passed")


if __name__ == "__main__":
    main()
