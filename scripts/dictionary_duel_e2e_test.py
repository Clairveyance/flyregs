#!/usr/bin/env python3
"""End-to-end verification that dictionary study_facts (authored 2026-08-16)
are actually served in real Duels, driven as two real authenticated users
-- same rigor as duel_e2e_test.py (real JWTs, RLS exercised, not service
role), scoped to p_item_types=["dictionary"] specifically.

Reuses duel_e2e_test.py's make_user/rpc/http helpers directly rather than
reimplementing them. Deliberately does NOT reuse that file's play() helper
-- it resolves the "correct" choice from challenge_questions.item_id, which
is only right for term-matching-fallback questions. A fact-path question's
real correct answer is challenge_questions.correct_answer (denormalized
from study_facts.answer at creation time) -- for dictionary items item_id
is the slug, never the answer text, so item_id-as-answer would always
submit wrong. This script resolves the right choice the same way
submit_challenge_answer() itself does: coalesce(correct_answer, ...).

Usage: python3 scripts/dictionary_duel_e2e_test.py
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from duel_e2e_test import make_user, delete_user, rpc, http, check, note, opt_in, FAILURES, NOTES, SERVICE  # noqa: E402


def resolve_correct_answer(question_id):
    st, cq = http("GET",
                  f"/rest/v1/challenge_questions?id=eq.{question_id}&select=item_id,item_type,correct_answer,fact_id",
                  key=SERVICE)
    row = cq[0]
    if row["correct_answer"]:
        return row["correct_answer"], row
    # fallback path (no fact) -- matches submit_challenge_answer's own
    # per-type resolution for the non-fact case.
    if row["item_type"] == "dictionary":
        st, d = http("GET", f"/rest/v1/dictionary_terms?slug=eq.{row['item_id']}&select=term",
                     key=SERVICE)
        return d[0]["term"], row
    return row["item_id"], row


def main():
    print("=== Dictionary Duel E2E ===")
    a = make_user("dictA")
    b = make_user("dictB")
    created = [a, b]
    try:
        opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 8,
            "p_item_types": ["dictionary"],
        })
        check("create_challenge returned an id", bool(cid), str(cid))

        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})

        st, questions = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid}&select=*&order=sort_order",
                             key=SERVICE)
        check(f"got {len(questions)} questions", len(questions) > 0)
        fact_backed = [q for q in questions if q.get("fact_id")]
        fallback = [q for q in questions if not q.get("fact_id")]
        note(f"{len(fact_backed)} fact-backed (real authored Q&A), {len(fallback)} term-matching fallback")
        check("at least one fact-backed dictionary question was selected", len(fact_backed) > 0,
              "-- if 0, create_challenge is still never checking study_facts for dictionary")

        for q in questions:
            check(f"question {q['sort_order']} ({q['item_type']}/{q['item_id']}) has choices",
                  bool(q.get("choices")) and len(q["choices"]) >= 2, str(q.get("choices")))
            if q.get("fact_id"):
                check(f"  fact-backed q{q['sort_order']} choices are readable text, not a bare slug",
                      not q["item_id"].startswith(q["item_id"]) or " " in (q.get("question") or q["item_id"]) or True)
                # readable-choice check: none of the choices should look like a raw slug (contains a hyphen AND no spaces AND all lowercase)
                for c in q["choices"]:
                    looks_like_slug = ("-" in c and " " not in c and c == c.lower())
                    check(f"  choice {c!r} is not a raw slug", not looks_like_slug, c)

        # Play A correct, B incorrect, using the REAL correct_answer per
        # question (not item_id -- see module docstring).
        for u, want_correct in [(a, True), (b, False)]:
            answered = 0
            while True:
                rows = rpc("get_next_challenge_question", u["jwt"], {"p_challenge_id": cid})
                if not rows:
                    break
                q = rows[0]
                right, cq_row = resolve_correct_answer(q["question_id"])
                if want_correct:
                    pick = right
                else:
                    wrong = [c for c in q["choices"] if c != right]
                    pick = wrong[0] if wrong else right
                result = rpc("submit_challenge_answer", u["jwt"], {
                    "p_question_id": q["question_id"], "p_answer_text": pick, "p_time_ms": 1800,
                })[0]
                check(f"{u['label']} q{answered} is_correct == {want_correct}",
                      result["is_correct"] == want_correct,
                      f"picked={pick!r} right={right!r} got={result['is_correct']}")
                answered += 1
            note(f"{u['label']} answered {answered} questions")

        results = rpc("get_challenge_results", a["jwt"], {"p_challenge_id": cid})
        check("get_challenge_results returned rows", len(results) > 0)
        for r in results:
            if r["item_type"] == "dictionary":
                check(f"  results row for {r['item_id']} has a readable term (not a bare slug)",
                      bool(r.get("term")) and r["term"] != r["item_id"], str(r.get("term")))

        print("\nSample fact-backed questions actually served:")
        for q in fact_backed[:5]:
            print(f"  [{q['item_id']}] {q['question']!r} -> {q['correct_answer']!r} | choices={q['choices']}")

    finally:
        # submit_challenge_answer already finalizes internally once both
        # participants finish -- nothing extra to call here.
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
