#!/usr/bin/env python3
"""End-to-end My Aircraft test: add aircraft / tag equipment / AD backfill+
notifications / maintenance reminders / parts search / delete.

One real authenticated account, real user JWT (anon key, not the service
key), driving the same tables and RPCs src/lib/adParts.ts, src/lib/
adNotifications.ts, and src/app/my-aircraft/*.tsx use -- so RLS and
auth.uid() are genuinely exercised, matching the pattern already proven out
in folders_e2e_test.py / duel_e2e_test.py / study_lifecycle_test.py.

Uses a real Cessna 172S -- migrations_ad_backfill.sql's own header names
this exact make/model as the real case that surfaced (and got fixed for)
the null-model precision bug, so it's a known-real match, not a guess.

Usage:  python3 scripts/aircraft_e2e_test.py
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


def main():
    user = make_user("acftA")
    stranger = make_user("acftB")
    aircraft_id = None
    equipment_id = None
    reminder_id = None
    try:
        print("=== ADD AIRCRAFT (user_aircraft) ===")
        st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=user["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"user_id": user["id"], "make": "Cessna", "model": "172S",
                              "nickname": "Test 172", "type_designator": "C172", "year": 2015})
        check("aircraft insert succeeded", st in (200, 201), f"{st} {body}")
        aircraft_id = body[0]["id"] if isinstance(body, list) else None
        check("aircraft row has an id", bool(aircraft_id), str(body))

        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=make,model,nickname,type_designator,year",
                        key=ANON, jwt=user["jwt"])
        check("owner can read back their own aircraft", st == 200 and len(rows) == 1, f"{st} {rows}")

        st, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        check("a stranger cannot read someone else's aircraft", st == 200 and len(rows) == 0, f"{st} {rows}")

        print("\n=== TAG EQUIPMENT (user_aircraft_equipment / ad_parts) ===")
        st, parts = http("GET", "/rest/v1/ad_parts?select=id,name&status=eq.active&limit=1", key=SERVICE)
        check("a real active part exists to tag", st == 200 and len(parts) == 1, f"{st} {parts}")
        part_id = parts[0]["id"]

        st, body = http("POST", "/rest/v1/user_aircraft_equipment", key=ANON, jwt=user["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"user_aircraft_id": aircraft_id, "part_id": part_id})
        check("equipment tag insert succeeded", st in (200, 201), f"{st} {body}")
        equipment_id = body[0]["id"] if isinstance(body, list) else None

        st, rows = http("GET", f"/rest/v1/user_aircraft_equipment?user_aircraft_id=eq.{aircraft_id}"
                        f"&select=id,ad_parts!inner(id,name)", key=ANON, jwt=user["jwt"])
        check("tagged equipment reads back with joined part name",
              st == 200 and len(rows) == 1 and rows[0]["ad_parts"]["name"] == parts[0]["name"], f"{st} {rows}")

        print("\n=== AD BACKFILL (backfill_aircraft_ad_notifications RPC) ===")
        added = rpc("backfill_aircraft_ad_notifications", user["jwt"], {"p_user_aircraft_id": aircraft_id})
        check("backfill returns a count without erroring", isinstance(added, int), str(added))
        check("backfill found at least one real applicable AD for a Cessna 172S",
              added and added > 0, f"added={added}")

        st, notes = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{aircraft_id}"
                         f"&dismissed_at=is.null&select=id,ad_number,matched_via,read_at,"
                         f"airworthiness_directives!inner(subject_heading)",
                         key=ANON, jwt=user["jwt"])
        check("notification rows readable by the owner", st == 200 and len(notes) == added, f"{st} added={added} got={len(notes)}")
        check("every notification has a real subject heading",
              all(n["airworthiness_directives"]["subject_heading"] for n in notes), str(notes[:2]))
        check("every notification starts unread", all(n["read_at"] is None for n in notes), str(notes[:2]))
        check("matched_via is a real value on every row",
              all(n["matched_via"] in ("airframe", "equipment") for n in notes), str(notes[:2]))

        st, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        check("a stranger cannot read someone else's AD notifications", st == 200 and len(rows) == 0, f"{st} {rows}")

        note_id = notes[0]["id"]
        st, _ = http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{note_id}&read_at=is.null",
                     key=ANON, jwt=user["jwt"], body={"read_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        st2, rows = http("GET", f"/rest/v1/user_ad_notifications?id=eq.{note_id}&select=read_at", key=SERVICE)
        check("marking a notification read persists", st == 204 and rows[0]["read_at"] is not None, f"{st} {rows}")

        st, _ = http("PATCH", f"/rest/v1/user_ad_notifications?id=eq.{note_id}",
                     key=ANON, jwt=user["jwt"], body={"dismissed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        st2, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{aircraft_id}"
                         f"&dismissed_at=is.null&select=id", key=ANON, jwt=user["jwt"])
        check("dismissing a notification removes it from the active list",
              st == 204 and len(rows) == added - 1, f"{st} remaining={len(rows)} expected={added - 1}")

        st2, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{aircraft_id}"
                         f"&select=id", key=SERVICE)
        check("dismissed row still exists (soft delete, not gone)", len(rows) == added, str(rows))

        print("\n=== MAINTENANCE REMINDERS (user_aircraft_reminders) ===")
        due = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400 * 30))
        st, body = http("POST", "/rest/v1/user_aircraft_reminders", key=ANON, jwt=user["jwt"],
                        headers={"Prefer": "return=representation"},
                        body={"user_id": user["id"], "user_aircraft_id": aircraft_id,
                              "title": "Annual Inspection", "due_date": due,
                              "linked_ad_number": None, "notes": "e2e test reminder"})
        check("reminder insert succeeded", st in (200, 201), f"{st} {body}")
        reminder_id = body[0]["id"] if isinstance(body, list) else None

        st, rows = http("GET", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{aircraft_id}"
                        f"&select=id,title,due_date,notes&order=due_date", key=ANON, jwt=user["jwt"])
        check("reminder reads back with correct fields",
              st == 200 and len(rows) == 1 and rows[0]["title"] == "Annual Inspection" and rows[0]["due_date"] == due,
              f"{st} {rows}")

        st, rows = http("GET", f"/rest/v1/user_aircraft_reminders?user_aircraft_id=eq.{aircraft_id}&select=id",
                        key=ANON, jwt=stranger["jwt"])
        check("a stranger cannot read someone else's reminders", st == 200 and len(rows) == 0, f"{st} {rows}")

        st, _ = http("PATCH", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}", key=ANON, jwt=user["jwt"],
                     body={"title": "Annual Inspection (updated)", "due_date": due, "notes": "updated"})
        st2, rows = http("GET", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}&select=title,notes", key=SERVICE)
        check("reminder update persists", st == 204 and rows[0]["title"] == "Annual Inspection (updated)", f"{st} {rows}")

        st, _ = http("DELETE", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}", key=ANON, jwt=user["jwt"])
        st2, rows = http("GET", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}&select=id", key=SERVICE)
        check("reminder delete actually removes the row", st == 204 and len(rows) == 0, f"{st} {rows}")
        reminder_id = None

        print("\n=== PARTS SEARCH (ad_parts, multi-word AND-across-fields) ===")
        st, rows = http("GET", f"/rest/v1/ad_parts?select=id,name,manufacturer&status=eq.active"
                        f"&or=(name.ilike.%25propeller%25,manufacturer.ilike.%25propeller%25)&limit=5",
                        key=SERVICE)
        check("a real 'propeller' part exists in the catalog to search for", st == 200 and len(rows) > 0, f"{st} {rows}")

        print("\n=== REMOVE EQUIPMENT / DELETE AIRCRAFT ===")
        st, _ = http("DELETE", f"/rest/v1/user_aircraft_equipment?id=eq.{equipment_id}", key=ANON, jwt=user["jwt"])
        st2, rows = http("GET", f"/rest/v1/user_aircraft_equipment?id=eq.{equipment_id}&select=id", key=SERVICE)
        check("equipment removal actually removes the row", st == 204 and len(rows) == 0, f"{st} {rows}")
        equipment_id = None

        st, _ = http("DELETE", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=ANON, jwt=user["jwt"])
        st2, rows = http("GET", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}&select=id", key=SERVICE)
        check("aircraft delete actually removes the row", st == 204 and len(rows) == 0, f"{st} {rows}")
        st2, rows = http("GET", f"/rest/v1/user_ad_notifications?user_aircraft_id=eq.{aircraft_id}&select=id", key=SERVICE)
        check("deleting the aircraft cascades its AD notifications", len(rows) == 0, str(rows))
        aircraft_id = None

    finally:
        if reminder_id:
            http("DELETE", f"/rest/v1/user_aircraft_reminders?id=eq.{reminder_id}", key=SERVICE)
        if equipment_id:
            http("DELETE", f"/rest/v1/user_aircraft_equipment?id=eq.{equipment_id}", key=SERVICE)
        if aircraft_id:
            http("DELETE", f"/rest/v1/user_aircraft?id=eq.{aircraft_id}", key=SERVICE)
        for u in (user, stranger):
            delete_user(u["id"])
        print("\n" + "=" * 66)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All aircraft/parts/reminders checks passed.")


if __name__ == "__main__":
    main()
    sys.exit(1 if FAILURES else 0)
