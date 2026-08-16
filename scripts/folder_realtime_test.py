#!/usr/bin/env python3
"""Live-verify the actual folder-realtime-{id} Phoenix/websocket channel
fires a genuine push event to a collaborator, not just eventual consistency
via polling -- mirrors src/lib/sharedFolders.ts's useFolderRealtime exactly:

  supabase.channel(`folder-realtime-${folderId}`)
    .on('postgres_changes', {event:'*', schema:'public', table:'synced_folder_items', filter:`folder_id=eq.${folderId}`}, cb)
    .on('postgres_changes', {event:'*', schema:'public', table:'synced_notes'}, cb)
    .on('postgres_changes', {event:'*', schema:'public', table:'synced_folders', filter:`id=eq.${folderId}`}, cb)
    .subscribe()

Two real accounts (owner + collaborator), owner shares a folder, collaborator
opens a raw websocket to Supabase Realtime (same join payload shape as the
JS client -- read directly from node_modules/@supabase/realtime-js/dist/main/
RealtimeChannel.js's subscribe(), not guessed), joins with their own JWT as
access_token (for RLS-authorized postgres_changes), then the OWNER renames
the folder and adds an item over plain REST. Test asserts the collaborator's
socket actually RECEIVES a `postgres_changes` push for both, within a short
timeout -- not a poll-until-appears loop.

Usage: python3 scripts/folder_realtime_test.py
"""
import json
import secrets
import sys
import threading
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (
    http, rpc, check, make_user, delete_user, grant_premium, URL, ANON, NOW, FAILURES,
)

try:
    import websocket  # websocket-client
except ImportError:
    print("FAIL  websocket-client not installed (pip install websocket-client)")
    sys.exit(1)


def ws_url():
    # https://<ref>.supabase.co -> wss://<ref>.supabase.co/realtime/v1/websocket
    host = URL.split("//", 1)[1]
    return f"wss://{host}/realtime/v1/websocket?apikey={ANON}&vsn=1.0.0"


def join_folder_channel(jwt, folder_id, received, ready_evt):
    """Runs in a background thread: opens the socket, joins the channel with
    the exact config shape useFolderRealtime uses, and appends every
    postgres_changes push it receives to `received`."""
    topic = f"realtime:folder-realtime-{folder_id}"

    def on_open(ws):
        join = {
            "topic": topic,
            "event": "phx_join",
            "payload": {
                "config": {
                    "broadcast": {"ack": False, "self": False},
                    "presence": {"key": "", "enabled": False},
                    "postgres_changes": [
                        {"event": "*", "schema": "public", "table": "synced_folder_items",
                         "filter": f"folder_id=eq.{folder_id}"},
                        {"event": "*", "schema": "public", "table": "synced_notes"},
                        {"event": "*", "schema": "public", "table": "synced_folders",
                         "filter": f"id=eq.{folder_id}"},
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
            status = msg.get("payload", {}).get("status")
            received.append(("_joined", status, msg.get("payload")))
            ready_evt.set()
        elif msg.get("event") == "postgres_changes":
            received.append(("change", msg.get("payload")))
        elif msg.get("event") == "phx_error" or msg.get("event") == "system":
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
    print("=== folder-realtime-{id} live websocket push verification ===")
    owner = make_user("rtA")
    mate = make_user("rtB")
    grant_premium(owner["id"])
    grant_premium(mate["id"])
    folder_id = "rt-" + secrets.token_hex(6)
    token = secrets.token_urlsafe(9)
    try:
        st, body = http("POST", "/rest/v1/synced_folders", key=ANON, jwt=owner["jwt"],
                         body={"id": folder_id, "user_id": owner["id"], "name": "Realtime Test",
                               "deleted": False, "created_at": NOW, "updated_at": NOW},
                         headers={"Prefer": "return=representation"})
        if st >= 300:
            raise RuntimeError(f"create folder: HTTP {st}: {body}")

        st, body = http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}",
                         key=ANON, jwt=owner["jwt"], body={"share_token": token})
        if st >= 300:
            raise RuntimeError(f"set share token: HTTP {st}: {body}")

        joined = rpc("join_shared_folder", mate["jwt"], {"p_token": token})
        check("collaborator joined the folder before opening the socket", bool(joined), str(joined))

        received = []
        ready_evt = threading.Event()
        t = threading.Thread(target=join_folder_channel, args=(mate["jwt"], folder_id, received, ready_evt), daemon=True)
        t.start()

        joined_ok = ready_evt.wait(timeout=10)
        join_msg = next((r for r in received if r[0] == "_joined"), None)
        check("collaborator's socket got phx_reply for phx_join", joined_ok, "no reply within 10s")
        check("channel join status is 'ok' (RLS/access_token accepted)",
              bool(join_msg) and join_msg[1] == "ok", str(join_msg))

        if not (joined_ok and join_msg and join_msg[1] == "ok"):
            print("  Cannot proceed to push checks -- channel never joined successfully.")
        else:
            print("\n--- OWNER RENAMES THE FOLDER (synced_folders UPDATE) ---")
            baseline = len(received)
            http("PATCH", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON, jwt=owner["jwt"],
                 body={"name": "Renamed Live", "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
            hit = wait_for(received[baseline:] if False else received,
                            lambda r: r[0] == "change" and r[1].get("data", {}).get("table") == "synced_folders",
                            timeout_s=8)
            check("collaborator's socket received a LIVE push for the folder rename "
                  "(not polling)", hit is not None, "no postgres_changes event for synced_folders arrived within 8s")

            print("\n--- OWNER ADDS AN ITEM (synced_folder_items INSERT) ---")
            baseline2 = len(received)
            http("POST", "/rest/v1/synced_folder_items", key=ANON, jwt=owner["jwt"],
                 body={"id": f"{folder_id}-item", "user_id": owner["id"], "folder_id": folder_id,
                       "item_type": "far", "item_id": "91.3", "deleted": False,
                       "added_at": NOW, "updated_at": NOW})
            hit2 = wait_for(received,
                             lambda r: r[0] == "change" and r[1].get("data", {}).get("table") == "synced_folder_items",
                             timeout_s=8)
            check("collaborator's socket received a LIVE push for the new item "
                  "(not polling)", hit2 is not None, "no postgres_changes event for synced_folder_items arrived within 8s")

    finally:
        http("DELETE", f"/rest/v1/synced_folder_items?folder_id=eq.{folder_id}", key=ANON, jwt=owner["jwt"])
        http("DELETE", f"/rest/v1/folder_collaborators?folder_id=eq.{folder_id}", key=ANON, jwt=owner["jwt"])
        http("DELETE", f"/rest/v1/synced_folders?id=eq.{folder_id}", key=ANON, jwt=owner["jwt"])
        for u in (owner, mate):
            delete_user(u["id"])

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All realtime checks passed.")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
