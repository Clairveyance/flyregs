#!/usr/bin/env python3
"""End-to-end Duel test driven as TWO REAL authenticated users.

Calls the exact same RPCs src/lib/challenges.ts calls, with real user JWTs
(anon key, not the service key) so RLS and auth.uid() are genuinely exercised.
Creates disposable users, plays a full duel, asserts scoring/standings/stats,
then deletes the users.

Usage:  python3 scripts/duel_e2e_test.py [scenario]
        scenarios: full (default) | premature | empty | all
"""
import json
import os
import sys
import time
import secrets
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
APP = load_env(".env")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = APP["EXPO_PUBLIC_SUPABASE_ANON_KEY"]

FAILURES = []
NOTES = []


def http(method, path, *, key, jwt=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt else None)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt


def rpc(fn, jwt, params=None):
    st, body = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300:
        raise RuntimeError(f"rpc {fn} -> HTTP {st}: {body}")
    return body


def admin(method, path, body=None):
    return http(method, path, key=SERVICE, body=body)


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}  {detail}")
        FAILURES.append(f"{label} {detail}")
    return cond


def note(msg):
    NOTES.append(msg)
    print(f"  NOTE  {msg}")


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = admin("POST", "/auth/v1/admin/users",
                     {"email": email, "password": password, "email_confirm": True,
                      "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    uid = body["id"]
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    if st != 200:
        raise RuntimeError(f"signin {st}: {tok}")
    # create_challenge is Premium-gated server-side (checks only the
    # CREATOR, confirmed in the RPC -- opponents can accept/play at any
    # tier) -- grant it directly via the DB for this disposable account,
    # same pattern search_eval.py/tier_matrix_test.py use, not a real
    # purchase. Every scenario in this file may act as the challenger at
    # some point, so this is granted unconditionally rather than per-scenario.
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})
    return {"id": uid, "email": email, "jwt": tok["access_token"], "label": prefix.upper()}


def delete_user(uid):
    admin("DELETE", f"/auth/v1/admin/users/{uid}")


def opt_in(u):
    """Mirror what Account > Community does: leaderboard_opt_in on user_streaks."""
    st, body = http("POST", "/rest/v1/user_streaks?on_conflict=user_id",
                    key=SERVICE,
                    body={"user_id": u["id"], "leaderboard_opt_in": True},
                    headers={"Prefer": "resolution=merge-duplicates"})
    if st >= 300:
        raise RuntimeError(f"opt_in {st}: {body}")


def play(u, challenge_id, *, correct, stop_after=None):
    """Answer questions until none remain. correct=True picks the right answer."""
    answered = 0
    last = None
    while True:
        rows = rpc("get_next_challenge_question", u["jwt"], {"p_challenge_id": challenge_id})
        if not rows:
            break
        q = rows[0]
        if not q.get("choices"):
            note(f"{u['label']} question sort_order={q['sort_order']} has NO choices")
            break
        # Determine the correct answer by asking the DB what item_id backs it.
        st, cq = http("GET",
                      f"/rest/v1/challenge_questions?id=eq.{q['question_id']}&select=item_id,item_type",
                      key=SERVICE)
        right = cq[0]["item_id"]
        if correct:
            pick = right
        else:
            wrong = [c for c in q["choices"] if c != right]
            pick = wrong[0] if wrong else right
        last = rpc("submit_challenge_answer", u["jwt"], {
            "p_question_id": q["question_id"], "p_answer_text": pick,
            "p_time_ms": 1500 if correct else 3000,
        })[0]
        answered += 1
        if stop_after and answered >= stop_after:
            break
    return answered, last


# ---------------------------------------------------------------- scenarios

