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
from authored_private_questions import Q

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
    main()
