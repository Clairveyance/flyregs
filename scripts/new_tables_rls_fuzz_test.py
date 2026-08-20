#!/usr/bin/env python3
"""RLS write-path fuzz test for the 4 surfaces that changed on 2026-08-19
(feedback_submissions + feedback-attachments bucket, study_mastery_high_water,
document_citations) -- none of these fit rls_write_path_fuzzer.py's generic
"A owns a row, B attacks it" TABLE_CONFIGS shape, because each has a
deliberately non-standard access pattern:

  - feedback_submissions: INSERT-only for EVERYONE, including the owner --
    nobody can read their own submission back via the client.
  - feedback-attachments storage bucket: INSERT-only, no SELECT policy at
    all -- not even the uploader can read their own screenshot back.
  - study_mastery_high_water: zero client policies of any kind -- only
    ever touched by get_study_mastery()/get_mastery_leaderboard()
    (SECURITY DEFINER).
  - document_citations: public SELECT only -- writes only ever happen via
    the service-role sync scripts, which bypass RLS entirely.

This is a live, real-anon-key-client verification (disposable accounts,
never real users), not just a policy-text read. Every check should PASS
(block). Run manually -- not part of run_all_audits.sh (account-mutating,
same convention as rls_write_path_fuzzer.py).

Usage: python3 scripts/new_tables_rls_fuzz_test.py
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


APP_ENV = load_env(f"{BASE}/.env")
MGMT_ENV = load_env(f"{BASE}/.env.supabase-mgmt")
SCRAPER_ENV = load_env(f"{BASE}/.env.scraper")
SUPABASE_URL = APP_ENV["EXPO_PUBLIC_SUPABASE_URL"]
ANON_KEY = APP_ENV["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
SERVICE_KEY = SCRAPER_ENV["SUPABASE_SERVICE_KEY"]

RESULTS = []


def delete_storage_object(bucket, path):
    """Delete via the Storage API (service role), not raw SQL -- a plain
    `delete from storage.objects` 400s (the Storage API also needs to clean
    up the underlying object, not just the catalog row)."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/storage/v1/object/{bucket}",
        data=json.dumps({"prefixes": [path]}).encode(),
        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"},
        method="DELETE")
    try:
        urllib.request.urlopen(req)
    except Exception as e:
        print(f"  NOTE  storage cleanup failed (non-fatal): {str(e)[:200]}")


def mgmt_query(sql):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{MGMT_ENV['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {MGMT_ENV['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode())


def create_user(prefix):
    out = subprocess.run(["python3", f"{BASE}/scripts/disposable_test_user.py", "create", prefix],
                          capture_output=True, text=True, check=True).stdout
    fields = dict(line.split("=", 1) for line in out.strip().splitlines() if "=" in line)
    return fields["id"], fields["email"], fields["password"]


def delete_user(uid):
    subprocess.run(["python3", f"{BASE}/scripts/disposable_test_user.py", "delete", uid],
                    capture_output=True, text=True)


def mint(email, password):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read().decode())["access_token"]


def rest(method, path, token=None, body=None, extra_headers=None, raw=False):
    headers = {"apikey": ANON_KEY}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # else: no Authorization header at all -- matches what supabase-js
    # actually sends for a signed-out request under the new sb_publishable_
    # key format (which is NOT a valid JWT and breaks role resolution if
    # sent as a Bearer token -- confirmed live during this sweep: sending
    # `Authorization: Bearer <publishable key>` gets misresolved and RLS-
    # rejected, while omitting Authorization entirely correctly resolves
    # to the anon role). See PROJECT_NOTES/flyregs_pending.md 2026-08-19.
    if extra_headers:
        headers.update(extra_headers)
    if body is not None and not raw:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    else:
        data = body
    req = urllib.request.Request(f"{SUPABASE_URL}/{path}", data=data, headers=headers, method=method)
    try:
        resp = urllib.request.urlopen(req)
        out = resp.read()
        try:
            return resp.status, json.loads(out.decode())
        except Exception:
            return resp.status, out
    except urllib.error.HTTPError as e:
        out = e.read()
        try:
            return e.code, json.loads(out.decode())
        except Exception:
            return e.code, out.decode(errors="replace")[:300]


