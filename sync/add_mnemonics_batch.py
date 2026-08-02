#!/usr/bin/env python3
"""Bulk-adds the mnemonic batch RC provided (two screenshots + IMAIR) as
new dictionary_terms rows, category='mnemonic', grouped via
mnemonic_group. Skips any term that already exists (checked by slug) so
this is safe to re-run.

Run once against production 2026-08-02: 31 total, 31 new, 0 already
existed. See sync/migrations_mnemonics_2.sql for the mnemonic_group
column itself and the group backfill for mnemonics that existed before
that column did (PAVE, IMSAFE, AVE-F, MEA)."""
import os
import re
import requests

BASE = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app"


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
HEADERS = {"apikey": SCRAPER["SUPABASE_SERVICE_KEY"],
           "Authorization": f"Bearer {SCRAPER['SUPABASE_SERVICE_KEY']}",
           "Content-Type": "application/json", "Prefer": "return=representation"}

SOURCE_GENERAL = "General aviation flight-training mnemonic (widely taught, not FAA-published verbatim)"
SOURCE_FAA_RISK = "FAA-H-8083-2A (Risk Management Handbook)"
SOURCE_ORIGINAL = "Original FlyRegs mnemonic"


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return f"mnem-{s}"


def entry(term, group, intro, source, breakdown):
    return {
        "term": term,
        "slug": slugify(term),
        "letter": term[0].upper(),
        "category": "mnemonic",
        "mnemonic_group": group,
        "senses": [{"usage": None, "definition": intro, "breakdown": breakdown}],
        "source": source,
    }


def b(letter, concept, detail=""):
    return {"letter": letter, "concept": concept, "detail": detail}


G_PREFLIGHT = "Preflight Planning & Risk Management"
G_VFR_EQUIP = "VFR & Equipment Requirements"
G_IFR = "IFR Flight Planning & En Route"
G_APPROACH = "Approaches & Transitions"
G_WX_INSTR = "Weather & Navigation Instrument Errors"
G_SPATIAL = "Spatial Disorientation & Illusions"
G_ENGINE = "Engine Failures & Emergencies"