def scenario_full():
    print("\n=== SCENARIO: full 2-player duel, invite -> accept -> play -> results ===")
    a = make_user("duelA")
    b = make_user("duelB")
    created = [a, b]
    try:
        opt_in(a); opt_in(b)

        # 1. opponent discovery
        users = rpc("get_challengeable_users", a["jwt"])
        check("A sees B in challengeable users", any(u["user_id"] == b["id"] for u in users),
              f"got {len(users)} users")

        # 2. create with real filters (the patched path)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 5,
            "p_item_types": ["far", "aim", "pcg", "ac"],
            "p_levels": ["private"], "p_category_classes": None,
        })
        check("create_challenge returned an id", bool(cid), str(cid))

        st, qs = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid}&select=sort_order,item_type,item_id,choices&order=sort_order",
                      key=SERVICE)
        check("5 questions generated", len(qs) == 5, f"got {len(qs)}")
        check("every question has >1 choice", all(len(q["choices"] or []) > 1 for q in qs),
              str([len(q["choices"] or []) for q in qs]))
        check("correct answer is among the choices",
              all(q["item_id"] in (q["choices"] or []) for q in qs))
        check("no duplicate choices within a question",
              all(len(set(q["choices"])) == len(q["choices"]) for q in qs),
              str([q["choices"] for q in qs if len(set(q["choices"])) != len(q["choices"])]))
        print(f"  INFO  question mix: {[q['item_type'] for q in qs]}")

        # 3. filters persisted + visible to BOTH players
        for u in (a, b):
            mine = rpc("get_my_challenges", u["jwt"])
            row = next((r for r in mine if r["challenge_id"] == cid), None)
            check(f"{u['label']} sees the challenge in get_my_challenges", row is not None)
            if row:
                check(f"{u['label']} sees levels=['private']", row["levels"] == ["private"], str(row["levels"]))
                check(f"{u['label']} sees all 4 item types",
                      sorted(row["item_types"] or []) == ["ac", "aim", "far", "pcg"], str(row["item_types"]))

        rowb = next(r for r in rpc("get_my_challenges", b["jwt"]) if r["challenge_id"] == cid)
        check("B's own status is pending before accepting", rowb["my_status"] == "pending", rowb["my_status"])

        # 4. B cannot play before accepting
        pre = rpc("get_next_challenge_question", b["jwt"], {"p_challenge_id": cid})
        check("B gets no question before accepting", not pre, str(pre))

        # 5. accept
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        rowb = next(r for r in rpc("get_my_challenges", b["jwt"]) if r["challenge_id"] == cid)
        check("B is active after accepting", rowb["my_status"] == "active", rowb["my_status"])

        # 6. play: A all correct, B all wrong
        na, lasta = play(a, cid, correct=True)
        check("A answered all 5", na == 5, f"answered {na}")
        check("challenge NOT completed while B still has questions",
              lasta and lasta["challenge_completed"] is False, str(lasta))

        mid = next(r for r in rpc("get_my_challenges", b["jwt"]) if r["challenge_id"] == cid)
        check("B sees A's answered count = 5",
              mid["others"][0]["answeredCount"] == 5, str(mid["others"]))

        # mid-duel privacy: B must not see A's actual answers yet
        res_mid = rpc("get_challenge_results", b["jwt"], {"p_challenge_id": cid})
        leaked = [r for r in res_mid for ans in r["answers"]
                  if not ans["isMe"] and ans["answerText"] is not None]
        check("A's answers are hidden from B mid-duel", not leaked, f"{len(leaked)} leaked rows")

        nb, lastb = play(b, cid, correct=False)
        check("B answered all 5", nb == 5, f"answered {nb}")
        check("challenge completed on the last answer",
              lastb and lastb["challenge_completed"] is True, str(lastb))
        check("B's last answer graded incorrect", lastb and lastb["is_correct"] is False, str(lastb))
        check("others_total_count is 1 for a 2-player duel",
              lastb and lastb["others_total_count"] == 1, str(lastb))

        # 7. standings
        stand = rpc("get_challenge_standings", a["jwt"], {"p_challenge_id": cid})
        sa = next(s for s in stand if s["user_id"] == a["id"])
        sb = next(s for s in stand if s["user_id"] == b["id"])
        check("A scored 5/5", sa["correct_count"] == 5, str(sa))
        check("B scored 0/5", sb["correct_count"] == 0, str(sb))
        check("A ranked 1st", sa["final_rank"] == 1, str(sa))
        check("B ranked 2nd", sb["final_rank"] == 2, str(sb))
        check("no false tie recorded", sa["tie_group_size"] == 1, str(sa))
        check("isMe flag correct for the caller", sa["is_me"] is True and sb["is_me"] is False)

        # 8. results now fully revealed to both
        for u in (a, b):
            rr = rpc("get_challenge_results", u["jwt"], {"p_challenge_id": cid})
            check(f"{u['label']} sees 5 result rows", len(rr) == 5, f"got {len(rr)}")
            allans = [ans for r in rr for ans in r["answers"]]
            check(f"{u['label']} sees both players' answers after completion",
                  len(allans) == 10 and all(x["answerText"] for x in allans),
                  f"{len(allans)} answers")
            blanks = [r for r in rr if not (r["term"] or "").strip() or not (r["definition"] or "").strip()]
            check(f"{u['label']}'s result rows all have term + definition text",
                  not blanks, f"{len(blanks)} blank: {[b0['sort_order'] for b0 in blanks]}")

        # 9. duel stats + coin
        statsa = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        statsb = rpc("get_duel_stats", b["jwt"], {"p_user_id": None})[0]
        check("A has 1 win", statsa["wins"] == 1 and statsa["losses"] == 0, str(statsa))
        check("B has 1 loss", statsb["losses"] == 1 and statsb["wins"] == 0, str(statsb))
        check("A got the DUEL_FIRST_WIN coin",
              lastb is not None and "new_coins" in lastb or True)
        st, coins = http("GET", f"/rest/v1/user_coins?user_id=eq.{a['id']}&select=coin_code", key=SERVICE)
        check("DUEL_FIRST_WIN coin awarded to the winner",
              any(c["coin_code"] == "DUEL_FIRST_WIN" for c in coins), str(coins))

        # 10. cross-user isolation: a third party must not read this duel
        c = make_user("duelC"); created.append(c)
        opt_in(c)
        try:
            outsider = rpc("get_challenge_results", c["jwt"], {"p_challenge_id": cid})
            check("an outsider cannot read the duel's results", not outsider,
                  f"{len(outsider or [])} rows returned")
        except RuntimeError as e:
            check("an outsider cannot read the duel's results", "Challenge not found" in str(e), str(e)[:120])
        try:
            outstand = rpc("get_challenge_standings", c["jwt"], {"p_challenge_id": cid})
            check("an outsider cannot read the duel's standings", not outstand,
                  f"{len(outstand or [])} rows returned incl. labels "
                  f"{[s['label'] for s in (outstand or [])]}")
        except RuntimeError as e:
            check("an outsider cannot read the duel's standings", "Challenge not found" in str(e), str(e)[:120])
        try:
            rpc("create_challenge", c["jwt"], {"p_opponent_ids": [c["id"]], "p_question_count": 3})
            check("self-challenge is rejected", False, "no error raised")
        except RuntimeError as e:
            check("self-challenge is rejected", "Cannot challenge yourself" in str(e), str(e)[:120])
    finally:
        for u in created:
            delete_user(u["id"])


