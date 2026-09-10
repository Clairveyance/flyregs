"""Publish build/acs_reg_links.json into public.acs_task_reg_links.

Full recompute-and-replace, written so it is INCAPABLE of leaving the table
empty or half-written (No Regression Mandate):
  * refuses to run at all if the computed set is implausibly small
  * loads everything into a staging table FIRST
  * swaps in a single transaction, so a failure mid-insert leaves the live
    table exactly as it was
"""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt  # noqa: E402

# A healthy run computes ~8.2k (3.2k FAR + 4.6k AIM + 417 ACS-cited ACs).
# It was ~10.3k until 2026-09-10, when the 2,101 keyword-GUESSED AC links were
# dropped -- see build_acs_reg_links.py for why guessing ACs cannot work.
# Anything far below this floor is a builder bug, not a content change.
MIN_EXPECTED = 5000

def q(v):
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "acs_reg_links.json")
    links = json.load(open(path))
    print(f"loaded {len(links)} links")
    if len(links) < MIN_EXPECTED:
        print(f"REFUSING TO PUBLISH -- only {len(links)} links, expected >= {MIN_EXPECTED}.")
        print("Nothing was written. Investigate the builder before retrying.")
        return 1

    before = mgmt("select count(*) c from public.acs_task_reg_links")[0]["c"]
    print(f"live table currently holds {before} rows")

    mgmt("drop table if exists public.acs_task_reg_links_staging;")
    mgmt("""create table public.acs_task_reg_links_staging
            (like public.acs_task_reg_links including defaults including constraints);""")

    CHUNK = 400
    cols = "(doc_code,area_number,task_letter,cited_type,cited_id,rank,score,source)"
    for i in range(0, len(links), CHUNK):
        vals = ",".join(
            f"({q(l['doc_code'])},{q(l['area_number'])},{q(l['task_letter'])},"
            f"{q(l['cited_type'])},{q(l['cited_id'])},{int(l['rank'])},"
            f"{'null' if l.get('score') is None else float(l['score'])},{q(l['source'])})"
            for l in links[i:i + CHUNK])
        mgmt(f"insert into public.acs_task_reg_links_staging {cols} values {vals} on conflict do nothing;")
        print(f"  staged {min(i+CHUNK, len(links))}/{len(links)}", end="\r")
    staged = mgmt("select count(*) c from public.acs_task_reg_links_staging")[0]["c"]
    print(f"\nstaged {staged} rows")
    if staged < MIN_EXPECTED:
        print("REFUSING TO SWAP -- staging came up short; live table untouched.")
        return 1

    mgmt("""begin;
            delete from public.acs_task_reg_links;
            insert into public.acs_task_reg_links
              (doc_code,area_number,task_letter,cited_type,cited_id,rank,score,source)
            select doc_code,area_number,task_letter,cited_type,cited_id,rank,score,source
              from public.acs_task_reg_links_staging;
            commit;""")
    mgmt("drop table if exists public.acs_task_reg_links_staging;")
    # Idempotent, and deliberately unconditional. An RLS policy is NOT a grant:
    # this table had `acs_task_reg_links_public_read` for SELECT to `public` and
    # still returned 403 to every real user, because no GRANT SELECT existed for
    # anon/authenticated. The client treats that error as "lookup failed" and
    # falls back to keyword search -- so the whole curated-links feature was
    # invisible while every audit (which queries as service_role) passed.
    mgmt("grant select on public.acs_task_reg_links to anon, authenticated;")
    after = mgmt("select count(*) c from public.acs_task_reg_links")[0]["c"]
    print(f"published: {before} -> {after} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
