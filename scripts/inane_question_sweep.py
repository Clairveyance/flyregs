#!/usr/bin/env python3
"""Find and quarantine study questions that are accurate but not worth asking.

RC, 2026-09-07: "make sure all Qs are useful and relevant. nothing inane...
def fix any issue that would cause those inane Qs to be allowed into the DB.
none of those types can be allowed in."

The quarantine mechanism already existed and works -- study_facts.status, which
get_study_queue, create_challenge and get_reg_of_the_day all require to be
'live'. 5,648 rows were already flagged as 'trivia' or 'number_recall'. What was
missing is detection: whole CLASSES were still being served, e.g.

    "What phone number can be used to initiate a diplomatic clearance
     with the U.S. State Department?"   -> (202) 453-8390
    "Which ICAO document details PBN navigation specifications?" -> ICAO Doc 9613
    "Which FAA office initiated AC 120-123?"                     -> AFS-200

Every rule below targets what the ANSWER IS, not what the question mentions. A
question that happens to cite TSO-C145 while asking something real must survive;
one whose entire answer IS "TSO-C145" must not. That distinction is the whole
design, and the --sample mode exists to keep checking it stays true.

Deliberately NOT flagged, though they look similar:
  - 1-800-WX-BRIEF and 122.2 -- a pilot really does need those.
  - Any authored row. Those passed a grounding gate and a human wrote them.
"""
import argparse, json, os, re, sys, time
from datetime import date

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
sys.path.insert(0, os.path.join(BASE, "sync"))
from access_matrix_sweep import mgmt                      # noqa: E402
from content_snapshot import SNAPSHOT_DIR                  # noqa: E402

THIS_YEAR = date.today().year

# Numbers a pilot genuinely uses. Exempt from the contact-details rule.
USEFUL_CONTACT = re.compile(
    r"(WX-?BRIEF|1-?800-?992-?7433|LOCKHEED|FLIGHT\s*SERVICE\s*STATION)", re.I)

RULES = []
def rule(name, why):
    def deco(fn):
        RULES.append((name, why, fn)); return fn
    return deco


@rule("contact_details", "a phone, fax, address or URL is a lookup, never a thing to know")
def r_contact(q, a):
    if USEFUL_CONTACT.search(a) or USEFUL_CONTACT.search(q):
        return False
    return bool(
        re.search(r"\(?\d{3}\)?[-. ]\d{3}-\d{4}", a)              # (202) 267-3290
        or re.search(r"\b\d{3}-\d{3}-\d{4}\b", a)
        or re.search(r"https?://|www\.", a)
        or re.search(r"[\w.]+@[\w.]+\.\w+", a)
        or re.search(r"\bP\.?O\.? Box\b", a, re.I)
        or re.search(r"\b\d{4,6}\s+[A-Z][a-z]+\s+(Street|Avenue|Road|Blvd|Boulevard)\b", a)
    )


@rule("document_designator", "the answer is a document's NUMBER, not anything it says")
def r_doc(q, a):
    s = a.strip().strip(".")
    return bool(re.fullmatch(
        r"(?:(?:ICAO\s+)?Doc(?:ument)?\.?\s*\d+[A-Z]?"
        r"|FAA\s+Order\s+[A-Z]*\s*[\d.]+[A-Z]?"
        r"|Order\s+[A-Z]{1,3}\s*[\d.]+[A-Z]?"
        r"|IEEE\s*[\d.]+[A-Z]?"
        r"|RTCA[/ ]?DO-\d+[A-Z]?"
        r"|SAE\s+AS?\d+[A-Z]?"
        r"|MIL-[A-Z]-\d+[A-Z]?(?:\s*\(?or equivalent\)?)?"
        r"|Amendment\s+[\d-]+"
        r"|SFAR\s+(?:No\.\s*)?\d+"
        r"|AC\s*\d+[-.]\d+[A-Z]?"
        r"|Advisory\s+Circular\s+[\d-]+[A-Z]?"
        r")(?:\s*\(or equivalent\))?", s, re.I))
    # NOT flagged, and this is the load-bearing exclusion: a bare "Part 65" or
    # "TSO-C88" answer. Knowing WHICH PART governs dispatcher certificates, or
    # which TSO an altitude digitizer must meet, is exactly the kind of thing a
    # certificate candidate is asked. The first version of this rule swept 252
    # rows and most were those -- "Under which part are aircraft dispatcher
    # certificates issued? -> Part 65" is a good question, not trivia.


