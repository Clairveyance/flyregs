#!/usr/bin/env python3
"""What happens to a duel nobody finishes?

RC, 2026-09-04: "duel interactions, gameplay, stagnant sets, time-outs, the
whole process."

A duel that hangs is the worst failure this feature has, because it doesn't
error -- it just sits in your list forever, and the other player's does too.
expire_stale_challenges() exists to end them, runs hourly on pg_cron, and
handles four distinct shapes. Nothing tested that it produces the right
OUTCOME for any of them.

That distinction matters more here than almost anywhere else in the app,
because the outcome is permanent: nothing ever reverses a user_duel_stats
increment. A cleanup job that resolves a stalled duel in the wrong direction
records a win the player didn't earn and a loss the other one didn't deserve,
silently, unattended, forever.

THE FOUR SHAPES, and what each should produce:

  (a) invited, never responded            -> that invite is declined
  (b) accepted, never answered a question -> declined
  (b2) THE CREATOR walked away before answering anything -> the whole duel is
       cancelled. Nobody played, so nobody gets a record. This branch was
       added after finding that a creator with zero answers was ranked ABOVE
       an opponent who actually played and had been forfeited by (c) --
       finalize ranks every 'active' participant over every 'forfeited' one
       regardless of score, so the abandoner took the win.
  (c) played some, then walked away       -> forfeited, and the opponent who
       finished wins

Each case is built with two real accounts through the real RPCs, then
backdated past the 24-hour cutoff with the service key -- the only way to
test a time-based job without waiting a day. Nothing else is faked.

Usage: python3 scripts/duel_stagnation_test.py
"""
import secrets
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import (                                        # noqa: E402
    http, rpc, admin, check, make_user, delete_user, opt_in, play,
    URL, ANON, SERVICE, FAILURES,
)

import datetime as _dt
# 48 hours ago: past the job's 24h cutoff, but still inside the 30-day window
# its finalize loop scans. Backdating to an arbitrary old date (I first used
# 2026-01-01) puts the duel OUTSIDE that window, so (c) forfeits the quitter
# and then nothing finalizes -- which looks exactly like a bug in the job and
# is really a bug in the fixture. Worth keeping in mind: a duel genuinely
# stalled for over 30 days would hit that gap for real, but only if the hourly
# cron had been down for a month, since a stall is normally caught within the
# hour.
OLD = (_dt.datetime.utcnow() - _dt.timedelta(hours=48)).strftime("%Y-%m-%dT%H:%M:%SZ")


def backdate(challenge_id):
    """Age every timestamp the expiry job looks at."""
    http("PATCH", f"/rest/v1/challenges?id=eq.{challenge_id}", key=SERVICE,
         body={"created_at": OLD})
    http("PATCH", f"/rest/v1/challenge_participants?challenge_id=eq.{challenge_id}",
         key=SERVICE, body={"invited_at": OLD, "responded_at": OLD})


def age_answers(challenge_id):
    st, qs = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{challenge_id}"
                         f"&select=id", key=SERVICE)
    for q in (qs or []):
        http("PATCH", f"/rest/v1/challenge_answers?challenge_question_id=eq.{q['id']}",
             key=SERVICE, body={"answered_at": OLD})


def run_expiry():
    """The job pg_cron runs hourly. EXECUTE is revoked from anon and
    authenticated, so this goes through the service key -- which is exactly
    how the scheduler reaches it too."""
    st, body = http("POST", "/rest/v1/rpc/expire_stale_challenges", key=SERVICE, body={})
    return st, body


def participants(challenge_id):
    st, rows = http("GET", f"/rest/v1/challenge_participants?challenge_id=eq.{challenge_id}"
                           f"&select=user_id,status,is_creator", key=SERVICE)
    return {r["user_id"]: r for r in (rows or [])}


def challenge_status(challenge_id):
    st, rows = http("GET", f"/rest/v1/challenges?id=eq.{challenge_id}&select=status",
                    key=SERVICE)
    return (rows or [{}])[0].get("status")


def duel_stats(uid):
    st, rows = http("GET", f"/rest/v1/user_duel_stats?user_id=eq.{uid}"
                           f"&select=wins,losses", key=SERVICE)
    r = (rows or [{}])[0]
    return int(r.get("wins") or 0), int(r.get("losses") or 0)


