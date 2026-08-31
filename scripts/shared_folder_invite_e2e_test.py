#!/usr/bin/env python3
"""End-to-end test for the 2026-08-17/22/29 shared-folder bug cluster.

Three real authenticated accounts, real user JWTs (anon key, not the service
key), driving the exact tables and RPCs src/lib/sharedFolders.ts uses -- so
RLS, the self-update guard trigger, and auth.uid() are all genuinely
exercised. Complements folders_e2e_test.py (which covers the happy path of
link-based sharing) by targeting the specific failures RC and Adriana
reported repeatedly:

  A. Invite by Callsign is delivered ONLY by push -- a pending invite is
     invisible in-app, so an invite whose push doesn't land is unrecoverable.
     (Reports 2026-08-17, ea844156, e94a988c, 0d73eb1f.)
  B. A highlight added to a shared folder "never made it into that folder"
     -- the item POINTER syncs, but the backing synced_bookmarks row (the
     only place a highlight's passage text lives) never does, so it resolves
     to nothing for everyone. (Report 16558ccd.)
  C. A Callsign invite wrote the invitee's personal token into
     synced_folders.share_token, breaking the folder's anonymous link.

Usage:  python3 scripts/shared_folder_invite_e2e_test.py
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
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True, "is_pro": True, "is_unlocked": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def set_callsign(jwt, callsign):
    """The real set_callsign RPC, same as Account > Callsign -- it owns
    callsign_lower's normalization, which lookup_user_by_callsign matches on."""
    rpc("set_callsign", jwt, {"p_callsign": callsign})