@rule("org_unit", "an internal FAA office code tells a pilot nothing about flying")
def r_org(q, a):
    s = a.strip().strip(".")
    return bool(re.fullmatch(r"(?:AFS|AIR|AVS|ANM|ACE|ASW|AGC|AWP|ANE|ASO|AEA|AAL|ATO)-?\d{1,3}"
                             r"(?:\s*,?\s*(?:the\s+)?\w+(\s+\w+){0,4})?", s, re.I))


@rule("expired_provision", "the provision itself lapsed years ago -- nothing left to comply with")
def r_expired(q, a):
    t = q + " " + a
    # A date is only damning when the PROVISION ends at it. "airplanes
    # manufactured before Feb 26, 1985" or "an FSTD qualified on/after May 30,
    # 2008" are APPLICABILITY scopes -- perfectly good questions, and the first
    # version of this rule flagged 405 rows that were nearly all of that shape.
    if re.search(r"\b(manufactured|certificated|type certificat\w+|approved|qualified|"
                 r"issued|applications? made|built|produced|installed|registered)\b",
                 t, re.I):
        return False
    m = re.search(r"\b(until|expires?(?: on)?|no later than|not later than|"
                  r"valid through|in effect until)\b[^.]{0,30}?\b(19\d{2}|20[0-2]\d)\b",
                  t, re.I)
    return bool(m and int(m.group(2)) < THIS_YEAR - 1)


@rule("citation_only_answer", "the answer is a cross-reference; the reader still does not know the rule")
def r_citation(q, a):
    s = a.strip().strip(".")
    return bool(re.fullmatch(
        r"(?:§{1,2}\s*[\d.]+[a-z()\d]*"
        r"(?:\s*(?:,|and|&|through|to|-)\s*(?:§{1,2}\s*)?[\d.]+[a-z()\d]*)*)"
        r"(?:\s*of this chapter)?", s, re.I))


@rule("subpart_letter_answer", "'Subparts D and F' is filing, not knowledge")
def r_subpart(q, a):
    s = a.strip().strip(".")
    return bool(re.fullmatch(
        r"(?:[Ss]ub)?[Pp]arts?\s+[A-Z](?:\s*(?:,|and|&)\s*[A-Z])*", s))


# Acronyms a pilot actually says out loud. Expanding these is weak as a study
# card but it is not INANE, and sweeping them would quietly delete the only
# vocabulary coverage the deck has.
COMMON_ACRONYMS = {
    "VFR", "IFR", "MVFR", "LIFR", "ATC", "ATIS", "AWOS", "ASOS", "METAR", "TAF",
    "NOTAM", "TFR", "ADIZ", "MOA", "TRSA", "CTAF", "UNICOM", "FSS", "ARTCC",
    "TRACON", "ILS", "VOR", "DME", "NDB", "ADF", "GPS", "WAAS", "LAAS", "RNAV",
    "RNP", "LPV", "LNAV", "VNAV", "MDA", "DA", "DH", "MEA", "MOCA", "MORA",
    "MRA", "MCA", "OROCA", "SID", "STAR", "IAF", "FAF", "MAP", "TDZE", "VASI",
    "PAPI", "REIL", "MALSR", "HIRL", "MIRL", "RVR", "AGL", "MSL", "ADS-B",
    "TCAS", "TAWS", "EGPWS", "GPWS", "ELT", "AD", "STC", "TSO", "TC", "PIC",
    "SIC", "CFI", "CFII", "MEI", "ATP", "PTS", "ACS", "IPC", "BFR", "MEL",
    "KIAS", "KTAS", "CAS", "TAS", "AOA", "CG", "MAC", "POH", "AFM", "FBO",
    "TSA", "NTSB", "FAA", "ICAO", "NWS", "AIRMET", "SIGMET", "PIREP", "CRM",
    "ADM", "SRM", "IMSAFE", "PAVE", "ARROW", "GUMPS", "VMC", "IMC", "SVFR",
}


@rule("obscure_acronym", "expanding an acronym nobody uses is vocabulary, not airmanship")
def r_acronym(q, a):
    if not re.search(r"what does the (?:aviation )?(?:acronym|abbreviation|initialism)\b", q, re.I):
        return False
    m = re.search(r"\b([A-Z][A-Z0-9-]{1,6})\b\s+stand for", q)
    return bool(m and m.group(1).upper() not in COMMON_ACRONYMS)


@rule("study_statistic", "a percentage from one study is not a regulation")
def r_stat(q, a):
    return bool(re.search(r"what percentage|what proportion|how many percent", q, re.I)
                and re.search(r"\d+(\.\d+)?\s*%", a))


@rule("deep_paragraph_prompt", "hanging a question on (a)(2)(iii) tests the index, not the rule")
def r_deep(q, a):
    return bool(re.search(r"\([a-z]\)\s*\(\d+\)\s*\((?:i|v|x)+\)", q))


