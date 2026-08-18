#!/usr/bin/env python3
"""Live verification of Duels' mid-match entitlement handling -- part of
the 2026-08-18 "more full gating checks" sweep (Folders/Notes/Bookmarks/
Saved/Back-up&sync/Duels), specifically re-testing the known bug class:
"Duels gameplay/finalize never re-checking Premium status during an active
match."

This repo's own history (sync/migrations_fix_duel_finalize_entitlement_
check.sql, migrations_fix_submit_challenge_answer_missing_premium_check.sql,
migrations_fix_duel_answer_premium_regression.sql) shows this was fixed,
then over-corrected into a softlock regression, then fixed again to the
final intended design:
  - create_challenge / respond_to_challenge(accept=true): Premium required
    (starting/accepting a NEW duel)
  - get_next_challenge_question / submit_challenge_answer: NO premium
    gate -- gameplay stays open even if a participant's Premium lapses
    mid-duel, so a downgraded participant can still finish and doesn't
    soft-lock their opponent's duel forever
  - finalize_challenge_if_done: re-checks each participant's LIVE
    is_premium immediately before writing any win/loss/tie/coin record --
    a lapsed participant's answers still count toward opponents' correct-
    count comparisons (fair competition), but THEY get no reward

This script proves that design live: B accepts as Premium, gets downgraded
to Pro (non-Premium) mid-duel via a direct entitlement PATCH (simulating a
real subscription lapse -- no re-login needed, matching the JWT-independent
nature of a real RevenueCat downgrade), keeps playing to completion, and the
duel finalizes correctly -- A's own win is recorded normally, B gets no
win/loss/tie/coin recorded despite finishing, and neither player's game
gets stuck.

Usage: python3 scripts/duel_downgrade_midmatch_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import (
    make_user, delete_user, rpc, http, check, note, opt_in, play,
    FAILURES, NOTES, SERVICE, ANON,
)


def downgrade_to_pro(uid):
    http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{uid}", key=SERVICE,
         body={"is_premium": False, "is_pro": True})


def main():
    print("=== Duel mid-match Premium downgrade: gameplay stays open, "
          "finalize withholds reward from the lapsed participant ===")
    a = make_user("dgA")  # stays Premium the whole time
    b = make_user("dgB")  # downgraded mid-duel
    created = [a, b]
    try:
        opt_in(a); opt_in(b)

        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 4,
            "p_item_types": ["far", "aim", "pcg", "ac"],
        })
        check("duel created", bool(cid), str(cid))

        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        rowb = next(r for r in rpc("get_my_challenges", b["jwt"]) if r["challenge_id"] == cid)
        check("B accepted while Premium", rowb["my_status"] == "active", rowb["my_status"])

        # B answers 2 of 4 questions correctly, still Premium.
        n_before, _ = play(b, cid, correct=True, stop_after=2)
        check("B answered 2/4 before downgrading", n_before == 2, f"answered {n_before}")

        # --- Simulate a real mid-duel subscription lapse ---
        downgrade_to_pro(b["id"])
        st, ue = http("GET", f"/rest/v1/user_entitlements?user_id=eq.{b['id']}&select=is_premium,is_pro",
                      key=SERVICE)
        check("B's entitlement is now Pro, not Premium (live DB state)",
              ue and ue[0]["is_pro"] is True and ue[0]["is_premium"] is False, str(ue))

        # B (now lapsed) must still be able to fetch/answer remaining
        # questions -- no gate here by design, or A's duel would freeze.
        q = rpc("get_next_challenge_question", b["jwt"], {"p_challenge_id": cid})
        check("lapsed B can still fetch their next question (no gameplay block)",
              bool(q), str(q))

        # B answers the remaining 2 WRONG (not correct=True) so this duel
        # produces an outright WIN for A, not a tie -- a stricter check on
        # "A's own result is completely unaffected by B's downgrade" than a
        # tie would be, since an outright win also triggers the coin-award
        # branch of finalize_challenge_if_done (ties never award a coin --
        # see the NOTE further down).
        n_after, last_b = play(b, cid, correct=False, stop_after=2)
        check("lapsed B can still submit remaining answers", n_after == 2, f"answered {n_after}")
        check("B's own answers score correctly (wrong) despite being lapsed (real competition)",
              last_b and last_b["is_correct"] is False, str(last_b))

        # A (still Premium) finishes too -- this is the call that will
        # trigger finalize_challenge_if_done to actually complete the duel
        # once both have answered everything.
        n_a, last_a = play(a, cid, correct=True)
        check("A (still Premium) answered all questions", n_a == 4, f"answered {n_a}")
        check("duel reaches completed status -- NOT stuck because of B's downgrade",
              last_a and last_a["challenge_completed"] is True, str(last_a))

        st, chal = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        check("challenges row itself shows status=completed",
              chal and chal[0]["status"] == "completed", str(chal))

        # A answered all 4 correctly, B answered 2 correct + 2 wrong -> A
        # wins outright (2 > 4 is false -- A:4, B:2, no tie).
        stand = rpc("get_challenge_standings", a["jwt"], {"p_challenge_id": cid})
        sa = next(s for s in stand if s["user_id"] == a["id"])
        sb = next(s for s in stand if s["user_id"] == b["id"])
        check("A scored 4/4", sa["correct_count"] == 4, str(sa))
        check("B scored 2/4 (their real answers still count toward the comparison, "
              "not erased by the downgrade)", sb["correct_count"] == 2, str(sb))
        check("A wins outright (rank 1), B ranked 2nd -- no tie",
              sa["final_rank"] == 1 and sb["final_rank"] == 2, str((sa, sb)))

        statsa = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        check("A (still Premium) gets a real recorded WIN despite B being lapsed",
              statsa["wins"] == 1 and statsa["losses"] == 0 and statsa["ties"] == 0, str(statsa))
        st, coinsa_win = http("GET", f"/rest/v1/user_coins?user_id=eq.{a['id']}&select=coin_code", key=SERVICE)
        check("A gets the DUEL_FIRST_WIN coin for their real, unaffected win",
              any(c["coin_code"] == "DUEL_FIRST_WIN" for c in (coinsa_win or [])), str(coinsa_win))
        # get_duel_stats() itself hard-requires the CALLER to be live Premium
        # (raises "Duels requires Premium" otherwise) -- separate from and
        # consistent with the finalize gate, not a bug: it mirrors
        # challenges/index.tsx's own client-side `if (!isPremium)` full-
        # paywall gate, so a real lapsed user would never reach this call in
        # the app anyway. Read user_duel_stats directly (service key) to
        # check what finalize actually wrote for B, independent of whether
        # B could currently call the RPC at all.
        st, rowsb = http("GET", f"/rest/v1/user_duel_stats?user_id=eq.{b['id']}&select=wins,losses,ties",
                         key=SERVICE)
        statsb = rowsb[0] if rowsb else {"wins": 0, "losses": 0, "ties": 0}
        check("B (lapsed at finalize time) gets NO win/loss/tie recorded at all -- not even "
              "the loss they'd otherwise legitimately have -- revenue-integrity backstop skips "
              "them entirely", statsb == {"wins": 0, "losses": 0, "ties": 0}, str(statsb))

        st, coinsb = http("GET", f"/rest/v1/user_coins?user_id=eq.{b['id']}&select=coin_code", key=SERVICE)
        check("B gets no coin (moot here since they lost, but confirms no stray award)",
              not coinsb, str(coinsb))

        # Re-upgrade B back to Premium after the fact: finalize already ran
        # and wrote nothing for them -- confirms this isn't merely a timing
        # race (re-checking again should NOT retroactively grant anything,
        # since finalize_challenge_if_done only runs once per challenge).
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{b['id']}", key=SERVICE,
             body={"is_premium": True, "is_pro": False})
        statsb_after = rpc("get_duel_stats", b["jwt"], {"p_user_id": None})[0]
        check("re-upgrading B afterward does not retroactively grant/backfill anything",
              statsb_after == {"wins": 0, "losses": 0, "ties": 0}, str(statsb_after))
        note("get_duel_stats() itself hard-requires live Premium for the CALLER -- "
             "consistent w/ challenges/index.tsx's client-side full-paywall gate "
             "for non-Premium, not a leak; just means a lapsed user can't self-query "
             "stats via this RPC until re-upgraded (which is what just happened above).")

    finally:
        for u in created:
            delete_user(u["id"])

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
    else:
        print("All duel mid-match downgrade checks passed.")
    for n in NOTES:
        print(f"  note: {n}")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
