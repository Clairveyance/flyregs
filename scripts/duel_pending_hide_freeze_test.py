#!/usr/bin/env python3
"""Settle the "hidden pending invite freezes the duel forever" risk.

The worry: get_my_challenges() filters on `mycp.hidden_at is null`. If an
invitee can set hidden_at on a still-'pending' participant row, the invite
vanishes from their ONLY in-app surface while staying 'pending' in the DB --
and finalize_challenge_if_done() returns early whenever v_pending_count > 0,
so the duel would be frozen for every other participant with nobody able to
clear it.

This drives real disposable accounts with real JWTs (anon key, so RLS and
auth.uid() are genuinely exercised) against the live database and tries every
reachable way to hide a pending invite:

  1. hide_challenge_from_history() while the invite is pending  -> must raise
  2. a direct PostgREST PATCH of challenge_participants.hidden_at -> must fail
  3. after both attempts, the invite must still be visible to the invitee and
     the duel must still be able to reach 'completed' for the challenger

It also covers the LEGITIMATE hide-a-pending-row case (the creator cancelled,
so the challenge is no longer 'active'): that hide must succeed, and it must
not strand anyone, because the duel is already over.

Usage: python3 scripts/duel_pending_hide_freeze_test.py
"""
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import (  # noqa: E402
    make_user, delete_user, rpc, http, opt_in, play, check, note,
    FAILURES, ANON, SERVICE,
)


def my_row(cid, uid):
    """Read the raw participant row with the service key (ground truth)."""
    st, rows = http(
        "GET",
        f"/rest/v1/challenge_participants?challenge_id=eq.{cid}&user_id=eq.{uid}"
        "&select=status,hidden_at,responded_at",
        key=SERVICE,
    )
    return rows[0] if rows else None


def challenge_status(cid):
    st, rows = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
    return rows[0]["status"] if rows else None


def sees(jwt, cid):
    return any(c["challenge_id"] == cid for c in rpc("get_my_challenges", jwt))


def scenario_active_invite():
    """A challenges B; B tries to make the still-pending invite disappear."""
    print("=== Pending invite on an ACTIVE duel cannot be hidden ===")
    a = make_user("hideA")
    b = make_user("hideB")
    created = [a, b]
    try:
        opt_in(a)
        opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 3, "p_item_types": ["pcg"],
        })
        note(f"challenge {cid} created; status={challenge_status(cid)}")

        row = my_row(cid, b["id"])
        check("B's participant row starts 'pending'", row["status"] == "pending", str(row))
        check("B can see the pending invite via get_my_challenges()", sees(b["jwt"], cid))

        # --- attack 1: the hide RPC itself -------------------------------
        raised = None
        try:
            rpc("hide_challenge_from_history", b["jwt"], {"p_challenge_id": cid})
        except RuntimeError as e:
            raised = str(e)
        check("hide_challenge_from_history() REFUSES a pending invite on an active duel",
              raised is not None, "it did NOT raise -- the freeze is real")
        if raised:
            note(f"server rejected the hide: {raised}")

        # --- attack 2: bypass the RPC, PATCH the row directly ------------
        st, body = http(
            "PATCH",
            f"/rest/v1/challenge_participants?challenge_id=eq.{cid}&user_id=eq.{b['id']}",
            key=ANON, jwt=b["jwt"], body={"hidden_at": "now()"},
            headers={"Prefer": "return=representation"},
        )
        note(f"direct PATCH of hidden_at with B's own JWT -> HTTP {st}: {body}")
        row = my_row(cid, b["id"])
        check("direct PATCH did not set hidden_at", row["hidden_at"] is None, str(row))

        # --- nothing moved ----------------------------------------------
        row = my_row(cid, b["id"])
        check("B's row is still 'pending' and NOT hidden",
              row["status"] == "pending" and row["hidden_at"] is None, str(row))
        check("B can STILL see the invite (it never vanished)", sees(b["jwt"], cid))

        # --- and the duel can still finish for A -------------------------
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        play(a, cid, correct=True)
        play(b, cid, correct=False)
        final = challenge_status(cid)
        check("duel reaches 'completed' -- A was never stuck", final == "completed", f"status={final}")
    finally:
        for u in created:
            delete_user(u["id"])


def scenario_declined_then_hidden():
    """The other reachable order: B declines first, THEN hides. Must be fine."""
    print("=== Decline-then-hide leaves nobody stuck ===")
    a = make_user("hideC")
    b = make_user("hideD")
    created = [a, b]
    try:
        opt_in(a)
        opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 3, "p_item_types": ["pcg"],
        })
        # This is exactly what the swipe does for a pending row -- see
        # handleDeleteFromHistory in src/app/challenges/index.tsx.
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": False})
        row = my_row(cid, b["id"])
        check("swipe-on-pending routes to a real decline", row["status"] == "declined", str(row))
        st = challenge_status(cid)
        check("the last invitee declining cancels the duel (nothing left pending)",
              st == "cancelled", f"status={st}")

        # Now the challenge is no longer 'active', so the hide is allowed --
        # and harmless, because the duel is already over.
        rpc("hide_challenge_from_history", b["jwt"], {"p_challenge_id": cid})
        row = my_row(cid, b["id"])
        check("hiding an already-over duel is allowed", row["hidden_at"] is not None, str(row))
        check("hidden for B", not sees(b["jwt"], cid))
        check("still visible for A (per-user hide only)", sees(a["jwt"], cid))
    finally:
        for u in created:
            delete_user(u["id"])


if __name__ == "__main__":
    scenario_active_invite()
    scenario_declined_then_hidden()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("All checks passed.")
