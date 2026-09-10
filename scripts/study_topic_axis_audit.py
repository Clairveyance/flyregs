#!/usr/bin/env python3
"""Audit: the Study-Mode topic axis is complete, honest, and reachable.

REPLACES `study_topic_map.py --score` AS THE GATE, AND WHY
That check scored a PART-grain derivation against the hand-assigned
categories. It was the right gate while 355 items had a human label. Once
authoring reached every FAR section the oracle grew to 4,472 items and the
derivation disagreed with the human on 2,552 of them -- because a part is not
a topic (§ 121.360, ground proximity warning equipment, is not "Air Carrier
Ops" just because it lives in part 121). Tuning the derivation to close that
gap was never going to work: the information is in the section text, which the
derivation never reads.

So the axis is now materialized in `study_item_topics` (human label wins,
derivation fills the rest) and this audit guards THAT. Scoring the table
against the labels it was built from would be tautology, so each check below
is something that can actually break:

  1. every topic in the table is a real Study chip (src/lib/study.ts) --
     otherwise the item is filed somewhere no user can select, i.e. hidden
  2. the DEPLOYED study_topic() agrees with the table -- catches someone
     restoring the old generated CASE over the top
  3. no item that had a topic has lost one -- a rebuild must never shrink the
     axis, which would empty a chip silently
  4. where a human labelled an item, production returns the human's label,
     except the two documented bridges -- catches a rebuild that quietly
     re-derives over the top of human judgement
  5. the administrative parts stay OUT -- part 11 rulemaking must not sit in
     "Required Documents & Equipment"
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt  # noqa: E402
from study_topic_map import VALID_TOPICS, ADMINISTRATIVE_PARTS, topic as derived_topic  # noqa: E402
from build_study_item_topics import DERIVATION_WINS  # noqa: E402

fails = []


def check(label, ok, detail=""):
    print("  %s %s%s" % ("PASS " if ok else "FAIL ", label, "  -- " + detail if detail else ""))
    if not ok:
        fails.append(label)


def main():
    rows = mgmt("select item_type, item_id, topic, source from study_item_topics")
    print("study_item_topics: %d rows" % len(rows))
    check("the axis is populated at all", len(rows) > 4000, "%d rows" % len(rows))

    # 1 -- every topic is a chip a user can actually press
    bad = sorted({r["topic"] for r in rows if r["topic"] not in VALID_TOPICS})
    check("every topic is a real Study chip", not bad, "unknown: %s" % bad[:5])

    # 2 -- the deployed function agrees with the table
    drift = mgmt("""
        select count(*) c from study_item_topics t
         where study_topic(t.item_type, t.item_id) is distinct from t.topic""")[0]["c"]
    check("deployed study_topic() matches the table", drift == 0, "%d disagreements" % drift)

    # 3 -- nothing that had a topic lost one
    items = mgmt("select item_type, item_id from study_facts group by 1, 2")
    have = {(r["item_type"], r["item_id"]) for r in rows}
    lost = [(t, i) for t, i in ((x["item_type"], x["item_id"]) for x in items)
            if derived_topic(t, i) is not None
            and not (t == "far" and i.split(".")[0] in ADMINISTRATIVE_PARTS)
            and (t, i) not in have]
    check("no item lost the topic it had", not lost, "%d lost, e.g. %s" % (len(lost), lost[:4]))

    # 4 -- human judgement is not silently re-derived over
    human = mgmt("""
        select item_type, item_id,
               mode() within group (order by category)
                 filter (where origin = 'authored' and category is not null) as cat
          from study_facts group by 1, 2""")
    by_id = {(r["item_type"], r["item_id"]): r for r in rows}
    clobbered = []
    for h in human:
        if not h["cat"]:
            continue
        key = (h["item_type"], h["item_id"])
        got = by_id.get(key)
        if got is None:
            continue                      # covered by check 5 / deliberate NULL
        if got["topic"] == h["cat"]:
            continue
        if got["source"] == "vocabulary_bridge" and got["topic"] in DERIVATION_WINS:
            continue                      # documented: the gate cannot say this word
        clobbered.append((key, h["cat"], got["topic"], got["source"]))
    check("human labels are not silently overridden", not clobbered,
          "%d overridden, e.g. %s" % (len(clobbered), clobbered[:3]))

    # 5 -- administrative parts stay out of real chips
    admin = [r for r in rows
             if r["item_type"] == "far" and r["item_id"].split(".")[0] in ADMINISTRATIVE_PARTS]
    check("administrative FAR parts carry no topic", not admin,
          "%d leaked, e.g. %s" % (len(admin), [(a["item_id"], a["topic"]) for a in admin[:4]]))

    print()
    if fails:
        print("FAILED: " + "; ".join(fails))
        return 1
    print("The Study topic axis is complete, reachable, and human-labelled where a human looked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
