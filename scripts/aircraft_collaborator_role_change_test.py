#!/usr/bin/env python3
"""Live end-to-end verification for update_aircraft_collaborator_role --
the new RPC letting an aircraft owner change an EXISTING collaborator's role
(viewer<->editor) after they've already joined. See
sync/migrations_aircraft_collaborator_role_change.sql and
src/lib/aircraftSharing.ts's updateCollaboratorRole.

Real accounts, real JWTs (anon key, not the service key), driving the same
RPC src/app/my-aircraft/[id].tsx's roster toggle calls -- so auth.uid(),
RLS, and the guard_aircraft_collaborator_self_update trigger are genuinely
exercised, not mocked.

Covers, in order:
  1. Owner shares an aircraft as viewer; collaborator joins.
  2. Collaborator confirmed viewer-only (baseline, mirrors aircraft_sharing_
     e2e_test.py's own assertions).
  3. SELF-ESCALATION EXPLOIT ATTEMPT #1: collaborator calls the new RPC
     targeting their OWN row to promote themselves to editor -- must be
     rejected, role must stay viewer.
  4. SELF-ESCALATION EXPLOIT ATTEMPT #2: collaborator bypasses the RPC
     entirely with a raw PostgREST PATCH on their own aircraft_collaborators
     row setting role='editor' directly -- must be rejected by the
     pre-existing guard trigger (unchanged by this migration), role must
     stay viewer.
  5. A non-owner, non-collaborator stranger calls the RPC -- must be
     rejected ("Not authorized").
  6. Collaborator opens a real websocket on the aircraft-realtime-{id}
     channel (same config shape as useAircraftRealtime).
  7. LEGITIMATE CHANGE: owner calls the RPC to promote the collaborator to
     editor. Verified three ways: (a) the collaborator's open socket
     receives a live postgres_changes push for aircraft_collaborators,
     (b) the owner's next get_aircraft_collaborators fetch shows role=
     editor, (c) the collaborator's own next fetch (their own row) shows
     role=editor.
  8. Editor affordances actually unlock for the collaborator: can now add
     equipment, add a reminder, and update the aircraft -- previously
     rejected as a viewer in step 2.
  9. POST-PROMOTION: the now-legitimate editor STILL cannot call the RPC
     targeting their own row (not the owner) -- confirms the "auth.uid()
     owns the aircraft" check, not just the role check, is what's gating
     this end to end.

Usage: python3 scripts/aircraft_collaborator_role_change_test.py
"""
import json
import secrets
import sys
import threading
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from aircraft_sharing_e2e_test import (
    http, rpc, check, make_user, delete_user, grant_premium, URL, ANON, FAILURES,
)

try:
    import websocket  # websocket-client
    HAVE_WS = True
except ImportError:
    HAVE_WS = False


def ws_url():
    host = URL.split("//", 1)[1]
    return f"wss://{host}/realtime/v1/websocket?apikey={ANON}&vsn=1.0.0"


def join_aircraft_channel(jwt, aircraft_id, received, ready_evt):
    """Background thread: opens the socket, joins aircraft-realtime-{id}
    with the exact config shape useAircraftRealtime uses in
    src/lib/aircraftSharing.ts, appends every postgres_changes push."""
    topic = f"realtime:aircraft-realtime-{aircraft_id}"

    def on_open(ws):
        join = {
            "topic": topic,
            "event": "phx_join",
            "payload": {
                "config": {
                    "broadcast": {"ack": False, "self": False},
                    "presence": {"key": "", "enabled": False},
                    "postgres_changes": [
                        {"event": "*", "schema": "public", "table": "aircraft_collaborators",
                         "filter": f"aircraft_id=eq.{aircraft_id}"},
                        {"event": "*", "schema": "public", "table": "user_aircraft",
                         "filter": f"id=eq.{aircraft_id}"},
                        {"event": "*", "schema": "public", "table": "user_aircraft_equipment"},
                        {"event": "*", "schema": "public", "table": "user_aircraft_reminders"},
                    ],
                    "private": False,
                },
                "access_token": jwt,
            },
            "ref": "1",
        }
        ws.send(json.dumps(join))

    def on_message(ws, message):
        msg = json.loads(message)
        if msg.get("event") == "phx_reply" and msg.get("ref") == "1":
            received.append(("_joined", msg.get("payload", {}).get("status"), msg.get("payload")))
            ready_evt.set()
        elif msg.get("event") == "postgres_changes":
            received.append(("change", msg.get("payload")))
        elif msg.get("event") in ("phx_error", "system"):
            received.append(("_meta", msg.get("event"), msg.get("payload")))

    ws_app = websocket.WebSocketApp(ws_url(), on_open=on_open, on_message=on_message)
    ws_app.run_forever(ping_interval=20, ping_timeout=10)


