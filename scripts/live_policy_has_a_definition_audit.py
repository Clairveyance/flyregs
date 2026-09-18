#!/usr/bin/env python3
"""Every live RLS policy must have a definition somewhere on disk.

The sibling of live_function_has_a_definition_audit.py, and the higher-stakes
half: RLS policies ARE this app's security model. They are what stands between
one account's data and another's.

Found 2026-09-18 -- 33 policies existed only in production, with no CREATE
POLICY in any file under sync/ or migrations/. Among them
users_manage_own_synced_bookmarks and users_manage_own_synced_notes (the core
per-user data isolation) and most of the folder-sharing access control. Several
look dashboard-created: Supabase's UI names them like "far_sections public read",
with spaces, which no hand-written migration in this repo does.

There is no point-in-time recovery here, only daily snapshots. A snapshot
restores them; the repository did not describe them. Anybody reading the repo to
answer "who can read this table" would have found a partial answer and had no
way to know it was partial.

TWO TRAPS, both of which produced a confidently wrong answer on the way here and
are therefore handled explicitly rather than worked around:

  * POLICY NAMES CONTAIN SPACES. Aggregating them into one string and splitting
    on whitespace invents fragments -- the first run of this check reported
    policies named "a", "can", "click", "log" and "select". Aggregate with a
    separator that cannot appear in a name.
  * USE THE RIGHT CLIENT. apply_migration.py prints only the first 2000
    characters of a response (its line 35), which is why half a day was spent
    paging queries alphabetically to stay under a cap that did not need to
    exist. supabase_mgmt_api.request() returns the whole body AND already
    retries 429/5xx with Retry-After backoff -- which matters here because this
    audit runs inside run_all_audits.sh alongside every other Management API
    caller, and a rate-limited audit that errors is just a flaky audit.

Usage: python3 scripts/live_policy_has_a_definition_audit.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from supabase_mgmt_api import request                            # noqa: E402

FAILURES = []


def q(sql):
    raw = request("/database/query", {"query": sql})
    if raw.startswith("HTTP "):
        raise RuntimeError(f"policy query failed: {raw[:160]}")
    return json.loads(raw)


def main():
    # One query, whole result -- no alphabetical paging needed once the client
    # is not truncating. Rows, not a joined string, so a policy name containing
    # spaces cannot be split into fragments.
    live = {r["policyname"]: r["tablename"]
            for r in q("select policyname, tablename from pg_policies "
                       "where schemaname='public';")}

    disk = set()
    for d in ("sync", "migrations"):
        p = ROOT / d
        if not p.exists():
            continue
        for f in p.glob("*.sql"):
            for m in re.finditer(r'create\s+policy\s+(?:"([^"]+)"|([a-z0-9_]+))',
                                 f.read_text(), re.I):
                disk.add((m.group(1) or m.group(2)).lower())

    # An under-reporting audit PASSES when it should fail, which is the
    # dangerous direction -- so refuse to report at all on an implausible read.
    if len(live) < 40:
        print(f"  FAIL  only saw {len(live)} live policies — the query or its "
              f"paging is broken, not the database")
        sys.exit(1)

    missing = sorted(n for n in live if n.lower() not in disk)
    print(f"  {len(live)} live RLS policies; {len(disk)} defined on disk")
    for n in missing:
        print(f"    LIVE ONLY  {n:46} on {live[n]}")
    if missing:
        FAILURES.append(f"{len(missing)} live policy(ies) with no definition on disk")

    print()
    if FAILURES:
        print("FAILED:")
        for f in FAILURES:
            print("  - " + f)
        print("\n  Capture them into a migration file. These are the app's access")
        print("  control; the repo should be able to answer 'who can read this'.")
        sys.exit(1)
    print("live_policy_has_a_definition -- every live RLS policy is described on disk")


if __name__ == "__main__":
    main()
