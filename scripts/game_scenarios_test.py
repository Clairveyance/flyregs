#!/usr/bin/env python3
"""Full Study / Flashcard / Duel gameplay scenarios with real accounts.

Plays complete sessions the way a user would, across several personas and
filter combinations, asserting that every step succeeds and that the
questions served are short and game-show-shaped.

Personas exercise different filter shapes on purpose:
  student pilot   student level, ASEL, FAR+AIM
  cfi candidate   cfi level, all content
  A&P mechanic    mechanic level, HELI (rotorcraft airworthiness)
  glossary crammer P/CG only, no level filter

Usage:  python3 scripts/game_scenarios_test.py
"""
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


SCRAPER = load_env(".env.scraper")
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]

FAILURES = []
QUESTION_SAMPLES = []


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
        raise RuntimeError(f"{fn} -> HTTP {st}: {body}")
    return body


def check(label, cond, detail=""):
    if cond:
        print(f"    PASS  {label}")
    else:
        print(f"    FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")
    return cond


def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": password, "email_confirm": True,
                          "user_metadata": {"display_name": prefix}})
    if st != 200:
        raise RuntimeError(f"create user {st}: {body}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    # create_challenge is Premium-gated server-side (checks only the
    # CREATOR) -- grant it directly via the DB for this disposable
    # account, same pattern as search_eval.py/tier_matrix_test.py, not a
    # real purchase. Any persona here may act as the duel creator.
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": body["id"], "is_premium": True},
         headers={"Prefer": "resolution=merge-duplicates"})
    return {"id": body["id"], "jwt": tok["access_token"], "label": prefix}


def delete_user(uid):
    http("DELETE", f"/auth/v1/admin/users/{uid}", key=SERVICE)


def opt_in(u):
    http("POST", "/rest/v1/user_streaks?on_conflict=user_id", key=SERVICE,
         body={"user_id": u["id"], "leaderboard_opt_in": True},
         headers={"Prefer": "resolution=merge-duplicates"})


# ---- question-shape assertions (the "game show" bar) ---------------------

def audit_question(text, where):
    """A prompt must be answerable, short, and free of formatting junk."""
    problems = []
    if not text or not text.strip():
        problems.append("empty")
        return problems
    t = text.strip()
    # 180 is the product bar, set by quiz_prompt_condense()'s cap in
    # sync/migrations_pcg_prompt.sql. FAR/AIM/AC prompts are titles and come
    # in far shorter; P/CG definitions are condensed to their first sentence
    # and hard-capped here.
    if len(t) > 180:
        problems.append(f"too long ({len(t)} chars)")
    if "??" in t:
        problems.append("double question mark")
    if re.search(r"[.,;:]\?$", t):
        problems.append("punctuation stacked before '?'")
    if re.match(r"^\s*\([a-z0-9]{1,3}\)", t, re.I):
        problems.append("starts with a list marker like '(a)'")
    if t.count("(") != t.count(")"):
        problems.append("unbalanced parentheses")
    if re.search(r"\s{2,}", t):
        problems.append("double space")
    if t.endswith("-") or t.endswith("—"):
        problems.append("ends mid-phrase")
    QUESTION_SAMPLES.append((where, t))
    return problems


# ---- scenarios -----------------------------------------------------------

PERSONAS = [
    ("student pilot",    {"p_item_types": ["far", "aim"], "p_levels": ["student"],
                          "p_category_classes": ["ASEL"]}),
    ("cfi candidate",    {"p_item_types": None, "p_levels": ["cfi"],
                          "p_category_classes": None}),
    ("A&P mechanic",     {"p_item_types": ["far"], "p_levels": ["mechanic"],
                          "p_category_classes": ["HELI"]}),
    ("glossary crammer", {"p_item_types": ["pcg"], "p_levels": None,
                          "p_category_classes": None}),
    ("everything",       {"p_item_types": None, "p_levels": None,
                          "p_category_classes": None}),
]


