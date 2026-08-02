#!/usr/bin/env python3
"""One-time backfill for dead pcg_terms.see_refs entries -- found live
2026-08-02 (MagicLink/SmartSearch coverage sweep): pcg/[id].tsx's "See
also" section renders each see_refs entry as a Pressable that routes to
`/pcg/${slugifyPcgTerm(ref)}` (a plain uppercase-and-underscore transform,
see src/lib/pcg.ts), but 467 of 1048 see_refs entries corpus-wide (45%)
slugify to something that doesn't exist as a real pcg_terms row --
confirmed dead links, not a rendering bug.

Two confirmed, deterministic, zero-ambiguity patterns account for 296 of
those 467:
  - "ICAO term X" is stored as a PREFIX in see_refs, but the real target
    term is stored as "X [ICAO]" (a SUFFIX), slugifying to "..._ICAO" --
    e.g. see_refs "ICAO term ACROBATIC FLIGHT" needs to become
    "ACROBATIC FLIGHT [ICAO]" for the existing naive slugify to land on
    the real row "ACROBATIC_FLIGHT_ICAO".
  - Many real terms carry an abbreviation suffix in their own name
    ("ADVANCED AIR MOBILITY (AAM)") that a plain cross-reference by full
    name alone ("ADVANCED AIR MOBILITY") omits -- e.g. see_refs
    "ADVANCED AIR MOBILITY" needs to become "ADVANCED AIR MOBILITY (AAM)"
    to hit the real row "ADVANCED_AIR_MOBILITY_AAM".

This script REWRITES the stored see_refs text for those 296 (a pure data
fix -- src/lib/pcg.ts's slugify function and pcg/[id].tsx's rendering are
both correct and untouched, they just need correctly-formed input) and
DROPS the remaining ~171 entries that resolve to nothing under either
strategy after manual review of a sample confirmed they're genuinely one
of: a term that doesn't exist anywhere in this corpus (P/CG cross-
references ICAO terminology FAA's own glossary doesn't separately define,
e.g. "AREA CONTROL CENTER"), an ambiguous multi-target reference with no
single correct pick (bare "AUTOMATIC DEPENDENT SURVEILLANCE-BROADCAST"
when only the IN/OUT-specific variants exist), or plain non-term text
that was never meant to be a cross-reference at all (an FAA Order
citation). Keeping a dead entry serves no purpose -- it's unclickable
either way, so removing it is strictly better than leaving a landmine for
a future "why doesn't this see_refs code use per-row existence checks"
question.

Usage:
  python3 sync/fix_pcg_see_refs.py --dry-run
  python3 sync/fix_pcg_see_refs.py
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import mgmt_sql  # noqa: E402


def slugify(term: str) -> str:
    t = term.upper()
    t = re.sub(r"[^A-Z0-9]+", "_", t)
    return t.strip("_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    all_terms = mgmt_sql("select slug, term from pcg_terms")
    all_slugs = {r["slug"] for r in all_terms}

    # "term without its trailing (ABBREV) suffix" -> real slug, e.g.
    # "ADVANCED AIR MOBILITY" -> "ADVANCED_AIR_MOBILITY_AAM". Only terms
    # whose OWN name has this exact "Name (ABBR)" shape are captured --
    # a real ambiguity-avoidance property, not an approximation: if two
    # different real terms stripped to the same base name, this dict
    # would silently keep only one and we'd rather know than guess, so
    # log it (never observed in this corpus as of this run).
    stripped_lookup: dict[str, str] = {}
    collisions = []
    for r in all_terms:
        m = re.match(r"^(.*)\s*\([A-Z0-9/\-]+\)\s*$", r["term"])
        if m:
            key = slugify(m.group(1))
            if key in stripped_lookup and stripped_lookup[key] != r["slug"]:
                collisions.append((key, stripped_lookup[key], r["slug"]))
            stripped_lookup[key] = r["slug"]
    if collisions:
        print(f"WARNING: {len(collisions)} abbreviation-strip collisions, skipping those keys:")
        for key, a, b in collisions:
            print(f"  {key}: both {a} and {b} -- ambiguous, left unfixed")
            stripped_lookup.pop(key, None)

    def resolve(ref: str):
        direct = slugify(ref)
        if direct in all_slugs:
            return None  # already correct, no rewrite needed
        icao_m = re.match(r"^ICAO\s+term\s+(.*)$", ref, re.I)
        if icao_m:
            icao_slug = slugify(icao_m.group(1)) + "_ICAO"
            if icao_slug in all_slugs:
                return f"{icao_m.group(1).strip()} [ICAO]"
        if direct in stripped_lookup:
            target_slug = stripped_lookup[direct]
            target_term = next(t["term"] for t in all_terms if t["slug"] == target_slug)
            return target_term
        return "DROP"

    rows = mgmt_sql(
        "select id, slug, see_refs from pcg_terms "
        "where see_refs is not null and jsonb_array_length(to_jsonb(see_refs)) > 0"
    )

    rewrites = 0
    drops = 0
    updates: list[tuple[str, list[str]]] = []
    for r in rows:
        new_refs = []
        changed = False
        for ref in r["see_refs"]:
            fix = resolve(ref)
            if fix is None:
                new_refs.append(ref)
            elif fix == "DROP":
                drops += 1
                changed = True
            else:
                new_refs.append(fix)
                rewrites += 1
                changed = True
        if changed:
            updates.append((r["id"], new_refs))

    print(f"{rewrites} entries to rewrite, {drops} entries to drop, across {len(updates)} pcg_terms rows")

    if args.dry_run:
        for pid, refs in updates[:15]:
            orig = next(r["see_refs"] for r in rows if r["id"] == pid)
            print(f"  {pid}: {orig!r} -> {refs!r}")
        return

    for pid, refs in updates:
        arr_literal = "ARRAY[" + ",".join("'" + r.replace("'", "''") + "'" for r in refs) + "]::text[]" if refs else "ARRAY[]::text[]"
        mgmt_sql(f"update pcg_terms set see_refs = {arr_literal} where id = '{pid}'")
    print(f"Updated {len(updates)} rows.")


if __name__ == "__main__":
    main()
