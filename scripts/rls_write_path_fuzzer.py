#!/usr/bin/env python3
"""Systematic RLS write-path check: for each configured user-owned table,
User A creates a row they legitimately own, then User B (a different real
account, zero relationship to A) attempts UPDATE, DELETE, and a targeted
SELECT against that specific row. Every one of those should be blocked --
any that succeed are a real cross-account write/read gap.

Every other RLS gap found this project (folder cap bypass, aircraft cap
bypass, collaborator self-escalation, etc.) was found manually, one at a
time, by whoever happened to be looking at that specific feature. This is
meant to be the standing, re-runnable version of that same check instead
of relying on it being reinvented by hand each time.

SAFE BY DESIGN: never touches a real user's data. Both accounts are fresh
disposable test users (scripts/disposable_test_user.py's pattern) created
at the start of the run and deleted at the end -- if RLS is actually
broken and B's write succeeds, the only thing that gets modified is A's
own throwaway test row, not anything belonging to a real person.

Extensible: TABLE_CONFIGS below is a list of (table, minimal insert
payload template, id column). Add an entry for any other user-owned table
that should be covered -- there's no way to make row construction fully
generic across arbitrary schemas without per-table knowledge of required
columns and their valid shapes, so this is a curated list, not a scan of
every table in the database. See scripts/tier_gate_audit.mjs and
scripts/magiclink_audit.py for this project's other standing audits;
run_all_audits.sh chains all of them together.

Usage: python3 scripts/rls_write_path_fuzzer.py
"""
import datetime
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"
env = {}
with open(f"{BASE}/.env") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        env[k] = v.strip('"')
SUPABASE_URL = env["EXPO_PUBLIC_SUPABASE_URL"]
ANON_KEY = env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]

mgmt_env = {}
with open(f"{BASE}/.env.supabase-mgmt") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        mgmt_env[k] = v


def mgmt_query(sql):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{mgmt_env['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {mgmt_env['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode())


def create_disposable_user(prefix):
    out = subprocess.run(
        ["python3", f"{BASE}/scripts/disposable_test_user.py", "create", prefix],
        capture_output=True, text=True, check=True,
    ).stdout
    fields = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
    return fields["id"], fields["email"], fields["password"]


def delete_disposable_user(uid):
    subprocess.run(["python3", f"{BASE}/scripts/disposable_test_user.py", "delete", uid],
                    capture_output=True, text=True)


def mint_session(email, password):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode())["access_token"]