def main():
    a = make_user("stagA")
    b = make_user("stagB")
    opt_in(a)
    opt_in(b)
    made = []
    try:
        print("=== (a) INVITED, NEVER RESPONDED ===")
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        made.append(cid)
        backdate(cid)
        st, changed = run_expiry()
        check("the expiry job ran", st < 300, f"HTTP {st} {changed}")
        p = participants(cid)
        check("the un-answered invite is declined",
              p[b["id"]]["status"] == "declined", str(p[b["id"]]))
        check("...and the duel does not hang as active",
              challenge_status(cid) != "active", challenge_status(cid))

        print("\n=== (b) ACCEPTED, NEVER ANSWERED A QUESTION ===")
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        made.append(cid)
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        # The creator plays their full set, so only B is stalled.
        play(a, cid, correct=True)
        backdate(cid)
        age_answers(cid)
        run_expiry()
        p = participants(cid)
        check("the opponent who accepted but never played is declined",
              p[b["id"]]["status"] == "declined", str(p[b["id"]]))

        print("\n=== (b2) THE CREATOR ABANDONED BEFORE ANSWERING ANYTHING ===")
        # The dangerous one. Before this branch existed the creator was
        # unreachable by every other branch, the duel hung forever, and if the
        # opponent got forfeited by (c) the creator was recorded a WIN with
        # zero answers.
        wins_before, _ = duel_stats(a["id"])
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        made.append(cid)
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        play(b, cid, correct=True)          # B plays, A never does
        backdate(cid)
        age_answers(cid)
        run_expiry()
        check("a duel whose creator never played is cancelled outright",
              challenge_status(cid) == "cancelled", challenge_status(cid))
        wins_after, _ = duel_stats(a["id"])
        check("the abandoning creator is NOT recorded a win",
              wins_after == wins_before, f"{wins_before} -> {wins_after}")

        print("\n=== (c) PLAYED SOME, THEN WALKED AWAY ===")
        b_wins_before, _ = duel_stats(b["id"])
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        made.append(cid)
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        play(b, cid, correct=True)                     # B finishes
        play(a, cid, correct=True, stop_after=1)       # A answers one, stops
        backdate(cid)
        age_answers(cid)
        run_expiry()
        p = participants(cid)
        check("the player who walked away mid-duel is forfeited",
              p[a["id"]]["status"] == "forfeited", str(p[a["id"]]))
        check("the duel is finished, not left active",
              challenge_status(cid) != "active", challenge_status(cid))
        b_wins_after, _ = duel_stats(b["id"])
        check("the player who FINISHED gets the win, not the one who quit",
              b_wins_after == b_wins_before + 1,
              f"B {b_wins_before} -> {b_wins_after}")

        print("\n=== (d) A FRESH DUEL MUST NOT BE TOUCHED ===")
        # The cutoff has to cut. A job that expires everything is as broken as
        # one that expires nothing, and far harder to notice.
        cid = rpc("create_challenge", a["jwt"],
                  {"p_opponent_ids": [b["id"]], "p_question_count": 3,
                   "p_item_types": ["far"]})
        made.append(cid)
        run_expiry()
        p = participants(cid)
        check("a duel created seconds ago is left alone",
              p[b["id"]]["status"] == "pending" and challenge_status(cid) == "active",
              f"{p[b['id']]['status']} / {challenge_status(cid)}")

        print("\n=== (e) THE JOB IS NOT CALLABLE BY A USER ===")
        st, _ = http("POST", "/rest/v1/rpc/expire_stale_challenges",
                     key=ANON, jwt=a["jwt"], body={})
        check("a signed-in user cannot run the expiry job themselves",
              st >= 400, f"HTTP {st}")

    finally:
        for cid in made:
            http("DELETE", f"/rest/v1/challenges?id=eq.{cid}", key=SERVICE)
        for u in (a, b):
            delete_user(u["id"])

    print("\n" + "=" * 62)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("Stalled duels end, they end the right way, and fresh ones are left alone.")


if __name__ == "__main__":
    main()
