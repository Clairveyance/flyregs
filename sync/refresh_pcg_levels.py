#!/usr/bin/env python3
"""
Refreshes pcg_term_levels — the knowledge-level classification for P/CG terms.

WHY IT IS DERIVED, NOT HAND-WRITTEN: there are 926 glossary terms, and hand
-assigning each to student/private/commercial/atp/cfi/mechanic would be guesswork
that rots. Instead a term inherits the levels of the documents that CITE it,
using the ->pcg MagicLinks that pcg_term_links.py already builds. A term pulled
in by Part 91 is student material; one pulled in only by Part 25 is mechanic
material. 487 of 926 terms classify this way; terms nothing cites are left
unclassified and are correctly excluded from level-filtered study pools.

POSTGREST ONLY, NO MANAGEMENT TOKEN. The first version issued DELETE+INSERT as
raw SQL through the Supabase management API, needing SUPABASE_PROJECT_REF +
SUPABASE_MANAGEMENT_TOKEN. The weekly workflows only ever provide SUPABASE_URL
+ SUPABASE_SERVICE_KEY (verified against .github/workflows/), so that version
would have SKIPPED on every scheduled run and let this table go stale --
silently, which is the exact failure mode this whole session was spent
eliminating. The classification is therefore computed here in Python from plain
PostgREST reads and written back with a scoped DELETE + batched POST.

MUST RUN AFTER sync/pcg_term_links.py — it reads that script's output. If the
links change and this doesn't re-run, the Study/Duel level filters silently
drift. Wired into sync_ad.sh immediately after the P/CG linking step.
"""
import os, sys, requests
from collections import defaultdict

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not URL or not KEY:
    sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")

import argparse, logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}

# Mirrors of the SQL classification functions in sync/migrations_curriculum.sql.
# If you change one, change BOTH -- they must agree or the pool count and the
# P/CG classification will disagree.
ALL_PILOT = ["student", "private", "commercial", "atp", "cfi"]
PILOT_PLUS_MECH = ALL_PILOT + ["mechanic"]
FAR_61 = {"A": ALL_PILOT, "B": ALL_PILOT, "C": ALL_PILOT, "J": ALL_PILOT,
          "D": ["private","commercial","atp","cfi"], "E": ["private","commercial","atp","cfi"],
          "F": ["commercial","atp","cfi"], "G": ["atp"], "H": ["cfi"], "I": ["cfi"], "K": ["cfi"]}

def far_levels(part, subpart):
    if part == "61": return FAR_61.get(subpart or "", ALL_PILOT)
    if part == "91": return PILOT_PLUS_MECH
    if part in ("71","73"): return ALL_PILOT
    if part in ("43","45","47","39"): return PILOT_PLUS_MECH
    if part == "119": return ["commercial","atp","cfi"]
    if part in ("117","121","125","135","136"): return ["atp"]
    if part in ("141","142"): return ["cfi"]
    if part in ("21","23","25","27","29","31","33","34","35","36","65","145","147","183"): return ["mechanic"]
    return []

def aim_levels(ch):
    if ch in ("1","2","3","4","5","6","7","8","9"): return ALL_PILOT
    if ch in ("10","11"): return ["commercial","atp","cfi"]
    return []

def ac_levels(s):
    if s in ("00","60","61","67","70","90","91"): return ALL_PILOT
    if s in ("117","119","120","121","125","135"): return ["atp"]
    if s in ("140","141","142"): return ["cfi"]
    if s in ("20","21","23","25","27","29","33","35","36","39","43","45","65","147","183"): return ["mechanic"]
    return []

