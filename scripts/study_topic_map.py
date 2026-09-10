#!/usr/bin/env python3
"""The Study-Mode TOPIC axis: one topic per study item, derived from its id.

WHY A DERIVATION AND NOT JUST THE COLUMN
`study_facts.category` is hand-assigned and exists on 1,000 of 41,328 rows.
Filtering on the column alone would collapse the study pool from 41k to at
most 113 for any one topic -- a filter that looks broken. So the topic axis is
DERIVED per item (a FAR section, an AIM paragraph, a 49 CFR section), which is
also the right grain: a study card is the item, not the question.

HOW IT IS TRUSTED
The 1,000 authored rows are the test oracle. `--score` replays this mapping
against the 355 items a human actually labelled and reports every disagreement.
The mapping is not "probably right" -- it is measured against hand-labelled
truth, and the disagreements are listed so they can be judged one at a time.

WHAT IS DELIBERATELY NOT COVERED
ac / pcg / dictionary items return NULL: an Advisory Circular or a glossary
term has no natural place on a regulatory-topic axis, and inventing one would
be worse than leaving it out. When a topic filter is active those item types
are excluded, and the Study screen says so -- the CONTENT filter is how you
reach them.
"""
import json, os, re, sys

# ---------------------------------------------------------------- AIM
# Chapter, then section where the chapter genuinely splits. AIM chapters are
# already a topic taxonomy, which is why this is short.
AIM_CHAPTER = {
    "1": "Navigation", "2": "Airport Operations", "3": "Airspace",
    "4": "ATC Communications & Clearances", "5": "IFR Procedures",
    "6": "Emergency Procedures", "7": "Weather & Safety of Flight",
    "8": "Medical & Fitness", "9": "Navigation",
    "10": "Airport Operations", "11": "Remote Pilot Operations",
}
AIM_SECTION = {
    ("2", "3"): "Airport Operations",          # markings/signs folded into Airport Ops
    ("2", "1"): "Airport Operations",
    ("4", "3"): "Airport Operations",
    ("4", "5"): "Navigation",
    ("5", "1"): "Flight Planning",
    ("5", "2"): "ATC Communications & Clearances",
    ("5", "6"): "Airspace",                    # ADIZ / national security
    ("7", "6"): "Weather & Safety of Flight",
    ("10", "1"): "IFR Procedures",
}
# Paragraph-level, where the section itself straddles two topics.
AIM_PARAGRAPH = {
    "3-5-1": "Airport Operations",             # airport advisory services
    "4-1-9":  "Airport Operations",            # traffic advisory practices
    "4-1-20": "Required Documents & Equipment",# transponder operation
    "4-3-22": "IFR Procedures",                # practice instrument approaches
    "5-3-3":  "ATC Communications & Clearances",
    "5-3-4":  "Airspace",                      # airways and route systems
    "5-5-1":  "Right-of-Way & Operating Rules",# pilot/controller roles
    "5-6-13": "Emergency Procedures",          # interception procedures
    "7-3-5":  "IFR Procedures",                # cold temperature altimetry
}