ENTRIES = [
    # ---- Preflight Planning & Risk Management ----
    entry("CARE", G_PREFLIGHT, "Memory aid for managing risk during flight.", SOURCE_GENERAL, [
        b("C", "Consequences"), b("A", "Alternatives"), b("R", "Reality"), b("E", "External Factors"),
    ]),
    entry("TEAM", G_PREFLIGHT, "Memory aid for risk mitigation strategies.", SOURCE_GENERAL, [
        b("T", "Transfer"), b("E", "Eliminate"), b("A", "Accept"), b("M", "Mitigate"),
    ]),
    entry("DECIDE", G_PREFLIGHT, "Six-step aeronautical decision-making model.", SOURCE_FAA_RISK, [
        b("D", "Detect"), b("E", "Estimate"), b("C", "Choose"), b("I", "Identify"), b("D", "Do"), b("E", "Evaluate"),
    ]),
    entry("5 Ps", G_PREFLIGHT, "Single-pilot resource management intervals -- checked at multiple points before and during a flight.", SOURCE_GENERAL, [
        b("P", "Pilot"), b("P", "Plane"), b("P", "Plan"), b("P", "Programming"), b("P", "Passengers"),
    ]),
    entry("RAW FAT", G_PREFLIGHT, "Preflight briefing items required by FAR 91.103.", SOURCE_GENERAL, [
        b("R", "Runway lengths"), b("A", "Alternates"), b("W", "Weather"),
        b("F", "Fuel requirements"), b("A", "ATC delays"), b("T", "Takeoff/Landing distances"),
    ]),
    entry("NW KRAFT", G_PREFLIGHT, "Expanded preflight-briefing item list, same underlying FAR 91.103 requirement as RAW FAT.", SOURCE_GENERAL, [
        b("N", "NOTAMs"), b("W", "Weather"), b("K", "Known ATC delays"), b("R", "Runway lengths"),
        b("A", "Alternates"), b("F", "Fuel"), b("T", "Takeoff/Landing data"),
    ]),
    entry("ARROW", G_PREFLIGHT, "Required aircraft documents that must be aboard.", SOURCE_GENERAL, [
        b("A", "Airworthiness certificate"), b("R", "Registration"), b("R", "Radio station license", "if operating internationally"),
        b("O", "Operating limitations/POH"), b("W", "Weight and balance data"),
    ]),
    entry("AVIATES", G_PREFLIGHT, "Required aircraft inspections and their intervals.", SOURCE_GENERAL, [
        b("A", "Annual"), b("V", "VOR check", "IFR only, every 30 days"), b("I", "100-hour", "if used for hire/instruction"),
        b("A", "Altimeter/Static system", "IFR only, every 24 months"), b("T", "Transponder", "every 24 months"),
        b("E", "ELT", "battery + inspection"), b("S", "Supplemental Type Certificates/ADs", "as applicable"),
    ]),
    # Grouped with Preflight Planning & Risk Management, not a standalone
    # "ADM" group -- RC: "This goes neatly along with the well known IMSAFE,"
    # meaning co-located with it (same group as PAVE/IMSAFE below), not just
    # topically adjacent.
    entry("IMAIR", G_PREFLIGHT, "Memory aid for the five FAA-recognized hazardous attitudes in aeronautical decision-making. Pairs with IMSAFE as a second \"IM\" ADM checklist -- an original FlyRegs mnemonic, not published by the FAA.", SOURCE_ORIGINAL, [
        b("I", "Impulsivity", "\"Do something quickly\" without stopping to think"),
        b("M", "Macho", "\"I can do it, I'll show them\" risk-taking to prove something"),
        b("A", "Anti-authority", "\"Don't tell me\" resistance to rules and instruction"),
        b("I", "Invulnerability", "\"It won't happen to me\""),
        b("R", "Resignation", "\"What's the use?\" giving up control of the situation"),
    ]),

    # ---- VFR & Equipment Requirements ----
    entry("ATOMATO FLAMES", G_VFR_EQUIP, "Required instruments and equipment for day VFR flight (FAR 91.205(b)).", SOURCE_GENERAL, [
        b("A", "Altimeter"), b("T", "Tachometer"), b("O", "Oil pressure gauge"), b("M", "Manifold pressure gauge", "if constant-speed prop"),
        b("A", "Airspeed indicator"), b("T", "Temperature gauge", "liquid-cooled engines"), b("O", "Oil temperature gauge", "air-cooled engines"),
        b("F", "Fuel gauge"), b("L", "Landing gear position indicator", "if retractable"), b("A", "Anti-collision lights"),
        b("M", "Magnetic compass"), b("E", "ELT"), b("S", "Seatbelts"),
    ]),
    entry("FLAPS", G_VFR_EQUIP, "Additional equipment required for night VFR flight, on top of day VFR requirements (FAR 91.205(c)).", SOURCE_GENERAL, [
        b("F", "Fuses/Circuit breakers", "spares, if fuse-type"), b("L", "Landing light", "if for hire"),
        b("A", "Anti-collision lights"), b("P", "Position lights"), b("S", "Source of electrical power"),
    ]),
    entry("A FAST MOOSE", G_VFR_EQUIP, "Alternative memory aid covering the same day-VFR required-equipment list as ATOMATO FLAMES.", SOURCE_GENERAL, [
        b("A", "Altimeter"), b("F", "Fuel gauge"), b("A", "Airspeed indicator"), b("S", "Seatbelts"),
        b("T", "Tachometer"), b("M", "Manifold pressure gauge", "if constant-speed prop"), b("O", "Oil pressure gauge"),
        b("O", "Oil temperature gauge"), b("S", "Safety gear", "ELT"), b("E", "ELT"),
    ]),

    # ---- IFR Flight Planning & En Route ----
    entry("GRAB CARD", G_IFR, "Required equipment for IFR flight, on top of day/night VFR requirements (FAR 91.205(d)).", SOURCE_GENERAL, [
        b("G", "Generator/Alternator"), b("R", "Radio", "appropriate for the route"), b("A", "Attitude indicator"),
        b("B", "Ball", "slip/skid indicator"), b("C", "Clock", "sweep-second or digital"), b("A", "Altimeter", "sensitive, adjustable"),
        b("R", "Rate of turn indicator"), b("D", "Directional gyro"),
    ]),
    entry("CRAFT", G_IFR, "The elements ATC includes in an IFR clearance delivery.", SOURCE_GENERAL, [
        b("C", "Clearance limit"), b("R", "Route"), b("A", "Altitude"), b("F", "Frequency", "departure frequency"), b("T", "Transponder code"),
    ]),
    entry("MARC", G_IFR, "Missed-approach action sequence.", SOURCE_GENERAL, [
        b("M", "Max power"), b("A", "Attitude", "pitch up to climb"), b("R", "Reconfigure", "flaps/gear as appropriate"), b("C", "Communicate", "to ATC"),
    ]),
    entry("5 Cs", G_IFR, "Alternative missed-approach operational sequence, same underlying FAA missed-approach procedure as MARC.", SOURCE_GENERAL, [
        b("C", "Cram", "power"), b("C", "Climb"), b("C", "Clean", "flaps/gear"), b("C", "Cool", "flaps as needed"), b("C", "Call", "ATC"),
    ]),
    entry("6 T's", G_IFR, "Actions when crossing an IFR fix or entering a holding pattern.", SOURCE_GENERAL, [
        b("T", "Turn"), b("T", "Time"), b("T", "Twist", "set the OBS/course"), b("T", "Throttle"), b("T", "Talk", "report to ATC if required"), b("T", "Toggle", "nav source if needed"),
    ]),
    entry("DECR", G_IFR, "Required VOR-check logbook entries (FAR 91.171).", SOURCE_GENERAL, [
        b("D", "Date"), b("E", "Error", "bearing error observed, in degrees"), b("C", "Checkpoint", "place or radial used"), b("R", "Radio technician/Pilot signature"),
    ]),
    entry("MARVELOUS VFR C", G_IFR, "Reports required from an IFR flight not in radar contact, or on request when in radar contact (AIM 5-3-3 / FAR 91.183).", SOURCE_GENERAL, [
        b("M", "Missed approach"), b("A", "Airspeed change", "5% or 10 knots from filed"), b("R", "Reaching a holding fix"),
        b("V", "Vacating an altitude"), b("E", "ETA error", "more than 3 minutes off"), b("L", "Leaving a holding fix"),
        b("O", "Outage", "equipment failure affecting nav/approach"), b("U", "Unforecast weather"), b("S", "Safety of flight", "any hazard"),
        b("V", "VFR-on-top altitude change"), b("F", "Final approach fix inbound"), b("R", "Radio failure"),
        b("C", "Climb/Descent rate unable", "unable to comply with an assigned rate, e.g. 500 fpm"),
    ]),

    # ---- Approaches & Transitions ----
    entry("SHARPTT", G_APPROACH, "When a charted procedure turn (or hold-in-lieu-of-PT) is NOT required before an approach (AIM 5-4-9).", SOURCE_GENERAL, [
        b("S", "Straight-in", "approach cleared"), b("H", "Hold-in-lieu of PT", "charted and flown instead"),
        b("A", "Absence", "of the PT barb on the chart"), b("R", "Radar vectors", "to the final approach course"),
        b("P", "No PT", "\"No PT\" charted on the segment being used"), b("T", "Timed approach", "from a holding fix"),
        b("T", "Teardrop", "course reversal not required when so charted"),
    ]),
    entry("WIRE", G_APPROACH, "Inbound approach briefing setup items.", SOURCE_GENERAL, [
        b("W", "Weather"), b("I", "Instrument setup"), b("R", "Radio frequencies"), b("E", "Entry/Missed approach plan"),
    ]),
    entry("NATS", G_APPROACH, "Commercial/heavy-operations approach briefing items.", SOURCE_GENERAL, [
        b("N", "NOTAMs"), b("A", "Approach chart name"), b("T", "Terrain/Obstacles"), b("S", "Speeds/Special procedures"),
    ]),

    # ---- Weather & Navigation Instrument Errors ----
    entry("ANDS", G_WX_INSTR, "Magnetic compass acceleration/deceleration turning errors (Northern Hemisphere).", SOURCE_GENERAL, [
        b("A", "Accelerate", "= apparent turn toward North"), b("N", "North"), b("D", "Decelerate", "= apparent turn toward South"), b("S", "South"),
    ]),
    entry("UNOS", G_WX_INSTR, "Magnetic compass turning errors during a standard-rate turn (Northern Hemisphere).", SOURCE_GENERAL, [
        b("U", "Undershoot", "when turning to a Northerly heading"), b("N", "North"),
        b("O", "Overshoot", "when turning to a Southerly heading"), b("S", "South"),
    ]),
    entry("COPS", G_WX_INSTR, "Sloshing/dip compass errors during pitch changes.", SOURCE_GENERAL, [
        b("C", "Climb"), b("O", "Overshoot", "compass reads a turn during a climb"), b("P", "Pitch"), b("S", "South", "or reverse, depending on hemisphere/heading"),
    ]),
    entry("High to Low, Look Out Below", G_WX_INSTR,
          "Altimeter temperature/pressure error rhyme: moving from a high pressure or temperature area to a low one without resetting the altimeter means the aircraft's true altitude is LOWER than indicated.",
          SOURCE_GENERAL, []),
    entry("Low to High, Clear the Sky", G_WX_INSTR,
          "Altimeter temperature/pressure error rhyme, the inverse of \"High to Low, Look Out Below\": moving from a low pressure or temperature area to a high one means the aircraft's true altitude is HIGHER than indicated.",
          SOURCE_GENERAL, []),

    # ---- Spatial Disorientation & Illusions ----
    entry("ICEFLAGS", G_SPATIAL, "Vestibular (inner-ear) and visual illusions that cause spatial disorientation.", SOURCE_GENERAL, [
        b("I", "Inversion illusion"), b("C", "Coriolis illusion"), b("E", "Elevator illusion"), b("F", "False horizon"),
        b("L", "Leans"), b("A", "Autokinesis"), b("G", "Graveyard spin/spiral"), b("S", "Somatogravic illusion"),
    ]),
    entry("GAF", G_SPATIAL, "Conditions that commonly produce landing illusions.", SOURCE_GENERAL, [
        b("G", "Ground lighting", "irregular patterns"), b("A", "Atmospheric conditions", "rain/haze"), b("F", "Featureless terrain"),
    ]),

    # ---- Engine Failures & Emergencies ----
    entry("ABCDE", G_ENGINE, "Engine-failure-in-flight checklist flow.", SOURCE_GENERAL, [
        b("A", "Airspeed", "for best glide"), b("B", "Best place to land"), b("C", "Checklist", "attempt a restart"),
        b("D", "Declare", "emergency on 121.5 or squawk 7700"), b("E", "Execute", "landing / emergency shutoff"),
    ]),
    # ALARM is 5 letters (A-L-A-R-M) but only 4 concepts were legible in
    # the source image -- rather than guess which single word maps to
    # which of the two "A"s or force a 5th item that isn't actually
    # there, this stays a plain definition (no breakdown) until the real
    # letter-by-letter mapping can be confirmed.
    entry("ALARM", G_ENGINE, "Engine-fire-during-flight response: Airspeed increase to blow out flames, Air vents closed, Restart checklist bypassed, Mayday call. (Exact letter-by-letter mapping not yet confirmed against a source -- 4 concepts read for 5 letters.)", SOURCE_GENERAL, []),
]


def main():
    existing = set()
    offset = 0
    while True:
        r = requests.get(f"{URL}/rest/v1/dictionary_terms", headers=HEADERS,
                          params={"select": "slug", "limit": 1000, "offset": offset}, timeout=60)
        r.raise_for_status()
        batch = r.json()
        existing.update(row["slug"] for row in batch)
        if len(batch) < 1000:
            break
        offset += 1000

    to_insert = [e for e in ENTRIES if e["slug"] not in existing]
    skipped = [e for e in ENTRIES if e["slug"] in existing]
    print(f"{len(ENTRIES)} total, {len(to_insert)} new, {len(skipped)} already exist (skipped): {[e['term'] for e in skipped]}")

    if to_insert:
        r = requests.post(f"{URL}/rest/v1/dictionary_terms", headers=HEADERS, json=to_insert, timeout=30)
        r.raise_for_status()
        print(f"Inserted {len(r.json())} rows.")


if __name__ == "__main__":
    main()
