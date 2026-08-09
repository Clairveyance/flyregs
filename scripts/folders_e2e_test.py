#!/usr/bin/env python3
"""End-to-end Folders test: create / fill / share / join / read / leave.

Two real authenticated accounts, real user JWTs (anon key, not the service
key), driving the same tables and RPCs src/lib/folders.ts and
src/lib/sharedFolders.ts use — so RLS and auth.uid() are genuinely exercised.

Covers every folder item type (ac/far/aim/pcg/ad/loi/note), because a stale
CHECK constraint silently blocked FAR/AIM/PCG/AD/LOI folder sync once before
and the upsert error was never checked.

Usage:  python3 scripts/folders_e2e_test.py
"""
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
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
ITEM_TYPES = ["ac", "far", "aim", "pcg", "ad", "loi", "note"]
# created_at/added_at are NOT NULL with no default -- syncPush.ts supplies
# them from the local row, so the test must too.
NOW = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


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


def rpc(fn, jwt, params=None):
    st, body = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300:
        raise RuntimeError(f"rpc {fn} -> HTTP {st}: {body}")
    return body


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
    return {"id": body["id"], "jwt": tok["access_token"], "label": prefix.upper()}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


def grant_premium(uid):
    """Folder sharing is Premium-gated server-side (set_share_token RPC) --
    grant it directly via the DB for this disposable test account, same
    pattern search_eval.py/tier_matrix_test.py use, not a real purchase."""
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def real_item_ids():
    """Real ids for every folder item type, so nothing is a fake fixture."""
    out = {}
    for typ, table, col in [
        ("ac", "advisory_circulars", "document_number"),
        ("far", "far_sections", "section_number"),
        ("aim", "aim_paragraphs", "paragraph_number"),
        ("pcg", "pcg_terms", "slug"),
        ("ad", "airworthiness_directives", "ad_number"),
        ("loi", "legal_interpretations", "slug"),
    ]:
        st, rows = http("GET", f"/rest/v1/{table}?select={col}&limit=1", key=SERVICE)
        out[typ] = rows[0][col]
    out["note"] = "note-" + secrets.token_hex(4)
    return out


