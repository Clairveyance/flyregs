#!/usr/bin/env python3
"""Every live database function must have a definition somewhere on disk.

memory/gotcha_migration_files_drift_from_live_db.md documents this project's
habit: database changes get applied directly through the Management API for
speed, and writing the matching .sql back to the repo is a separate,
easy-to-forget step. That note warns not to trust a migration file as matching
what is deployed.

This checks the other direction, which nothing covered: a function the repo has
never heard of AT ALL. Found 2026-09-18 -- eight of them, including
expand_search_terms, the query-expansion layer underneath SmartSearch. Nothing
on disk said what it does.

WHY IT MATTERS MORE THAN TIDINESS: there is no point-in-time recovery here, only
daily snapshots (memory/supabase_backup_posture_no_pitr.md). A snapshot would
bring such a function back -- but the repository, which is the thing actually
reviewed, diffed and reasoned about, did not describe the database it deploys.
Anyone reading the repo to understand a behaviour would have found nothing, and
anyone rebuilding from it would have produced a different database.

Extension-owned functions are excluded (pg_depend deptype 'e'): those belong to
pgcrypto/pgvector/etc and are not ours to define.

Usage: python3 scripts/live_function_has_a_definition_audit.py
"""
import json
import pathlib
import re
import string
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def live_functions():
    """Paged deliberately: apply_migration.py truncates its output at 2000
    characters (memory/gotcha_apply_migration_2000char_truncation.md), and a
    single string_agg of ~180 names silently exceeds that -- which would make
    this audit under-report, i.e. pass when it should not."""
    names, buckets = set(), list(string.ascii_lowercase) + ["_"]
    for i in range(0, len(buckets), 4):
        grp = buckets[i:i + 4]
        cond = " or ".join(f"p.proname like '{c}%'" for c in grp)
        sql = (f"select string_agg(p.proname, ' ' order by p.proname) as fns "
               f"from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
               f"where n.nspname='public' and p.prokind='f' and ({cond}) "
               f"and not exists (select 1 from pg_depend d "
               f"where d.objid=p.oid and d.deptype='e');")
        q = ROOT / "scripts/.tmp_livefn_query.sql"
        q.write_text(sql)
        try:
            out = subprocess.run([sys.executable, str(ROOT / "scripts/apply_migration.py"), str(q)],
                                 capture_output=True, text=True).stdout.strip().splitlines()
            v = json.loads(out[-1])[0]["fns"]
            if v:
                names.update(v.split())
        except Exception:
            pass
        finally:
            q.unlink(missing_ok=True)
    return names


def on_disk():
    found = set()
    for d in ("sync", "migrations"):
        p = ROOT / d
        if not p.exists():
            continue
        for f in p.glob("*.sql"):
            for m in re.finditer(
                    r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?\"?([a-z0-9_]+)\"?",
                    f.read_text(), re.I):
                found.add(m.group(1).lower())
    return found


def main():
    live, disk = live_functions(), on_disk()
    if len(live) < 50:
        print(f"  FAIL  only saw {len(live)} live functions — the query or the "
              f"paging is broken, not the database")
        sys.exit(1)
    missing = sorted(live - disk)
    print(f"  {len(live)} live non-extension function(s); {len(disk)} defined on disk")
    for m in missing:
        print(f"    LIVE ONLY  {m}")
    if missing:
        FAILURES.append(f"{len(missing)} live function(s) with no definition on disk: "
                        + ", ".join(missing))

    print()
    if FAILURES:
        print("FAILED:")
        for f in FAILURES:
            print("  - " + f)
        print("\n  Capture the live body with pg_get_functiondef into a migration")
        print("  file. Write the FULL current body, not a diff -- see")
        print("  memory/gotcha_migration_files_drift_from_live_db.md.")
        sys.exit(1)
    print("live_function_has_a_definition -- every live function is described on disk")


if __name__ == "__main__":
    main()