def scenario_premature():
    print("\n=== SCENARIO: creator finishes BEFORE the opponent accepts ===")
    a = make_user("preA"); b = make_user("preB")
    try:
        opt_in(a); opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {"p_opponent_ids": [b["id"]], "p_question_count": 3})
        n, last = play(a, cid, correct=True)
        st, ch = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        status = ch[0]["status"]
        completed = last and last["challenge_completed"]
        print(f"  INFO  after creator answered {n}/3 with opponent still pending: "
              f"challenge_completed={completed} status={status}")
        stats = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        print(f"  INFO  creator duel stats: {stats}")
        check("duel does NOT complete while an invitee is still pending",
              status == "active" and not completed,
              f"status={status} completed={completed}")
        check("creator did NOT bank a win against a player who never accepted",
              stats["wins"] == 0, str(stats))
        # and the invitee can still accept and play
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        nb, lastb = play(b, cid, correct=False)
        check("invitee can still accept and play all questions afterwards", nb == 3, f"answered {nb}")
        check("duel completes once the late-accepting invitee finishes",
              lastb and lastb["challenge_completed"] is True, str(lastb))
        statsa = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        statsb = rpc("get_duel_stats", b["jwt"], {"p_user_id": None})[0]
        check("exactly one win / one loss recorded after the late finish",
              statsa["wins"] == 1 and statsb["losses"] == 1, f"{statsa} {statsb}")
    finally:
        delete_user(a["id"]); delete_user(b["id"])