# ---------------------------------------------------------------- FAR
FAR_PART = {
    "1": "Definitions",
    # 13/16 also appear in ADMINISTRATIVE_PARTS below; kept here so the
    # generated SQL emits no branch for them either.
    "13": None, "16": None,
    "21": "Aircraft Certification Standards",
    "23": "Aircraft Certification Standards", "25": "Aircraft Certification Standards",
    "26": "Aircraft Certification Standards", "27": "Aircraft Certification Standards",
    "29": "Aircraft Certification Standards", "31": "Aircraft Certification Standards",
    "33": "Aircraft Certification Standards", "34": "Aircraft Certification Standards",
    "35": "Aircraft Certification Standards", "36": "Aircraft Certification Standards",
    "39": "Maintenance & Airworthiness", "43": "Maintenance & Airworthiness",
    "145": "Maintenance & Airworthiness",
    "45": "Aircraft Registration & Marking", "47": "Aircraft Registration & Marking",
    "48": "Aircraft Registration & Marking", "49": "Aircraft Registration & Marking",
    "60": "Flight Instructors", "141": "Flight Instructors",
    "142": "Flight Instructors", "147": "Flight Instructors",
    "61": "Certificates & Ratings",             # + section overrides below
    "63": "Certificates & Ratings", "65": "Certificates & Ratings",
    "183": "Certificates & Ratings",
    "67": "Medical & Fitness", "68": "Medical & Fitness", "120": "Medical & Fitness",
    "71": "Airspace", "73": "Airspace", "77": "Airspace", "93": "Airspace",
    "95": "Airspace", "97": "IFR Procedures", "99": "Airspace",
    "89": "Remote Pilot Operations", "107": "Remote Pilot Operations",
    "91": "Right-of-Way & Operating Rules",     # + section overrides below
    "101": "Right-of-Way & Operating Rules", "103": "Right-of-Way & Operating Rules",
    "105": "Right-of-Way & Operating Rules",
    "110": "Air Carrier & Commercial Operations", "119": "Air Carrier & Commercial Operations",
    "121": "Air Carrier & Commercial Operations", "125": "Air Carrier & Commercial Operations",
    "129": "Air Carrier & Commercial Operations", "135": "Air Carrier & Commercial Operations",
    "136": "Air Carrier & Commercial Operations", "137": "Air Carrier & Commercial Operations",
    "139": "Airport Operations",
    "150": "Airport Operations", "151": "Airport Operations", "152": "Airport Operations",
    "155": "Airport Operations", "156": "Airport Operations", "157": "Airport Operations",
    "158": "Airport Operations", "161": "Airport Operations", "169": "Airport Operations",
    "171": "Navigation",
    # Checked each of these against its own §.1 text rather than guessing from
    # the part number:
    "3": "Maintenance & Airworthiness",          # records about TC'd products
    "5": "Air Carrier & Commercial Operations",  # SMS for part 119 holders
    "38": "Aircraft Certification Standards",    # engine emission requirements
    "111": "Certificates & Ratings",             # Pilot Records Database
    "117": "Air Carrier & Commercial Operations",# flight/duty & rest limits
    "133": "Air Carrier & Commercial Operations",# rotorcraft external-load ops
    "153": "Airport Operations",                 # ASI access to airports
    "170": "Navigation",                         # NAVAID establishment criteria
    # 2026-09-10: two parts that WERE unmapped but are genuine study material,
    # found when every FAR section acquired a hand-assigned category and these
    # two turned out to be the only unmapped ones a pilot would ever study:
    "22": "Aircraft Certification Standards",     # light-sport airworthiness
    "189": "ATC Communications & Clearances",     # FSS message handling
    "194": "Air Carrier & Commercial Operations",
}

# Parts that deliberately have NO study topic. Administrative law -- rulemaking
# procedure, enforcement, claims, protests, fees, insurance. A student never
# studies them, and filing them under the nearest real chip only buries the
# content someone actually opened that chip to find.
#
# This is DATA, not a comment, because build_study_item_topics.py needs the
# same list: authoring assigned these sections a category (the 27-term gate has
# no way to say "not a study topic"), and taking that at face value would put
# 37 part-11 rulemaking sections into "Required Documents & Equipment" and 27
# part-17 procurement sections into "Air Carrier Ops". Kept here so the two
# files cannot drift.
ADMINISTRATIVE_PARTS = {
    "11",                                # rulemaking procedure
    "13", "14", "15", "16", "17",        # enforcement, claims, protests
    "185", "187",                        # fees
    "193",                               # voluntarily submitted information
    "198",                               # aviation insurance
}

