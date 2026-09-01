"""Insert the hand-authored question batch into study_facts.

Idempotent: relies on the existing UNIQUE (item_type, item_id, question), so
re-running inserts only genuinely new questions.

source_quote is NOT NULL by design in this table, and that is a useful forcing
function -- every authored question must point at real text in the reg. Quotes
are auto-extracted from the section's own body_text by answer-overlap, and any
question whose answer could not be matched to a sentence gets a hand-written
verbatim quote in MANUAL_QUOTES below. A question that ends up in neither
bucket is NOT inserted; it is reported, because an unsupportable question is
exactly what we are trying to stop shipping.
"""
import sys, re
sys.path.insert(0, "scripts")
from author_fact_deck import mgmt_sql
import importlib

# Which box's file to load. One module per box keeps each batch reviewable.
MODULE = sys.argv[sys.argv.index('--module') + 1] if '--module' in sys.argv else 'authored_private_questions'
Q = importlib.import_module(MODULE).Q

MODEL = "claude-opus-5 (authored in-session, verified against far_sections.body_text)"

MANUAL_QUOTES = {
 ("61.113","Under BasicMed, what are the aircraft limits?"):
   "The aircraft is authorized to carry not more than 7 occupants, has a maximum takeoff weight of not more than 12,500 pounds, is operated with no more than 6 passengers on board, and is not a transport category rotorcraft certified to airworthiness standards under part 29 of this chapter",
 ("91.17","What blood alcohol concentration disqualifies a person from acting as a crewmember, regardless of time elapsed?"):
   "While having an alcohol concentration of 0.04 or greater in a blood or breath specimen.",
 ("61.56","How current must a flight review be to act as pilot in command?"):
   "no person may act as pilot in command of an aircraft unless, since the beginning of the 24th calendar month before the month in which that pilot acts as pilot in command, that person has ... accomplished a flight review",
 ("91.159","Flying VFR on a magnetic course of 090 degrees above 3,000 feet AGL, what cruising altitude is appropriate?"):
   "On a magnetic course of zero degrees through 179 degrees, any odd thousand foot MSL altitude + 500 feet (such as 3,500, 5,500, or 7,500)",
 ("91.159","You are cruising VFR at 2,500 feet AGL on a magnetic course of 270 degrees. Must you fly an even thousand plus 500?"):
   "each person operating an aircraft under VFR in level cruising flight more than 3,000 feet above the surface shall maintain the appropriate altitude or flight level prescribed below",
 ("91.126","Approaching to land at a non-towered airport in Class G, which direction must turns be made?"):
   "Each pilot of a powered fixed-wing aircraft must make all turns to the left unless the airport displays approved light signals or visual markings indicating that turns should be made to the right",
 ("91.207","When must an emergency locator transmitter battery be replaced or recharged?"):
   "When the transmitter has been in use for more than 1 cumulative hour; or ... When 50 percent of their useful life (or, for rechargeable batteries, 50 percent of their useful life of charge) has expired",
 ("91.409","You rent an airplane from a flight school and fly it solo for personal travel. Does it need a 100-hour inspection?"):
   "no person may operate an aircraft carrying any person (other than a crewmember) for hire, and no person may give flight instruction for hire in an aircraft which that person provides, unless within the preceding 100 hours of time in service the aircraft has received an annual or 100-hour inspection",
 ("91.413","How often must an ATC transponder be tested and inspected?"):
   "No persons may use an ATC transponder ... unless, within the preceding 24 calendar months, the ATC transponder has been tested and inspected and found to comply with appendix F of part 43",
 ("43.3","May a private pilot who owns an aircraft perform preventive maintenance on it?"):
   "the holder of a pilot certificate issued under part 61 may perform preventive maintenance on any aircraft owned or operated by that pilot which is not used under part 121, 129, or 135 of this chapter",
 ("91.307","How recently must a synthetic-fiber emergency parachute have been packed by a certificated rigger?"):
   "Within the preceding 180 days, if its canopy, shrouds, and harness are composed exclusively of nylon, rayon, or other similar synthetic fiber",
  # --- batch 2: derived-answer scenarios. A computed answer (a fuel figure, a
 #     date) can never appear verbatim in the reg, so these carry the GOVERNING
 #     sentence instead. Without one the loader refuses to insert them, which is
 #     the behaviour we want -- it just needs the quote supplied deliberately.
 ("91.151","A day VFR flight will take 2 hours. Your aircraft burns 10 gallons per hour. What is the minimum usable fuel at takeoff?"):
   "No person may begin a flight in an airplane under VFR conditions unless (considering wind and forecast weather conditions) there is enough fuel to fly to the first point of intended landing and, assuming normal cruising speed ... During the day, to fly after that for at least 30 minutes",
 ("61.57","Your last three takeoffs and landings were 100 days ago. May you fly alone today?"):
   "no person may act as a pilot in command of an aircraft carrying persons or of an aircraft certificated for more than one pilot flight crewmember unless that person has made at least three takeoffs and three landings within the preceding 90 days",
 ("91.205","Your landing light burns out before a day VFR flight. Is the aircraft legal to fly?"):
   "For VFR flight during the day, the following instruments and equipment are required: (1) Airspeed indicator. (2) Altimeter. (3) Magnetic direction indicator. (4) Tachometer for each engine. (5) Oil pressure gauge for each engine using pressure system.",
 ("91.409","Your aircraft's annual was signed 15 April 2026. Through what date is it valid?"):
   "no person may operate an aircraft unless, within the preceding 12 calendar months, it has had ... an annual inspection in accordance with part 43 of this chapter and has been approved for return to service by a person authorized by 43.7",
 ("91.207","Your aircraft's ELT has been in use for 45 minutes cumulative. Must the battery be replaced?"):
   "Batteries used in the emergency locator transmitters required by paragraphs (a) and (b) of this section must be replaced (or recharged, if the batteries are rechargeable) ... When the transmitter has been in use for more than 1 cumulative hour",
 ("91.159","You are cruising VFR at 6,500 feet MSL on a magnetic course of 010 degrees. Is your altitude correct?"):
   "When operating below 18,000 feet MSL and ... On a magnetic course of zero degrees through 179 degrees, any odd thousand foot MSL altitude + 500 feet (such as 3,500, 5,500, or 7,500)",
 # --- Instrument box: quotes for answers that paraphrase or span paragraphs ---
 ("61.65","How much cross-country PIC time is required for an instrument-airplane rating?"):
   "50 hours of cross-country time as pilot in command, of which 10 hours must have been in an airplane",
 ("61.65","How recently before the practical test must the 3 hours of instrument flight training be accomplished?"):
   "Three hours of instrument flight training from an authorized instructor in an airplane that is appropriate to the instrument-airplane rating within 2 calendar months before the date of the practical test",
 ("91.177","Over a designated mountainous area with no prescribed minimum altitude, what is the IFR minimum?"):
   "In the case of operations over an area designated as a mountainous area in part 95 of this chapter, an altitude of 2,000 feet above the highest obstacle within a horizontal distance of 4 nautical miles from the course to be flown",
 ("91.175","What three conditions must ALL be met to descend below DA/DH or MDA?"):
   "no pilot may operate an aircraft ... below the authorized MDA or continue an approach below the authorized DA/DH unless (1) The aircraft is continuously in a position from which a descent to a landing on the intended runway can be made at a normal rate of descent using normal maneuvers; (2) The flight visibility is not less than the visibility prescribed in the standard instrument approach being used; and (3) ... at least one of the following visual references for the intended runway is distinctly visible and identifiable to the pilot",
 ("91.175","On approach you see only the approach light system. How low may you descend?"):
   "The approach light system, except that the pilot may not descend below 100 feet above the touchdown zone elevation using the approach lights as a reference unless the red terminating bars or the red side row bars are also distinctly visible and identifiable",
 ("91.171","How recently must a VOR check have been performed to use VOR navigation under IFR?"):
   "Has been operationally checked within the preceding 30 days, and was found to be within the limits of the permissible indicated bearing error set forth in paragraph (b) or (c) of this section",
 ("91.171","What is the maximum permissible bearing error using a VOT or a designated airport surface checkpoint?"):
   "Use, at the airport of intended departure, an FAA-operated or approved test signal ... to check the VOR equipment (the maximum permissible indicated bearing error is plus or minus 4 degrees)",
 ("91.205","Which instruments does 91.205(d) add for IFR beyond the day and night VFR lists?"):
   "For IFR flight, the following instruments and equipment are required: ... Two-way radio communication and navigation equipment suitable for the route to be flown. Gyroscopic rate-of-turn indicator ... Slip-skid indicator. Sensitive altimeter adjustable for barometric pressure. A clock displaying hours, minutes, and seconds ... Generator or alternator of adequate capacity. Gyroscopic pitch and bank indicator (artificial horizon). Gyroscopic direction indicator",
 ("61.87","A student was endorsed for solo in a Cessna 172 on 1 March. On 20 June they want to solo the same aircraft. Is the endorsement valid?"):
   "A student pilot may not operate an aircraft in solo flight unless that student pilot has received an endorsement in the student's logbook for the specific make and model aircraft to be flown by an authorized instructor who gave the training within the 90 days preceding the date of the flight",
 ("61.133","What does a commercial pilot certificate allow?"):
   "A person who holds a commercial pilot certificate may act as pilot in command of an aircraft carrying persons or property for compensation or hire, provided the person is qualified in accordance with this part and with the applicable parts of this chapter that apply to the operation",
 ("61.133","You hold a commercial certificate and want to fly paying passengers on demand in your own aircraft. Is the certificate alone enough?"):
   "provided the person is qualified in accordance with this part and with the applicable parts of this chapter that apply to the operation",
 ("61.189","What records must a flight instructor maintain beyond signing student logbooks?"):
   "A flight instructor must maintain a record in a logbook or a separate document that contains the following: (1) The name of each person whose logbook that instructor has endorsed for solo flight privileges, and the date of the endorsement; and (2) The name of each person that instructor has endorsed for a knowledge test or practical test, and the record shall also indicate the kind of test, the date, and the results",
 ("65.83","What recent experience must a mechanic have to exercise certificate privileges?"):
   "A certificated mechanic may not exercise the privileges of his certificate and rating unless, within the preceding 24 months (a) The Administrator has found that he is able to do that work; or (b) He has, for at least 6 months (1) Served as a mechanic under his certificate and rating; (2) Technically supervised other mechanics; (3) Supervised, in an executive capacity, the maintenance or alteration of aircraft",
 ("43.3","Who may perform maintenance under the supervision of a certificated mechanic or repairman?"):
   "A person working under the supervision of a holder of a mechanic or repairman certificate may perform the maintenance, preventive maintenance, and alterations that his supervisor is authorized to perform, if the supervisor personally observes the work being done to the extent necessary to ensure that it is being done properly and if the supervisor is readily available, in person, for consultation",
}