def check(label, cond, detail=""):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}" + (f"  -- {detail}" if detail and not cond else ""))
    RESULTS.append((label, cond, detail))
    return cond


def note(msg):
    print(f"  NOTE  {msg}")


def safe_mgmt_query(sql):
    try:
        return mgmt_query(sql)
    except Exception as e:
        note(f"cleanup query failed (non-fatal): {str(e)[:200]}")
        return None


def rpc(fn, token, params=None):
    return rest("POST", f"rest/v1/rpc/{fn}", token, params or {})


def main():
    print("Creating 2 disposable users (A, B)...")
    a_id, a_email, a_pw = create_user("newtblfuzza")
    b_id, b_email, b_pw = create_user("newtblfuzzb")
    a_tok = mint(a_email, a_pw)
    b_tok = mint(b_email, b_pw)
    print(f"  A={a_id[:8]}  B={b_id[:8]}\n")

    try:
        # ================= feedback_submissions =================
        print("--- feedback_submissions ---")
        # PLATFORM QUIRK found during this sweep (see PROJECT_NOTES/
        # flyregs_pending.md 2026-08-19 entry for the full diagnosis, done
        # via a scratch table + isolated policy experiments): a bare INSERT
        # (Prefer: return=minimal, PostgREST's default) into a table whose
        # policy has no clause that literally evaluates `using (true)`
        # works fine for both anon and authenticated. But INSERT ...
        # RETURNING (Prefer: return=representation -- what `.insert().
        # select()` sends) is REJECTED with a spurious RLS error on any
        # such policy, even ones with a trivially-true WITH CHECK and
        # regardless of role. Confirmed NOT specific to feedback_submissions
        # (reproduced on a disposable scratch table with `with check (true)`
        # and no matching using-true clause) and NOT a security regression
        # (USING(false) correctly still blocks SELECT/UPDATE/DELETE in
        # isolation) -- it's a live Postgres/PostgREST anomaly around
        # RETURNING + RLS that deserves a Supabase support ticket.
        # PRACTICAL IMPACT: NONE for the real app -- feedback.tsx (grep-
        # confirmed) calls plain `.insert({...})` with no `.select()`
        # chained, generates its own client-side id, and never asked for a
        # representation back, so it never hits this path. Send Feedback is
        # NOT currently broken for real users. The checks below exercise
        # the SAME call shape the app actually uses (no Prefer header) so
        # this test reflects real-world behavior, plus one annotated check
        # that intentionally reproduces the RETURNING quirk for tracking.
        st, body = rest("POST", "rest/v1/feedback_submissions", a_tok,
                         {"user_id": a_id, "user_email": a_email, "category": "bug",
                          "message": "fuzz-test row, safe to ignore"})
        check("A can insert own feedback (user_id = own uid), matching the app's real call shape (no .select())",
              st in (200, 201), f"{st} {body}")

        st, body = rest("POST", "rest/v1/feedback_submissions", a_tok,
                         {"user_id": a_id, "user_email": a_email, "category": "bug",
                          "message": "fuzz-test row with RETURNING"},
                         {"Prefer": "return=representation"})
        check("KNOWN PLATFORM QUIRK (not app-impacting, see comment above): INSERT+RETURNING on this policy shape",
              st in (200, 201), f"{st} {body}")
        row_id = body[0]["id"] if isinstance(body, list) and body else None

        st, body = rest("POST", "rest/v1/feedback_submissions", a_tok,
                         {"user_id": b_id, "user_email": a_email, "category": "bug",
                          "message": "spoofed user_id attempt"})
        check("A CANNOT insert feedback with a spoofed user_id = B", st >= 300, f"{st} {body}")

        # Anon (fully signed-out, no Authorization header at all -- matches
        # what supabase-js actually sends under the new sb_publishable_ key
        # format, which is NOT a valid JWT).
        st, body = rest("POST", "rest/v1/feedback_submissions", None,
                         {"user_email": "anon@example.com", "category": "bug", "message": "anon fuzz row"})
        check("Unauthenticated (anon) insert with user_id omitted succeeds (matches design: works signed-out)",
              st in (200, 201), f"{st} {body}")

        # Use whichever RETURNING-based insert produced a row id (the plain
        # inserts above succeeded but return no body) to exercise the
        # read/tamper checks below.
        probe_row_id = row_id
        if probe_row_id:
            st, body = rest("GET", f"rest/v1/feedback_submissions?id=eq.{probe_row_id}&select=*", a_tok)
            check("Nobody (incl. the submitter) can read a submitted row back (write-only by design)",
                  isinstance(body, list) and len(body) == 0, f"{st} {body}")

            st, body = rest("GET", f"rest/v1/feedback_submissions?id=eq.{probe_row_id}&select=*", b_tok)
            check("B cannot read the row", isinstance(body, list) and len(body) == 0, f"{st} {body}")

            st, body = rest("PATCH", f"rest/v1/feedback_submissions?id=eq.{probe_row_id}", b_tok,
                             {"message": "HACKED"}, {"Prefer": "return=representation"})
            check("B cannot UPDATE the row", st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

            st, body = rest("DELETE", f"rest/v1/feedback_submissions?id=eq.{probe_row_id}", b_tok, None,
                             {"Prefer": "return=representation"})
            check("B cannot DELETE the row", st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

            st, body = rest("DELETE", f"rest/v1/feedback_submissions?id=eq.{probe_row_id}", a_tok, None,
                             {"Prefer": "return=representation"})
            check("Nobody can DELETE the row, not even A (no delete policy for anyone, by design)",
                  st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")
        else:
            note("Neither authenticated nor anon insert produced a row id -- skipping read/tamper sub-checks")

        # ================= feedback-attachments bucket =================
        print("\n--- feedback-attachments storage bucket ---")
        obj_path = f"fuzztest/{a_id[:8]}.png"
        png_bytes = bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
            "53de0000000c4944415478da6360000002000155a55f070000000049454e44ae426082")
        st, body = rest("POST", f"storage/v1/object/feedback-attachments/{obj_path}", a_tok,
                         png_bytes, {"Content-Type": "image/png"}, raw=True)
        check("A can upload a screenshot to feedback-attachments", st in (200, 201), f"{st} {body}")

        st, body = rest("GET", f"storage/v1/object/feedback-attachments/{obj_path}", a_tok)
        check("A CANNOT read back their own uploaded screenshot (blind mail slot, by design)",
              st >= 300, f"{st} {str(body)[:150]}")

        st, body = rest("GET", f"storage/v1/object/feedback-attachments/{obj_path}", b_tok)
        check("B cannot read A's screenshot", st >= 300, f"{st} {str(body)[:150]}")

        st, body = rest("DELETE", f"storage/v1/object/feedback-attachments/{obj_path}", b_tok)
        check("B cannot delete A's screenshot", st >= 300, f"{st} {str(body)[:150]}")

        # cleanup via service role (mgmt SQL, storage.objects row + underlying object row)
        delete_storage_object("feedback-attachments", obj_path)

        # ================= study_mastery_high_water =================
        print("\n--- study_mastery_high_water ---")
        mgmt_query(f"insert into user_entitlements (user_id, is_pro, is_premium, is_unlocked) values ('{a_id}', true, false, false) on conflict (user_id) do update set is_pro = true")
        st, body = rpc("get_study_mastery", a_tok, {})
        check("A (Pro) can call get_study_mastery RPC (populates the ratchet row)", st == 200, f"{st} {body}")

        st, body = rest("GET", f"rest/v1/study_mastery_high_water?user_id=eq.{a_id}&select=*", a_tok)
        check("A CANNOT read their own high-water row directly via REST (RPC-only by design)",
              isinstance(body, list) and len(body) == 0, f"{st} {body}")

        st, body = rest("GET", f"rest/v1/study_mastery_high_water?user_id=eq.{a_id}&select=*", b_tok)
        check("B cannot read A's high-water row directly via REST", isinstance(body, list) and len(body) == 0, f"{st} {body}")

        st, body = rest("POST", "rest/v1/study_mastery_high_water", b_tok,
                         {"user_id": a_id, "item_type": "__all__", "best_pct": 100, "best_mastered": 9999},
                         {"Prefer": "return=representation"})
        check("B cannot forge-INSERT a fake 100% high-water row for A (no insert grant/policy)",
              st >= 300, f"{st} {body}")

        st, body = rest("PATCH", f"rest/v1/study_mastery_high_water?user_id=eq.{a_id}", b_tok,
                         {"best_pct": 100}, {"Prefer": "return=representation"})
        check("B cannot UPDATE A's high-water row to inflate it", st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

        # sanity check via mgmt (service role, ground truth) that a real row exists and wasn't tampered
        rows = mgmt_query(f"select best_pct from study_mastery_high_water where user_id = '{a_id}' and item_type = '__all__'")
        check("Ground truth: A's real high-water row exists and best_pct != 100 (B's forgery attempts had no effect)",
              isinstance(rows, list) and len(rows) == 1 and rows[0]["best_pct"] != 100, str(rows))

        # ================= document_citations =================
        print("\n--- document_citations ---")
        # The client NEVER queries the raw table directly (confirmed via
        # grep -rn "from('document_citations')" src/ -- zero hits); every
        # screen (far/[id].tsx, ac/[id].tsx, etc.) reads document_citations_
        # gated instead, a view with its own proper grants. The raw table
        # intentionally has no SELECT grant for anon/authenticated at all
        # (REFERENCES/TRIGGER only) -- that's correct-by-design, not a gap,
        # so check the actual client-facing surface instead.
        st, body = rest("GET", "rest/v1/document_citations_gated?limit=1&select=*", a_tok)
        check("Public SELECT on document_citations_gated (the real client read path) works",
              st == 200 and isinstance(body, list) and len(body) == 1, f"{st} {body}")

        st, body = rest("GET", "rest/v1/document_citations?limit=1&select=*", a_tok)
        check("Raw document_citations table correctly has NO client SELECT access (by design -- clients use the _gated view)",
              st >= 300, f"{st} {body}")

        st, body = rest("POST", "rest/v1/document_citations", a_tok,
                         {"citing_type": "far", "citing_id": "FUZZ.1", "cited_type": "far", "cited_id": "FUZZ.2", "label": None},
                         {"Prefer": "return=representation"})
        check("Authenticated client CANNOT INSERT into document_citations (server/sync-only)",
              st >= 300, f"{st} {body}")

        if isinstance(body, list) and body:
            # shouldn't happen, but clean up if the insert somehow succeeded
            mgmt_query("delete from document_citations where citing_id = 'FUZZ.1' and citing_type = 'far'")

        # find one real row to attack for update/delete
        rows = mgmt_query("select citing_type, citing_id, cited_type, cited_id from document_citations limit 1")
        if isinstance(rows, list) and rows:
            r = rows[0]
            filt = (f"citing_type=eq.{r['citing_type']}&citing_id=eq.{urllib.parse.quote(r['citing_id'])}"
                    f"&cited_type=eq.{r['cited_type']}&cited_id=eq.{urllib.parse.quote(r['cited_id'])}")
            st, body = rest("DELETE", f"rest/v1/document_citations?{filt}", a_tok, None, {"Prefer": "return=representation"})
            check("Authenticated client CANNOT DELETE a real document_citations row",
                  st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

            st, body = rest("PATCH", f"rest/v1/document_citations?{filt}", a_tok, {"label": "HACKED"}, {"Prefer": "return=representation"})
            check("Authenticated client CANNOT UPDATE a real document_citations row",
                  st >= 300 or (isinstance(body, list) and len(body) == 0), f"{st} {body}")

    finally:
        print("\nCleaning up...")
        safe_mgmt_query(f"delete from feedback_submissions where user_email in ('{a_email}', 'anon@example.com') or user_id in ('{a_id}','{b_id}')")
        safe_mgmt_query(f"delete from study_mastery_high_water where user_id in ('{a_id}','{b_id}')")
        delete_user(a_id)
        delete_user(b_id)

    print(f"\n{'='*60}")
    failures = [r for r in RESULTS if not r[1]]
    print(f"{len(RESULTS) - len(failures)}/{len(RESULTS)} checks passed")
    if failures:
        print(f"\n{len(failures)} REAL GAP(S) FOUND:")
        for label, _, detail in failures:
            print(f"  - {label}  ({detail})")
        sys.exit(1)
    print("No gaps found across feedback_submissions, feedback-attachments, study_mastery_high_water, document_citations.")


if __name__ == "__main__":
    import urllib.parse
    main()