# Section-level overrides, matched on the exact section number. Only parts 61
# and 91 need these -- they are the two parts whose sections span many topics,
# and the two a student actually lives in.
# Sections whose topic is not their part's default. ONE flat literal, not a
# series of appends: the first version of this built the map by calling a
# helper repeatedly, and a section named in two lists silently took whichever
# call came last -- which is how 91.155 (VFR weather minimums) ended up filed
# under Airspace. Every entry here is visible in one place.
#
# Parts 61 and 91 need this because their sections genuinely span the whole
# taxonomy; every other part is uniform enough for the part default.
FAR_SECTION = {
    # -- part 61 -------------------------------------------------------------
    "61.2": "Certificates & Ratings",
    "61.13": "Certificates & Ratings",
    "61.15": "Medical & Fitness",
    "61.23": "Medical & Fitness",
    "61.53": "Medical & Fitness",
    "61.35": "Knowledge & Practical Tests", "61.37": "Knowledge & Practical Tests",
    "61.39": "Knowledge & Practical Tests", "61.41": "Knowledge & Practical Tests",
    "61.43": "Knowledge & Practical Tests", "61.45": "Knowledge & Practical Tests",
    "61.47": "Knowledge & Practical Tests", "61.49": "Knowledge & Practical Tests",
    "61.4": "Flight Instructors", "61.64": "Flight Instructors",
    "61.181": "Flight Instructors", "61.183": "Flight Instructors",
    "61.185": "Flight Instructors", "61.187": "Flight Instructors",
    "61.189": "Flight Instructors", "61.191": "Flight Instructors",
    "61.193": "Flight Instructors", "61.195": "Flight Instructors",
    "61.199": "Flight Instructors", "61.211": "Flight Instructors",
    "61.213": "Flight Instructors", "61.215": "Flight Instructors",
    "61.412": "Flight Instructors", "61.413": "Flight Instructors",
    "61.415": "Flight Instructors", "61.419": "Flight Instructors",
    "61.423": "Flight Instructors", "61.427": "Flight Instructors",
    "61.429": "Flight Instructors", "61.405": "Flight Instructors",
    "61.407": "Flight Instructors", "61.409": "Flight Instructors",
    "61.411": "Flight Instructors",
    "61.51": "Logging, Currency & Proficiency",
    "61.55": "Logging, Currency & Proficiency",
    "61.56": "Logging, Currency & Proficiency",
    "61.57": "Logging, Currency & Proficiency",
    "61.58": "Logging, Currency & Proficiency",
    "61.69": "Logging, Currency & Proficiency",
    "61.197": "Logging, Currency & Proficiency",
    "61.217": "Logging, Currency & Proficiency",
    "61.83": "Student Pilot & Solo", "61.85": "Student Pilot & Solo",
    "61.87": "Student Pilot & Solo", "61.89": "Student Pilot & Solo",
    "61.93": "Student Pilot & Solo", "61.94": "Student Pilot & Solo",
    "61.95": "Student Pilot & Solo",
    # -- part 65: mechanic/IA sections are maintenance, not certification ------
    "65.81": "Maintenance & Airworthiness", "65.85": "Maintenance & Airworthiness",
    "65.87": "Maintenance & Airworthiness", "65.91": "Maintenance & Airworthiness",
    "65.93": "Maintenance & Airworthiness", "65.95": "Maintenance & Airworthiness",
    "65.109": "Maintenance & Airworthiness",
    "65.83": "Logging, Currency & Proficiency",
    # -- part 91 ---------------------------------------------------------------
    "91.7": "Maintenance & Airworthiness",
    "91.9": "Required Documents & Equipment",
    "91.17": "Medical & Fitness", "91.19": "Medical & Fitness",
    "91.21": "Required Documents & Equipment",
    "91.25": "Accident Reporting",
    "91.103": "Right-of-Way & Operating Rules",
    "91.107": "Required Documents & Equipment",
    "91.115": "Right-of-Way & Operating Rules",
    "91.117": "Altitudes & Speed Limits", "91.119": "Altitudes & Speed Limits",
    "91.121": "Altitudes & Speed Limits", "91.159": "Altitudes & Speed Limits",
    "91.126": "Airspace", "91.127": "Airspace", "91.129": "Airspace",
    "91.130": "Airspace", "91.131": "Airspace", "91.133": "Airspace",
    "91.135": "Airspace", "91.137": "Airspace", "91.138": "Airspace",
    "91.139": "Airspace", "91.141": "Airspace", "91.143": "Airspace",
    "91.144": "Airspace", "91.145": "Airspace", "91.161": "Airspace",
    "91.155": "VFR Weather Minimums", "91.157": "VFR Weather Minimums",
    "91.151": "Fuel, Oxygen & Life Support",
    "91.167": "Fuel, Oxygen & Life Support",
    "91.211": "Fuel, Oxygen & Life Support",
    "91.153": "Flight Planning",
    "91.123": "ATC Communications & Clearances",
    "91.125": "ATC Communications & Clearances",
    "91.183": "ATC Communications & Clearances",
    "91.185": "ATC Communications & Clearances",
    "91.187": "ATC Communications & Clearances",
    "91.169": "IFR Procedures", "91.171": "IFR Procedures",
    "91.173": "IFR Procedures", "91.175": "IFR Procedures",
    "91.176": "IFR Procedures", "91.177": "IFR Procedures",
    "91.179": "IFR Procedures", "91.181": "IFR Procedures",
    "91.189": "IFR Procedures", "91.191": "IFR Procedures",
    "91.193": "IFR Procedures",
    "91.203": "Required Documents & Equipment",
    "91.205": "Required Documents & Equipment",
    "91.207": "Required Documents & Equipment",
    "91.209": "Required Documents & Equipment",
    "91.213": "Required Documents & Equipment",
    "91.215": "Required Documents & Equipment",
    "91.219": "Required Documents & Equipment",
    "91.221": "Required Documents & Equipment",
    "91.223": "Required Documents & Equipment",
    "91.225": "Required Documents & Equipment",
    "91.227": "Required Documents & Equipment",
    "91.3": "Emergency Procedures",
    "91.303": "Emergency Procedures", "91.307": "Emergency Procedures",
    "91.309": "Emergency Procedures",
    "91.313": "Maintenance & Airworthiness", "91.315": "Maintenance & Airworthiness",
    "91.317": "Maintenance & Airworthiness", "91.319": "Maintenance & Airworthiness",
    "91.401": "Maintenance & Airworthiness", "91.403": "Maintenance & Airworthiness",
    "91.405": "Maintenance & Airworthiness", "91.407": "Maintenance & Airworthiness",
    "91.409": "Maintenance & Airworthiness", "91.411": "Maintenance & Airworthiness",
    "91.413": "Maintenance & Airworthiness", "91.415": "Maintenance & Airworthiness",
    "91.417": "Maintenance & Airworthiness", "91.419": "Maintenance & Airworthiness",
    "91.421": "Maintenance & Airworthiness",
}

