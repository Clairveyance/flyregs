#!/usr/bin/env python3
"""Consolidate study_facts.category (authored rows) from 85 drifted values to 26 sections.

RC approved 2026-09-07: "yes, consolidate the categories".

WHY THIS IS SAFE TO DO NOW: nothing reads study_facts.category yet. Verified both
sides -- no src/ reference (study.tsx's `categoryClasses` is the AIRCRAFT category/class
axis, a different column), and the only live functions touching study_facts are
get_study_queue, create_challenge and get_reg_of_the_day, whose every `category` mention
is `category_classes`. So this is a rename before any UI hardcodes the strings, which is
exactly what question_bank/README.md warned we would otherwise be stuck with.

NO-REGRESSION MANDATE: this is a bulk content write, so before touching anything it
(1) snapshots every affected row and (2) writes the exact inverse UPDATE statements to
disk. Neither is best-effort -- if either fails, nothing is written.
"""
import json, os, sys, time

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
sys.path.insert(0, os.path.join(BASE, "sync"))
from access_matrix_sweep import mgmt                      # noqa: E402
from content_snapshot import SNAPSHOT_DIR                  # noqa: E402

# old category -> consolidated section. Every one of the 85 live values must appear
# here or the script refuses to run; an unmapped value would silently survive.
MAP = {
    # --- Airspace -------------------------------------------------------------
    "Airspace": "Airspace",
    # --- Weather & Safety of Flight (AIM Ch 7 grouping) -----------------------
    "Weather": "Weather & Safety of Flight",
    "Wake Turbulence": "Weather & Safety of Flight",
    "Wildlife & Bird Strikes": "Weather & Safety of Flight",
    # --- VFR Weather Minimums (kept separate: it is its own study topic) ------
    "VFR Weather Minimums": "VFR Weather Minimums",
    # --- Certificates & Ratings -----------------------------------------------
    "Certificates & Ratings": "Certificates & Ratings",
    "Certificates & Documents": "Certificates & Ratings",
    "Pilot Certification & Privileges": "Certificates & Ratings",
    "Private Pilot Eligibility": "Certificates & Ratings",
    "Private Pilot Privileges": "Certificates & Ratings",
    "Commercial Eligibility": "Certificates & Ratings",
    "Commercial Knowledge": "Certificates & Ratings",
    "Commercial Privileges": "Certificates & Ratings",
    "Commercial Experience": "Certificates & Ratings",
    "Sport Pilot": "Certificates & Ratings",
    "Instrument Rating Requirements": "Certificates & Ratings",
    # --- Knowledge & Practical Tests ------------------------------------------
    "Knowledge & Practical Tests": "Knowledge & Practical Tests",
    # --- Medical & Fitness -----------------------------------------------------
    "Medical Standards": "Medical & Fitness",
    "Medical Certification": "Medical & Fitness",
    "Medical & BasicMed": "Medical & Fitness",
    "Aeromedical Factors": "Medical & Fitness",
    "Alcohol, Drugs & Fitness": "Medical & Fitness",
    # --- Logging, Currency & Proficiency --------------------------------------
    "Currency & Flight Review": "Logging, Currency & Proficiency",
    "Currency & Proficiency": "Logging, Currency & Proficiency",
    "IFR Currency & Experience": "Logging, Currency & Proficiency",
    "CFI Recency": "Logging, Currency & Proficiency",
    "Mechanic Recency": "Logging, Currency & Proficiency",
    "Logbooks & Records": "Logging, Currency & Proficiency",
    # --- Student Pilot & Solo --------------------------------------------------
    "Student Limitations": "Student Pilot & Solo",
    "Student Eligibility": "Student Pilot & Solo",
    "Pre-Solo Requirements": "Student Pilot & Solo",
    "Solo Cross-Country": "Student Pilot & Solo",
    # --- Flight Instructors ----------------------------------------------------
    "Training & Instruction": "Flight Instructors",
    "CFI Eligibility": "Flight Instructors",
    "CFI Knowledge": "Flight Instructors",
    "CFI Privileges": "Flight Instructors",
    "CFI Limitations": "Flight Instructors",
    "CFI Records": "Flight Instructors",
    # --- Required Documents & Equipment ----------------------------------------
    "Required Documents & Equipment": "Required Documents & Equipment",
    # --- Right-of-Way & Operating Rules ----------------------------------------
    "Right-of-Way & Operating Rules": "Right-of-Way & Operating Rules",
    "Operating Rules": "Right-of-Way & Operating Rules",
    "Crewmember Duties": "Right-of-Way & Operating Rules",
    "Preflight Action": "Right-of-Way & Operating Rules",
    "Aircraft Lights": "Right-of-Way & Operating Rules",     # 91.209 is an operating rule
    # --- Altitudes & Speed Limits ----------------------------------------------
    "Altitudes & Speed Limits": "Altitudes & Speed Limits",
    # --- Fuel, Oxygen & Life Support -------------------------------------------
    "Fuel Requirements": "Fuel, Oxygen & Life Support",
    "IFR Fuel Requirements": "Fuel, Oxygen & Life Support",
    "Oxygen & Altitude": "Fuel, Oxygen & Life Support",
    # --- Airport Operations -----------------------------------------------------
    "Airport Operations": "Airport Operations",
    "Airport Signs & Markings": "Airport Operations",
    "Airport Lighting": "Airport Operations",
    # --- ATC Communications & Clearances ----------------------------------------
    "ATC Clearances": "ATC Communications & Clearances",
    "ATC Procedures": "ATC Communications & Clearances",
    "Communications & Light Signals": "ATC Communications & Clearances",
    "IFR Communications & Lost Comm": "ATC Communications & Clearances",
    # --- IFR Procedures ----------------------------------------------------------
    "IFR Procedures": "IFR Procedures",
    "Instrument Approaches": "IFR Procedures",
    "IFR Altitudes": "IFR Procedures",
    "IFR Equipment & Checks": "IFR Procedures",
    "IFR Flight Planning & Alternates": "IFR Procedures",
    # --- Navigation ---------------------------------------------------------------
    "Navigation": "Navigation",
    "Navigation Systems": "Navigation",
    # --- Flight Planning ----------------------------------------------------------
    "Flight Planning": "Flight Planning",
    # --- Emergency Procedures ------------------------------------------------------
    "Emergency Procedures": "Emergency Procedures",
    "Emergency & Special Operations": "Emergency Procedures",
    # --- Accident Reporting ---------------------------------------------------------
    "Accident Reporting": "Accident Reporting",
    # --- Maintenance & Airworthiness --------------------------------------------------
    "Maintenance & Airworthiness": "Maintenance & Airworthiness",
    "Airworthiness & Inspections": "Maintenance & Airworthiness",
    "Airworthiness Directives": "Maintenance & Airworthiness",
    "Maintenance Records": "Maintenance & Airworthiness",
    "Maintenance Authority": "Maintenance & Airworthiness",
    "Maintenance Responsibility": "Maintenance & Airworthiness",
    "Inspection Authorization": "Maintenance & Airworthiness",
    "Mechanic Privileges": "Maintenance & Airworthiness",
    # --- Aircraft Registration & Marking -----------------------------------------------
    "Aircraft Registration & Marking": "Aircraft Registration & Marking",
    "Drone Registration": "Aircraft Registration & Marking",
    # --- Remote Pilot Operations ---------------------------------------------------------
    "Remote Pilot Operations": "Remote Pilot Operations",
    "Remote Pilot Certification": "Remote Pilot Operations",
    "Remote Pilot Operating Limits": "Remote Pilot Operations",
    "Remote Pilot Preflight": "Remote Pilot Operations",
    "Remote ID": "Remote Pilot Operations",
    # --- Aviation Security -----------------------------------------------------------------
    "Aviation Security": "Aviation Security",
    "Security Regulations": "Aviation Security",
    # --- Hazardous Materials ----------------------------------------------------------------
    "Hazardous Materials": "Hazardous Materials",
    # --- Definitions --------------------------------------------------------------------------
    "Definitions": "Definitions",
}


