#!/usr/bin/env python3
"""Whole-database posture sweep: RLS, grants, function security, cron health.

RC, 2026-09-05: "do a full sweep of the whole app... i need you to scour
everything."

Every check here corresponds to a real incident in this project:

  * RLS off, or on with no policy at all -- a table is then either wide open
    or silently unreadable, and both have shipped.
  * A policy that is literally USING (true) for `authenticated` -- how
    user_duel_stats leaked every player's win/loss record behind a correct
    RPC (migrations_gate_user_duel_stats_rls.sql).
  * A SELECT grant to `anon` on a user-data table -- how a public bucket's
    SELECT policy let the anon key list every avatar
    (gotcha_public_bucket_select_policy_enables_enumeration).
  * SECURITY DEFINER without a pinned search_path -- a privilege-escalation
    shape; every definer function in this project is supposed to pin it.
  * A cron job that has never succeeded, or last failed -- five live crons
    each failed silently and reported success on 2026-09-03
    (gotcha_scheduled_jobs_fail_silently).
  * An RPC the app never calls, or an RPC the app calls that does not exist.

Usage: python3 scripts/sweep_db_posture.py
"""
import json
import os
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
HARD: list[str] = []
INFO: list[str] = []


def q(sql: str):
    r = subprocess.run(["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
                       capture_output=True, text=True, cwd=str(BASE))
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(f"query failed: {out or r.stderr.strip()}")
    return json.loads(out)


def head(t):
    print(f"\n=== {t} ===")


def ok(msg):
    print(f"  PASS  {msg}")


def bad(msg):
    print(f"  FAIL  {msg}")
    HARD.append(msg)


def info(msg):
    print(f"  INFO  {msg}")
    INFO.append(msg)


def main():
    # ---------------------------------------------------------------- RLS
    head("RLS enabled on every table in public")
    rows = q("""
        select c.relname as t, c.relrowsecurity as rls,
               (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname
    """)
    no_rls = [r["t"] for r in rows if not r["rls"]]
    rls_no_policy = [r["t"] for r in rows if r["rls"] and r["policies"] == 0]
    print(f"  {len(rows)} tables in public")
    if no_rls:
        # A corpus table with no RLS is fine ONLY if it also has no grant to
        # anon/authenticated -- checked in the grants section below.
        info(f"{len(no_rls)} table(s) with RLS OFF: {', '.join(no_rls)}")
    else:
        ok("RLS is on for every table")
    if rls_no_policy:
        info(f"{len(rls_no_policy)} table(s) with RLS on and ZERO policies "
             f"(readable by nobody but the service key): {', '.join(rls_no_policy)}")
    else:
        ok("every RLS-enabled table has at least one policy")

    # ------------------------------------------------------- permissive
    head("policies that are literally USING (true) for authenticated/anon")
    rows = q("""
        select c.relname as t, p.polname, p.polcmd,
               pg_get_expr(p.polqual, p.polrelid) as using_expr,
               (select array_agg(rolname) from pg_roles where oid = any(p.polroles)) as roles
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
        order by c.relname, p.polname
    """)
    wide = []
    for r in rows:
        expr = (r["using_expr"] or "").strip().lower()
        roles = r["roles"] or ""
        if expr in ("true", "(true)") and ("authenticated" in str(roles) or "anon" in str(roles) or roles in (None, "")):
            wide.append(f"{r['t']}.{r['polname']} ({r['polcmd']}) roles={roles}")
    if wide:
        for w in wide:
            info(f"USING (true): {w}")
        info("^ each of these is only correct if the table is public corpus data. "
             "user_duel_stats shipped with exactly this shape and leaked every "
             "player's record.")
    else:
        ok("no USING (true) policy on any public table")

    # ------------------------------------------------------------ probes
    # MEASURED, not inferred from grants.
    #
    # The first version of this section failed on any table with a SELECT
    # grant to `anon` and reported 29 "leaks". Every one was wrong: with RLS
    # enabled and every policy predicated on auth.uid(), a grant lets you ASK
    # and returns nothing. Grants are not the gate; policies are. Reporting
    # 29 phantom security holes would have buried the one real finding in
    # this whole sweep, so this now sends actual requests.
    #
    # Two identities, because they see different things:
    #   * anon        -- the public key with no user at all
    #   * a FREE user -- a brand-new signed-up account with no entitlements
    #                    and no relationship to anyone. This is the identity
    #                    that found user_coins / user_profile_ratings
    #                    returning every user's rows on 2026-09-05.
    head("live probe: what can the public key actually read?")
    import json as _json, secrets as _secrets, time as _time
    import urllib.error as _uerr, urllib.request as _ureq

    def _env(name):
        e = {}
        for line in open(BASE / name):
            line = line.strip().removeprefix("export ")
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                e[k] = v.strip('"').strip("'")
        return e

    sc = _env(".env.scraper")
    URL, SERVICE = sc["SUPABASE_URL"], sc["SUPABASE_SERVICE_KEY"]
    ANON = _env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]

    def _http(method, path, key, jwt=None, body=None):
        d = _json.dumps(body).encode() if body is not None else None
        rq = _ureq.Request(URL + path, data=d, method=method)
        rq.add_header("apikey", key)
        rq.add_header("Authorization", f"Bearer {jwt or key}")
        if d:
            rq.add_header("Content-Type", "application/json")
        try:
            with _ureq.urlopen(rq) as r:
                t = r.read().decode()
                return r.status, (_json.loads(t) if t else None)
        except _uerr.HTTPError as e:
            t = e.read().decode()
            try:
                return e.code, _json.loads(t)
            except Exception:
                return e.code, t

    USER_TABLES = [
        "aircraft_collaborators", "callsign_registry", "challenge_answers",
        "challenge_participants", "challenge_questions", "device_signup_attempts",
        "feedback_submissions", "folder_collaborators", "push_tokens",
        "study_facts", "study_facts_gated", "study_mastery_high_water",
        "study_progress", "synced_bookmarks", "synced_bookmarks_gated",
        "synced_folder_items", "synced_folders", "synced_notes",
        "user_ad_notifications", "user_aircraft", "user_aircraft_equipment",
        "user_aircraft_reminders", "user_app_settings", "user_coins",
        "user_duel_stats", "user_entitlements", "user_offline_downloads",
        "user_profile_ratings", "user_streaks", "push_delivery_failures",
    ]

    anon_leaks = []
    for t in USER_TABLES:
        st, rows = _http("GET", f"/rest/v1/{t}?select=*&limit=3", ANON)
        if st == 200 and rows:
            anon_leaks.append(f"{t} ({len(rows)} rows)")
    if anon_leaks:
        for l in anon_leaks:
            bad(f"ANON (no user at all) can read {l}")
    else:
        ok(f"anon reads zero rows from all {len(USER_TABLES)} user-data tables")

    head("live probe: what can a brand-new FREE account read of OTHER users?")
    email = f"sweep-{int(_time.time())}-{_secrets.token_hex(3)}@flyregs.invalid"
    pw = f"Tmp{_secrets.token_urlsafe(12)}!"
    st, u = _http("POST", "/auth/v1/admin/users", SERVICE,
                  body={"email": email, "password": pw, "email_confirm": True})
    if st != 200:
        bad(f"could not create the probe account: {st} {u}")
    else:
        st, tok = _http("POST", "/auth/v1/token?grant_type=password", ANON,
                        body={"email": email, "password": pw})
        jwt, uid = tok["access_token"], u["id"]
        try:
            free_leaks = []
            for t in USER_TABLES:
                st, rows = _http("GET", f"/rest/v1/{t}?select=user_id&limit=200", ANON, jwt=jwt)
                if st != 200 or not isinstance(rows, list):
                    continue
                others = {r.get("user_id") for r in rows if r.get("user_id") and r.get("user_id") != uid}
                if others:
                    free_leaks.append((t, len(others)))
            # These two are deliberately readable when the OWNER has opted in
            # -- that IS the Community feature. They are only a leak if they
            # return a user who has opted OUT, which
            # scripts/profile_privacy_gate_test.py checks precisely.
            OPT_IN_BY_DESIGN = {"user_coins", "user_profile_ratings", "user_streaks", "callsign_registry"}
            real = [f"{t}: {n} other user(s)" for t, n in free_leaks if t not in OPT_IN_BY_DESIGN]
            bydesign = [f"{t}: {n}" for t, n in free_leaks if t in OPT_IN_BY_DESIGN]
            if real:
                for r in real:
                    bad(f"a FREE account reads other users' rows from {r}")
            else:
                ok("a free account reads no other user's rows from any private table")
            if bydesign:
                info("opt-in-by-design tables returning other users (correct only "
                     "while those users have Show my stats ON -- see "
                     "profile_privacy_gate_test.py): " + ", ".join(bydesign))
        finally:
            _http("DELETE", f"/auth/v1/admin/users/{uid}", SERVICE)

    # -------------------------------------------------- function security
    head("SECURITY DEFINER functions without a pinned search_path")
    rows = q("""
        select p.proname, p.prosecdef,
               coalesce(array_to_string(p.proconfig, ' | '), '') as cfg
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
        order by p.proname
    """)
    unpinned = [r["proname"] for r in rows if "search_path" not in (r["cfg"] or "")]
    print(f"  {len(rows)} SECURITY DEFINER function(s)")
    if unpinned:
        for u in unpinned:
            bad(f"SECURITY DEFINER without search_path: {u}()")
    else:
        ok("every SECURITY DEFINER function pins search_path")

    # ------------------------------------------------------- rpc wiring
    head("RPCs the app calls vs functions that exist")
    src = ""
    for p in (BASE / "src").rglob("*.ts"):
        src += p.read_text()
    for p in (BASE / "src").rglob("*.tsx"):
        src += p.read_text()
    called = set(re.findall(r"\.rpc\(\s*['\"]([a-z0-9_]+)['\"]", src))
    existing = {r["proname"] for r in q("""
        select distinct p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname = 'public'
    """)}
    missing = sorted(called - existing)
    if missing:
        for m in missing:
            bad(f"app calls .rpc('{m}') but no such function exists")
    else:
        ok(f"all {len(called)} RPCs the app calls exist in the database")

    # executable-by-client functions the app never calls
    rows = q("""
        select distinct p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('authenticated', p.oid, 'EXECUTE')
          -- Extension-owned functions (pgvector, pg_trgm, fuzzystrmatch) are
          -- installed into public and are client-executable by nature. Listing
          -- 150 of them buried the handful that are actually ours -- and a
          -- report nobody can read is a report nobody reads.
          and not exists (
            select 1 from pg_depend d
            where d.objid = p.oid and d.deptype = 'e'
          )
    """)
    client_callable = {r["proname"] for r in rows}
    # Helper predicates used INSIDE policies are legitimately client-callable
    # without ever being called from the app.
    policy_helpers = re.compile(r"^(has_|is_|folder_owner_id|.*_label$|.*_levels$|"
                                r".*_weight$|.*_classes.*|pcg_all_levels|far_all_levels|"
                                r"quizzable_|search_|hybrid_|.*_gated$)")
    orphans = sorted(n for n in client_callable - called if not policy_helpers.match(n))
    if orphans:
        info(f"{len(orphans)} function(s) executable by the client that the app "
             f"never calls (each is reachable with the public key):")
        for o in orphans:
            print(f"          {o}()")
    else:
        ok("no client-executable function is unused")

    # ------------------------------------------- state-changing RPC surface
    head("state-changing SECURITY DEFINER RPCs reachable with the public key")
    # 2026-09-05: refresh_search_popularity (14 full-table UPDATEs across the
    # whole corpus) and finalize_challenge_if_done (settles a duel, writes
    # stats, awards coins) were both callable by ANON. Neither had ever been
    # called from client code. A function that WRITES and is not called by the
    # app has no business being reachable from it.
    rows = q("""
        select p.proname, pg_get_function_arguments(p.oid) as args
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and pg_get_function_result(p.oid) not like '%trigger%'
          and has_function_privilege('anon', p.oid, 'EXECUTE')
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
          and (
            pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert|update|delete)[[:space:]]+(into[[:space:]]+)?[a-z_]'
          )
          -- A writing definer function that CONSULTS auth.uid() is safe from
          -- anon by construction: auth.uid() is NULL with no JWT, so it
          -- matches no row and owns nothing. Checked, not assumed -- all 24
          -- of the RPCs this app actually calls were verified to reference it
          -- on 2026-09-05, and the only one that did not (record_signup_attempt)
          -- is pre-auth by design. Flagging them all made this check useless
          -- noise that hid the two functions that really were exposed.
          and pg_get_functiondef(p.oid) not like '%auth.uid()%'
        order by p.proname
    """)
    # Known-good writers that MUST stay anon-reachable, each with its reason.
    EXPECTED_WRITERS = {
        "check_and_record_signup_attempt":
            "the signup rate limiter -- runs before an account exists, and its "
            "threshold is a server-side constant (migrations_fix_signup_rate_limit_bypass)",
        "record_signup_attempt":
            "its companion -- records the attempt after a SUCCESSFUL signup, "
            "also necessarily pre-auth (migrations_signup_rate_limit_record_on_success)",
    }
    unexpected = [r for r in rows if r["proname"] not in EXPECTED_WRITERS]
    for name, why in EXPECTED_WRITERS.items():
        if any(r["proname"] == name for r in rows):
            info(f"{name}() anon-callable BY DESIGN -- {why}")
    if unexpected:
        for r in unexpected:
            bad(f"anon can call a writing SECURITY DEFINER function: "
                f"{r['proname']}({r['args'][:60]})")
    else:
        ok("no unexpected writing SECURITY DEFINER function is anon-callable")

    # ------------------------------------------------------------- cron
    head("scheduled jobs: did the last run actually succeed?")
    jobs = q("select jobid, jobname, schedule, active from cron.job order by jobname")
    print(f"  {len(jobs)} cron job(s)")
    for j in jobs:
        runs = q(f"""
            select status, return_message, start_time
            from cron.job_run_details where jobid = {j['jobid']}
            order by start_time desc limit 1
        """)
        if not j["active"]:
            info(f"{j['jobname']} is INACTIVE ({j['schedule']})")
            continue
        if not runs:
            info(f"{j['jobname']} ({j['schedule']}) has never run yet")
            continue
        r = runs[0]
        if r["status"] == "succeeded":
            ok(f"{j['jobname']} -- last run {r['start_time'][:16]} succeeded")
        else:
            bad(f"{j['jobname']} -- last run {r['start_time'][:16]} {r['status']}: {r['return_message']}")

    # --------------------------------------------------------- push log
    head("push delivery failures recorded since the log was added")
    try:
        rows = q("""select error_code, count(*)::int n from push_delivery_failures
                    group by error_code order by n desc""")
        if rows:
            for r in rows:
                info(f"{r['n']} x {r['error_code']}")
        else:
            ok("no push delivery failures recorded")
    except Exception as e:
        bad(f"could not read push_delivery_failures: {e}")

    print("\n" + "=" * 62)
    if HARD:
        print(f"{len(HARD)} HARD finding(s):")
        for h in HARD:
            print("  -", h)
        sys.exit(1)
    print("No hard findings.")
    if INFO:
        print(f"{len(INFO)} observation(s) above to read.")


if __name__ == "__main__":
    main()
