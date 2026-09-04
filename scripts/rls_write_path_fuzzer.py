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
    # 2026-08-29 "built but inert" sweep: synced_bookmarks writes no longer
    # go through a raw table INSERT at all -- push_bookmark/soft_delete_
    # bookmarks (SECURITY DEFINER RPCs) are the only write path now (see
    # migrations_fix_synced_bookmarks_read_write_grant_leak.sql), so A's
    # setup step below needs the RPC special-case in main()'s loop, not a
    # plain payload dict -- a raw POST would now correctly 403 before this
    # table's real B-vs-A checks (UPDATE/DELETE/SELECT against the raw
    # table, which remain valid regardless of how the row was created) ever
    # got to run, silently dropping coverage rather than reporting a false
    # failure. p_id is a real, deterministic string so it can double as
    # the id_col value below without reading it back from an RPC response
    # (push_bookmark RETURNS void).
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


# A cross-account read is not automatically a leak. Some rows are meant to
# be readable by other signed-in users, and reporting those as gaps every run
# is how a security check stops being read.
#
# The bar for being in here: the exposure must be DELIBERATE, gated on the
# user's own opt-out, and the opt-out must actually work -- which is asserted
# below rather than taken on trust, since an allowlist entry that is wrong is
# worse than no check at all.
INTENTIONALLY_READABLE = {
    ("user_streaks", "SELECT"):
        "Ready Room's leaderboard and the duel opponent list read other players' "
        "streaks. The policy is stats_visible = true, and RC set that default ON "
        "deliberately (2026-09-04: \"we want users to... be seen in the app, so "
        "default is on and they can turn off anytime\"). "
        "assert_optout_works() below proves turning it off hides the row.",
}


def assert_optout_works(a_id, b_token, results):
    """Every INTENTIONALLY_READABLE entry has to earn its place.

    Flipping stats_visible off must make A's row disappear for B completely.
    If it does not, the allowlist above is hiding a real leak rather than
    excusing an intended one, and this reports it as the failure it is.
    """
    mgmt_query("insert into user_streaks (user_id, stats_visible) values "
               f"('{a_id}', false) on conflict (user_id) do update set stats_visible = false")
    st, body = rest("GET", f"user_streaks?user_id=eq.{a_id}&select=user_id", b_token)
    hidden = st in (403, 404) or (isinstance(body, list) and len(body) == 0)
    print(f"[{'PASS' if hidden else 'FAIL'}] user_streaks opt-out: with stats_visible=false, "
          f"B sees nothing ({st})")
    results.append(("user_streaks", "SELECT opt-out", hidden))
    mgmt_query(f"update user_streaks set stats_visible = true where user_id = '{a_id}'")


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
        if table == "synced_bookmarks":
            # See TABLE_CONFIGS' own comment -- setup goes through the real
            # write RPC, not a raw POST (which the raw table no longer
            # grants at all). push_bookmark returns void, so row_id comes
            # from the p_id we chose, not the response body.
            rpc_payload = {
                "p_id": payload["id"], "p_document_number": payload["document_number"],
                "p_title": payload["title"], "p_date_issued": None, "p_office": None,
                "p_subject_series": None, "p_saved_at": payload["saved_at"],
                "p_item_type": "ac", "p_ac_id": None, "p_block_kind": None,
                "p_block_label": None, "p_block_snippet": None, "p_block_text": None,
            }
            status, body = rest("POST", "rpc/push_bookmark", a_token, rpc_payload)
            if status not in (200, 201, 204):
                print(f"[SETUP FAILED] {table}: A couldn't create own test row via push_bookmark ({status}) {body}")
                continue
            row_id = payload["id"]
        else:
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
        # Found live, 2026-08-29 sweep: unlike upd_blocked/del_blocked just
        # above, this never had the `sel_status in (403, 404)` branch --
        # every table checked here so far happened to block a stranger's
        # SELECT via RLS filtering the row out (200 + empty list), never via
        # a raw table-level grant denial (403), so the gap never surfaced.
        # synced_bookmarks is the first table in this suite closed entirely
        # at the GRANT level (no anon/authenticated SELECT on the raw table
        # at all -- see migrations_fix_synced_bookmarks_read_write_grant_
        # leak.sql), which correctly 403s ANY caller, not just a non-owner --
        # without this, that correct, stronger block would have been
        # reported as "B succeeded!", a false positive in the fuzzer's own
        # logic, not a real security gap.
        sel_blocked = sel_status in (403, 404) or (isinstance(sel_body, list) and len(sel_body) == 0)

        for op, blocked, raw_status in [("UPDATE", upd_blocked, upd_status), ("DELETE", del_blocked, del_status), ("SELECT", sel_blocked, sel_status)]:
            if not blocked and (table, op) in INTENTIONALLY_READABLE:
                print(f"[PASS (by design)] {table}.{op} -- {INTENTIONALLY_READABLE[(table, op)]}")
                results.append((table, op, True))
                continue
            status_str = "PASS (blocked)" if blocked else "FAIL (B succeeded!)"
            print(f"[{status_str}] {table}.{op} by non-owner B against A's row ({raw_status})")
            results.append((table, op, blocked))

    assert_optout_works(a_id, b_token, results)

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