def main():
    owner = make_user("invA")
    mate = make_user("invB")
    stranger = make_user("invC")
    for u in (owner, mate, stranger):
        grant_premium(u["id"])
    mate_callsign = "TstB" + secrets.token_hex(3)
    set_callsign(mate["jwt"], mate_callsign)

    folder_id = "inv-" + secrets.token_hex(6)
    invite_token = secrets.token_urlsafe(9)
    link_token = secrets.token_urlsafe(9)

    # A real AC to hang a real highlight off, so nothing here is a fixture.
    st, acs = http("GET", "/rest/v1/advisory_circulars?select=id,document_number&limit=1", key=SERVICE)
    ac_id = acs[0]["id"]
    # Same synthetic shape addHighlight() builds in src/lib/bookmarks.ts:
    # "<real doc id>-hl-<timestamp>-<rand>". This id exists in NO public
    # content table, which is the whole reason a highlight can only ever be
    # resolved through synced_bookmarks.
    highlight_id = f"{ac_id}-hl-{int(time.time()*1000)}-{secrets.token_hex(3)}"
    # Every synced_bookmarks row this run creates, so the finally block can
    # remove exactly those and nothing else.
    created_bookmark_ids = [highlight_id]

    try:
        print("=== SETUP: owner pushes a folder and shares it read/write ===")
        st, _ = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                     body={"id": folder_id, "user_id": owner["id"], "name": "Invite Repro",
                           "deleted": False, "created_at": NOW, "updated_at": NOW,
                           "collab_mode": "read_write"})
        check("owner can push the folder", st < 300, f"HTTP {st}")

        print("\n=== A. INVITE BY CALLSIGN: is it reachable without a push? ===")
        row = rpc("invite_folder_collaborator", owner["jwt"], {
            "p_folder_id": folder_id, "p_callsign": mate_callsign, "p_token": invite_token})
        check("invite_folder_collaborator resolves the callsign and creates the invite",
              bool(row) and row[0]["out_user_id"] == mate["id"], str(row))

        # This is the reported symptom, reproduced exactly: the invite is
        # real in the database, and Shared > With Me shows nothing, because
        # collaborators_view_shared_folders requires accepted_at IS NOT NULL.
        st, folders_seen = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=id,name",
                                key=ANON, jwt=mate["jwt"])
        check("REPRO: an unaccepted invite's folder is NOT readable by the invitee "
              "(this is why 'With Me' looked empty)",
              not folders_seen, str(folders_seen))

        # ...but the invitee CAN read their own collaborator row, which is
        # what the new Saved > Shared > With Me pending-invite list is built
        # on (users_view_own_collaborations). No migration needed for this.
        st, pending = http(
            "GET", f"/rest/v1/folder_collaborators?user_id=eq.{mate['id']}"
                   f"&left_at=is.null&accepted_at=is.null&invite_token=not.is.null"
                   f"&select=folder_id,invite_token,joined_at",
            key=ANON, jwt=mate["jwt"])
        check("FIX: the invitee CAN read their own pending invite row (+ its token)",
              any(p["folder_id"] == folder_id and p["invite_token"] == invite_token
                  for p in (pending or [])), str(pending))

        st, other_pending = http(
            "GET", "/rest/v1/folder_collaborators?accepted_at=is.null&select=folder_id",
            key=ANON, jwt=stranger["jwt"])
        check("...and nobody else's pending invites leak to a third account",
              not any(p["folder_id"] == folder_id for p in (other_pending or [])),
              str(other_pending))

        # Optional label RPC (sync/migrations_folder_pending_invite_inbox.sql).
        # The client treats this as best-effort, so BOTH outcomes are valid --
        # this reports which one the live DB is in.
        st, meta = http("POST", "/rest/v1/rpc/get_my_pending_folder_invites",
                        key=ANON, jwt=mate["jwt"], body={})
        if st < 300:
            check("label RPC (migration applied) names the folder and inviter",
                  any(m["out_folder_id"] == folder_id and m["out_folder_name"] == "Invite Repro"
                      for m in (meta or [])), str(meta))
            st2, leak = http("POST", "/rest/v1/rpc/get_my_pending_folder_invites",
                             key=ANON, jwt=owner["jwt"], body={})
            check("label RPC is self-scoped (owner sees no invite they SENT)",
                  st2 < 300 and not any(m["out_folder_id"] == folder_id for m in (leak or [])),
                  str(leak))
        else:
            print("  NOTE  get_my_pending_folder_invites not applied yet "
                  f"(HTTP {st}) -- client falls back to a generic label. "
                  "Apply sync/migrations_folder_pending_invite_inbox.sql for names.")

        print("\n=== A2. ACCEPT from the pending list (what the Accept button calls) ===")
        joined = rpc("join_shared_folder", mate["jwt"], {"p_token": invite_token})
        check("invitee can accept their own invite by its token",
              bool(joined) and joined[0]["out_folder_id"] == folder_id, str(joined))
        st, folders_seen = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=id,name",
                                key=ANON, jwt=mate["jwt"])
        check("after accepting, the folder IS readable (it now shows in With Me)",
              bool(folders_seen), str(folders_seen))

        print("\n=== A3. DECLINE (self-set left_at on an unaccepted invite) ===")
        decline_token = secrets.token_urlsafe(9)
        d_folder = "inv-" + secrets.token_hex(6)
        http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
             body={"id": d_folder, "user_id": owner["id"], "name": "Decline Me",
                   "deleted": False, "created_at": NOW, "updated_at": NOW})
        rpc("invite_folder_collaborator", owner["jwt"], {
            "p_folder_id": d_folder, "p_callsign": mate_callsign, "p_token": decline_token})
        st, body = http("PATCH",
                        f"/rest/v1/folder_collaborators?folder_id=eq.{d_folder}"
                        f"&user_id=eq.{mate['id']}&accepted_at=is.null",
                        key=ANON, jwt=mate["jwt"], body={"left_at": NOW})
        check("invitee can decline (self-set left_at) -- the guard trigger allows it",
              st < 300, f"HTTP {st}: {body}")
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{d_folder}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{d_folder}", key=SERVICE)

        print("\n=== B. HIGHLIGHT ADDED TO A SHARED FOLDER (report 16558ccd) ===")
        # The collaborator files their own highlight into the owner's folder,
        # exactly as addExistingItemToSharedFolder does: insert the pointer.
        st, body = http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=mate["jwt"],
                        body={"id": "item-" + secrets.token_hex(5), "user_id": mate["id"],
                              "folder_id": folder_id, "item_type": "ac",
                              "item_id": highlight_id, "added_at": NOW,
                              "updated_at": NOW, "deleted": False})
        check("read/write collaborator can file an item into the owner's folder",
              st < 300, f"HTTP {st}: {body}")

        # Before the fix, that was ALL that happened. Prove the consequence:
        # the pointer exists, but there is nothing anywhere to resolve it to.
        # advisory_circulars.id is a uuid column and a highlight id never is
        # one, so this doesn't just miss -- Postgres rejects the comparison
        # outright (22P02). Either way the conclusion is the same and is the
        # entire reason resolveMissingAsHighlights exists: a highlight is
        # unresolvable through any public content table.
        st, ac_rows = http("GET", f"/rest/v1/advisory_circulars?id=eq.{highlight_id}&select=id",
                           key=SERVICE)
        check("a highlight id matches NO row in the public content table "
              "(so the normal resolve path can never find it)",
              not ac_rows or (isinstance(ac_rows, dict) and ac_rows.get("code") == "22P02"),
              str(ac_rows))
        st, hl_rows = http("GET", f"/rest/v1/synced_bookmarks_gated?id=eq.{highlight_id}"
                                  f"&select=id,ac_id,block_text", key=ANON, jwt=owner["jwt"])
        check("REPRO: with no backing synced_bookmarks row, the owner resolves NOTHING "
              "-- the item is invisible to everyone ('never made it into that folder')",
              not hl_rows, str(hl_rows))

        # The fix: addExistingItemToSharedFolder now force-pushes the backing
        # bookmark through the same push_bookmark RPC syncPushBookmark uses.
        rpc("push_bookmark", mate["jwt"], {
            "p_id": highlight_id, "p_document_number": acs[0]["document_number"],
            "p_title": "Highlight under test", "p_date_issued": None, "p_office": None,
            "p_subject_series": None, "p_saved_at": NOW, "p_item_type": "ac",
            "p_ac_id": ac_id, "p_block_kind": "section", "p_block_label": "1.1",
            "p_block_snippet": "highlighted passage", "p_block_text": "highlighted passage"})
        st, hl_rows = http("GET", f"/rest/v1/synced_bookmarks_gated?id=eq.{highlight_id}"
                                  f"&select=id,ac_id,block_text", key=ANON, jwt=owner["jwt"])
        # This specific check is also the guard for the OWNER arm of
        # migrations_fix_synced_bookmarks_gated_rls_bypass.sql's WHERE clause.
        # A folder's owner has no folder_collaborators row for their own
        # folder, so has_folder_access() is FALSE for them -- without the
        # folder_owner_id() arm this would start failing after that migration,
        # and folder/[id].tsx would then self-heal-DELETE the collaborator's
        # item for everyone rather than merely fail to draw it.
        check("FIX: once the backing bookmark is force-pushed, the OWNER resolves the "
              "highlight (resolveMissingAsHighlights' exact query)",
              bool(hl_rows) and hl_rows[0]["ac_id"] == ac_id, str(hl_rows))
        check("...and its passage text comes through intact",
              bool(hl_rows) and hl_rows[0]["block_text"] == "highlighted passage", str(hl_rows))

        # The mirror direction: the OWNER's own highlight must resolve for an
        # accepted COLLABORATOR (has_folder_access arm).
        owner_hl = f"{ac_id}-hl-{int(time.time()*1000)}-{secrets.token_hex(3)}"
        created_bookmark_ids.append(owner_hl)
        rpc("push_bookmark", owner["jwt"], {
            "p_id": owner_hl, "p_document_number": acs[0]["document_number"],
            "p_title": "Owner highlight", "p_date_issued": None, "p_office": None,
            "p_subject_series": None, "p_saved_at": NOW, "p_item_type": "ac",
            "p_ac_id": ac_id, "p_block_kind": "section", "p_block_label": "1.2",
            "p_block_snippet": "owner passage", "p_block_text": "owner passage"})
        http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
             body={"id": "item-" + secrets.token_hex(5), "user_id": owner["id"],
                   "folder_id": folder_id, "item_type": "ac", "item_id": owner_hl,
                   "added_at": NOW, "updated_at": NOW, "deleted": False})
        st, mate_sees = http("GET", f"/rest/v1/synced_bookmarks_gated?id=eq.{owner_hl}"
                                    f"&select=id,ac_id,block_text", key=ANON, jwt=mate["jwt"])
        check("...and the reverse direction works too: an accepted COLLABORATOR "
              "resolves the OWNER's highlight",
              bool(mate_sees) and mate_sees[0]["block_text"] == "owner passage", str(mate_sees))

        # Standing regression guard for the leak found 2026-08-30: this
        # SHOULD fail until sync/migrations_fix_synced_bookmarks_gated_rls_
        # bypass.sql is applied. synced_bookmarks_gated is a non-
        # security_invoker view owned by postgres over an RLS'd table, with
        # no row filter and SELECT granted to anon + authenticated -- so it
        # hands every user's bookmarks and highlight passages to anyone.
        # Tested from BOTH a signed-in stranger and a bare anon key, since
        # the two are separate grants.
        st, leak = http("GET", f"/rest/v1/synced_bookmarks_gated?id=eq.{highlight_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        anon_status, anon_leak = http("GET", f"/rest/v1/synced_bookmarks_gated?id=eq.{highlight_id}&select=id",
                             key=ANON)
        check("SECURITY: an unrelated account cannot read another user's highlight",
              not leak, f"LEAKED to a signed-in stranger: {leak} -- apply "
                        f"sync/migrations_fix_synced_bookmarks_gated_rls_bypass.sql")
        # A bare anon key gets REVOKEd outright (42501 permission denied, a
        # dict, not []), unlike a signed-in stranger, who still legitimately
        # gets a 200 with an empty list from the row filter -- both count as
        # "not leaked", the shapes just differ because the two calls hit
        # different grants (no anon SELECT at all vs. a row-filtered SELECT).
        check("SECURITY: an UNAUTHENTICATED caller cannot read another user's highlight",
              anon_status == 200 and anon_leak == [] or (isinstance(anon_leak, dict) and anon_leak.get("code") == "42501"),
              f"LEAKED to a bare anon key: {anon_leak} -- apply "
              f"sync/migrations_fix_synced_bookmarks_gated_rls_bypass.sql")

        print("\n=== C. A CALLSIGN INVITE MUST NOT BECOME THE FOLDER'S PUBLIC LINK ===")
        st, folder_row = http("GET", f"/rest/v1/synced_folders?id=eq.{folder_id}&select=share_token",
                              key=SERVICE)
        current = (folder_row or [{}])[0].get("share_token")
        check("REPRO GUARD: share_token is not the invitee's personal invite token",
              current != invite_token,
              f"share_token == invite_token ({current}) -- the anonymous link now "
              f"resolves to one person's invite row and fails for everyone else")

        # Prove WHY that matters: join_shared_folder checks invite_token
        # first, so a link carrying an invite token is rejected for anyone
        # other than the invitee.
        try:
            rpc("join_shared_folder", stranger["jwt"], {"p_token": invite_token})
            check("a third party cannot redeem someone else's Callsign invite", False,
                  "the stranger joined with another person's invite token")
        except RuntimeError as e:
            check("a third party cannot redeem someone else's Callsign invite",
                  "different FlyRegs account" in str(e) or "already been accepted" in str(e), str(e))

        # An independent anonymous token (what confirmFolderSharedByInvite
        # now mints) still lets a stranger join normally.
        http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON, jwt=owner["jwt"],
             body={"share_token": link_token})
        joined = rpc("join_shared_folder", stranger["jwt"], {"p_token": link_token})
        check("an INDEPENDENT anonymous share_token still works for a link invite",
              bool(joined) and joined[0]["out_folder_id"] == folder_id, str(joined))

    finally:
        # By exact id only -- NEVER by ac_id, which real users' own bookmarks
        # on this same public AC would also match.
        for bid in created_bookmark_ids:
            http("DELETE", f"/rest/v1/synced_bookmarks?id=eq.{urllib.parse.quote(bid)}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=SERVICE)
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=SERVICE)
        for u in (owner, mate, stranger):
            http("DELETE", f"/rest/v1/callsign_registry?user_id=eq.{u['id']}", key=SERVICE)
            delete_user(u["id"])
        print("\n" + "=" * 70)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All shared-folder invite checks passed.")


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
