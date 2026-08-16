#!/usr/bin/env python3
"""Verify hide_challenge_from_history: after user A hides a completed duel,
(1) it disappears from A's own get_my_challenges(), (2) it still appears
in B's, and (3) user_duel_stats (wins/losses/ties, the thing the
leaderboard and profile stats actually read) is byte-identical for both
users before and after -- the core guarantee RC asked for.

Usage: python3 scripts/duel_delete_history_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import make_user, delete_user, rpc, http, opt_in, check, note, FAILURES, NOTES, SERVICE


def get_stats(jwt):
    return rpc("get_duel_stats", jwt, {"p_user_id": None})


def main():
    print("=== Duel history delete: server-side guarantees ===")
    a = make_user("delA")
    b = make_user("delB")
    created = [a, b]
    try:
        opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 3,
            "p_item_types": ["pcg"],
        })
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})

        # Play both to completion so finalize_challenge_if_done() writes
        # real wins/losses/ties, not just an in-progress duel.
        for u in (a, b):
            while True:
                rows = rpc("get_next_challenge_question", u["jwt"], {"p_challenge_id": cid})
                if not rows:
                    break
                q = rows[0]
                st, cq = http("GET", f"/rest/v1/challenge_questions?id=eq.{q['question_id']}&select=correct_answer,item_id",
                              key=SERVICE)
                right = cq[0]["correct_answer"] or cq[0]["item_id"]
                rpc("submit_challenge_answer", u["jwt"], {
                    "p_question_id": q["question_id"], "p_answer_text": right, "p_time_ms": 1200,
                })

        stats_a_before = get_stats(a["jwt"])
        stats_b_before = get_stats(b["jwt"])
        note(f"A stats before: {stats_a_before}")
        note(f"B stats before: {stats_b_before}")

        mine_a_before = rpc("get_my_challenges", a["jwt"])
        mine_b_before = rpc("get_my_challenges", b["jwt"])
        check("challenge visible in A's history before delete",
              any(c["challenge_id"] == cid for c in mine_a_before))
        check("challenge visible in B's history before delete",
              any(c["challenge_id"] == cid for c in mine_b_before))

        # The actual action under test.
        rpc("hide_challenge_from_history", a["jwt"], {"p_challenge_id": cid})

        mine_a_after = rpc("get_my_challenges", a["jwt"])
        mine_b_after = rpc("get_my_challenges", b["jwt"])
        check("challenge GONE from A's history after A hides it",
              not any(c["challenge_id"] == cid for c in mine_a_after))
        check("challenge STILL visible in B's history (B never hid it)",
              any(c["challenge_id"] == cid for c in mine_b_after))

        stats_a_after = get_stats(a["jwt"])
        stats_b_after = get_stats(b["jwt"])
        check("A's wins/losses/ties byte-identical after hiding their own history",
              stats_a_before == stats_a_after, f"before={stats_a_before} after={stats_a_after}")
        check("B's wins/losses/ties byte-identical (B didn't even hide anything)",
              stats_b_before == stats_b_after, f"before={stats_b_before} after={stats_b_after}")

        # Re-run hide on an already-hidden row -- should be a harmless no-op,
        # not an error (RLS still matches the row, just re-sets hidden_at).
        try:
            rpc("hide_challenge_from_history", a["jwt"], {"p_challenge_id": cid})
            note("re-hiding an already-hidden challenge is a harmless no-op (no error)")
        except Exception as e:
            check("re-hiding an already-hidden challenge should not error", False, str(e))

        # A stranger (not a participant) must not be able to hide it.
        c_stranger = make_user("delC")
        created.append(c_stranger)
        try:
            rpc("hide_challenge_from_history", c_stranger["jwt"], {"p_challenge_id": cid})
            check("non-participant hide_challenge_from_history should raise", False, "did not raise")
        except RuntimeError as e:
            check("non-participant hide_challenge_from_history correctly rejected", "not a participant" in str(e).lower(), str(e))

    finally:
        for u in created:
            delete_user(u["id"])

    print("\n================ SUMMARY ================")
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All checks passed.")
    for n in NOTES:
        print(f"  note: {n}")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