STOP = set("the a an of to in and or for that this with is are be may must not no any each person aircraft".split())
def sentences(t):
    return [re.sub(r'\s+', ' ', p).strip()
            for p in re.split(r'(?<=[.;])\s+(?=[(A-Z0-9])', (t or '').replace('\n', ' '))
            if 25 < len(p) < 400]
def toks(t): return {w for w in re.findall(r'[a-z0-9]+', t.lower()) if w not in STOP and len(w) > 2}
def lit(s): return "'" + str(s).replace("'", "''") + "'"
def arr(xs): return "array[" + ",".join(lit(x) for x in xs) + "]::text[]"

def main():
    secs = sorted({q[0] for q in Q})
    inlist = ",".join("'" + s + "'" for s in secs)
    body = {r['section_number']: (r['body_text'] or '') for r in
            mgmt_sql(f"select section_number, body_text from far_sections where section_number in ({inlist})")}
    rows, missing = [], []
    for item, cat, typ, ques, ans, dis, expl in Q:
        quote = MANUAL_QUOTES.get((item, ques))
        if not quote:
            best, score = None, 0.0
            for s in sentences(body.get(item, '')):
                ov = len(toks(ans) & toks(s)) / max(len(toks(ans)), 1)
                if ov > score: best, score = s, ov
            if score >= 0.34: quote = best
        if not quote:
            missing.append((item, ques[:70])); continue
        rows.append("('far'," + ",".join([lit(item), lit(ques), lit(ans), arr(dis), lit(quote),
                     lit(cat), lit(typ), lit(expl), lit(MODEL)]) + ",'authored','live')")
    print(f"ready: {len(rows)}   unsupportable (NOT inserted): {len(missing)}")
    for m in missing: print("   ", m)
    if rows:
        mgmt_sql("insert into study_facts (item_type,item_id,question,answer,distractors,source_quote,"
                 "category,q_type,explanation,model,origin,status) values\n" + ",\n".join(rows) +
                 "\non conflict (item_type,item_id,question) do nothing")
    print("authored rows now:", mgmt_sql("select count(*) c from study_facts where origin='authored'")[0]['c'])

if __name__ == "__main__":
    print(f"loading {MODULE}")
    main()
