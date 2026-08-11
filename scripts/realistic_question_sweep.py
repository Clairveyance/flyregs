#!/usr/bin/env python3
"""Hand-crafted realistic-question sweep, the second of the two methods RC
asked for ("do all rounds of realistic Qs across all topic. use both of
your methods.") -- complements search_anchor_gap_sweep.py's mechanical
title-echo test with actual pilot-phrased questions across topics a title
echo can't cover (glossary "what does X mean" questions, questions that
span multiple sections, questions with no clean section-title match).

Each question can optionally carry an `expect` id (section_number /
paragraph_number / slug / ad_number / document_number) when the answer is
confidently known -- those get scored PASS/MISS automatically. Questions
without `expect` are logged with their top-3 for manual eyeball judgment
(deliberately used for cases like drug/alcohol Part 120 subparts or NTSB
830 reporting where the "right" hit may legitimately not exist in a
Title-14-only corpus, or may span more than one reasonable section).

Usage: python3 scripts/realistic_question_sweep.py [far|aim|pcg|acs|ads]
  (no args) runs all 5.
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {}
with open(os.path.join(BASE, ".env")) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        env[k] = v.strip('"')
SUPABASE_URL = env["EXPO_PUBLIC_SUPABASE_URL"]
ANON_KEY = env["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
HEADERS = {"apikey": ANON_KEY, "Content-Type": "application/json"}


def search(fn, query, limit=5):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{fn}",
        data=json.dumps({"query": query, "result_limit": limit}).encode(),
        headers=HEADERS, method="POST",
    )
    try:
        return json.loads(urllib.request.urlopen(req).read().decode())
    except urllib.error.HTTPError as e:
        return {"__error__": e.code, "__body__": e.read().decode()[:200]}


ID_KEY = {
    "search_far": "section_number",
    "search_aim": "paragraph_number",
    "search_pcg": "slug",
    "search_acs": "document_number",
    "search_ads": "ad_number",
}


def run_bank(name, fn, bank):
    print(f"\n{'='*70}\n{name} -- {len(bank)} questions\n{'='*70}")
    idk = ID_KEY[fn]
    misses, passes, unscored = [], [], []
    for topic, q, expect in bank:
        res = search(fn, q, 5)
        if isinstance(res, dict):
            print(f"  ERROR [{topic}] {q!r}: {res}")
            continue
        top = [(r.get(idk), r.get("title") or r.get("term") or r.get("subject_heading")) for r in res]
        if expect:
            rank = next((i for i, (rid, _) in enumerate(top) if rid == expect), None)
            if rank is None or rank > 0:
                misses.append({"topic": topic, "q": q, "expect": expect, "rank": rank, "top": top})
                status = "MISS" if rank is None else f"#{rank+1}"
                print(f"  [{status}] ({topic}) {q!r} expected {expect} -> {top[:3]}")
            else:
                passes.append({"topic": topic, "q": q, "expect": expect})
        else:
            unscored.append({"topic": topic, "q": q, "top": top})
            print(f"  [??] ({topic}) {q!r} -> {top[:3]}")

    print(f"\n{name}: {len(passes)} passed, {len(misses)} missed/wrong-rank, {len(unscored)} unscored (needs eyeball)")
    out_path = os.path.join(BASE, "scripts", "audit_reports", f"realistic_q_{name}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({"passes": passes, "misses": misses, "unscored": unscored}, f, indent=1)
    print(f"Full results: {out_path}")
    return misses, unscored


# ── Question banks ──────────────────────────────────────────────────────
# (topic, question, expected_section_or_None)

FAR_BANK = [
    # Weight & balance / performance
    ("weight_balance", "what weight and balance information must I review before flight", "91.103"),
    ("weight_balance", "preflight action required before every flight", "91.103"),
    # Fuel requirements
    ("fuel", "how much fuel do I need for a day VFR flight", "91.151"),
    ("fuel", "VFR fuel reserve requirements", "91.151"),
    ("fuel", "fuel requirements for flight in IFR conditions", "91.167"),
    ("fuel", "how much reserve fuel is required for an IFR flight", "91.167"),
    # Airspace classes
    ("airspace", "what do I need to enter class B airspace", "91.131"),
    ("airspace", "class C airspace equipment and clearance requirements", "91.130"),
    ("airspace", "class D airspace operating rules", "91.129"),
    ("airspace", "VFR weather minimums for class G airspace", "91.155"),
    ("airspace", "basic VFR weather minimums by airspace class", "91.155"),
    # NOTAMs / TFRs
    ("notam_tfr", "do I need to check NOTAMs before flying", "91.103"),
    ("notam_tfr", "temporary flight restrictions near a disaster area", "91.137"),
    ("notam_tfr", "temporary flight restriction for the president", "91.141"),
    # Currency
    ("currency", "how many night takeoffs and landings to carry passengers at night", "61.57"),
    ("currency", "instrument currency requirements", "61.57"),
    ("currency", "flight review requirements every 24 months", "61.56"),
    ("currency", "how long is a flight review valid", "61.56"),
    # Right of way
    ("row", "who has right of way when two aircraft are converging", "91.113"),
    ("row", "right of way on final approach to land", "91.113"),
    ("row", "right of way between aircraft and balloons", "91.113"),
    # Maintenance / Part 43
    ("maintenance", "who can perform an annual inspection", "91.409"),
    ("maintenance", "what records must be kept after aircraft maintenance", "43.9"),
    ("maintenance", "content and form of maintenance records", "43.9"),
    ("maintenance", "persons authorized to approve an aircraft for return to service", "43.7"),
    # ELT/transponder/ADS-B
    ("equipment", "when is an emergency locator transmitter required", "91.207"),
    ("equipment", "transponder requirements for flight", "91.215"),
    ("equipment", "ADS-B out equipment requirements", "91.225"),
    # Holding / diversion
    ("alternate", "when do I need to file an alternate airport on an IFR flight plan", "91.169"),
    ("alternate", "IFR alternate airport weather minimums", "91.169"),
    # Drug/alcohol
    ("drugalcohol", "eight hours from bottle to throttle rule", "91.17"),
    ("drugalcohol", "alcohol and drug restrictions for pilots", "91.17"),
    # Registration/airworthiness
    ("airworthiness", "aircraft airworthiness certificate must be displayed", "91.203"),
    ("airworthiness", "civil aircraft registration and airworthiness requirements", "91.203"),
    # Medical
    ("medical", "third class medical certificate duration", "61.23"),
    ("medical", "BasicMed requirements", "61.113"),
    # No-clean-hit probes (unscored, judged by eyeball / legitimate absence)
    ("icing_probe", "can I take off with frost on the wings", None),
    ("holding_probe", "standard holding pattern turn direction", None),
    ("accident_probe", "what accidents must be reported to the NTSB", None),
    ("dutytime_probe", "part 121 flight and duty time limitations", None),
    ("part135_probe", "part 135 pilot flight time limitations", None),
]

AIM_BANK = [
    ("lost_comm", "lost communications procedures", "6-4-1"),
    ("wake_turb", "wake turbulence avoidance procedures", None),
    ("light_gun", "light gun signals from the tower", None),
    ("class_airspace", "class A airspace description", "3-2-2"),
    ("markings", "runway hold short markings", None),
    ("emergency", "emergency transponder code 7700", None),
    ("radar", "radar traffic advisory services", None),
    ("phraseology", "cleared for the option meaning", None),
    ("vfr_procedures", "VFR cruising altitude rules", None),
    ("ifr_procedures", "instrument approach procedure minimums", None),
    ("weather_briefing", "how to get a preflight weather briefing", None),
    ("birds", "bird strike hazard reporting", None),
    ("pireps", "pilot weather report PIREP", None),
    ("go_around", "missed approach procedure", None),
]

PCG_BANK = [
    ("glossary", "what does squawk mean", "slang-squawk-list"),
    ("glossary", "what is a stopway", "stopway"),
    ("glossary", "meaning of cleared for the option", None),
    ("glossary", "what does VFR on top mean", None),
    ("glossary", "definition of decision height", None),
    ("glossary", "what is minimum vectoring altitude", None),
    ("glossary", "meaning of circle to land", None),
    ("glossary", "what does say again mean on the radio", None),
    ("glossary", "definition of runway incursion", None),
    ("glossary", "what is a hold short line", None),
    ("glossary", "meaning of critical area for ILS", None),
    ("glossary", "what does cleared to land mean", None),
    ("glossary", "definition of special VFR", None),
    ("glossary", "what is a traffic pattern", None),
    ("glossary", "meaning of go around", None),
]

ACS_BANK = [
    ("figures_forms", "how to install a low range radio altimeter", "20-199"),
    ("gyro", "maintenance and handling of air driven gyroscopic instruments", "91-26A"),
    ("export_approval", "export airworthiness approval process", "21-44B"),
    ("lightning", "aircraft electrical system lightning protection", "20-136C"),
    ("low_visibility", "low visibility takeoff landing rollout approval", "20-191"),
    ("fatigue_probe", "pilot fatigue and crew rest guidance", "91-82A"),
    ("deice_probe", "aircraft deicing and anti-icing guidance", None),
    ("preflight_probe", "preflight inspection guidance for pilots", None),
    ("weight_shift_probe", "weight shift control aircraft guidance", None),
    ("night_probe", "night flying guidance for pilots", None),
]

ADS_BANK = [
    ("engine_probe", "engine failure airworthiness directive", None),
    ("landing_gear_probe", "landing gear collapse airworthiness directive", None),
    ("fuel_probe", "fuel system contamination airworthiness directive", None),
    ("wing_probe", "wing spar corrosion inspection", None),
    ("propeller_probe", "propeller blade crack inspection", None),
    ("avionics_probe", "avionics software update airworthiness directive", None),
    ("boeing_probe", "Boeing airplanes airworthiness directive", None),
    ("helicopter_probe", "helicopter tail rotor airworthiness directive", None),
]

BANKS = {
    "far": ("search_far", FAR_BANK),
    "aim": ("search_aim", AIM_BANK),
    "pcg": ("search_pcg", PCG_BANK),
    "acs": ("search_acs", ACS_BANK),
    "ads": ("search_ads", ADS_BANK),
}

if __name__ == "__main__":
    targets = sys.argv[1:] or list(BANKS.keys())
    all_misses, all_unscored = {}, {}
    for t in targets:
        fn, bank = BANKS[t]
        misses, unscored = run_bank(t, fn, bank)
        all_misses[t] = misses
        all_unscored[t] = unscored
    total_miss = sum(len(v) for v in all_misses.values())
    total_unscored = sum(len(v) for v in all_unscored.values())
    print(f"\n{'#'*70}\nGRAND TOTAL: {total_miss} missed/wrong-rank, {total_unscored} unscored across {len(targets)} corpora\n{'#'*70}")