def q(s):
    return "'" + s.replace("'", "''") + "'"


def main():
    apply = "--apply" in sys.argv

    live = mgmt("select category, count(*) as n from study_facts "
                "where origin='authored' group by 1")
    live_cats = {r["category"]: r["n"] for r in live}
    total = sum(live_cats.values())

    unmapped = sorted(set(live_cats) - set(MAP))
    if unmapped:
        print("REFUSING -- %d live category value(s) are not in the map:" % len(unmapped))
        for u in unmapped:
            print("   ", u)
        return 1
    stale = sorted(set(MAP) - set(live_cats))
    if stale:
        print("note: %d mapped value(s) no longer present live (harmless): %s"
              % (len(stale), ", ".join(stale)))

    after = {}
    for old, n in live_cats.items():
        after[MAP[old]] = after.get(MAP[old], 0) + n
    if sum(after.values()) != total:
        print("REFUSING -- row count would change: %d -> %d" % (total, sum(after.values())))
        return 1

    print("%d rows, %d categories -> %d sections\n" % (total, len(live_cats), len(after)))
    for c in sorted(after, key=lambda k: (-after[k], k)):
        print("  %4d  %s" % (after[c], c))

    changing = {o: MAP[o] for o in live_cats if MAP[o] != o}
    print("\n%d of %d category values change; %d rows move."
          % (len(changing), len(live_cats), sum(live_cats[o] for o in changing)))

    if not apply:
        print("\nDRY RUN. Re-run with --apply to write.")
        return 0

    # ---- snapshot + inverse SQL BEFORE any write -------------------------------
    rows, offset = [], 0
    while True:
        page = mgmt("select id, category from study_facts where origin='authored' "
                    "order by id limit 1000 offset %d" % offset)
        rows.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    if len(rows) != total:
        print("REFUSING -- snapshot read %d rows, expected %d" % (len(rows), total))
        return 1

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    snap = SNAPSHOT_DIR / ("study_facts_category_consolidation_%s.json" % stamp)
    snap.write_text(json.dumps({
        "table": "study_facts", "key_column": "id", "columns": "id,category",
        "taken_at": stamp, "row_count": len(rows), "rows": rows,
    }, ensure_ascii=False))

    # exact undo, grouped by original value -- one statement per old category
    by_old = {}
    for r in rows:
        by_old.setdefault(r["category"], []).append(r["id"])
    undo = SNAPSHOT_DIR / ("study_facts_category_consolidation_%s.undo.sql" % stamp)
    undo.write_text(
        "-- exact inverse of the %s category consolidation. Restores all %d rows.\n"
        % (stamp, len(rows))
        + "\n".join(
            "update study_facts set category = %s where id in (%s);"
            % (q(old), ",".join("'%s'" % i for i in ids))
            for old, ids in sorted(by_old.items())) + "\n")
    print("\nsnapshot: %s (%d rows)\nundo:     %s" % (snap, len(rows), undo))

    # ---- write --------------------------------------------------------------
    cases = "\n".join("      when %s then %s" % (q(o), q(n)) for o, n in sorted(changing.items()))
    sql = ("update study_facts set category = case category\n%s\n      else category end\n"
           "where origin = 'authored' and category in (%s);"
           % (cases, ",".join(q(o) for o in sorted(changing))))
    mgmt(sql)

    post = mgmt("select category, count(*) as n from study_facts "
                "where origin='authored' group by 1")
    post_map = {r["category"]: r["n"] for r in post}
    ok = (sum(post_map.values()) == total and post_map == after)
    print("\nAFTER: %d rows in %d sections -- %s"
          % (sum(post_map.values()), len(post_map), "MATCHES PLAN" if ok else "MISMATCH"))
    if not ok:
        print("  expected:", dict(sorted(after.items())))
        print("  got:     ", dict(sorted(post_map.items())))
        print("  -> restore with", undo)
        return 1
    return 0


sys.exit(main())
