#!/usr/bin/env python3
"""
Second and final cleanup pass on the 2026-08-14 AD full re-scan diff --
the 57 "other-shape" disagreements deliberately left untouched by
cleanup_superseded_engine_mentions.py (that script only handled the 532
bare-engine-model cases, matched by a literal engine/turbofan/etc keyword
filter).

Every one of these 57 was individually read against the REAL, live
airworthiness_directives.applicability text (not guessed from the mention
name alone) before being classified. Four confirmed shapes, all the same
underlying story as the original 532 -- the pre-guardrail prompt stored a
SCOPING DETAIL from the applicability text (a tool used to perform the
work, a modification/SB/STC number, a location where a part is installed,
or a configuration the AD explicitly EXCLUDES) as if it were itself the
affected part, when the real affected part is a different, more specific
thing named in the same sentence:

  A. Modification/Service-Bulletin/Service-Instruction/STC numbers (17
     rows) -- these are regulatory/procedural references, never a
     physical part a user would tag as aircraft equipment. Always wrong
     to have been in the parts catalog as a "part" mention regardless of
     what the fresh prompt found instead.
  B. Bare engine model names/lists (14 rows) -- same exact pattern as the
     532 already cleaned up, just missed by that script's literal
     engine/turbofan/turboshaft/turboprop/reciprocating keyword filter
     (e.g. "RB211 Trent 560A2-61" doesn't contain the word "engine").
  C. Tool part numbers used to perform the AD's required action (2 rows,
     both AD 2022-03-16) -- confirmed via real text: "...CDP bolted joint
     assembled...with the 11C4525P01 torque fixture or assembled with the
     11C4629P01 torque wrench." The torque fixture/wrench are shop tools,
     not installed aircraft parts.
  D. Location/context/excluded-configuration descriptors (21 rows) --
     each verified individually against real applicability text. Two
     representative examples: AD 2012-22-13's unsafe condition is
     "unintended movement of the ENGINE CONTROL LEVERS due to an external
     force to the windshield or canopy" -- windshield/canopy are the
     trigger, engine control levers are the real affected part. AD
     2020-19-09 explicitly EXCLUDES helicopters "with bubble windows P/N
     8G5620F00112" from applicability -- the old "Bubble Window" mention
     had it backwards entirely.

One row was investigated and deliberately KEPT, not deleted: AD
2020-06-11's real applicability text is "...with a yaw stability
augmentation system AND WITH a main rotor blade upper control
collective/longitudinal link assembly...installed" -- a genuine AND
condition, not a supersession. The fresh, hardened-guardrail prompt only
caught one of the two independently-required conditions; the old
"Yaw stability augmentation system" mention is factually correct and
still needed. Left in the DELETE_LIST comments below for the record, not
in the actual list.

See PROJECT_NOTES/flyregs_pending.md, 2026-08-14 section, for the full
per-AD verification trail.

Usage:
  python3 cleanup_other_shape_disagreements.py --dry-run   (default)
  python3 cleanup_other_shape_disagreements.py --apply

Environment variables required: SUPABASE_URL, SUPABASE_SERVICE_KEY
"""
from __future__ import annotations

import argparse
import json
import os

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