# ---------------------------------------------------------------- Advisory Circulars
# RC, 2026-09-08: "what about the ACs? aren't you building Qs in ref to those?
# there's a lot of testable info in those."
#
# ACs were returning NULL, which meant an authored AC question would have been
# INVISIBLE the moment any topic was selected -- the filter excludes untopiced
# items by design. So the axis has to cover them before the questions exist.
#
# Mapped by SUBJECT SERIES, and deliberately by what the FAA says each series
# IS rather than by whichever examples I happened to sample. Series 90 is "Air
# Traffic and General Operating Rules" and series 120 is "Air Carrier and
# Commercial Operator Operations"; picking a topic from three sampled titles
# would have filed 90-100A (RNAV) under Navigation and left its siblings on
# wake vortex and collision avoidance somewhere else.
#
# Series 00 ("General") is left NULL on purpose. It really is general -- a
# quality-control certification program, air medical resource management, the
# Aviation Safety Reporting Program, software assurance -- and inventing one
# topic for those would pollute whichever topic it landed in. 21 ACs.
AC_SERIES = {
    "20": "Aircraft Certification Standards", "21": "Aircraft Certification Standards",
    "23": "Aircraft Certification Standards", "25": "Aircraft Certification Standards",
    "27": "Aircraft Certification Standards", "29": "Aircraft Certification Standards",
    "33": "Aircraft Certification Standards", "35": "Aircraft Certification Standards",
    "36": "Aircraft Certification Standards",
    "39": "Maintenance & Airworthiness", "43": "Maintenance & Airworthiness",
    "145": "Maintenance & Airworthiness",
    "45": "Aircraft Registration & Marking", "47": "Aircraft Registration & Marking",
    "48": "Aircraft Registration & Marking",
    "61": "Certificates & Ratings", "63": "Certificates & Ratings",
    "65": "Certificates & Ratings", "67": "Medical & Fitness",
    "141": "Flight Instructors", "142": "Flight Instructors", "147": "Flight Instructors",
    "71": "Airspace", "73": "Airspace", "77": "Airspace", "93": "Airspace", "99": "Airspace",
    "89": "Remote Pilot Operations", "107": "Remote Pilot Operations",
    "90": "Right-of-Way & Operating Rules",   # FAA series: Air Traffic and General Operating Rules
    "91": "Right-of-Way & Operating Rules",
    "103": "Right-of-Way & Operating Rules", "105": "Right-of-Way & Operating Rules",
    "117": "Air Carrier & Commercial Operations",
    "119": "Air Carrier & Commercial Operations",
    "120": "Air Carrier & Commercial Operations",   # FAA series: Air Carrier and Commercial Operator Operations
    "121": "Air Carrier & Commercial Operations",
    "125": "Air Carrier & Commercial Operations",
    "129": "Air Carrier & Commercial Operations",
    "135": "Air Carrier & Commercial Operations",
    "136": "Air Carrier & Commercial Operations",
    "137": "Air Carrier & Commercial Operations",
    "139": "Airport Operations", "150": "Airport Operations",
    "170": "Navigation", "171": "Navigation",
    "60": "Certificates & Ratings",   # FAA series: Airmen
    "68": "Medical & Fitness",
    "00": None,     # genuinely general -- see the note above
    "183": "Certificates & Ratings",
    "450": None,    # commercial space licensing; no aviation study topic
}


