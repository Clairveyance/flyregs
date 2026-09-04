#!/usr/bin/env python3
"""Are the flashcards a real user gets actually worth studying?

RC, 2026-09-04: "flashcard content (needs to be real and interactive, simple,
relevant test-style Q/As, not obscure junk we've had in the past)."

The raw study_facts table is not the answer to that question, and looking at
it is misleading. Ten random live FAR rows pulled while writing this:

    136.1     life preservers on Hawaii commercial air tours
    27.625    fitting factors for welded and scarf wood joints
    158.24    comment period for a Passenger Facility Charge notice
    183.55    ODA Unit member function changes
    13.45     computing time periods in enforcement proceedings

One of those ten was something a pilot could plausibly be asked. But a user
never sees the table -- they see whatever get_study_queue() hands them, and
that RPC weights by relevance before anything reaches a deck. So this audit
walks the REAL path (get_study_queue, then the study_facts_gated overlay that
study.ts applies) and scores the cards that actually arrive.

HOW "OBSCURE" IS DEFINED, WITHOUT AN OPINION
--------------------------------------------
The app already has a data-driven answer: far_relevance_weight(part) returns
how many ACS tasks cite that Part. A Part cited by zero ACS tasks is, by the
FAA's own testing standards, not something a certificate applicant is examined
on. That is the definition used here -- not a hand-written list of parts I
happen to think are boring, which would just be my taste dressed up as a
measurement.

A weight-0 card is not automatically wrong; a Premium user with no filters set
has asked for the whole library. What matters is the RATE, and whether the
level filters actually pull it down. Both are reported.

Also checked, because a card can be relevant and still be a bad card:
  * questions that ask you to recall a document NUMBER rather than a fact --
    the format RC rejected outright ("a lot of our Qs are just asking the
    player to remember the FAR, AC, etc number cold")
  * answers so long they are a paragraph rather than an answer
  * questions with no question in them

Usage:
  python3 scripts/study_card_quality_audit.py            # 8 decks per profile
  python3 scripts/study_card_quality_audit.py --decks 20
"""
import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"}

# A question that asks which document covers something is testing the index,
# not the content. RC rejected this format explicitly.
NUMBER_RECALL = re.compile(
    r"^\s*(which|what)\s+(far|ac|aim|advisory circular|section|part|paragraph|rule)\b",
    re.I)

