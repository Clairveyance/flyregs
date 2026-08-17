#!/usr/bin/env python3
"""Drive the OTHER side of a duel while you play the first side in the app.

The web preview shares one browser session, so a two-account duel can't be
hand-tested from two tabs. Sign into the app as player A, then use this to be
player B (opt in, accept, play) against the same live database.

Usage:
  python3 scripts/duel_helper.py optin <user-id> [<user-id> ...]
  python3 scripts/duel_helper.py list <email> <password>
  python3 scripts/duel_helper.py accept <email> <password> <challenge-id>
  python3 scripts/duel_helper.py play <email> <password> <challenge-id> [right|wrong|mixed]
"""
import json
import os
import sys
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
URL = SCRAPER["SUPABASE_URL"]
SERVICE = SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]


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


def signin(email, password):
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": password})
    if st != 200:
        raise SystemExit(f"signin failed {st}: {tok}")
    return tok["access_token"]


def rpc(fn, jwt, params=None):
    st, body = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300:
        raise SystemExit(f"rpc {fn} -> HTTP {st}: {body}")
    return body


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    cmd = sys.argv[1]

    if cmd == "optin":
        for uid in sys.argv[2:]:
            st, b = http("POST", "/rest/v1/user_streaks?on_conflict=user_id", key=SERVICE,
                         body={"user_id": uid, "leaderboard_opt_in": True},
                         headers={"Prefer": "resolution=merge-duplicates"})
            print(uid, "->", st, b or "ok")

    elif cmd == "list":
        jwt = signin(sys.argv[2], sys.argv[3])
        for c in rpc("get_my_challenges", jwt):
            print(f"{c['challenge_id']}  status={c['status']} mine={c['my_status']} "
                  f"{c['my_answered_count']}/{c['question_count']} "
                  f"others={[(o['label'], o['status'], o['answeredCount']) for o in c['others']]}")

    elif cmd == "accept":
        jwt = signin(sys.argv[2], sys.argv[3])
        rpc("respond_to_challenge", jwt, {"p_challenge_id": sys.argv[4], "p_accept": True})
        print("accepted")

    elif cmd == "play":
        jwt = signin(sys.argv[2], sys.argv[3])
        cid = sys.argv[4]
        mode = sys.argv[5] if len(sys.argv) > 5 else "mixed"
        i = 0
        while True:
            rows = rpc("get_next_challenge_question", jwt, {"p_challenge_id": cid})
            if not rows:
                break
            q = rows[0]
            # correct_answer, not item_id -- an authored question's real
            # answer can be totally different text from item_id (e.g.
            # item_id "91.815" answered by "Part 36"). See duel_e2e_test.py's
            # play() for how this silently picked wrong answers before.
            st, cq = http("GET", f"/rest/v1/challenge_questions?id=eq.{q['question_id']}&select=item_id,correct_answer",
                          key=SERVICE)
            right = cq[0]["correct_answer"] or cq[0]["item_id"]
            want_right = mode == "right" or (mode == "mixed" and i % 2 == 0)
            pick = right if want_right else next((c for c in q["choices"] if c != right), right)
            r = rpc("submit_challenge_answer", jwt, {
                "p_question_id": q["question_id"], "p_answer_text": pick,
                "p_time_ms": 2000 + i * 400})[0]
            print(f"  q{q['sort_order']} ({q['item_type']}) answered "
                  f"{'RIGHT' if r['is_correct'] else 'wrong'}  completed={r['challenge_completed']}")
            i += 1
        print("done")

    else:
        print(__doc__)
        raise SystemExit(1)