# Document-level overrides, for the same reason FAR_SECTION exists: the series
# is the right default and the wrong answer for the ACs a pilot actually studies.
# Series 61 is "Airmen", so 61-98E (flight reviews and IPCs) and 61-107B (high
# altitude operations) both default to Certificates & Ratings, which is where
# neither belongs. Series 90 and 91 sweep taxi procedures, non-towered
# operations and preflight briefings into Right-of-Way & Operating Rules.
#
# Keyed on the number WITHOUT its revision letter, so 61-98E and a future 61-98F
# both match -- an AC's revision letter changes far more often than its subject.
AC_DOCUMENT = {
    "61-98": "Logging, Currency & Proficiency",
    "61-107": "Fuel, Oxygen & Life Support",
    "61-134": "Right-of-Way & Operating Rules",
    "61-142": "Certificates & Ratings",
    "90-23": "Weather & Safety of Flight",
    "90-66": "Airport Operations",
    "90-48": "Right-of-Way & Operating Rules",
    "90-100": "Navigation",
    "90-105": "Navigation",
    "90-114": "Navigation",
    "91-73": "Airport Operations",
    "91-79": "Airport Operations",
    "91-92": "Flight Planning",
    "00-6": "Weather & Safety of Flight",
    "00-45": "Weather & Safety of Flight",
    "00-54": "Weather & Safety of Flight",
    "00-46": "Accident Reporting",
    "00-63": "Weather & Safety of Flight",
    "00-34": "Airport Operations",
    "20-32": "Required Documents & Equipment",
    "20-113": "Required Documents & Equipment",
    "43-9": "Maintenance & Airworthiness",
    "120-12": "Air Carrier & Commercial Operations",
}


# ---------------------------------------------------------------- 49 CFR
CFR49_PART = {
    "830": "Accident Reporting",
    "175": "Hazardous Materials", "171": "Hazardous Materials",
    "172": "Hazardous Materials", "173": "Hazardous Materials",
    "1540": "Aviation Security", "1542": "Aviation Security",
    "1544": "Aviation Security", "1546": "Aviation Security",
    "1550": "Aviation Security", "1552": "Aviation Security",
    "1560": "Aviation Security",
}


# The 26 consolidated sections (see question_bank/README.md) plus two that
# only ever arise by derivation -- no authored question has been written in
# either yet, but thousands of generated items live there.
VALID_TOPICS = {
    "Accident Reporting", "Air Carrier & Commercial Operations",
    "Aircraft Certification Standards", "Aircraft Registration & Marking",
    "Airport Operations", "Airspace", "ATC Communications & Clearances",
    "Altitudes & Speed Limits", "Aviation Security", "Certificates & Ratings",
    "Definitions", "Emergency Procedures", "Flight Instructors",
    "Flight Planning", "Fuel, Oxygen & Life Support", "Hazardous Materials",
    "IFR Procedures", "Knowledge & Practical Tests",
    "Logging, Currency & Proficiency", "Maintenance & Airworthiness",
    "Medical & Fitness", "Navigation", "Remote Pilot Operations",
    "Required Documents & Equipment", "Right-of-Way & Operating Rules",
    "Student Pilot & Solo", "VFR Weather Minimums",
    "Weather & Safety of Flight",
}

