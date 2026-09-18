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
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from supabase_mgmt_api import request                            # noqa: E402

FAILURES = []


def live_functions():
    """One query, whole result. An earlier version paged alphabetically to stay
    under apply_migration.py's 2000-character output cap (its line 35) -- but
    supabase_mgmt_api.request() does not truncate at all, and already retries
    429/5xx with Retry-After backoff. That second part matters: this audit runs
    inside run_all_audits.sh alongside every other Management API caller, and
    the paged version swallowed rate-limit failures into an empty result, which
    would make it UNDER-REPORT and therefore pass when it should not."""
    raw = request("/database/query", {"query":
        "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
        "where n.nspname='public' and p.prokind='f' "
        "and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e');"})
    if raw.startswith("HTTP "):
        raise RuntimeError(f"live function query failed: {raw[:160]}")
    return {r["proname"] for r in json.loads(raw)}


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
