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

REGRESSION FOUND AND FIXED 2026-08-10 (P/CG corpus-wide MagicLink
investigation): this script was only ever run once, by hand, on 2026-08-02.
sync/pcg_scraper.py --mode full re-upserts EVERY pcg_terms column, including
see_refs, straight from the FAA's raw HTML on every weekly run (`Prefer:
resolution=merge-duplicates` overwrites the whole row) -- so every one of
this script's 296 rewrites got silently reset back to the FAA's original,
un-rewritten text on the very next scheduled sync, and stayed that way ever
since; a live recheck the same day this comment was written found exactly
296 rewrites and 171 drops pending again, i.e. the ENTIRE original fix had
been fully undone, not partially. Also converted this script from the
Supabase Management API (mgmt_sql) to plain PostgREST (SUPABASE_URL +
SUPABASE_SERVICE_KEY) as part of the same fix -- the Management API's token
is deliberately never a CI secret (see sync/pcg_term_links.py's own header),
so a script that only speaks to it can only ever be run by hand, which is
what let this regress silently for over a week with no failing job to
notice. Now wired into sync_pcg.sh to re-run every week, right after the
scraper step whose overwrite necessitates it -- see that file's comment.

Usage:
  python3 sync/fix_pcg_see_refs.py --dry-run
  python3 sync/fix_pcg_see_refs.py
"""
import argparse
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcg_term_links import fetch_all  # noqa: E402

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}


def slugify(term: str) -> str:
    t = term.upper()
    t = re.sub(r"[^A-Z0-9]+", "_", t)
    return t.strip("_")


# Tidy a ref we could not resolve, purely for display. It is about to be shown
# to a reader as plain text, so it has to read like something the FAA printed
# rather than like scraped markup:
#   * "ICAO Term X"      -> "X [ICAO]"   (matches how we title our own ICAO
#                                         entries, instead of leaking the
#                                         source's inline prefix)
#   * "A and B"          -> two entries  (the FAA joins multiple targets in one
#                                         cross-reference; splitting lets the
#                                         UI list them properly)
#   * U+2010/2011/2013.. -> "-"          (the source uses a Unicode hyphen in
#                                         WIDE-AREA, ACCELERATE-STOP, MICRO-EN
#                                         ROUTE and others; normalising keeps it
#                                         consistent with our own term titles)
# Only ever reformats text we are already keeping -- never invents a target and
# never affects see_refs, which stays link-only.
_HYPHENS = {0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2014: "-", 0x2212: "-"}


def tidy_unresolved(ref: str) -> list[str]:
    out = []
    for part in re.split(r"\s+and\s+", ref.translate(_HYPHENS)):
        part = part.strip()
        if not part:
            continue
        m = re.match(r"^ICAO\s+term\s+(.*)$", part, re.I)
        if m:
            part = f"{m.group(1).strip()} [ICAO]"
        out.append(part)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    all_terms = fetch_all("pcg_terms", "id,slug,term,see_refs,see_refs_unresolved")
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
        # Singular/plural tolerance. The FAA writes the cross-reference in
        # the singular while the target entry is titled in the plural (or
        # vice versa) -- "See MINIMUM IFR ALTITUDE" pointing at the real
        # entry "MINIMUM IFR ALTITUDES (MIA)". Nothing above matches that,
        # so the ref was DROPped as unresolvable and the content silently
        # disappeared: APPROPRIATE OBSTACLE/TERRAIN CLEARANCE MINIMUM
        # ALTITUDE are defined as "Any of the following:" plus exactly four
        # See-refs, and this dropped one of the four, leaving a list of
        # three where the FAA publishes four.
        #
        # Only ever an s-suffix flip on the whole slug, checked against the
        # same two authoritative lookups as above -- it can only ever land
        # on a term that really exists, never invent a target.
        for variant in (direct + "S", direct[:-1] if direct.endswith("S") else ""):
            if not variant:
                continue
            if variant in all_slugs:
                return next(t["term"] for t in all_terms if t["slug"] == variant)
            if variant in stripped_lookup:
                target_slug = stripped_lookup[variant]
                return next(t["term"] for t in all_terms if t["slug"] == target_slug)
        return "DROP"

    rows = [r for r in all_terms if r.get("see_refs")]

    rewrites = 0
    drops = 0
    updates: list[tuple[str, list[str], list[str]]] = []
    for r in rows:
        new_refs = []
        # An unresolvable ref is no longer thrown away. Dropping it from
        # see_refs is still right -- see_refs is the LINKABLE list and a dead
        # link is worse than none -- but the raw target text is kept here so
        # the app can print it as plain, unlinked text.
        #
        # Why this matters: 42 terms have no definition of their own (the FAA
        # publishes them purely as a redirect), so when their only ref was
        # dropped the detail screen rendered "See related term below -- no
        # standalone definition." with nothing below it. The page contradicted
        # itself, on terms as common as WAAS, PBN, ADS-B, ASDA and D-ATIS.
        # Of the 39 that have a real FAA "See X", only 9 resolve to a term we
        # carry; the other 30 name something the FAA references but does not
        # define as its own entry (ADS-B -> AUTOMATIC DEPENDENT
        # SURVEILLANCE-BROADCAST, ATO -> AIR TRAFFIC ORGANIZATION). That name
        # is still the most useful thing we can show -- it is exactly what the
        # FAA prints on that page.
        unresolved = []
        changed = False
        for ref in r["see_refs"]:
            fix = resolve(ref)
            if fix is None:
                new_refs.append(ref)
            elif fix == "DROP":
                drops += 1
                changed = True
                for tidy in tidy_unresolved(ref):
                    if tidy not in unresolved:
                        unresolved.append(tidy)
            else:
                new_refs.append(fix)
                rewrites += 1
                changed = True
        # Also clear a stale unresolved list when everything now resolves, so a
        # later corpus addition (the target term finally being carried) removes
        # the plain-text fallback instead of leaving it duplicated beside a real
        # link.
        if changed or (r.get("see_refs_unresolved") or []) != unresolved:
            updates.append((r["id"], new_refs, unresolved))

    print(f"{rewrites} entries to rewrite, {drops} entries to keep as unresolved text, across {len(updates)} pcg_terms rows")

    if args.dry_run:
        for pid, refs, unres in updates[:15]:
            orig = next(r["see_refs"] for r in rows if r["id"] == pid)
            print(f"  {pid}: {orig!r} -> refs={refs!r} unresolved={unres!r}")
        return

    for pid, refs, unres in updates:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/pcg_terms",
            headers={**HEADERS, "Prefer": "return=minimal"},
            params={"id": f"eq.{pid}"},
            json={"see_refs": refs, "see_refs_unresolved": unres},
            timeout=30,
        )
        resp.raise_for_status()
    print(f"Updated {len(updates)} rows.")


if __name__ == "__main__":
    main()