# Where this map deliberately disagrees with a hand-assigned category, with
# the reason. Kept as data, not as a silent difference, so --score can still
# fail loudly on a NEW disagreement while these stay quiet.
ACCEPTED_DIVERGENCE = {
    ("far", "61.47"): (
        "Flight Instructors",
        "61.47 is entirely the EXAMINER's status during a practical test. A "
        "DPE is not a flight instructor, and someone filtering Flight "
        "Instructors is not looking for examiner rules."),
    ("far", "91.127"): (
        "Airport Operations",
        "Both are true, but 91.127 is keyed on Class E airspace and its "
        "siblings 91.126/129/130/131 are all Airspace. Consistency inside the "
        "block beats a coin-flip on one section."),
    ("far", "91.25"): (
        "Right-of-Way & Operating Rules",
        "91.25 is the ASRS -- a safety REPORTING program. Accident Reporting "
        "is where a pilot looks for it; 'operating rules' is where it would "
        "disappear."),
}


def topic(item_type: str, item_id: str):
    if not item_id:
        return None
    if item_type == "aim":
        m = re.match(r"^(\d+)-(\d+)-", item_id)
        if not m:
            return None
        ch, sec = m.group(1), m.group(2)
        return (AIM_PARAGRAPH.get(item_id)
                or AIM_SECTION.get((ch, sec))
                or AIM_CHAPTER.get(ch))
    if item_type == "far":
        if item_id in FAR_SECTION:
            return FAR_SECTION[item_id]
        part = item_id.split(".")[0]
        return FAR_PART.get(part)
    if item_type == "ac":
        # strip the trailing revision letter: "61-98E" -> "61-98"
        base = re.match(r"^(\d+-\d+)", item_id)
        if base and base.group(1) in AC_DOCUMENT:
            return AC_DOCUMENT[base.group(1)]
        # "61-65K" -> 61 ; "150/5300-18B" -> 150 ; "450.101-1B" -> 450
        m = re.match(r"^(\d+)", item_id)
        return AC_SERIES.get(m.group(1)) if m else None
    if item_type == "cfr49":
        part = item_id.split(".")[0]
        return CFR49_PART.get(part)
    return None                                  # pcg / dictionary


def q(v):
    return "'" + v.replace("'", "''") + "'"


