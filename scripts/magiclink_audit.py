#!/usr/bin/env python3
"""MagicLink corpus integrity audit.

Checks every document_citations row in the corpus for:
  DEAD TARGET   the cited document does not exist
  ORPHAN SOURCE the citing document does not exist
  DUPLICATE     the same (citing, cited) pair stored more than once --
                MagicLinks render per row, so a duplicate is a repeated link
  SELF LINK     a document linking to itself
  EMPTY IDS     blank citing_id / cited_id

and, with --ownership, verifies that no sync script's DELETE scope overlaps
another script's rows -- the failure mode that silently wiped 1,484 AD links
weekly and had the same shape in ac/far/aim.

Usage:  python3 scripts/magiclink_audit.py [--ownership]
"""
import json
import os
import re
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Which cited_types each sync script is allowed to delete. cited_type='pcg'
# is owned corpus-wide by sync/pcg_term_links.py and must appear in exactly
# one owner.
OWNERSHIP = {
    "sync/ac_citations.py":      {"citing": "ac",  "cited": {"ac", "far", "aim", "ad", "cfr49"}},
    "sync/far_citations.py":     {"citing": "far", "cited": {"ac", "far", "aim", "ad", "cfr49"}},
    "sync/ad_citations.py":      {"citing": "ad",  "cited": {"ac", "far", "aim", "ad"}},
    "sync/aim_scraper.py":       {"citing": "aim", "cited": {"ac", "far", "aim", "ad"}},
    "sync/aim_far_citations.py": {"citing": "aim", "cited": {"far", "ac", "cfr49"}},
    "sync/loi_scraper.py":       {"citing": "loi", "cited": {"far"}},
    "sync/loi_vision_cleanup.py": {"citing": "loi", "cited": {"far"}},
    "sync/loi_ac_citations.py":  {"citing": "loi", "cited": {"ac"}},
    "sync/loi_far_part_citations.py": {"citing": "loi", "cited": {"far_part"}},
    # Added 2026-08-14 alongside this file's own TARGET_EXISTS['cfr49'] fix --
    # sync/cfr49_citations.py shipped this session, was silently unchecked by
    # --ownership. Its own delete_cfr49_citations() scopes to
    # citing_type=eq.cfr49, cited_type=in.(ac,far,aim,ad,cfr49) -- confirmed
    # by reading sync/cfr49_citations.py directly. Same shape as the
    # loi_loi_citations.py gap noted below.
    "sync/cfr49_citations.py":   {"citing": "cfr49", "cited": {"ac", "far", "aim", "ad", "cfr49"}},
    # Added 2026-08-12 alongside this file's own TARGET_EXISTS['loi'] fix --
    # shipped today, was silently unchecked by --ownership (not a false
    # FAIL like TARGET_EXISTS was, just never verified at all). Its own
    # write_citations() scopes the delete to
    # citing_type=eq.loi&citing_id=eq.<slug>&cited_type=eq.loi -- confirmed
    # by reading sync/loi_loi_citations.py directly.
    "sync/loi_loi_citations.py": {"citing": "loi", "cited": {"loi"}},
    "sync/pcg_citations.py":     {"citing": "pcg", "cited": {"far", "far_part", "ac", "aim", "ad"}},
    "sync/pcg_term_links.py":    {"citing": "*",   "cited": {"pcg"}},
}