# (ad_number, old_name) pairs confirmed safe to remove -- see header.
# NOT included: ('2020-06-11', 'Yaw stability augmentation system') --
# investigated and deliberately kept, real independent AND condition.
DELETE_LIST: list[tuple[str, str]] = [
    # Bucket A -- modification/SB/service-instruction/STC numbers
    ("2011-26-02", "Modification TU347"),
    ("2018-05-01", "Modification AL25612"),
    ("2018-05-01", "Modification 0725870"),
    ("2013-08-22", "Modification TU 207"),
    ("2013-08-22", "Modification TU 243"),
    ("2013-08-22", "Service Bulletin No. 292 80 0168"),
    ("2013-08-22", "Service Bulletin No. 292 80 0190"),
    ("2020-09-15", "Modification 0722907"),
    ("2020-09-15", "Airbus Helicopters modification 0722907"),
    ("2020-23-03", "Modification 0728456"),
    ("2020-23-03", "MOD 0728456"),
    ("2021-19-04", "HG modification 16-009"),
    ("2020-24-07", "Twist Grip MOD 073773"),
    ("2020-24-07", "Twist Grip MOD 073254"),
    ("2021-12-05", "Modification POST MOD 0752C05"),
    ("2021-17-08", "Astronics Armstrong Aerospace STC ST04096CH"),
    ("2021-24-15", "Bell Model 206L1/L3 Service Instruction for Increased Gross Weight Upgrade Kit BHT-206-SI-2052"),
    # Bucket B -- bare engine model names/lists, same shape as the 532
    ("2017-03-03", "RB211 Trent 560A2-61"),
    ("2017-03-03", "RB211 Trent 556B-61"),
    ("2017-03-03", "RB211 Trent 560-61"),
    ("2017-03-03", "RB211 Trent 553A2-61"),
    ("2017-03-03", "RB211 Trent 556B2-61"),
    ("2017-03-03", "RB211 Trent 553-61"),
    ("2017-03-03", "RB211 Trent 556-61"),
    ("2017-03-03", "RB211 Trent 556A2-61"),
    ("2021-17-12", "Trent 1000-A, Trent 1000-A2, Trent 1000-AE, Trent 1000-AE2, Trent 1000-C, Trent 1000-C2, Trent 1000-CE, Trent 1000-CE2, Trent 1000-D, Trent 1000-D2, Trent 1000-G, Trent 1000-G2, Trent 1000-H, Trent 1000-H2, Trent 1000-J2, Trent 1000-K2, Trent 1000-L2"),
    ("2017-10-06", "RB211 Trent 772B-60"),
    ("2017-10-06", "RB211 Trent 768-60"),
    ("2017-10-06", "RB211 Trent 772-60"),
    ("2012-16-13", "Rotax 912 F2; 912 F3; 912 F4; 912 S2; 912 S3; 912 S4"),
    ("2022-18-04", "GEnx-1B64, GEnx-1B64/P1, GEnx-1B64/P2, GEnx-1B67, GEnx-1B67/P1, GEnx-1B67/P2, GEnx-1B70, GEnx-1B70/75/P1, GEnx-1B70/75/P2, GEnx-1B70/P1, GEnx-1B70/P2, GEnx-1B70C/P1, GEnx-1B70C/P2, GEnx-1B74/75/P1, GEnx-1B74/75/P2, GEnx-1B76/P2, GEnx-1B76A/P2"),
    # Bucket C -- tool part numbers, not installed aircraft parts
    ("2022-03-16", "11C4525P01 Torque Fixture"),
    ("2022-03-16", "11C4629P01 Torque Wrench"),
    # Bucket D -- location/context/excluded-configuration descriptors,
    # each individually verified against real applicability text
    ("2022-04-08", "PMA Part D5237106020400S"),
    ("2022-04-08", "PMA Part D5237106020400"),
    ("2021-03-06", "Main Gearbox (MGB) Pump Intake"),
    ("2012-22-13", "Windshield"),
    ("2012-22-13", "Canopy"),
    ("2021-10-03", "multi-purpose sponsons"),
    ("2013-16-20", "External pump drive"),
    ("2021-26-14", "Steel splice kit part number 332A08-2649-3072"),
    ("2020-05-23", "Main gearbox (MGB) suspension bars"),
    ("2013-05-15", "Emergency Floats"),
    ("2020-18-51", "BendixKing Model KI-300"),
    ("2021-19-04", "Plastic bushing HG22-1001"),
    ("2021-19-04", "Plastic bushing part number HG22-1001"),
    ("2021-19-17", "Sitting platform assembly MBCS4111"),
    ("2021-19-17", "Sitting platform assembly MBCS12215"),
    ("2020-19-09", "Bubble Window P/N 8G5620F00112"),
    ("2020-19-09", "Bubble Window"),
    ("2017-06-11", "Rotor Brake"),
    ("2017-06-11", "Compressor"),
    ("2017-06-11", "Pulley"),
    ("2018-25-11", "Thrust Reverser (T/R) Inner Wall"),
    ("2014-04-07", "Tailboom"),
    ("2021-10-23", "Tail rotor ball bearing control aft connection"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually delete; default is dry-run")
    args = ap.parse_args()

    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

    print(f"{len(DELETE_LIST)} confirmed superseded mentions to remove "
          f"(1 of the original 57, AD 2020-06-11, deliberately kept -- real AND condition, see header)")

    all_parts, offset = [], 0
    while True:
        r = requests.get(f"{SUPABASE_URL}/rest/v1/ad_parts", headers=h,
                          params={"select": "id,name", "limit": 1000, "offset": offset})
        batch = r.json()
        all_parts.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    name_to_id = {p["name"]: p["id"] for p in all_parts}

    to_delete = []
    unresolved = []
    for ad_number, name in DELETE_LIST:
        pid = name_to_id.get(name)
        if pid:
            to_delete.append({"ad_number": ad_number, "part_id": pid, "name": name})
        else:
            unresolved.append((ad_number, name))

    print(f"resolved {len(to_delete)} (ad_number, part_id) mention pairs to remove")
    if unresolved:
        print(f"WARNING: {len(unresolved)} had no matching part name (changed since the diff ran?) -- skipped")
        for u in unresolved:
            print("  unresolved:", u)

    if not args.apply:
        print("\nDRY RUN -- nothing deleted. Sample:")
        for row in to_delete[:15]:
            print(f"    {row['ad_number']}: '{row['name']}'")
        return

    deleted = 0
    failed = []
    for row in to_delete:
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/ad_part_mentions",
            headers=h,
            params={"ad_number": f"eq.{row['ad_number']}", "part_id": f"eq.{row['part_id']}"},
        )
        if resp.status_code in (200, 204):
            deleted += 1
        else:
            failed.append({**row, "status": resp.status_code, "body": resp.text[:200]})

    print(f"\nDeleted {deleted} of {len(to_delete)} superseded mention rows.")
    if failed:
        print(f"{len(failed)} failed:")
        for f_ in failed:
            print(" ", f_)


if __name__ == "__main__":
    main()