@rule("boundary_coordinate", "a boundary vertex is a chart lookup; nobody navigates from memorised latitudes")
def r_coord(q, a):
    """Found 2026-09-09 while authoring part 95. The mountainous-area and ADIZ
    sections are pure coordinate lists, and the generator dutifully turned their
    vertices into questions: "What is the southernmost latitude/longitude vertex
    listed in the Eastern US Mountainous Area?" -> "32 deg 30' N., 86 deg 25' W."

    No pilot recalls a boundary corner; they read it off a chart. What IS worth
    knowing about those sections -- that the whole State of Alaska is designated
    mountainous, that designation raises IFR obstacle clearance from 1,000 to
    2,000 feet -- is a different question entirely, and is being hand-authored.
    """
    return bool(re.search(r"\d{1,3}\s*°\s*\d{1,2}\s*[\u2032']?\s*[NSEW]\b", str(a)))


def classify(q, a):
    return [n for n, _, fn in RULES if fn(q or "", str(a or ""))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", action="store_true", help="show examples per rule and exit")
    ap.add_argument("--apply", action="store_true", help="flag the hits (snapshot first)")
    ap.add_argument("--limit-sample", type=int, default=6)
    ap.add_argument("--fail-on-hits", action="store_true",
                    help="exit non-zero if anything inane is live (for run_all_audits.sh)")
    a = ap.parse_args()

    rows, off = [], 0
    while True:
        page = mgmt("select id, item_type, item_id, question, answer, status, origin "
                    "from study_facts where status = 'live' and origin <> 'authored' "
                    "order by id limit 5000 offset %d" % off)
        rows += page
        if len(page) < 5000:
            break
        off += 5000

    hits = {}
    for r in rows:
        for name in classify(r["question"], r["answer"]):
            hits.setdefault(name, []).append(r)

    print("Scanned %d live, non-authored questions.\n" % len(rows))
    total = set()
    for name, why, _ in RULES:
        h = hits.get(name, [])
        total.update(x["id"] for x in h)
        print("  %-24s %5d   %s" % (name, len(h), why))
        if a.sample:
            for x in h[:a.limit_sample]:
                print("        [%s %s] %s" % (x["item_type"], x["item_id"], (x["question"] or "")[:88]))
                print("              -> %s" % str(x["answer"])[:74])
            print()
    print("\n  %-24s %5d distinct row(s) -- %.1f%% of the live non-authored bank"
          % ("TOTAL", len(total), 100 * len(total) / max(1, len(rows))))

    if a.fail_on_hits:
        if total:
            print("\nFAIL: %d inane question(s) are live. Run --sample to see them, "
                  "--apply to quarantine." % len(total))
            return 1
        print("\nNothing inane is being served.")
        return 0

    if not a.apply:
        print("\nReport only. --sample to see examples, --apply to quarantine.")
        return 0

    ids = sorted(total)
    if not ids:
        print("nothing to do"); return 0

    # snapshot + exact undo BEFORE any write (no-regression mandate)
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    snap = SNAPSHOT_DIR / ("study_facts_inane_sweep_%s.json" % stamp)
    keep = [r for r in rows if r["id"] in total]
    snap.write_text(json.dumps({"table": "study_facts", "key_column": "id",
                                "taken_at": stamp, "row_count": len(keep),
                                "rows": [{"id": r["id"], "status": r["status"]} for r in keep],
                                "note": "status before the inane-question sweep"},
                               ensure_ascii=False))
    undo = SNAPSHOT_DIR / ("study_facts_inane_sweep_%s.undo.sql" % stamp)
    undo.write_text("-- restores every row this sweep quarantined\nupdate study_facts "
                    "set status = 'live', flag_reason = null where id in (%s);\n"
                    % ",".join("'%s'" % i for i in ids))
    print("\nsnapshot: %s\nundo:     %s" % (snap, undo))

    # one statement per rule so flag_reason records WHICH rule caught it
    for name, _, _ in RULES:
        h = [x["id"] for x in hits.get(name, [])]
        if not h:
            continue
        for i in range(0, len(h), 500):
            chunk = h[i:i + 500]
            mgmt("update study_facts set status='flagged', flag_reason=%s "
                 "where id in (%s) and status='live'"
                 % ("'inane:" + name + "'", ",".join("'%s'" % x for x in chunk)))
    after = mgmt("select status, count(*) as n from study_facts group by 1 order by 2 desc")
    print("\nAFTER: %s" % after)
    return 0


# Guarded: this module is IMPORTED by insert_authored_questions.py so the
# authoring gate and the sweep share one definition of "inane". Without the
# guard, importing it ran main() and hijacked the importer's argv.
if __name__ == "__main__":
    sys.exit(main())