def emit_sql():
    """Generate study_topic() from THIS map, so the two cannot drift.

    The map lives in Python because that is where it is scored against the
    oracle; the database needs it because get_study_queue filters on it. Hand-
    maintaining both would guarantee they diverge, so the SQL is generated and
    `--verify-sql` re-checks the deployed function against every row.
    """
    L = []
    L.append("-- GENERATED by scripts/study_topic_map.py --emit-sql. DO NOT EDIT BY HAND.")
    L.append("-- Edit the Python map, re-run --score, then regenerate.")
    L.append("--")
    L.append("-- The Study-Mode TOPIC axis. One topic per ITEM (a FAR section, an AIM")
    L.append("-- paragraph, a 49 CFR section), because a study card IS the item.")
    L.append("--")
    L.append("-- study_facts.category is hand-assigned and covers 1,000 of 41,328 rows, so")
    L.append("-- filtering on the column alone would collapse the pool to at most 113 for")
    L.append("-- any one topic. This derives the same axis for the whole regulatory corpus")
    L.append("-- (94.3% of FAR/AIM/49 CFR). ac/pcg/dictionary return NULL on purpose: an")
    L.append("-- ACs are mapped by SUBJECT SERIES (91.5% of AC facts); series 00 (General)")
    L.append("-- and 450 (commercial space) stay null because they genuinely have no single")
    L.append("-- topic. pcg/dictionary stay null: a glossary term has no place on a")
    L.append("-- regulatory-topic axis, and inventing one would be worse than leaving it out.")
    L.append("--")
    L.append("-- Scored against the 1,000 hand-labelled rows: 352/355 items agree, 3 are")
    L.append("-- documented divergences, 0 unexplained, 0 uncovered.")
    L.append("create or replace function public.study_topic(p_item_type text, p_item_id text)")
    L.append("returns text language sql immutable parallel safe as $fn$")
    L.append("  select case")
    # AIM: paragraph, then chapter-section, then chapter
    for k, v in sorted(AIM_PARAGRAPH.items()):
        L.append("    when p_item_type = 'aim' and p_item_id = %s then %s" % (q(k), q(v)))
    for (ch, sec), v in sorted(AIM_SECTION.items()):
        L.append("    when p_item_type = 'aim' and p_item_id like %s then %s"
                 % (q("%s-%s-%%" % (ch, sec)), q(v)))
    for ch, v in sorted(AIM_CHAPTER.items(), key=lambda kv: int(kv[0])):
        L.append("    when p_item_type = 'aim' and split_part(p_item_id, '-', 1) = %s then %s"
                 % (q(ch), q(v)))
    # FAR: exact section, then part
    for k, v in sorted(FAR_SECTION.items()):
        L.append("    when p_item_type = 'far' and p_item_id = %s then %s" % (q(k), q(v)))
    for k, v in sorted(FAR_PART.items()):
        if v is None:
            continue
        L.append("    when p_item_type = 'far' and split_part(p_item_id, '.', 1) = %s then %s"
                 % (q(k), q(v)))
    for k, v in sorted(AC_DOCUMENT.items()):
        L.append("    when p_item_type = 'ac' and substring(p_item_id from '^[0-9]+-[0-9]+') = %s then %s"
                 % (q(k), q(v)))
    for k, v in sorted(AC_SERIES.items(), key=lambda kv: (-len(kv[0]), kv[0])):
        if v is None:
            continue
        L.append("    when p_item_type = 'ac' and substring(p_item_id from '^[0-9]+') = %s then %s"
                 % (q(k), q(v)))
    for k, v in sorted(CFR49_PART.items()):
        L.append("    when p_item_type = 'cfr49' and split_part(p_item_id, '.', 1) = %s then %s"
                 % (q(k), q(v)))
    L.append("    else null")
    L.append("  end;")
    L.append("$fn$;")
    L.append("")
    L.append("comment on function public.study_topic(text, text) is")
    L.append("  'Study-Mode topic axis, generated by scripts/study_topic_map.py. "
             "Returns null for ac/pcg/dictionary and for administrative FAR parts "
             "(11, 13-17, 185, 187, 193, 198), which have no study topic.';")
    L.append("")
    L.append("grant execute on function public.study_topic(text, text) to authenticated, anon;")
    return "\n".join(L)


def main():
    if "--emit-sql" in sys.argv:
        print(emit_sql()); return 0
    if "--score" not in sys.argv:
        print(__doc__); return 0
    here = os.path.dirname(os.path.abspath(__file__))
    oracle = json.load(open(sys.argv[sys.argv.index("--score") + 1]))
    agree = disagree = uncovered = accepted = 0
    misses = []
    bad_topic = []
    for row in oracle:
        want = set(row["cats"].split("||"))
        got = topic(row["item_type"], row["item_id"])
        if got is not None and got not in VALID_TOPICS:
            bad_topic.append((row["item_type"], row["item_id"], got))
        key = (row["item_type"], row["item_id"])
        if got is None:
            uncovered += 1; misses.append(("UNCOVERED", row["item_type"], row["item_id"], "|".join(sorted(want)), "-"))
        elif got in want:
            agree += 1
        elif key in ACCEPTED_DIVERGENCE and ACCEPTED_DIVERGENCE[key][0] in want:
            accepted += 1
        else:
            disagree += 1; misses.append(("DISAGREE", row["item_type"], row["item_id"], "|".join(sorted(want)), got))
    tot = len(oracle)
    print("Scored against %d hand-labelled items:" % tot)
    print("   agree      %4d  (%.1f%%)" % (agree, 100 * agree / tot))
    print("   accepted   %4d  (documented divergences, see ACCEPTED_DIVERGENCE)" % accepted)
    print("   disagree   %4d" % disagree)
    print("   uncovered  %4d" % uncovered)
    if bad_topic:
        print()
        print("   *** %d item(s) mapped to a topic that is not a real section:" % len(bad_topic))
        for b in bad_topic[:10]:
            print("       %-6s %-10s -> %r" % b)
        return 1
    if "--list" in sys.argv:
        print()
        for m in sorted(misses):
            print("   %-9s %-6s %-10s want=%-52s got=%s" % m)
    return 1 if (disagree or uncovered) else 0


if __name__ == "__main__":
    sys.exit(main())