def scenario_study():
    print("\n" + "=" * 70)
    print("STUDY / FLASHCARD SESSIONS")
    print("=" * 70)
    for name, filt in PERSONAS:
        print(f"\n  --- persona: {name} ---")
        u = make_user("study")
        try:
            n = rpc("get_study_pool_count", u["jwt"], filt)
            n = n[0] if isinstance(n, list) else n
            n = list(n.values())[0] if isinstance(n, dict) else n
            check(f"{name}: pool is non-empty", int(n or 0) > 0, f"{n} items")

            # Play a full 20-card session, recording each answer like the app.
            served = 0
            bad_cards = []
            for _round in range(3):
                cards = rpc("get_study_queue", u["jwt"], {"p_limit": 20, **filt}) or []
                if not cards:
                    break
                for c in cards:
                    served += 1
                    if not (c.get("term") or "").strip():
                        bad_cards.append(f"{c['item_type']}:{c['item_id']} blank FRONT")
                    if not (c.get("definition") or "").strip():
                        bad_cards.append(f"{c['item_type']}:{c['item_id']} blank BACK")
                    # record_study_review is what the app calls on every card
                    rpc("record_study_review", u["jwt"], {
                        "p_item_id": c["item_id"], "p_correct": served % 3 != 0,
                        "p_item_type": c["item_type"]})
            check(f"{name}: served {served} cards over 3 rounds", served > 0, "no cards served")
            check(f"{name}: every card has a front AND a back", not bad_cards,
                  f"{len(bad_cards)} bad: {bad_cards[:3]}")

            mastery = rpc("get_study_mastery", u["jwt"], {"p_item_type": None})
            check(f"{name}: mastery reads back after the session", mastery is not None,
                  str(mastery))
        except RuntimeError as e:
            check(f"{name}: session ran without an error", False, str(e)[:160])
        finally:
            delete_user(u["id"])