def rest(method, path, token, body=None, extra_headers=None):
    headers = {"apikey": ANON_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1/{path}",
                                  data=json.dumps(body).encode() if body is not None else None,
                                  headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req)
        body_out = resp.read().decode()
        return resp.status, (json.loads(body_out) if body_out else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


NOW = datetime.datetime.now(datetime.timezone.utc).isoformat()

# (table, id_column, insert_payload_fn(uid, created_ids), update_payload)
# insert_payload_fn always receives created_ids (a {table: row_id} map of
# everything already set up earlier in the list this run) so a later entry
# can depend on an earlier one's FK -- e.g. user_aircraft_reminders needs a
# real user_aircraft_id, so user_aircraft is listed first and its id is
# available by the time the reminder's lambda runs.
TABLE_CONFIGS = [
    ("user_aircraft", "id",
     lambda uid, ids: {"user_id": uid, "make": "FuzzTest", "model": "X1"},
     {"model": "HACKED"}),
    ("synced_folders", "id",
     lambda uid, ids: {"id": f"fuzz-folder-{uid[:8]}", "user_id": uid, "name": "Fuzz",
                        "created_at": NOW, "updated_at": NOW},
     {"name": "HACKED"}),
    ("synced_notes", "id",
     lambda uid, ids: {"id": f"fuzz-note-{uid[:8]}", "user_id": uid, "title": "Fuzz",
                        "body": "test", "updated_at": NOW},
     {"title": "HACKED"}),
    ("synced_bookmarks", "id",
     lambda uid, ids: {"id": f"fuzz-bm-{uid[:8]}", "user_id": uid,
                        "document_number": "FUZZ-1", "title": "Fuzz", "saved_at": NOW},
     {"title": "HACKED"}),
    ("push_tokens", "user_id",
     lambda uid, ids: {"user_id": uid, "expo_push_token": f"ExponentPushToken[fuzz-{uid[:8]}]"},
     {"enabled": False}),
    ("user_streaks", "user_id",
     lambda uid, ids: {"user_id": uid},
     {"leaderboard_opt_in": True}),
    ("user_aircraft_reminders", "id",
     lambda uid, ids: {"user_id": uid, "user_aircraft_id": ids["user_aircraft"],
                        "title": "Fuzz reminder", "due_date": "2027-01-01"},
     {"title": "HACKED"}),
]


def main():
    print("Creating 2 disposable test users (A owns the data, B attempts cross-account writes)...")
    a_id, a_email, a_pw = create_disposable_user("rlsfuzza")
    b_id, b_email, b_pw = create_disposable_user("rlsfuzzb")
    a_token = mint_session(a_email, a_pw)
    b_token = mint_session(b_email, b_pw)
    print(f"  A={a_id[:8]}  B={b_id[:8]}")

    # Several configured tables (folders, notes, bookmarks) require at
    # least Pro to write at all -- grant it to A so setup can reach the
    # actual write-path check, not fail before getting there. B stays at
    # zero entitlement throughout: the check is "can a stranger touch A's
    # row," not "does B also need Pro," and a real attacker wouldn't need
    # a paid account to attempt a raw REST call either.
    mgmt_query(f"insert into user_entitlements (user_id, is_pro, is_premium, is_unlocked) values ('{a_id}', true, false, false) on conflict (user_id) do update set is_pro = true")
    print(f"  Granted A a Pro entitlement so folder/note/bookmark setup can proceed.\n")

    results = []
    cleanup = []  # (table, id_col, id_value) to delete via service-role at the end
    created_ids = {}  # table -> row_id, for later entries' FK dependencies

    for table, id_col, payload_fn, update_payload in TABLE_CONFIGS:
        payload = payload_fn(a_id, created_ids)
        status, body = rest("POST", table, a_token, payload, {"Prefer": "return=representation"})
        if status not in (200, 201):
            print(f"[SETUP FAILED] {table}: A couldn't create own test row ({status}) {body}")
            continue
        row_id = body[0][id_col] if isinstance(body, list) and body else payload.get(id_col, a_id)
        created_ids[table] = row_id
        cleanup.append((table, id_col, row_id))

        # B attempts UPDATE on A's row
        upd_status, upd_body = rest("PATCH", f"{table}?{id_col}=eq.{row_id}", b_token,
                                     update_payload, {"Prefer": "return=representation"})
        upd_blocked = upd_status in (403, 404) or (isinstance(upd_body, list) and len(upd_body) == 0)

        # B attempts DELETE on A's row
        del_status, del_body = rest("DELETE", f"{table}?{id_col}=eq.{row_id}", b_token, None,
                                     {"Prefer": "return=representation"})
        del_blocked = del_status in (403, 404) or (isinstance(del_body, list) and len(del_body) == 0)

        # B attempts to SELECT A's specific row by id
        sel_status, sel_body = rest("GET", f"{table}?{id_col}=eq.{row_id}&select=*", b_token)
        sel_blocked = isinstance(sel_body, list) and len(sel_body) == 0

        for op, blocked, raw_status in [("UPDATE", upd_blocked, upd_status), ("DELETE", del_blocked, del_status), ("SELECT", sel_blocked, sel_status)]:
            status_str = "PASS (blocked)" if blocked else "FAIL (B succeeded!)"
            print(f"[{status_str}] {table}.{op} by non-owner B against A's row ({raw_status})")
            results.append((table, op, blocked))

    print("\nCleaning up test data...")
    for table, id_col, row_id in cleanup:
        mgmt_query(f"delete from {table} where {id_col} = " + (f"'{row_id}'" if isinstance(row_id, str) else str(row_id)))
    delete_disposable_user(a_id)
    delete_disposable_user(b_id)

    failures = [(t, op) for t, op, blocked in results if not blocked]
    print(f"\n{'='*60}")
    print(f"{len(results) - len(failures)}/{len(results)} checks passed (write correctly blocked)")
    if failures:
        print(f"\n{len(failures)} REAL GAPS FOUND:")
        for t, op in failures:
            print(f"  - {t}.{op}: non-owner succeeded against another user's row")
        sys.exit(1)
    else:
        print("No cross-account write/read gaps found in the configured tables.")


if __name__ == "__main__":
    main()