def wait_for(received, predicate, timeout_s):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for item in received:
            if predicate(item):
                return item
        time.sleep(0.25)
    return None


def main():
    owner = make_user("rolA")
    mate = make_user("rolB")
    stranger = make_user("rolC")
    grant_premium(owner["id"])
    grant_premium(mate["id"])

    aircraft_id = None
    try:
        print("=== SETUP: aircraft + viewer share ===")
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=owner["jwt"],
                        body={"user_id": owner["id"], "make": "Piper", "model": "PA-28",
                              "type_designator": "P28A", "nickname": "Role Change Test Bird"},
                        headers={"Prefer": "return=representation"})
        check("aircraft insert succeeded", st < 300, f"HTTP {st}: {body}")
        aircraft_id = (body or [{}])[0].get("id")
        check("aircraft row has an id", bool(aircraft_id), str(body))

        viewer_token = secrets.token_urlsafe(16)
        http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"],
             body={"share_code": viewer_token, "share_code_role": "viewer"})
        joined = rpc("join_shared_aircraft", mate["jwt"], {"p_code": viewer_token})
        row = (joined or [{}])[0]
        check("collaborator joined as viewer", row.get("out_role") == "viewer", str(row))

        print("\n=== BASELINE: viewer cannot write ===")
        st, _b = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=mate["jwt"],
                      body={"user_id": mate["id"], "user_aircraft_id": aircraft_id,
                            "title": "Should not stick", "due_date": "2027-01-01"})
        check("viewer's reminder insert is rejected (HTTP or RLS no-row)", st >= 300, f"HTTP {st}")

        print("\n=== EXPLOIT ATTEMPT 1: collaborator self-promotes via the new RPC ===")
        try:
            rpc("update_aircraft_collaborator_role", mate["jwt"],
                {"p_aircraft_id": aircraft_id, "p_user_id": mate["id"], "p_role": "editor"})
            check("collaborator cannot self-promote via update_aircraft_collaborator_role", False, "call SUCCEEDED -- self-escalation possible")
        except RuntimeError as e:
            check("collaborator cannot self-promote via update_aircraft_collaborator_role", True, str(e))

        collabs = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        mate_row = next((c for c in (collabs or []) if str(c.get("out_user_id")) == mate["id"]), {})
        check("role is still viewer after exploit attempt 1", mate_row.get("out_role") == "viewer", str(mate_row))

        print("\n=== EXPLOIT ATTEMPT 2: collaborator bypasses the RPC with a raw PATCH ===")
        st, body = http("PATCH", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}&user_id=eq.{mate['id']}",
                        key=ANON, jwt=mate["jwt"], body={"role": "editor"})
        st2, chk = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}&user_id=eq.{mate['id']}&select=role",
                        key=ANON, jwt=owner["jwt"])
        still_viewer = bool(chk) and chk[0].get("role") == "viewer"
        check("raw PostgREST self-PATCH to role='editor' is blocked (pre-existing guard trigger)",
              still_viewer, f"PATCH HTTP {st}: {body}; post-check: {chk}")

        print("\n=== A non-owner, non-collaborator stranger cannot call the RPC at all ===")
        try:
            rpc("update_aircraft_collaborator_role", stranger["jwt"],
                {"p_aircraft_id": aircraft_id, "p_user_id": mate["id"], "p_role": "editor"})
            check("stranger cannot call update_aircraft_collaborator_role", False, "call SUCCEEDED")
        except RuntimeError as e:
            check("stranger cannot call update_aircraft_collaborator_role", True, str(e))

        print("\n=== LEGITIMATE CHANGE: owner promotes the collaborator to editor ===")
        received = []
        socket_ok = False
        if HAVE_WS:
            ready_evt = threading.Event()
            t = threading.Thread(target=join_aircraft_channel, args=(mate["jwt"], aircraft_id, received, ready_evt), daemon=True)
            t.start()
            joined_ok = ready_evt.wait(timeout=10)
            join_msg = next((r for r in received if r[0] == "_joined"), None)
            socket_ok = joined_ok and bool(join_msg) and join_msg[1] == "ok"
            check("collaborator's realtime socket joined aircraft-realtime-{id}", socket_ok, str(join_msg))
            if socket_ok:
                # Known lag: phx_reply:"ok" can land slightly before the
                # server-side postgres_changes subscription is fully wired
                # -- see folder_realtime_test.py's own history of the same
                # class of transient-after-join timing gap.
                time.sleep(2)
        else:
            print("  (websocket-client not installed -- skipping live push check, still verifying via REST refetch)")

        rpc("update_aircraft_collaborator_role", owner["jwt"],
            {"p_aircraft_id": aircraft_id, "p_user_id": mate["id"], "p_role": "editor"})

        if socket_ok:
            hit = wait_for(received, lambda r: r[0] == "change" and r[1].get("data", {}).get("table") == "aircraft_collaborators", timeout_s=15)
            check("collaborator's socket received a LIVE push for the role change (not polling)",
                  hit is not None, "no postgres_changes event for aircraft_collaborators arrived within 15s")

        collabs2 = rpc("get_aircraft_collaborators", owner["jwt"], {"p_aircraft_id": aircraft_id})
        mate_row2 = next((c for c in (collabs2 or []) if str(c.get("out_user_id")) == mate["id"]), {})
        check("owner's next fetch shows role=editor", mate_row2.get("out_role") == "editor", str(mate_row2))

        st, own_row = http("GET", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}&user_id=eq.{mate['id']}&select=role",
                           key=ANON, jwt=mate["jwt"])
        check("collaborator's own next fetch shows role=editor", bool(own_row) and own_row[0].get("role") == "editor", str(own_row))

        print("\n=== EDITOR AFFORDANCES NOW UNLOCK ===")
        st, parts = http("GET", "/rest/v1/ad_parts?select=id&status=eq.active&limit=1", key=ANON, jwt=owner["jwt"])
        part_id = parts[0]["id"] if parts else None
        st, body = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=mate["jwt"],
                        body={"user_aircraft_id": aircraft_id, "part_id": part_id},
                        headers={"Prefer": "return=representation"})
        check("newly-promoted editor can add equipment", st < 300, f"HTTP {st}: {body}")

        st, body = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=mate["jwt"],
                        body={"user_id": mate["id"], "user_aircraft_id": aircraft_id,
                              "title": "Editor-added after promotion", "due_date": "2027-01-01"},
                        headers={"Prefer": "return=representation"})
        check("newly-promoted editor can add a reminder", st < 300, f"HTTP {st}: {body}")

        st, _b = http("PATCH", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=mate["jwt"],
                      body={"nickname": "Edited post-promotion"})
        st2, chk = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=nickname", key=ANON, jwt=owner["jwt"])
        check("newly-promoted editor can update the aircraft",
              chk and chk[0]["nickname"] == "Edited post-promotion", str(chk))

        print("\n=== POST-PROMOTION: still-not-the-owner cannot self-touch the RPC ===")
        try:
            rpc("update_aircraft_collaborator_role", mate["jwt"],
                {"p_aircraft_id": aircraft_id, "p_user_id": mate["id"], "p_role": "viewer"})
            check("editor (still not owner) cannot call the RPC on their own row", False, "call SUCCEEDED")
        except RuntimeError as e:
            check("editor (still not owner) cannot call the RPC on their own row", True, str(e))

    finally:
        if aircraft_id:
            http("DELETE", f"/rest/v1/aircraft_collaborators?aircraft_id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"])
            http("DELETE", f"/rest/v1/user_aircraft_equipment?user_aircraft_id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"])
            http("DELETE", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"])
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=owner["jwt"])
        for u in (owner, mate, stranger):
            delete_user(u["id"])
        print("\n" + "=" * 66)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All role-change + self-escalation checks passed.")


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
