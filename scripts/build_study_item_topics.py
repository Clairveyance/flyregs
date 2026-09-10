#!/usr/bin/env python3
"""Materialize the Study-Mode topic axis: one row per item, human label wins.

WHY THIS EXISTS
`scripts/study_topic_map.py` derives a topic from an item's ID -- mostly at
PART grain ("everything in part 121 is Air Carrier Ops"). That was the right
call when 355 items had a hand-assigned category and 41,000 did not.

That is no longer the situation. Authoring now covers **every FAR section with
regulatory text**, so 4,472 items carry a category a human chose after reading
the section. Scored against them, the part-grain derivation disagrees on 2,552
-- and on inspection the human is right essentially every time:

    § 121.360  ground proximity warning  ->  derived: Air Carrier Ops
                                             human:   Required Documents & Equipment
    § 135.267  flight time limitations   ->  derived: Air Carrier Ops
                                             human:   Logging, Currency & Proficiency
    § 91.409   inspections               ->  derived: Right-of-Way & Operating Rules
                                             human:   Maintenance & Airworthiness

A part is not a topic. So the human label wins wherever there is one, and the
derivation stays as the fallback for the ~6,400 items nobody has labelled.

THE ONE PLACE THE DERIVATION STILL WINS, AND WHY
"Aircraft Certification Standards" is a live Study topic chip
(src/lib/study.ts) but is NOT one of the 27 categories the authoring gate
accepts. An author labelling § 27.1309 therefore has no way to say
"certification standards" and writes "Maintenance & Airworthiness" instead.
Taking that at face value would dump ~1,360 airframe design rules into the
Maintenance chip, which a mechanic uses to find part 43/39/145 work -- burying
the content they actually came for.

So: where the derivation says "Aircraft Certification Standards", it keeps it.
That is a VOCABULARY BRIDGE, not a judgement call, and it is the only override.

Usage:
  python3 scripts/build_study_item_topics.py --plan   # counts, writes nothing
  python3 scripts/build_study_item_topics.py --apply  # rebuild the table
"""
import os
import sys
import collections

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt  # noqa: E402
from study_topic_map import topic as derived_topic, VALID_TOPICS, ADMINISTRATIVE_PARTS  # noqa: E402

# The single term the authoring vocabulary cannot express. See the docstring.
DERIVATION_WINS = {"Aircraft Certification Standards"}


def is_administrative(item_type, item_id):
    """True for FAR parts that deliberately have no study topic.

    The mirror image of the vocabulary bridge above. The 27-term authoring gate
    cannot say "this is not study material", so every part-11 rulemaking and
    part-17 procurement section carries SOME category. Honouring it would put
    37 rulemaking sections into "Required Documents & Equipment" and 27
    procurement sections into "Air Carrier Ops" -- burying the content a user
    opened that chip to find. The derivation's NULL is the correct answer, and
    it outranks the label here.
    """
    return item_type == "far" and item_id.split(".")[0] in ADMINISTRATIVE_PARTS

# Every item type the Study queue can serve. An item with no facts cannot be
# served, so the table is built from study_facts, not from the corpus tables.
ITEM_SQL = """
  select item_type, item_id,
         mode() within group (order by category) filter (where origin = 'authored'
                                                           and category is not null) as human
  from study_facts
  group by 1, 2
"""


def build():
    rows = mgmt(ITEM_SQL)
    out, stats = [], collections.Counter()
    for r in rows:
        human = r["human"]
        d = derived_topic(r["item_type"], r["item_id"])
        if is_administrative(r["item_type"], r["item_id"]):
            stats["administrative_no_topic"] += 1
            continue
        if d in DERIVATION_WINS:
            topic, src = d, "vocabulary_bridge"
        elif human:
            topic, src = human, "authored"
        elif d:
            topic, src = d, "derived"
        else:
            stats["no_topic"] += 1
            continue
        if topic not in VALID_TOPICS:
            # Never write a topic no chip can select -- it would hide the item.
            stats["rejected_not_a_chip"] += 1
            continue
        stats[src] += 1
        out.append((r["item_type"], r["item_id"], topic, src))
    return out, stats


def q(v):
    return "'" + v.replace("'", "''") + "'"


def apply(rows):
    mgmt("""
      create table if not exists public.study_item_topics (
        item_type text not null,
        item_id   text not null,
        topic     text not null,
        source    text not null,
        primary key (item_type, item_id)
      )""")
    mgmt("""comment on table public.study_item_topics is
            'Study-Mode topic axis, one row per item. Built by
             scripts/build_study_item_topics.py: the hand-assigned category wins,
             study_topic_map.py derives the rest. DO NOT hand-edit -- rerun the
             builder.'""")
    # Build into a staging table and swap, so a partial write can never leave
    # the live axis half-populated (a topic chip would silently show nothing).
    mgmt("drop table if exists public.study_item_topics_staging")
    mgmt("""create table public.study_item_topics_staging
            (like public.study_item_topics including all)""")
    B = 400
    for i in range(0, len(rows), B):
        vals = ",".join("(%s,%s,%s,%s)" % (q(a), q(b), q(c), q(d)) for a, b, c, d in rows[i:i + B])
        mgmt("insert into public.study_item_topics_staging values " + vals)
    n = mgmt("select count(*) c from public.study_item_topics_staging")[0]["c"]
    if n != len(rows):
        raise SystemExit("REFUSING TO SWAP: staged %s of %s rows" % (n, len(rows)))
    mgmt("""begin;
            drop table public.study_item_topics;
            alter table public.study_item_topics_staging rename to study_item_topics;
            commit;""")
    # Grant AND policy, every time, unconditionally.
    #
    # An RLS policy is not a grant, and a grant is not a policy -- this table
    # needs both, and the swap above recreates the table so neither survives.
    # It shipped with RLS on and ZERO policies and still worked, because every
    # caller (get_study_queue and friends) is SECURITY DEFINER and owned by
    # postgres. Any direct call from the client would have silently returned
    # NULL instead of erroring -- the same invisible failure that hid the
    # acs_task_reg_links 403 for a whole session.
    mgmt("grant select on public.study_item_topics to authenticated, anon")
    mgmt("alter table public.study_item_topics enable row level security")
    mgmt("drop policy if exists study_item_topics_public_read on public.study_item_topics")
    mgmt("""create policy study_item_topics_public_read on public.study_item_topics
            for select to anon, authenticated using (true)""")
    return n


def main():
    rows, stats = build()
    print("%d items mapped" % len(rows))
    for k, v in stats.most_common():
        print("   %-22s %6d" % (k, v))
    if "--apply" not in sys.argv:
        print("\n(--plan) nothing written. Re-run with --apply.")
        return 0
    print("\nwrote %d rows to study_item_topics" % apply(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