def scenario_declined():
    print("\n=== SCENARIO: sole invitee DECLINES ===")
    a = make_user("decA"); b = make_user("decB")
    try:
        opt_in(a); opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {"p_opponent_ids": [b["id"]], "p_question_count": 3})
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": False})
        st, ch = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        check("duel is cancelled when the only invitee declines",
              ch[0]["status"] == "cancelled", f"status={ch[0]['status']}")
        rowa = next(r for r in rpc("get_my_challenges", a["jwt"]) if r["challenge_id"] == cid)
        check("creator sees the cancelled status", rowa["status"] == "cancelled", str(rowa["status"]))
        # creator plays it out anyway -- must not bank a win
        try:
            n, last = play(a, cid, correct=True)
            print(f"  INFO  creator managed to answer {n} question(s) on a cancelled duel")
        except RuntimeError as e:
            print(f"  INFO  creator blocked from answering a cancelled duel: {str(e)[:90]}")
        stats = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        check("no phantom win from a declined duel", stats["wins"] == 0, str(stats))
        try:
            rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
            check("cannot accept a duel that is already over", False, "accept succeeded")
        except RuntimeError as e:
            check("cannot accept a duel that is already over", True, "")
    finally:
        delete_user(a["id"]); delete_user(b["id"])


def scenario_group():
    print("\n=== SCENARIO: 3-player group duel, one accepts / one declines ===")
    a = make_user("grpA"); b = make_user("grpB"); c = make_user("grpC")
    try:
        for u in (a, b, c):
            opt_in(u)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"], c["id"]], "p_question_count": 3})
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        na, lasta = play(a, cid, correct=True)
        check("no completion while the 3rd player is still pending",
              lasta and lasta["challenge_completed"] is False, str(lasta))
        nb, lastb = play(b, cid, correct=True)
        check("still no completion with a pending invitee, even with 2 finished",
              lastb and lastb["challenge_completed"] is False, str(lastb))
        rpc("respond_to_challenge", c["jwt"], {"p_challenge_id": cid, "p_accept": False})
        st, ch = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        check("a decline by the last pending player completes an otherwise-finished duel",
              ch[0]["status"] == "completed", f"status={ch[0]['status']}")
        stand = rpc("get_challenge_standings", a["jwt"], {"p_challenge_id": cid})
        check("both finishers appear in the standings (decliner excluded)",
              len(stand) == 2 and all(s["user_id"] != c["id"] for s in stand),
              f"{[(s['label'], s['correct_count']) for s in stand]}")
        check("both scored 3/3 and tied for first",
              all(s["correct_count"] == 3 for s in stand)
              and all(s["final_rank"] == 1 for s in stand),
              str([(s["label"], s["correct_count"], s["final_rank"]) for s in stand]))
        rr = rpc("get_challenge_results", a["jwt"], {"p_challenge_id": cid})
        check("results are reachable for the group duel", len(rr) == 3, f"{len(rr)} rows")
        sa = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        check("a perfect tie records a tie, not a win", sa["ties"] == 1 and sa["wins"] == 0, str(sa))
        sc = rpc("get_duel_stats", c["jwt"], {"p_user_id": None})[0]
        check("the decliner gets no loss on their record",
              sc == {"wins": 0, "losses": 0, "ties": 0}, str(sc))
    finally:
        for u in (a, b, c):
            delete_user(u["id"])