def mgmt_query(sql):
    env = {}
    with open(os.path.join(BASE, ".env.supabase-mgmt")) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{env['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {env['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    return json.load(urllib.request.urlopen(req))


TARGET_EXISTS = {
    "far": "exists (select 1 from far_sections f where f.section_number = dc.cited_id)",
    "far_part": "exists (select 1 from far_parts fp where fp.part = dc.cited_id)",
    "aim": "exists (select 1 from aim_paragraphs a where a.paragraph_number = dc.cited_id)",
    "ac":  "exists (select 1 from advisory_circulars c where c.document_number = dc.cited_id)",
    "ad":  "exists (select 1 from airworthiness_directives d where d.ad_number = dc.cited_id)",
    "pcg": "exists (select 1 from pcg_terms p where p.slug = dc.cited_id or p.term = dc.cited_id)",
    # Found 2026-08-12: missing entirely until sync/loi_loi_citations.py
    # shipped today and made 'loi' a legitimate cited_type for the first
    # time (previously loi only ever appeared as citing_type, which
    # SOURCE_EXISTS below already covered). Without this key the target_case
    # SQL's CASE...ELSE true fallthrough marked all 58 real loi->loi rows
    # "dead" -- confirmed via direct query all 58 cited_ids genuinely
    # resolve against legal_interpretations.slug (0 actually dead). Test-
    # tooling gap, not a real corpus/app bug -- same class as this file's
    # other historical false-positive fixes.
    "loi": "exists (select 1 from legal_interpretations l where l.slug = dc.cited_id)",
    # Added 2026-08-14 alongside sync/cfr49_citations.py shipping this
    # session -- same "missing key -> CASE...ELSE true fallthrough marks
    # every row dead" shape as the 'loi' fix above. Confirmed via direct
    # query before this fix: all cfr49->* cited_ids genuinely resolve
    # against cfr49_sections.section_number (0 actually dead).
    "cfr49": "exists (select 1 from cfr49_sections f where f.section_number = dc.cited_id)",
}

SOURCE_EXISTS = {
    "far": "exists (select 1 from far_sections f where f.section_number = dc.citing_id)",
    "aim": "exists (select 1 from aim_paragraphs a where a.paragraph_number = dc.citing_id)",
    "ac":  "exists (select 1 from advisory_circulars c where c.document_number = dc.citing_id)",
    "ad":  "exists (select 1 from airworthiness_directives d where d.ad_number = dc.citing_id)",
    "pcg": "exists (select 1 from pcg_terms p where p.slug = dc.citing_id or p.term = dc.citing_id)",
    "loi": "exists (select 1 from legal_interpretations l where l.slug = dc.citing_id)",
    "cfr49": "exists (select 1 from cfr49_sections f where f.section_number = dc.citing_id)",
}

problems = []


def audit_links():
    target_case = "case dc.cited_type " + " ".join(
        f"when '{k}' then not {v}" for k, v in TARGET_EXISTS.items()) + " else true end"
    source_case = "case dc.citing_type " + " ".join(
        f"when '{k}' then not {v}" for k, v in SOURCE_EXISTS.items()) + " else true end"

    rows = mgmt_query(f"""
      select dc.citing_type, dc.cited_type, count(*) as total,
        count(*) filter (where {target_case}) as dead_target,
        count(*) filter (where {source_case}) as orphan_source,
        count(*) - count(distinct (dc.citing_id || '|' || dc.cited_id)) as duplicates,
        count(*) filter (where dc.citing_type = dc.cited_type
                           and dc.citing_id = dc.cited_id) as self_links,
        count(*) filter (where dc.cited_id is null or btrim(dc.cited_id) = ''
                           or dc.citing_id is null or btrim(dc.citing_id) = '') as empty_ids
      from document_citations dc
      group by 1, 2 order by total desc
    """)
    print(f"  {'pair':12}{'rows':>8}{'dead':>7}{'orphan':>8}{'dupes':>7}{'self':>6}{'empty':>7}")
    tot = 0
    for r in rows:
        tot += r["total"]
        bad = sum(int(r[k]) for k in
                  ("dead_target", "orphan_source", "duplicates", "self_links", "empty_ids"))
        flag = "  <-- PROBLEM" if bad else ""
        if bad:
            problems.append(f"{r['citing_type']}->{r['cited_type']}: {bad} bad rows")
        print(f"  {r['citing_type'] + '->' + r['cited_type']:12}{r['total']:>8}"
              f"{r['dead_target']:>7}{r['orphan_source']:>8}{r['duplicates']:>7}"
              f"{r['self_links']:>6}{r['empty_ids']:>7}{flag}")
    print(f"\n  {tot} MagicLinks across {len(rows)} source->target pairs")


def audit_ownership():
    """Read each script's actual DELETE params and compare to its declared
    ownership. A script whose delete is broader than what it writes will
    destroy another script's rows."""
    print("\n  -- DELETE SCOPE vs OWNERSHIP --")
    for path, own in sorted(OWNERSHIP.items()):
        full = os.path.join(BASE, path)
        if not os.path.exists(full):
            continue
        src = open(full).read()
        # Every params={...} dict that targets document_citations.
        # NOT [^}]* -- an f-string value like f"eq.{slug}" contains a brace,
        # which truncated the block before cited_type and produced a false
        # "unscoped delete" report. Match up to the params closing brace by
        # requiring it to be followed by a comma/newline at statement level.
        # 1200, not 400: several of these have a long explanatory comment
        # between the URL and params=, and a too-small window silently
        # reported "no delete found" -- an audit that skips a file is worse
        # than one that fails it.
        blocks = re.findall(
            r"document_citations[\s\S]{0,1200}?params=\{([\s\S]*?)\},\s*\n", src)
        if not blocks:
            print(f"  FAIL {path}: no document_citations delete found — "
                  f"cannot verify its scope")
            problems.append(f"{path}: delete not found by the audit")
            continue
        ok = True
        for b in blocks:
            has_citing = "citing_type" in b
            # [a-z0-9_,]+, not [a-z_,]+ -- 'cfr49' is the first cited_type
            # value in this codebase with a digit in it, and the narrower
            # class silently failed to match its whole in.(...) list the
            # moment it shipped this session, misreporting 3 correctly-
            # scoped deletes (ac/far/aim_far_citations.py) as "unscoped."
            m = re.search(r"cited_type\"?\s*:\s*f?\"(?:eq|in)\.\(?([a-z0-9_,]+)\)?\"", b)
            if not has_citing:
                continue
            if not m:
                # Unscoped by cited_type -- deletes EVERY cited_type for this
                # citing_type, including pcg rows owned elsewhere.
                if own["cited"] != set(TARGET_EXISTS):
                    print(f"  FAIL {path}: delete not scoped by cited_type "
                          f"(would remove {sorted(set(TARGET_EXISTS) - own['cited'])} "
                          f"owned elsewhere)")
                    problems.append(f"{path}: unscoped delete")
                    ok = False
                continue
            scope = set(m.group(1).split(","))
            extra = scope - own["cited"]
            if extra:
                print(f"  FAIL {path}: deletes {sorted(extra)} it does not own")
                problems.append(f"{path}: deletes {sorted(extra)}")
                ok = False
        if ok:
            print(f"  PASS {path}: delete scoped to {sorted(own['cited'])}")

    # pcg must have exactly one owner
    owners = [p for p, o in OWNERSHIP.items() if "pcg" in o["cited"]]
    if len(owners) == 1:
        print(f"  PASS cited_type='pcg' has exactly one owner: {owners[0]}")
    else:
        print(f"  FAIL cited_type='pcg' claimed by {owners}")
        problems.append("pcg ownership is ambiguous")

    # And no script may still WRITE a cited_type it no longer deletes.
    print("\n  -- WRITES vs DELETE SCOPE (a write it can't delete = duplicates) --")
    for path, own in sorted(OWNERSHIP.items()):
        full = os.path.join(BASE, path)
        if not os.path.exists(full) or own["citing"] == "*":
            continue
        src = open(full).read()
        written = set(re.findall(r"[\"']cited_type[\"']\s*:\s*[\"']([a-z0-9_]+)[\"']", src))
        stray = written - own["cited"]
        if stray:
            print(f"  FAIL {path}: still writes {sorted(stray)} but no longer deletes it "
                  f"-> rows accumulate on every run")
            problems.append(f"{path}: writes-without-delete {sorted(stray)}")
        else:
            print(f"  PASS {path}: writes only {sorted(written) or ['(none)']}")


if __name__ == "__main__":
    print("=" * 74)
    print("MAGICLINK CORPUS AUDIT")
    print("=" * 74 + "\n")
    audit_links()
    if "--ownership" in sys.argv:
        audit_ownership()
    print("\n" + "=" * 74)
    if problems:
        print(f"{len(problems)} PROBLEM(S):")
        for p in problems:
            print(f"  - {p}")
    else:
        print("MagicLink corpus is clean.")
    sys.exit(1 if problems else 0)