# How generous a "relevant" answer is allowed to be before it stops being a
# flashcard answer and becomes a passage.
MAX_ANSWER_CHARS = 160


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(URL + path, data=data, method=method,
                               headers={**(headers or {}), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=90) as x:
            t = x.read().decode()
            return x.status, (json.loads(t) if t.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:250]


def far_weights():
    """part -> how many ACS tasks cite it. Zero means never tested."""
    st, rows = call("GET", "/rest/v1/acs_citation_density"
                           "?cited_type=eq.far&select=cited_id,task_count&limit=1000", None, SVC)
    return {r["cited_id"]: r["task_count"] for r in (rows or [])}


def part_of(item_id):
    return item_id.split(".")[0] if "." in item_id else item_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--decks", type=int, default=8)
    args = ap.parse_args()

    weights = far_weights()
    print(f"ACS citation density loaded: {len(weights)} FAR parts carry at least one "
          f"ACS task citation\n")

    email = f"cardq-{int(time.time())}@flyregs.invalid"
    pw = "Tmp" + secrets.token_urlsafe(10) + "!A9"
    st, u = call("POST", "/auth/v1/admin/users",
                 {"email": email, "password": pw, "email_confirm": True}, SVC)
    if st != 200:
        raise SystemExit(f"could not create the probe account: {st} {u}")
    uid = u["id"]
    call("POST", "/rest/v1/user_entitlements",
         {"user_id": uid, "is_pro": True, "is_premium": True},
         {**SVC, "Prefer": "resolution=merge-duplicates,return=minimal"})
    st, tok = call("POST", "/auth/v1/token?grant_type=password",
                   {"email": email, "password": pw}, {"apikey": ANON})
    jwt = {"apikey": ANON, "Authorization": f"Bearer {tok['access_token']}"}

    profiles = [
        ("Private pilot, FAR + AIM", {"p_item_types": ["far", "aim"], "p_levels": ["private"]}),
        ("Instrument, FAR + AIM",    {"p_item_types": ["far", "aim"], "p_levels": ["instrument"]}),
        ("FAR only, no level set",   {"p_item_types": ["far"]}),
        ("No filters at all",        {}),
    ]

    worst = []
    try:
        for label, params in profiles:
            cards, weightless, number_recall, long_answers, empty = [], [], [], [], []
            for _ in range(args.decks):
                st, q = call("POST", "/rest/v1/rpc/get_study_queue",
                             {"p_limit": 20, **params}, jwt)
                if not isinstance(q, list):
                    print(f"  {label}: get_study_queue -> HTTP {st} {q}")
                    break
                by_type = {}
                for r in q:
                    by_type.setdefault(r["item_type"], []).append(r["item_id"])
                facts = {}
                for t, ids in by_type.items():
                    inlist = ",".join(f'"{i}"' for i in ids)
                    st2, rows = call("GET", f"/rest/v1/study_facts_gated?item_type=eq.{t}"
                                            f"&item_id=in.({inlist})"
                                            f"&select=item_id,question,answer", None, jwt)
                    for r in (rows or []):
                        if r.get("question"):
                            facts.setdefault((t, r["item_id"]), r)
                for r in q:
                    key = (r["item_type"], r["item_id"])
                    f = facts.get(key)
                    cards.append(key)
                    if key[0] == "far" and weights.get(part_of(key[1]), 0) == 0:
                        weightless.append(key[1])
                    if not f:
                        continue
                    ques, ans = (f["question"] or "").strip(), (f["answer"] or "").strip()
                    if NUMBER_RECALL.match(ques):
                        number_recall.append((key[1], ques))
                    if len(ans) > MAX_ANSWER_CHARS:
                        long_answers.append((key[1], len(ans)))
                    if not ques or not ans:
                        empty.append(key[1])

            n = len(cards) or 1
            pct = 100 * len(weightless) / n
            print(f"  {label}")
            print(f"     {n} cards over {args.decks} decks")
            print(f"     {len(weightless):>4} ({pct:4.1f}%) from a FAR part with ZERO ACS citations"
                  + (f"  e.g. {sorted(set(weightless))[:6]}" if weightless else ""))
            print(f"     {len(number_recall):>4} ask for a document number rather than a fact")
            print(f"     {len(long_answers):>4} answers longer than {MAX_ANSWER_CHARS} chars")
            print(f"     {len(empty):>4} with an empty question or answer")
            if number_recall:
                for iid, ques in number_recall[:3]:
                    print(f"          {iid}: {ques[:88]}")
            worst.append((label, pct, len(number_recall), len(empty)))
            print()
    finally:
        call("DELETE", f"/auth/v1/admin/users/{uid}", None, SVC)

    print("=" * 74)
    filtered = [w for w in worst if "no level" not in w[0] and "No filters" not in w[0]]
    bad = [w for w in filtered if w[1] > 10]
    empties = [w for w in worst if w[3] > 0]
    if bad:
        print("FAIL: a LEVEL-FILTERED deck should not be pulling from parts the ACS "
              "never cites --")
        for label, pct, _, _ in bad:
            print(f"  {label}: {pct:.1f}%")
    if empties:
        print("FAIL: cards with an empty question or answer reached a deck")
    if not bad and not empties:
        print("Level-filtered decks stay on material the ACS actually tests, and every "
              "card has both a question and an answer.")
        print("Unfiltered decks range wider by design -- that is the user asking for the "
              "whole library, not a defect.")
    sys.exit(1 if (bad or empties) else 0)


if __name__ == "__main__":
    main()
