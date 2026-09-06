#!/usr/bin/env python3
"""Orphans, drift and slow queries -- the server-side classes nothing else checks.

RC, 2026-09-06: "let's do another full app sweep... i'd like to find them
before cutting B41."

The other sweeps cover access control, silent failures, error states,
promises and lifecycle leaks. None of them look at whether the DATA is
internally consistent, whether the migration files still describe the live
schema, or whether anything is quietly slow. Each section here is a real
failure mode this project has already had at least once.

  1. ORPHANS -- a folder item pointing at a bookmark that no longer exists
     renders as nothing, for everyone, with no error. That is precisely the
     2026-08-29 shared-folder incident.
  2. SCHEMA DRIFT -- migrations in sync/ are applied by hand here, so a file
     can describe a policy or column the live database does not have (see
     gotcha_migration_files_drift_from_live_db).
  3. SLOW QUERIES -- pg_stat_statements, ranked by total time. search_far
     once burned 830ms-1.5s per call on an uncapped correlated SubPlan.
  4. MISSING INDEXES -- a foreign key with no index behind it turns every
     cascade and every join into a sequential scan as the table grows.
  5. TABLE BLOAT / SIZE -- what is actually consuming the 1.5 GB.

Usage: python3 scripts/sweep_data_integrity.py
"""
import json
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HARD, INFO = [], []


def q(sql):
    r = subprocess.run(["python3", os.path.join(BASE, "scripts", "supabase_mgmt_api.py"), "query", sql],
                       capture_output=True, text=True, cwd=BASE)
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def head(t):
    print(f"\n=== {t} ===")


def ok(m):
    print(f"  PASS  {m}")


def bad(m):
    print(f"  FAIL  {m}")
    HARD.append(m)


def info(m):
    print(f"  INFO  {m}")
    INFO.append(m)