# RC, real device, build 33: Study Mode filtered to Student+ASEL surfaced
# "CLEARANCE VOID IF NOT OFF BY (TIME)" -- unambiguously IFR-only content,
# with zero business in a student-level pool. Root cause: the
# citation-inheritance heuristic above is coarse at the AIM-CHAPTER level
# -- AIM Ch. 4/5 ("ATC Clearances", "Air Traffic Procedures") are ALL_PILOT
# because MOST of their content genuinely is (radio phraseology, airspace,
# traffic patterns), but those same chapters also define/cross-reference a
# real cluster of IFR-approach-procedure-only P/CG terms (missed approach
# points, decision altitudes, glideslope, stepdown fixes, etc.), which
# inherited ALL_PILOT right along with the general content around them.
#
# Curated by hand against the real P/CG term list (not regex'd against
# definitions -- that produced real false positives: e.g. GO AROUND and
# WAYPOINT both mention "instrument approach" in one clause of an
# otherwise general-VFR-relevant definition, and removing them would have
# been its own accuracy bug). Every slug here is a term whose CORE MEANING
# is exclusively an instrument-approach-procedure concept -- confirmed
# term-by-term, not a blanket sweep. Overrides the citation-inherited
# levels by dropping student/private specifically (a non-instrument-rated
# Private pilot needs this exactly as little as a Student does);
# commercial/atp/cfi/mechanic are left as inherited.
IFR_ONLY_PCG_SLUGS = {
    "APPROACH_CLEARANCE", "CIRCLING_APPROACH", "CLEARANCE_VOID_IF_NOT_OFF_BY_TIME",
    "CLEARED_APPROACH", "CONTACT_APPROACH", "DECISION_ALTITUDE_DA", "DECISION_HEIGHT_DH",
    "FEEDER_FIX", "FEEDER_ROUTE", "FINAL_APPROACH_COURSE", "FINAL_APPROACH_FIX",
    "FINAL_APPROACH_SEGMENT", "GLIDESLOPE", "HEIGHT_ABOVE_TOUCHDOWN_HAT", "IFR_AIRCRAFT",
    "IFR_CONDITIONS", "IFR_FLIGHT", "IFR_LANDING_MINIMUMS", "INITIAL_APPROACH_FIX_IAF",
    "INSTRUMENT_APPROACH", "INSTRUMENT_APPROACH_PROCEDURE", "INSTRUMENT_APPROACH_PROCEDURE_CHARTS",
    "INSTRUMENT_DEPARTURE_PROCEDURE_DP_CHARTS", "INSTRUMENT_FLIGHT_RULES_IFR",
    "INSTRUMENT_LANDING_SYSTEM_ILS", "INSTRUMENT_METEOROLOGICAL_CONDITIONS_IMC",
    "INSTRUMENT_RUNWAY", "INTERMEDIATE_FIX", "LANDING_MINIMUMS",
    "LOCALIZER_PERFORMANCE_WITH_VERTICAL_GUIDANCE_LPV", "LOCALIZER_TYPE_DIRECTIONAL_AID_LDA",
    "LOW_APPROACH", "MIDDLE_MARKER", "MINIMUM_DESCENT_ALTITUDE_MDA", "MISSED_APPROACH",
    "MISSED_APPROACH_POINT_MAP", "MISSED_APPROACH_SEGMENT", "NONPRECISION_APPROACH",
    "NONPRECISION_APPROACH_PROCEDURE", "OUTER_MARKER", "PRACTICE_INSTRUMENT_APPROACH",
    "PRECISION_APPROACH", "PRECISION_APPROACH_PROCEDURE", "PRECISION_APPROACH_RADAR",
    "PRECISION_OBSTACLE_FREE_ZONE_POFZ", "PRM_APPROACH", "RADAR_APPROACH", "RNAV_APPROACH",
    "RUNWAY_PROFILE_DESCENT", "SIMULTANEOUS_OFFSET_INSTRUMENT_APPROACH_SOIA",
    "SPECIAL_INSTRUMENT_APPROACH_PROCEDURE", "STANDARD_TERMINAL_ARRIVAL_STAR", "STEPDOWN_FIX",
    "SURVEILLANCE_APPROACH", "UNPUBLISHED_ROUTE", "VISUAL_APPROACH",
    "VISUAL_APPROACH_SLOPE_INDICATOR_VASI",
}

def apply_ifr_only_override(levels_set, slug):
    if slug in IFR_ONLY_PCG_SLUGS:
        return levels_set - {"student", "private"}
    return levels_set

def fetch_all(table, select, **params):
    """Paginated -- an unfiltered PostgREST select silently caps at 1000 rows."""
    rows, off = [], 0
    while True:
        p = {"select": select, "limit": 1000, "offset": off}; p.update(params)
        r = requests.get(f"{URL}/rest/v1/{table}", headers=HEADERS, params=p, timeout=180)
        r.raise_for_status(); page = r.json(); rows.extend(page)
        if len(page) < 1000: break
        off += 1000
    return rows

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    far = {f["section_number"]: (f.get("part"), f.get("subpart_letter"))
           for f in fetch_all("far_sections", "section_number,part,subpart_letter")}
    aim = {a["paragraph_number"]: a.get("chapter") for a in fetch_all("aim_paragraphs", "paragraph_number,chapter")}
    acs = {c["document_number"]: c.get("subject_series") for c in fetch_all("advisory_circulars", "document_number,subject_series")}
    cites = fetch_all("document_citations", "citing_type,citing_id,cited_id", cited_type="eq.pcg")
    log.info(f"citations to classify: {len(cites)}")

    by_slug = defaultdict(set)
    for c in cites:
        t, cid = c["citing_type"], c["citing_id"]
        if t == "far" and cid in far: by_slug[c["cited_id"]].update(far_levels(*far[cid]))
        elif t == "aim" and cid in aim: by_slug[c["cited_id"]].update(aim_levels(aim[cid]))
        elif t == "ac"  and cid in acs: by_slug[c["cited_id"]].update(ac_levels(acs[cid]))

    rows = [{"slug": s, "levels": sorted(apply_ifr_only_override(v, s))} for s, v in by_slug.items() if v]
    rows = [r for r in rows if r["levels"]]
    tally = {lv: sum(1 for r in rows if lv in r["levels"]) for lv in PILOT_PLUS_MECH}
    log.info(f"classified {len(rows)} terms: {tally}")
    if args.dry_run:
        log.info("(dry run -- nothing written)"); return

    r = requests.delete(f"{URL}/rest/v1/pcg_term_levels", headers={**HEADERS, "Prefer": "return=minimal"},
                        params={"slug": "neq.\x00"}, timeout=120)
    r.raise_for_status()
    for i in range(0, len(rows), 500):
        r = requests.post(f"{URL}/rest/v1/pcg_term_levels",
                          headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
                          json=rows[i:i+500], timeout=120)
        r.raise_for_status()

    # Post-write count check: delete-then-insert fails SILENTLY if the process
    # dies mid-batch, leaving a partial table and a clean-looking log.
    c = requests.get(f"{URL}/rest/v1/pcg_term_levels", headers={**HEADERS, "Prefer": "count=exact", "Range": "0-0"},
                     params={"select": "slug"}, timeout=120)
    actual = int(c.headers.get("content-range", "0-0/0").split("/")[-1])
    if actual != len(rows):
        log.error(f"PARTIAL WRITE: expected {len(rows)}, table has {actual}. Re-run."); sys.exit(1)
    log.info(f"done. verified {actual} classified terms.")

if __name__ == "__main__":
    main()
