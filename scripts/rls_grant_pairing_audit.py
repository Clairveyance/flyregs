#!/usr/bin/env python3
"""Audit: every table the CLIENT reads is readable BY THE CLIENT.

WHY, 2026-09-10
`acs_task_reg_links` carried an RLS policy (`acs_task_reg_links_public_read`,
SELECT to `public`) and no `GRANT SELECT ... TO anon, authenticated`. Postgres
requires BOTH: the grant opens the door, the policy decides which rows come
through. With only the policy, PostgREST returned

    403  42501  permission denied for table acs_task_reg_links

to every real user. `getCuratedTaskLinks` maps any error to `null`, and the ACS
task screen treats `null` as "lookup failed -- fall back to keyword search". So
the entire curated-links feature was dead in the app while the corpus audit,
the link builder, the publisher and `tsc` all reported success -- because every
one of them queries as `service_role`, which bypasses grants and RLS alike.

The mirror-image trap is on the same table: RLS ON with ZERO policies. That
denies every row rather than erroring, so a caller gets an empty result and no
message at all. `study_item_topics` shipped that way and only worked because
its callers are SECURITY DEFINER.

WHAT THIS DOES NOT FLAG, AND WHY
Several tables intentionally have NO table-level grant and are read through
COLUMN-level grants instead -- that is how `advisory_circulars.pdf_text` stays
withheld while its metadata is public. A table-level-only check reports nine
false positives (advisory_circulars, airworthiness_directives, cfr49_sections,
dictionary_terms, legal_interpretations ...). So this checks table OR column
grants, and only for tables the client source actually reads by name.
"""
import os
import re
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt  # noqa: E402


def client_tables():
    """Relations the client SELECTS from, and separately those it only writes.

    The distinction matters. `feedback_submissions`, `search_click_log` and
    `search_query_log` are all RLS-on with an INSERT policy and NO SELECT
    policy, and that is exactly right -- a user submits feedback and must not
    read anyone else's. Flagging them would be a false alarm, and a noisy audit
    gets ignored. So only relations the client actually reads are checked.
    """
    out = subprocess.run(
        ["grep", "-rhoE", r"\.from\('[a-z0-9_]+'\)[^;]{0,120}", os.path.join(BASE, "src")],
        capture_output=True, text=True).stdout
    reads, all_named = set(), set()
    for line in out.splitlines():
        m = re.match(r"\.from\('([a-z0-9_]+)'\)(.*)", line, re.S)
        if not m:
            continue
        name, rest = m.group(1), m.group(2)
        all_named.add(name)
        if ".select(" in rest:
            reads.add(name)
    # A `.from(x)` whose `.select()` sits on the next line still counts as a
    # read: grep's 120-char window can miss it, so fall back to a whole-file
    # scan for the same table followed by a select within a few lines.
    out2 = subprocess.run(
        ["grep", "-rhoE", "-A3", r"\.from\('[a-z0-9_]+'\)", os.path.join(BASE, "src")],
        capture_output=True, text=True).stdout
    cur = None
    for line in out2.splitlines():
        m = re.search(r"\.from\('([a-z0-9_]+)'\)", line)
        if m:
            cur = m.group(1)
        elif cur and ".select(" in line:
            reads.add(cur)
            cur = None
    return sorted(reads), sorted(all_named)


def main():
    names, all_named = client_tables()
    print("client source SELECTs from %d relations (%d named in total; the rest are "
          "write-only and deliberately have no SELECT policy)" % (len(names), len(all_named)))
    inlist = ",".join("'%s'" % n for n in names)

    kind = {r["relname"]: r["relkind"] for r in mgmt(
        "select relname, relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "where n.nspname='public' and relname in (%s)" % inlist)}
    granted = {r["table_name"] for r in mgmt(
        "select distinct table_name from information_schema.role_table_grants "
        "where grantee in ('anon','authenticated') and privilege_type='SELECT' "
        "and table_name in (%s)" % inlist)}
    granted |= {r["table_name"] for r in mgmt(
        "select distinct table_name from information_schema.role_column_grants "
        "where grantee in ('anon','authenticated') and privilege_type='SELECT' "
        "and table_name in (%s)" % inlist)}
    rls = {r["relname"] for r in mgmt(
        "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace "
        "where n.nspname='public' and c.relrowsecurity and relname in (%s)" % inlist)}
    policed = {r["tablename"] for r in mgmt(
        "select distinct tablename from pg_policies where tablename in (%s) "
        "and cmd in ('SELECT','ALL')" % inlist)}

    fails = []
    for n in names:
        if n not in kind:
            continue                       # not a relation (an RPC name, a typo in a comment)
        if n not in granted:
            fails.append("%s: the client reads it, but neither anon nor authenticated has "
                         "SELECT (table or column). PostgREST will 403 -- and the client "
                         "almost certainly turns that into a silent fallback." % n)
        elif kind.get(n) == "r" and n in rls and n not in policed:
            fails.append("%s: RLS is ON with no SELECT policy. Every row is filtered out and "
                         "the caller gets an empty result with NO error -- worse than a 403." % n)

    print("  %d checked, %d granted, %d under RLS" % (len(kind), len(granted), len(rls)))
    if fails:
        print("\nFAIL  %d table(s):" % len(fails))
        for f in fails:
            print("   -", f)
        return 1
    print("\nPASS  every relation the client names is readable by a real client role")
    return 0


if __name__ == "__main__":
    sys.exit(main())