def main():
    # ---------------------------------------------------------- 1. orphans
    head("orphaned rows -- pointers to things that no longer exist")
    checks = [
        ("folder items whose folder is gone",
         """select count(*)::int n from synced_folder_items sfi
            where sfi.deleted = false
              and not exists (select 1 from synced_folders f where f.id = sfi.folder_id)"""),
        ("folder items pointing at a deleted bookmark",
         """select count(*)::int n from synced_folder_items sfi
            where sfi.deleted = false and sfi.item_type <> 'note'
              and exists (select 1 from synced_bookmarks b
                          where b.id = sfi.item_id and b.deleted = true)"""),
        ("folder items pointing at a deleted note",
         """select count(*)::int n from synced_folder_items sfi
            where sfi.deleted = false and sfi.item_type = 'note'
              and exists (select 1 from synced_notes nt
                          where nt.id = sfi.item_id and nt.deleted = true)"""),
        ("collaborators on a folder that no longer exists",
         """select count(*)::int n from folder_collaborators fc
            where not exists (select 1 from synced_folders f where f.id = fc.folder_id)"""),
        ("collaborators on an aircraft that no longer exists",
         """select count(*)::int n from aircraft_collaborators ac
            where not exists (select 1 from user_aircraft a where a.id = ac.aircraft_id)"""),
        ("AD notifications for an aircraft that is gone",
         """select count(*)::int n from user_ad_notifications un
            where not exists (select 1 from user_aircraft a where a.id = un.user_aircraft_id)"""),
        ("reminders for an aircraft that is gone",
         """select count(*)::int n from user_aircraft_reminders r
            where not exists (select 1 from user_aircraft a where a.id = r.user_aircraft_id)"""),
        ("equipment on an aircraft that is gone",
         """select count(*)::int n from user_aircraft_equipment e
            where not exists (select 1 from user_aircraft a where a.id = e.user_aircraft_id)"""),
        ("challenge participants with no challenge",
         """select count(*)::int n from challenge_participants cp
            where not exists (select 1 from challenges c where c.id = cp.challenge_id)"""),
        ("push tokens for a deleted user",
         """select count(*)::int n from push_tokens p
            where not exists (select 1 from auth.users u where u.id = p.user_id)"""),
        ("document_citations pointing at a FAR section that does not exist",
         """select count(*)::int n from document_citations dc
            where dc.cited_type = 'far'
              and not exists (select 1 from far_sections s where s.section_number = dc.cited_id)"""),
        # cited_id holds the DOCUMENT NUMBER ("00-34B"), not the uuid. The
        # first version of this check compared it to advisory_circulars.id::text
        # and reported 3,670 orphans -- every AC citation in the database.
        # Verified by reading three rows before believing the number.
        ("document_citations pointing at an AC that does not exist",
         """select count(*)::int n from document_citations dc
            where dc.cited_type = 'ac'
              and not exists (select 1 from advisory_circulars a
                              where a.document_number = dc.cited_id)"""),
    ]
    for label, sql in checks:
        try:
            n = q(sql)[0]["n"]
        except Exception as e:
            info(f"could not check {label}: {str(e)[:90]}")
            continue
        if n:
            # An orphan is not automatically a bug -- some are expected (a
            # citation to a cancelled AC, say). Report the count and let the
            # reader judge; only flag the ones that break a live feature.
            if "citations" in label:
                info(f"{n} {label}")
            else:
                bad(f"{n} {label}")
        else:
            ok(f"no {label}")

    # ------------------------------------------------------ 2. schema drift
    head("migration files that describe something the live database lacks")
    import pathlib
    import re
    missing = []
    for f in sorted(pathlib.Path(BASE, "sync").glob("migrations_*.sql")):
        text = f.read_text()
        for m in re.finditer(r"create policy\s+(\w+)\s+on\s+([\w.]+)", text, re.I):
            pol, tbl = m.group(1), m.group(2).split(".")[-1]
            try:
                rows = q(f"""select count(*)::int n from pg_policy p
                             join pg_class c on c.oid = p.polrelid
                             where p.polname = '{pol}' and c.relname = '{tbl}'""")
            except Exception:
                continue
            if rows[0]["n"] == 0:
                missing.append(f"{f.name}: policy {pol} on {tbl}")
    if missing:
        # A file can legitimately create a policy a LATER file replaces, so
        # this is INFO -- but a long list means the files no longer describe
        # the database, which is how a "fix" gets written twice.
        info(f"{len(missing)} policy(ies) named in sync/*.sql but not present live:")
        for m in missing[:20]:
            print(f"          {m}")
    else:
        ok("every policy created in sync/*.sql exists in the live database")

    # ------------------------------------------------------ 3. slow queries
    head("slowest statements by total time (pg_stat_statements)")
    try:
        rows = q("""select left(regexp_replace(query, '\\s+', ' ', 'g'), 88) as q,
                           calls, round(mean_exec_time::numeric, 1) as mean_ms,
                           round(total_exec_time::numeric / 1000, 1) as total_s
                    from pg_stat_statements
                    where query not ilike '%pg_stat_statements%'
                      and query not ilike '%information_schema%'
                    order by total_exec_time desc limit 10""")
        for r in rows:
            flag = "  <-- slow per call" if r["mean_ms"] and float(r["mean_ms"]) > 400 else ""
            print(f"  {str(r['mean_ms']):>8} ms x {str(r['calls']):>7} = {str(r['total_s']):>7}s   {r['q']}{flag}")
            if r["mean_ms"] and float(r["mean_ms"]) > 400 and r["calls"] and int(r["calls"]) > 20:
                info(f"slow+frequent: {r['q'][:60]} ({r['mean_ms']}ms x {r['calls']})")
    except Exception as e:
        info(f"pg_stat_statements unavailable: {str(e)[:90]}")

    # --------------------------------------------------- 4. missing indexes
    head("foreign keys with no index behind them")
    try:
        rows = q("""
            select c.conrelid::regclass::text as tbl, a.attname as col
            from pg_constraint c
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
            join pg_class cl on cl.oid = c.conrelid
            join pg_namespace n on n.oid = cl.relnamespace
            where c.contype = 'f' and n.nspname = 'public'
              and not exists (
                select 1 from pg_index i
                where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
            order by 1, 2""")
        if rows:
            info(f"{len(rows)} unindexed foreign key(s) -- every cascade delete and "
                 f"join on these is a sequential scan:")
            for r in rows:
                print(f"          {r['tbl']}.{r['col']}")
        else:
            ok("every foreign key has an index")
    except Exception as e:
        info(f"could not check indexes: {str(e)[:90]}")

    # ------------------------------------------------------------ 5. sizes
    head("largest tables")
    try:
        rows = q("""select relname as t, pg_size_pretty(pg_total_relation_size(c.oid)) as sz,
                           pg_total_relation_size(c.oid) as bytes
                    from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relkind = 'r'
                    order by bytes desc limit 8""")
        for r in rows:
            print(f"  {r['sz']:>10}  {r['t']}")
    except Exception as e:
        info(f"could not read sizes: {str(e)[:90]}")

    print("\n" + "=" * 62)
    if HARD:
        print(f"{len(HARD)} HARD finding(s):")
        for h in HARD:
            print("  -", h)
        sys.exit(1)
    print("No hard findings.")
    for i in INFO:
        print("  observation:", i)


if __name__ == "__main__":
    main()