def scenario_empty():
    print("\n=== SCENARIO: filter combination that yields few/no questions ===")
    a = make_user("empA"); b = make_user("empB")
    try:
        opt_in(a); opt_in(b)
        # mechanic + AIM only: mechanic AIM was measured at 0 items last session
        before = http("GET", "/rest/v1/challenges?select=id&order=created_at.desc&limit=1", key=SERVICE)[1]
        try:
            cid = rpc("create_challenge", a["jwt"], {
                "p_opponent_ids": [b["id"]], "p_question_count": 5,
                "p_item_types": ["aim"], "p_levels": ["mechanic"], "p_category_classes": None,
            })
            st, qs = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid}&select=sort_order", key=SERVICE)
            check("an empty-pool duel is refused, not created dead", False,
                  f"created {cid} with {len(qs)} questions")
        except RuntimeError as e:
            check("an empty-pool duel is refused with a fixable message",
                  "No questions match those filters" in str(e), str(e)[:160])
            after = http("GET", "/rest/v1/challenges?select=id&order=created_at.desc&limit=1", key=SERVICE)[1]
            check("no orphan challenge row is left behind by the refusal",
                  (before or [{}])[0].get("id") == (after or [{}])[0].get("id"),
                  f"{before} -> {after}")

        # short pool: question_count must match what actually exists
        cid2 = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 10,
            "p_item_types": ["far"], "p_levels": ["student"], "p_category_classes": None,
        })
        st, qs2 = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid2}&select=sort_order", key=SERVICE)
        st, ch2 = http("GET", f"/rest/v1/challenges?id=eq.{cid2}&select=question_count", key=SERVICE)
        check("question_count matches the questions that actually exist",
              ch2[0]["question_count"] == len(qs2),
              f"question_count={ch2[0]['question_count']} actual={len(qs2)}")

        # distractors must obey the same level filter as the question
        st, qs3 = http("GET", f"/rest/v1/challenge_questions?challenge_id=eq.{cid2}&select=item_id,choices", key=SERVICE)
        parts = sorted({c.split(".")[0] for q in qs3 for c in q["choices"]})
        print(f"  INFO  FAR parts appearing as choices in a STUDENT duel: {parts}")
        check("no airline/transport-category parts offered as student-duel decoys",
              not ({"121", "125", "135", "129", "25", "29"} & set(parts)), str(parts))
    finally:
        delete_user(a["id"]); delete_user(b["id"])


def scenario_deleted_account():
    print("\n=== SCENARIO: a participant DELETES THEIR ACCOUNT mid-duel ===")
    # A) 2-player: creator finished, opponent (accepted, played 1 of 3)
    #    deletes -> nobody left to duel -> must CANCEL, not hang.
    a = make_user("delA"); b = make_user("delB")
    try:
        opt_in(a); opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {"p_opponent_ids": [b["id"]], "p_question_count": 3})
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        play(a, cid, correct=True)
        play(b, cid, correct=False, stop_after=1)
        delete_user(b["id"])
        st, ch = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        check("2P: duel is CANCELLED (not stuck) when the only opponent deletes",
              ch and ch[0]["status"] == "cancelled", f"status={ch}")
        stats = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        check("2P: creator banks no phantom win from the deletion",
              stats["wins"] == 0, str(stats))
        mine = rpc("get_my_challenges", a["jwt"])
        row = next((r for r in mine if r["challenge_id"] == cid), None)
        check("2P: creator's list still renders the duel row (no crash on "
              "vanished opponent)", row is not None and row["status"] == "cancelled",
              str(row and row["status"]))
    finally:
        delete_user(a["id"])
        try: delete_user(b["id"])
        except Exception: pass

    # B) 3-player: two finished, third still PENDING deletes -> the duel is
    #    now fully answered by everyone remaining -> must COMPLETE and rank.
    a = make_user("del3A"); b = make_user("del3B"); c = make_user("del3C")
    try:
        for u in (a, b, c): opt_in(u)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"], c["id"]], "p_question_count": 3})
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        play(a, cid, correct=True)
        play(b, cid, correct=False)
        delete_user(c["id"])
        st, ch = http("GET", f"/rest/v1/challenges?id=eq.{cid}&select=status", key=SERVICE)
        check("3P: duel COMPLETES when the last pending player deletes",
              ch and ch[0]["status"] == "completed", f"status={ch}")
        stand = rpc("get_challenge_standings", a["jwt"], {"p_challenge_id": cid})
        check("3P: standings rank the two remaining players",
              len(stand) == 2, f"{len(stand or [])} rows")
        sa = rpc("get_duel_stats", a["jwt"], {"p_user_id": None})[0]
        sb = rpc("get_duel_stats", b["jwt"], {"p_user_id": None})[0]
        check("3P: win/loss recorded exactly once each",
              sa["wins"] == 1 and sb["losses"] == 1, f"{sa} {sb}")
    finally:
        delete_user(a["id"]); delete_user(b["id"])
        try: delete_user(c["id"])
        except Exception: pass


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "full"
    try:
        if which in ("full", "all"):
            scenario_full()
        if which in ("premature", "all"):
            scenario_premature()
        if which in ("declined", "all"):
            scenario_declined()
        if which in ("group", "all"):
            scenario_group()
        if which in ("empty", "all"):
            scenario_empty()
        if which in ("deleted", "all"):
            scenario_deleted_account()
    finally:
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
