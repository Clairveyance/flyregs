#!/usr/bin/env python3
"""End-to-end Aircraft Sharing test: link-share / Callsign-invite / join /
role enforcement (viewer vs editor) / leave.

Real authenticated accounts, real user JWTs (anon key, not the service key),
driving the same tables and RPCs src/lib/aircraftSharing.ts uses -- so RLS,
has_aircraft_access(), and auth.uid() are genuinely exercised.

Written because folders_e2e_test.py exists and re-runs regularly, but
aircraft sharing (Callsign-invite roster, viewer/editor roles, link-based
join -- a real feature built earlier this session) had zero re-runnable
regression coverage; aircraft_e2e_test.py only covers solo aircraft CRUD
and never calls invite_aircraft_collaborator/join_shared_aircraft at all.
See PROJECT_NOTES/flyregs_pending.md's "Real gap found 2026-08-08" entry.

Usage:  python3 scripts/aircraft_sharing_e2e_test.py
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
    """Aircraft sharing is Premium-gated server-side on BOTH sides --
    enforce_aircraft_share_premium (trigger, owner setting share_code) and
    join_shared_aircraft/invite_aircraft_collaborator (RPC, checked
    unconditionally regardless of which path is used) all require
    is_premium. Grant it directly via the DB for this disposable account,
    same pattern as folders_e2e_test.py/search_eval.py -- not a real
    purchase."""
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})


def set_callsign(jwt, callsign):
    rpc("set_callsign", jwt, {"p_callsign": callsign})


def main():
    owner = make_user("shrA")
    mate = make_user("shrB")
    invitee = make_user("shrC")
    stranger = make_user("shrD")
    # Only the owner and the two who actually join need Premium -- `stranger`
    # stays ungranted since it only exercises RLS rejection, never joins.
    grant_premium(owner["id"])
    grant_premium(mate["id"])
    grant_premium(invitee["id"])

    invitee_callsign = "ShrInvitee" + secrets.token_hex(3)
    set_callsign(invitee["jwt"], invitee_callsign)

    st, parts = http("GET", "/rest/v1/ad_parts?select=id&status=eq.active&limit=1", key=SERVICE)
    part_id = parts[0]["id"] if parts else None
    due_date = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400 * 30))

    aircraft_id = None
    try:
        print("=== ADD AIRCRAFT (user_aircraft) ===")
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        body={"user_id": owner["id"], "make": "Cessna", "model": "172S",
                              "type_designator": "172S", "nickname": "Sharing Test Bird"},
                        headers={"Prefer": "return=representation"})
        check("aircraft insert succeeded", st < 300, f"HTTP {st}: {body}")
        aircraft_id = (body or [{}])[0].get("id")
        check("aircraft row has an id", bool(aircraft_id), str(body))

        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        check("a stranger cannot see it before sharing (RLS)", not rows, str(rows))

        print("\n=== LINK-BASED SHARE (viewer role) ===")
        viewer_token = secrets.token_urlsafe(16)
        st, body = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}",
                        key=ANON, jwt=owner["jwt"],
                        body={"share_code": viewer_token, "share_code_role": "viewer"},
                        headers={"Prefer": "return=representation"})
        check("owner (Premium) can set a share code", st < 300, f"HTTP {st}: {body}")

        joined = rpc("join_shared_aircraft", mate["jwt"], {"p_code": viewer_token})
        check("collaborator can join by link code", bool(joined), str(joined))
        row = (joined or [{}])[0]
        check("joined as VIEWER role", row.get("out_role") == "viewer", str(row))

        print("\n=== VIEWER CAN READ, CANNOT WRITE ===")
        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id,nickname",
                        key=ANON, jwt=mate["jwt"])
        check("viewer can read the shared aircraft", bool(rows), str(rows))

        st, eq_insert = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=mate["jwt"],
                             body={"user_aircraft_id": aircraft_id, "part_id": part_id})
        st2, chk = http("GET", f"/rest/v1/user_aircraft_equipment?user_aircraft_id=eq.{aircraft_id}"
                               f"&select=id", key=SERVICE)
        check("viewer cannot add equipment", not chk, f"HTTP {st}, rows={chk}")

        st, rem_insert = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=mate["jwt"],
                              body={"user_id": mate["id"], "user_aircraft_id": aircraft_id,
                                    "title": "Should not stick", "due_date": due_date})
        st2, chk = http("GET", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{aircraft_id}"
                               f"&select=id", key=SERVICE)
        check("viewer cannot add reminders", not chk, f"HTTP {st}, rows={chk}")

        st, _b = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}",
                      key=ANON, jwt=mate["jwt"], body={"nickname": "HIJACKED"})
        st2, chk = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=nickname",
                        key=SERVICE)
        check("viewer cannot update the aircraft",
              chk and chk[0]["nickname"] == "Sharing Test Bird", str(chk))

        print("\n=== OWNER SEES THE VIEWER COLLABORATOR ===")
        collabs = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        mate_row = next((c for c in (collabs or [])
                          if str(c.get("out_user_id")) == mate["id"]), {})
        check("owner sees the collaborator in the roster", bool(mate_row), str(collabs))
        check("collaborator shows role=viewer", mate_row.get("out_role") == "viewer", str(mate_row))
        check("collaborator shows accepted=true (joined via open link, not a pending invite)",
              bool(mate_row.get("out_accepted")), str(mate_row))

        st, mine = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        check("a non-collaborator still cannot see it", not mine, str(mine))
        try:
            rpc("get_aircraft_collaborators", mate["jwt"], {"p_aircraft_id": aircraft_id})
            check("a non-owner collaborator cannot list the roster", False, "call succeeded")
        except RuntimeError:
            check("a non-owner collaborator cannot list the roster", True, "")

        print("\n=== RE-SHARING AS EDITOR UPGRADES THE EXISTING COLLABORATOR ===")
        editor_token = secrets.token_urlsafe(16)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": editor_token, "share_code_role": "editor"})
        joined2 = rpc("join_shared_aircraft", mate["jwt"], {"p_code": editor_token})
        row2 = (joined2 or [{}])[0]
        check("re-joining under a new editor link upgrades the role",
              row2.get("out_role") == "editor", str(row2))

        print("\n=== EDITOR CAN WRITE ===")
        st, body = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=mate["jwt"],
                        body={"user_aircraft_id": aircraft_id, "part_id": part_id},
                        headers={"Prefer": "return=representation"})
        check("editor can add equipment", st < 300, f"HTTP {st}: {body}")
        eq_id = (body or [{}])[0].get("id") if isinstance(body, list) and body else None

        st, body = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=mate["jwt"],
                        body={"user_id": mate["id"], "user_aircraft_id": aircraft_id,
                              "title": "Editor-added reminder", "due_date": due_date},
                        headers={"Prefer": "return=representation"})
        check("editor can add a reminder", st < 300, f"HTTP {st}: {body}")
        rem_id = (body or [{}])[0].get("id") if isinstance(body, list) and body else None

        st, _b = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}",
                      key=ANON, jwt=mate["jwt"], body={"nickname": "Edited By Collaborator"})
        st2, chk = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=nickname",
                        key=SERVICE)
        check("editor CAN update the aircraft",
              chk and chk[0]["nickname"] == "Edited By Collaborator", str(chk))

        st, chk = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                       key=ANON, jwt=owner["jwt"])
        check("owner still owns/sees the aircraft after the editor's edit", bool(chk), str(chk))

        print("\n=== FLEET SUMMARY REFLECTS THE SHARE ===")
        fleet = rpc("get_fleet_summary", mate["jwt"])
        mine_in_fleet = next((f for f in (fleet or [])
                               if str(f.get("out_aircraft_id")) == aircraft_id), None)
        check("collaborator's get_fleet_summary includes the shared aircraft",
              bool(mine_in_fleet), str(fleet))
        check("fleet summary role reflects editor",
              mine_in_fleet and mine_in_fleet.get("out_role") == "editor", str(mine_in_fleet))

        shared_with_me = rpc("get_my_shared_aircraft", mate["jwt"])
        check("get_my_shared_aircraft lists it too",
              any(str(r.get("out_aircraft_id")) == aircraft_id for r in (shared_with_me or [])),
              str(shared_with_me))

        print("\n=== CALLSIGN-INVITE PATH (pending until accepted) ===")
        invite = rpc("invite_aircraft_collaborator", owner["jwt"],
                     {"p_aircraft_id": aircraft_id, "p_callsign": invitee_callsign,
                      "p_role": "viewer", "p_token": secrets.token_urlsafe(16)})
        inv_row = (invite or [{}])[0]
        check("invite_aircraft_collaborator returns a token", bool(inv_row.get("out_token")), str(inv_row))
        check("invite resolves the real Callsign back",
              inv_row.get("out_callsign") == invitee_callsign, str(inv_row))
        invite_token = inv_row.get("out_token")

        collabs2 = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        inv_collab_row = next((c for c in (collabs2 or [])
                                if str(c.get("out_user_id")) == invitee["id"]), {})
        check("pending invite shows accepted=false before the invitee opens it",
              inv_collab_row and inv_collab_row.get("out_accepted") is False, str(inv_collab_row))

        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=invitee["jwt"])
        check("invitee cannot read the aircraft BEFORE accepting", not rows, str(rows))

        print("\n=== PENDING INVITE INBOX (recipient can discover it without push) ===")
        # RC, real device: "even if a person is somehow able to send an
        # invite... the invite never comes to the intended recipient. Not
        # through call sign, not through a text message, nothing." The DB
        # row was never the problem (proven above -- it exists, pending,
        # correct owner/role/token); what was missing is any way for the
        # RECIPIENT to discover it if the one-shot push missed. This is the
        # exact query getMyPendingAircraftInvites() (src/lib/aircraftSharing.ts)
        # runs -- needs no new migration, since users_view_own_aircraft_
        # collaborations already lets the invitee read their own row.
        st, own_pending = http(
            "GET",
            f"/rest/v1/aircraft_collaborators?user_id=eq.{invitee['id']}&aircraft_id=eq.{aircraft_id}"
            f"&left_at=is.null&accepted_at=is.null&invite_token=not.is.null"
            f"&select=aircraft_id,invite_token,joined_at",
            key=ANON, jwt=invitee["jwt"],
        )
        check("invitee can read their OWN pending invite row directly (no push needed)",
              bool(own_pending) and len(own_pending) == 1, str(own_pending))
        check("that row carries the real invite token",
              bool(own_pending) and own_pending[0].get("invite_token") == invite_token,
              str(own_pending))

        st, stranger_pending = http(
            "GET",
            f"/rest/v1/aircraft_collaborators?user_id=eq.{stranger['id']}&aircraft_id=eq.{aircraft_id}"
            f"&select=aircraft_id",
            key=ANON, jwt=stranger["jwt"],
        )
        check("a stranger's own-row query returns nothing for someone else's invite",
              not stranger_pending, str(stranger_pending))

        # get_my_pending_aircraft_invites() -- the label-enrichment RPC from
        # sync/migrations_aircraft_pending_invite_inbox.sql. NOT YET APPLIED
        # (see that file's own header) -- this is a best-effort check, same
        # as the client's own degrade-to-generic-label behavior, not a hard
        # requirement for the inbox mechanism itself to work.
        try:
            pending_meta = rpc("get_my_pending_aircraft_invites", invitee["jwt"])
            meta_row = next((m for m in (pending_meta or [])
                              if str(m.get("out_aircraft_id")) == aircraft_id), None)
            check("get_my_pending_aircraft_invites() returns this invite's label (migration applied)",
                  bool(meta_row), str(pending_meta))
            if meta_row:
                check("label's inviter_label resolves to the owner's Callsign/name",
                      bool(meta_row.get("out_inviter_label")), str(meta_row))
                owner_meta = rpc("get_my_pending_aircraft_invites", owner["jwt"])
                check("the OWNER calling the same RPC gets zero rows (self-scoped to the invitee only)",
                      not owner_meta, str(owner_meta))
        except RuntimeError as e:
            print(f"  SKIP  get_my_pending_aircraft_invites() not callable yet -- "
                  f"sync/migrations_aircraft_pending_invite_inbox.sql not applied ({e}). "
                  f"Inbox still works via the raw-row check above; this is cosmetic-only.")

        hidden = rpc("get_fleet_hidden_count", invitee["jwt"])
        check("a pending, unaccepted invite does NOT inflate get_fleet_hidden_count",
              hidden == 0, f"got {hidden}, expected 0")

        try:
            rpc("invite_aircraft_collaborator", owner["jwt"],
                {"p_aircraft_id": aircraft_id, "p_callsign": "no-such-callsign-" + secrets.token_hex(4),
                 "p_role": "viewer", "p_token": secrets.token_urlsafe(16)})
            check("inviting a nonexistent Callsign is rejected", False, "call succeeded")
        except RuntimeError:
            check("inviting a nonexistent Callsign is rejected", True, "")

        try:
            owner_callsign = "ShrOwner" + secrets.token_hex(3)
            set_callsign(owner["jwt"], owner_callsign)
            rpc("invite_aircraft_collaborator", owner["jwt"],
                {"p_aircraft_id": aircraft_id, "p_callsign": owner_callsign,
                 "p_role": "viewer", "p_token": secrets.token_urlsafe(16)})
            check("owner cannot invite themselves", False, "call succeeded")
        except RuntimeError:
            check("owner cannot invite themselves", True, "")

        joined3 = rpc("join_shared_aircraft", invitee["jwt"], {"p_code": invite_token})
        row3 = (joined3 or [{}])[0]
        check("invitee accepts via their own invite token", bool(row3), str(row3))
        check("accepted invite joins with the invited role (viewer)",
              row3.get("out_role") == "viewer", str(row3))

        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=invitee["jwt"])
        check("invitee can read the aircraft AFTER accepting", bool(rows), str(rows))

        collabs3 = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        inv_row_after = next((c for c in (collabs3 or [])
                               if str(c.get("out_user_id")) == invitee["id"]), {})
        check("roster now shows accepted=true",
              bool(inv_row_after.get("out_accepted")), str(inv_row_after))

        st, own_pending_after = http(
            "GET",
            f"/rest/v1/aircraft_collaborators?user_id=eq.{invitee['id']}&aircraft_id=eq.{aircraft_id}"
            f"&accepted_at=is.null&select=aircraft_id",
            key=ANON, jwt=invitee["jwt"],
        )
        check("the pending-invite inbox query no longer returns it once accepted",
              not own_pending_after, str(own_pending_after))

        print("\n=== AN INVITE ADDRESSED TO SOMEONE ELSE CANNOT BE REDEEMED ===")
        try:
            rpc("join_shared_aircraft", stranger["jwt"], {"p_code": invite_token})
            check("a different account cannot redeem someone else's invite token", False, "call succeeded")
        except RuntimeError:
            check("a different account cannot redeem someone else's invite token", True, "")

        print("\n=== LEAVE / REMOVE ===")
        http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}"
                       f"&user_id=eq.{mate['id']}", key=ANON, jwt=mate["jwt"])
        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=mate["jwt"])
        check("after leaving, the ex-collaborator can no longer read the aircraft",
              not rows, f"{len(rows or [])} rows still visible")
        st, eq_rows = http("GET", f"/rest/v1/user_aircraft_equipment?id=eq.{eq_id}&select=id",
                          key=SERVICE)
        check("the editor's earlier equipment write survives their leaving (not cascaded)",
              bool(eq_rows), str(eq_rows))

        http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}"
                       f"&user_id=eq.{invitee['id']}", key=ANON, jwt=owner["jwt"])
        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=invitee["jwt"])
        check("owner removing a collaborator revokes their access immediately",
              not rows, f"{len(rows or [])} rows still visible")

        collabs4 = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        check("roster is empty after both collaborators are gone",
              not collabs4, str(collabs4))
    finally:
        if aircraft_id:
            http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft_equipment?user_aircraft_id=eq.{aircraft_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{aircraft_id}", key=SERVICE)
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=SERVICE)
        for u in (owner, mate, invitee, stranger):
            delete_user(u["id"])
        print("\n" + "=" * 66)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All aircraft-sharing checks passed.")


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