def main():
    owner = make_user("fldA")
    mate = make_user("fldB")
    stranger = make_user("fldC")
    # Sharing is Premium-only on BOTH sides -- join_shared_folder itself
    # requires the JOINER to have Premium too (confirmed live in the RPC:
    # not just gating who can create a share token), so both real
    # participants need the grant for this suite to exercise the actual
    # flow. `stranger` stays ungranted -- it only tests RLS/invalid-token
    # rejection, never joins.
    grant_premium(owner["id"])
    grant_premium(mate["id"])
    ids = real_item_ids()
    folder_id = "fld-" + secrets.token_hex(6)
    token = secrets.token_urlsafe(9)
    try:
        print("=== CREATE (synced_folders — folders are local until shared) ===")
        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                        body={"id": folder_id, "user_id": owner["id"],
                              "name": "Checkride Prep", "deleted": False,
                              "created_at": NOW, "updated_at": NOW},
                        headers={"Prefer": "return=representation"})
        check("owner can push a folder", st < 300, f"HTTP {st}: {body}")

        st, rows = http("GET", "/rest/v1/synced_folders?select=id,name", key=ANON, jwt=owner["jwt"])
        check("owner sees their folder", any(r["id"] == folder_id for r in rows), str(rows))
        st, rows = http("GET", "/rest/v1/synced_folders?select=id", key=ANON, jwt=stranger["jwt"])
        check("a stranger cannot see it (RLS)",
              not any(r["id"] == folder_id for r in rows), f"{len(rows or [])} rows")

        # Give the note item real content, so "can the collaborator open it"
        # is a genuine question about synced_notes' RLS rather than a lookup
        # of a row that was never there.
        # Body deliberately cites every chip-detectable type (AC/FAR/AIM/AD +
        # a P/CG term) — the receiver's note modal auto-links these, and the
        # data-level guarantee that makes those chips work is a byte-identical
        # body. linked_ac exercises the note's own AC pointer.
        NOTE_BODY = ("Review AC 61-65K endorsements, § 91.155 minimums, "
                     "AIM 4-3-13 light gun signals, AD 2024-25-51, and the "
                     "MINIMUM FUEL definition before the checkride.")
        http("POST", "/rest/v1/synced_notes", key=ANON, jwt=owner["jwt"],
             body={"id": ids["note"], "user_id": owner["id"], "title": "Shared note",
                   "body": NOTE_BODY, "linked_ac": "61-65K",
                   "deleted": False, "updated_at": NOW})

        print("\n=== FILL: every item type (the CHECK constraint that broke sync before) ===")
        for typ in ITEM_TYPES:
            st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
                            body={"id": f"{folder_id}-{typ}", "user_id": owner["id"],
                                  "folder_id": folder_id, "item_type": typ,
                                  "item_id": ids[typ], "deleted": False,
                                  "added_at": NOW, "updated_at": NOW},
                            headers={"Prefer": "return=representation"})
            check(f"add {typ} item", st < 300, f"HTTP {st}: {body}")

        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&select=item_type", key=ANON, jwt=owner["jwt"])
        got = {r["item_type"] for r in (rows or [])}
        check("all 7 item types stored", got == set(ITEM_TYPES),
              f"missing {sorted(set(ITEM_TYPES) - got)}")

        print("\n=== SHARE ===")
        st, body = http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}",
                        key=ANON, jwt=owner["jwt"], body={"share_token": token},
                        headers={"Prefer": "return=representation"})
        check("owner can set a share token", st < 300, f"HTTP {st}: {body}")

        preview = rpc("get_shared_folder_preview", stranger["jwt"], {"p_token": token})
        check("a non-member can PREVIEW the link before joining", bool(preview), str(preview))

        try:
            bad = rpc("get_shared_folder_preview", stranger["jwt"], {"p_token": "not-a-real-token"})
            check("an invalid token previews nothing", not bad, str(bad))
        except RuntimeError as e:
            check("an invalid token is rejected", True, "")

        print("\n=== JOIN ===")
        joined = rpc("join_shared_folder", mate["jwt"], {"p_token": token})
        check("collaborator can join by token", bool(joined), str(joined))

        collabs = rpc("get_folder_collaborators", owner["jwt"], {"p_folder_id": folder_id})
        check("owner sees the collaborator in the list",
              any(str(c.get("out_user_id") or c.get("user_id")) == mate["id"] for c in (collabs or [])), str(collabs))

        print("\n=== COLLABORATOR READS THE CONTENTS ===")
        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&select=item_type,item_id", key=ANON, jwt=mate["jwt"])
        seen = {r["item_type"] for r in (rows or [])}
        check("collaborator can read EVERY item type in the shared folder",
              seen == set(ITEM_TYPES),
              f"sees {sorted(seen)}, missing {sorted(set(ITEM_TYPES) - seen)}")

        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&select=item_type", key=ANON, jwt=stranger["jwt"])
        check("a stranger still cannot read the items",
              not rows, f"{len(rows or [])} rows leaked")

        # A pointer the receiver can see is useless if the DOCUMENT behind it
        # won't load for them. Resolve every shared item to its real row AS
        # THE COLLABORATOR, which is what opening it in the app does.
        print("\n=== EVERY SHARED ITEM TYPE OPENS ON THE RECEIVER'S SIDE ===")
        RESOLVE = {
            "ac":  ("advisory_circulars",        "document_number"),
            "far": ("far_sections",              "section_number"),
            "aim": ("aim_paragraphs",            "paragraph_number"),
            "pcg": ("pcg_terms",                 "slug"),
            "ad":  ("airworthiness_directives",  "ad_number"),
            "loi": ("legal_interpretations",     "slug"),
        }
        for typ, (table, col) in RESOLVE.items():
            st, doc = http("GET", f"/rest/v1/{table}?{col}=eq.{urllib.parse.quote(str(ids[typ]))}"
                                  f"&select={col}&limit=1", key=ANON, jwt=mate["jwt"])
            check(f"collaborator can OPEN the shared {typ} item ({ids[typ]})",
                  bool(doc), f"HTTP {st}, resolved {len(doc or [])} rows")
        # Notes are the one type whose content is user-owned rather than
        # public catalogue data, so it needs its own RLS policy to be
        # readable by a collaborator.
        st, notes = http("GET", f"/rest/v1/synced_notes?id=eq.{ids['note']}&select=id,title",
                         key=ANON, jwt=mate["jwt"])
        check("collaborator can OPEN the shared note",
              bool(notes), f"HTTP {st}, {len(notes or [])} rows — needs "
                           f"collaborators_read_shared_notes on synced_notes")

        # ---- What each side SEES in Saved > Shared -------------------------
        # "With Me"  = getMyCollaborations()  -> folder_collaborators rows
        #              where I am the collaborator and left_at is null
        # "From Me"  = getMySharedFolders()   -> folders I OWN that have at
        #              least one collaborator
        print("\n=== 'WITH ME' / 'FROM ME' SECTIONS ===")
        st, mine_withme = http(
            "GET", f"/rest/v1/folder_collaborators?user_id=eq.{mate['id']}"
                   f"&left_at=is.null&select=folder_id,last_viewed_at",
            key=ANON, jwt=mate["jwt"])
        check("receiver's WITH ME lists the folder",
              any(r["folder_id"] == folder_id for r in (mine_withme or [])),
              str(mine_withme))
        check("it starts UNREAD (last_viewed_at null) so the badge shows",
              any(r["folder_id"] == folder_id and r["last_viewed_at"] is None
                  for r in (mine_withme or [])), str(mine_withme))

        st, owner_withme = http(
            "GET", f"/rest/v1/folder_collaborators?user_id=eq.{owner['id']}"
                   f"&left_at=is.null&select=folder_id", key=ANON, jwt=owner["jwt"])
        check("owner's WITH ME does NOT list their own folder",
              not any(r["folder_id"] == folder_id for r in (owner_withme or [])),
              f"owner sees their own folder under With Me: {owner_withme}")

        st, from_me = http(
            "GET", f"/rest/v1/folder_collaborators?owner_id=eq.{owner['id']}"
                   f"&select=folder_id,user_id", key=ANON, jwt=owner["jwt"])
        check("owner's FROM ME lists the folder with its collaborator",
              any(r["folder_id"] == folder_id and r["user_id"] == mate["id"]
                  for r in (from_me or [])), str(from_me))

        st, mate_from_me = http(
            "GET", f"/rest/v1/folder_collaborators?owner_id=eq.{mate['id']}&select=folder_id",
            key=ANON, jwt=mate["jwt"])
        check("receiver's FROM ME is empty (they own nothing shared)",
              not mate_from_me, str(mate_from_me))

        # Marking it viewed clears the unread badge.
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{mate['id']}", key=ANON, jwt=mate["jwt"],
             body={"last_viewed_at": NOW})
        st, seen = http("GET", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                               f"&user_id=eq.{mate['id']}&select=last_viewed_at",
                        key=ANON, jwt=mate["jwt"])
        check("opening it clears the unread badge",
              seen and seen[0]["last_viewed_at"] is not None, str(seen))

        print("\n=== OWNER ADDS AFTER SHARING (live sync) ===")
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
             body={"id": f"{folder_id}-late", "user_id": owner["id"], "folder_id": folder_id,
                   "item_type": "far", "item_id": "91.3", "deleted": False,
                   "added_at": NOW, "updated_at": NOW})
        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&item_id=eq.91.3&select=item_id", key=ANON, jwt=mate["jwt"])
        check("an item added AFTER sharing reaches the collaborator", bool(rows),
              "collaborator did not see the new item")

        print("\n=== SOFT DELETE propagates ===")
        http("PATCH", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}&item_id=eq.91.3",
             key=ANON, jwt=owner["jwt"], body={"deleted": True})
        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&item_id=eq.91.3&select=deleted", key=ANON, jwt=mate["jwt"])
        check("a removed item shows as deleted to the collaborator",
              rows and rows[0]["deleted"] is True, str(rows))

        print("\n=== COLLABORATOR CANNOT WRITE (read-only sharing) ===")
        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                        body={"id": f"{folder_id}-mate", "user_id": mate["id"],
                              "folder_id": folder_id, "item_type": "ac",
                              "item_id": ids["ac"], "deleted": False,
                              "added_at": NOW, "updated_at": NOW})
        st2, rows = http("GET", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-mate&select=id",
                         key=SERVICE)
        check("collaborator cannot inject items into someone else's folder",
              not rows, f"HTTP {st}, row present: {rows}")

        print("\n=== NOTE CONTENT SURVIVES INTACT ON THE RECEIVER ===")
        st, notes2 = http("GET", f"/rest/v1/synced_notes?id=eq.{ids['note']}"
                                 f"&select=title,body,linked_ac", key=ANON, jwt=mate["jwt"])
        row = (notes2 or [{}])[0]
        check("note body is byte-identical for the collaborator",
              row.get("body") == NOTE_BODY, f"got {str(row.get('body'))[:60]!r}")
        for frag in ("AC 61-65K", "91.155", "AIM 4-3-13", "AD 2024-25-51", "MINIMUM FUEL"):
            check(f"citation text intact: {frag}", frag in (row.get("body") or ""), "")
        check("linked_ac pointer survives", row.get("linked_ac") == "61-65K",
              str(row.get("linked_ac")))
        st, acdoc = http("GET", "/rest/v1/advisory_circulars?document_number=eq.61-65K"
                              "&select=document_number&limit=1", key=ANON, jwt=mate["jwt"])
        check("the linked AC itself opens for the collaborator", bool(acdoc), f"HTTP {st}")

        print("\n=== SHARED FOLDER IS READ-ONLY FOR THE COLLABORATOR ===")
        st, _b = http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}",
                      key=ANON, jwt=mate["jwt"], body={"name": "HIJACKED"})
        st2, chk = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=name",
                        key=SERVICE)
        check("collaborator cannot RENAME the folder",
              chk and chk[0]["name"] == "Checkride Prep", f"name={chk}")
        http("PATCH", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-far",
             key=ANON, jwt=mate["jwt"], body={"deleted": True})
        st2, chk = http("GET", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-far"
                               f"&select=deleted", key=SERVICE)
        check("collaborator cannot soft-delete an item",
              chk and chk[0]["deleted"] is False, str(chk))
        http("DELETE", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-ac",
             key=ANON, jwt=mate["jwt"])
        st2, chk = http("GET", f"/rest/v1/synced_folder_items?id=eq.{folder_id}-ac"
                               f"&select=id", key=SERVICE)
        check("collaborator cannot hard-delete an item", bool(chk), "row vanished")
        http("PATCH", f"/rest/v1/synced_notes?id=eq.{ids['note']}",
             key=ANON, jwt=mate["jwt"], body={"body": "defaced"})
        st2, chk = http("GET", f"/rest/v1/synced_notes?id=eq.{ids['note']}&select=body",
                        key=SERVICE)
        check("collaborator cannot edit the shared note",
              chk and chk[0]["body"] == NOTE_BODY, str(chk)[:70])

        print("\n=== OWNER'S COLLABORATOR VIEW (joined / opened / left) ===")
        collabs2 = rpc("get_folder_collaborators", owner["jwt"], {"p_folder_id": folder_id})
        me_row = next((c for c in (collabs2 or [])
                       if str(c.get("out_user_id")) == mate["id"]), {})
        check("owner sees WHEN the collaborator joined",
              bool(me_row.get("out_joined_at")), str(me_row))
        check("owner sees the collaborator HAS OPENED the folder (last_viewed_at)",
              bool(me_row.get("out_last_viewed_at")), str(me_row))
        try:
            rpc("get_folder_collaborators", mate["jwt"], {"p_folder_id": folder_id})
            check("a non-owner cannot list collaborators", False, "call succeeded")
        except RuntimeError:
            check("a non-owner cannot list collaborators", True, "")

        print("\n=== LEAVE ===")
        # Mirrors src/lib/sharedFolders.ts leaveSharedFolder(): a soft leave
        # that stamps left_at rather than deleting the row.
        http("PATCH", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}"
                      f"&user_id=eq.{mate['id']}", key=ANON, jwt=mate["jwt"],
             body={"left_at": NOW})
        st, rows = http("GET", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}"
                               f"&select=item_type", key=ANON, jwt=mate["jwt"])
        check("after leaving, the ex-collaborator can no longer read items",
              not rows, f"{len(rows or [])} rows still visible")
        collabs3 = rpc("get_folder_collaborators", owner["jwt"], {"p_folder_id": folder_id})
        gone = next((c for c in (collabs3 or [])
                     if str(c.get("out_user_id")) == mate["id"]), {})
        check("owner still sees the departed member, flagged as LEFT",
              bool(gone.get("out_left_at")), str(gone))
        st, withme_after = http(
            "GET", f"/rest/v1/folder_collaborators?user_id=eq.{mate['id']}"
                   f"&left_at=is.null&select=folder_id", key=ANON, jwt=mate["jwt"])
        check("after leaving, WITH ME no longer lists the folder",
              not any(r["folder_id"] == folder_id for r in (withme_after or [])),
              str(withme_after))

        print("\n=== DELETE FOLDER ===")
        http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON, jwt=owner["jwt"],
             body={"deleted": True})
        st, rows = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=deleted",
                        key=SERVICE)
        check("folder marked deleted", rows and rows[0]["deleted"] is True, str(rows))
        preview = None
        try:
            preview = rpc("get_shared_folder_preview", stranger["jwt"], {"p_token": token})
        except RuntimeError:
            preview = None
        check("a deleted folder's share link no longer previews", not preview, str(preview))
    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        for u in (owner, mate, stranger):
            delete_user(u["id"])
        print("\n" + "=" * 66)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All folder checks passed.")


_RPC_CACHE = None


def _has_rpc(name):
    global _RPC_CACHE
    if _RPC_CACHE is None:
        st, rows = http("GET", "/rest/v1/", key=SERVICE)
        _RPC_CACHE = json.dumps(rows) if rows else ""
    return name in _RPC_CACHE


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