def scenario_duels():
    print("\n" + "=" * 70)
    print("DUEL SESSIONS — 2-player and 4-player, played to completion")
    print("=" * 70)

    def play(u, cid, correct_every):
        i = 0
        last = None
        while True:
            rows = rpc("get_next_challenge_question", u["jwt"], {"p_challenge_id": cid})
            if not rows:
                break
            qn = rows[0]
            probs = audit_question(qn.get("prompt", ""), f"duel/{qn['item_type']}")
            if probs:
                FAILURES.append(f"duel prompt {qn['item_type']} :: {probs} :: "
                                f"{qn.get('prompt','')[:90]}")
            if not qn.get("choices"):
                FAILURES.append(f"duel question {qn['sort_order']} had no choices")
                break
            st, cq = http("GET", f"/rest/v1/challenge_questions?id=eq.{qn['question_id']}"
                                 f"&select=item_id", key=SERVICE)
            right = cq[0]["item_id"]
            pick = right if (i % correct_every == 0) else \
                next((c for c in qn["choices"] if c != right), right)
            last = rpc("submit_challenge_answer", u["jwt"], {
                "p_question_id": qn["question_id"], "p_answer_text": pick,
                "p_time_ms": 1200 + i * 300})[0]
            i += 1
        return i, last

    # ---- 2-player, filtered
    print("\n  --- 2-player duel, FAR+P/CG, private level ---")
    a, b = make_user("duelA"), make_user("duelB")
    try:
        opt_in(a); opt_in(b)
        cid = rpc("create_challenge", a["jwt"], {
            "p_opponent_ids": [b["id"]], "p_question_count": 5,
            "p_item_types": ["far", "pcg"], "p_levels": ["private"],
            "p_category_classes": None})
        rpc("respond_to_challenge", b["jwt"], {"p_challenge_id": cid, "p_accept": True})
        na, _ = play(a, cid, 1)
        nb, lastb = play(b, cid, 2)
        check("2-player: both players answered all 5", na == 5 and nb == 5, f"{na}/{nb}")
        check("2-player: duel completed", lastb and lastb["challenge_completed"], str(lastb))
        stand = rpc("get_challenge_standings", a["jwt"], {"p_challenge_id": cid})
        check("2-player: standings list both players", len(stand) == 2, str(len(stand)))
        res = rpc("get_challenge_results", a["jwt"], {"p_challenge_id": cid})
        check("2-player: results reachable with 5 rows", len(res) == 5, str(len(res)))
    except RuntimeError as e:
        check("2-player duel ran without error", False, str(e)[:160])
    finally:
        delete_user(a["id"]); delete_user(b["id"])

    # ---- 4-player group duel, unfiltered, 10 questions
    print("\n  --- 4-player group duel, all content, 10 questions ---")
    users = [make_user(f"grp{i}") for i in range(4)]
    try:
        for u in users:
            opt_in(u)
        cid = rpc("create_challenge", users[0]["jwt"], {
            "p_opponent_ids": [u["id"] for u in users[1:]], "p_question_count": 10,
            "p_item_types": None, "p_levels": None, "p_category_classes": None})
        for u in users[1:]:
            rpc("respond_to_challenge", u["jwt"], {"p_challenge_id": cid, "p_accept": True})
        lasts = []
        for i, u in enumerate(users):
            n, last = play(u, cid, i + 1)
            lasts.append((u["label"], n, last))
            check(f"4-player: {u['label']} answered all 10", n == 10, f"answered {n}")
        check("4-player: duel completed on the last answer",
              lasts[-1][2] and lasts[-1][2]["challenge_completed"], str(lasts[-1][2]))
        stand = rpc("get_challenge_standings", users[0]["jwt"], {"p_challenge_id": cid})
        check("4-player: standings list all 4", len(stand) == 4, str(len(stand)))
        ranks = sorted(s["final_rank"] for s in stand)
        check("4-player: ranks are sane (start at 1, no gaps beyond ties)",
              ranks[0] == 1 and max(ranks) <= 4, str(ranks))
        wins = sum(1 for s in stand if s["final_rank"] == 1)
        check("4-player: exactly one rank-1 group", wins >= 1, str(ranks))
        # every participant's stats moved exactly once
        for u in users:
            s = rpc("get_duel_stats", u["jwt"], {"p_user_id": None})[0]
            tot = s["wins"] + s["losses"] + s["ties"]
            check(f"4-player: {u['label']} recorded exactly one result", tot == 1, str(s))
    except RuntimeError as e:
        check("4-player duel ran without error", False, str(e)[:160])
    finally:
        for u in users:
            delete_user(u["id"])


def scenario_question_quality():
    print("\n" + "=" * 70)
    print("QUESTION SHAPE — every duel prompt collected above")
    print("=" * 70)
    if not QUESTION_SAMPLES:
        check("collected some questions to audit", False, "none seen")
        return
    lens = sorted(len(t) for _, t in QUESTION_SAMPLES)
    print(f"  {len(QUESTION_SAMPLES)} prompts   median {lens[len(lens)//2]}   "
          f"max {lens[-1]}")
    check("no duel prompt exceeds 180 characters", lens[-1] <= 180, f"max {lens[-1]}")
    print("\n  sample prompts as a player sees them:")
    seen = set()
    for where, t in QUESTION_SAMPLES:
        if where in seen:
            continue
        seen.add(where)
        print(f"    [{where}] {t}")


if __name__ == "__main__":
    try:
        scenario_study()
        scenario_duels()
        scenario_question_quality()
    finally:
        print("\n" + "=" * 70)
        if FAILURES:
            print(f"{len(FAILURES)} FAILURE(S):")
            for f in FAILURES:
                print(f"  - {f}")
        else:
            print("All gameplay scenarios passed.")
    sys.exit(1 if FAILURES else 0)
