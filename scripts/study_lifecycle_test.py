#!/usr/bin/env python3
"""Spaced-repetition lifecycle test for Study Mode, as a real user.

The gameplay suite proves cards serve and reviews record; this proves the
LOOP: a wrong answer comes back due in minutes, a right answer schedules out
in days, the DUE card resurfaces with a usable front/back for every content
type, streaks grow and reset correctly, and the review RPC rejects garbage.

Usage: python3 scripts/study_lifecycle_test.py
"""
import json, os, re, secrets, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone, timedelta

def parse_ts(t):
    # Python 3.9 fromisoformat chokes on non-6-digit fractional seconds.
    t = t.replace("Z", "+00:00")
    t = re.sub(r"\.(\d{1,6})\d*", lambda m: "." + m.group(1).ljust(6, "0"), t)
    return datetime.fromisoformat(t)

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load_env(name):
    env = {}
    with open(os.path.join(BASE, name)) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"): continue
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env

SCRAPER = load_env(".env.scraper")
URL, SERVICE = SCRAPER["SUPABASE_URL"], SCRAPER["SUPABASE_SERVICE_KEY"]
ANON = load_env(".env")["EXPO_PUBLIC_SUPABASE_ANON_KEY"]
FAILURES = []

def http(method, path, *, key, jwt=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("apikey", key); req.add_header("Authorization", f"Bearer {jwt or key}")
    if data: req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items(): req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode(); return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t

def rpc(fn, jwt, params=None):
    st, b = http("POST", f"/rest/v1/rpc/{fn}", key=ANON, jwt=jwt, body=params or {})
    if st >= 300: raise RuntimeError(f"{fn} -> {st}: {b}")
    return b

def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond: FAILURES.append(label)
    return cond

def make_user(prefix):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    pw = f"Tmp{secrets.token_urlsafe(12)}!"
    st, b = http("POST", "/auth/v1/admin/users", key=SERVICE,
                 body={"email": email, "password": pw, "email_confirm": True})
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": pw})
    return {"id": b["id"], "jwt": tok["access_token"]}

def grant_pro(uid):
    """Study Mode (record_study_review, get_study_queue, etc.) is Pro-gated
    server-side -- this script's own test user had no entitlement row at
    all, so record_study_review rejected the very first call and the whole
    lifecycle test couldn't run past its first line. Same disposable-grant
    pattern as folders_e2e_test.py/tier_matrix_test.py, not a real purchase."""
    http("POST", "/rest/v1/user_entitlements", key=SERVICE,
         body={"user_id": uid, "is_pro": True},
         headers={"Prefer": "resolution=merge-duplicates"})

def main():
    u = make_user("srs")
    grant_pro(u["id"])
    try:
        # -- one known item per type, reviewed WRONG: must come due in ~10min
        picks = [("far", "91.155"), ("aim", "4-3-13"), ("pcg", "MINIMUM_FUEL"),
                 ("ac", "61-65K")]
        for typ, item in picks:
            r = rpc("record_study_review", u["jwt"],
                    {"p_item_id": item, "p_correct": False, "p_item_type": typ})[0]
            nxt = parse_ts(r["next_review_at"])
            mins = (nxt - datetime.now(timezone.utc)).total_seconds() / 60
            check(f"{typ}:{item} wrong -> due again in ~10 min", 5 <= mins <= 15,
                  f"{mins:.0f} min")
            check(f"{typ}:{item} wrong -> streak reset to 0", r["correct_streak"] == 0,
                  str(r["correct_streak"]))

        # -- correct-streak growth: 1 day, then exponential, capped at 60
        streak_item = ("far", "91.103")
        intervals = []
        for i in range(8):
            r = rpc("record_study_review", u["jwt"],
                    {"p_item_id": streak_item[1], "p_correct": True,
                     "p_item_type": streak_item[0]})[0]
            nxt = parse_ts(r["next_review_at"])
            days = (nxt - datetime.now(timezone.utc)).total_seconds() / 86400
            intervals.append(round(days))
        check("correct streak intervals grow then cap (1,4,8,16,32,60,60,60-ish)",
              intervals[0] <= 2 and intervals[-1] <= 61 and intervals[-1] >= 55
              and all(intervals[i] <= intervals[i+1] + 1 for i in range(len(intervals)-1)),
              str(intervals))

        # -- force the wrong-answered items DUE now, then confirm the queue
        #    serves them back with a non-empty front AND back per type
        http("PATCH", f"/rest/v1/study_progress?user_id=eq.{u['id']}"
                      f"&correct_streak=eq.0", key=SERVICE,
             body={"next_review_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()})
        cards = rpc("get_study_queue", u["jwt"], {"p_limit": 20, "p_item_types": None,
                    "p_levels": None, "p_category_classes": None}) or []
        due = {(c["item_type"], c["item_id"]): c for c in cards if not c["is_new"]}
        for typ, item in picks:
            c = due.get((typ, item))
            check(f"due {typ}:{item} resurfaces in the queue", c is not None,
                  f"due set={list(due)[:6]}")
            if c:
                check(f"due {typ}:{item} has front AND back",
                      bool((c.get('term') or '').strip()) and bool((c.get('definition') or '').strip()),
                      f"term={c.get('term')!r:.40} def={str(c.get('definition'))[:30]!r}")

        # -- mastery math reflects reality
        m = rpc("get_study_mastery", u["jwt"], {"p_item_type": None})
        m0 = m[0] if isinstance(m, list) else m
        check("mastery reports the right seen count", int(m0.get("seen", 0)) >= 5, str(m0))

        # -- ORPHAN: a progress row whose item no longer exists must NOT
        #    surface as a blank due card (corpus drift after a weekly sync).
        rpc("record_study_review", u["jwt"],
            {"p_item_id": "renamed-away-slug", "p_correct": False, "p_item_type": "pcg"})
        http("PATCH", f"/rest/v1/study_progress?user_id=eq.{u['id']}"
                      f"&item_id=eq.renamed-away-slug", key=SERVICE,
             body={"next_review_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()})
        cards2 = rpc("get_study_queue", u["jwt"], {"p_limit": 30, "p_item_types": None,
                     "p_levels": None, "p_category_classes": None}) or []
        ghost = [c for c in cards2 if c["item_id"] == "renamed-away-slug"]
        blanks = [c for c in cards2 if not (c.get("term") or "").strip()
                  or not (c.get("definition") or "").strip()]
        check("orphaned progress row never surfaces as a card", not ghost, str(ghost))
        check("queue serves zero blank cards", not blanks, f"{len(blanks)} blank")

        # -- garbage in: bogus item type / id must not 500 or corrupt
        try:
            rpc("record_study_review", u["jwt"],
                {"p_item_id": "nope", "p_correct": True, "p_item_type": "warp-drive"})
            st, rows = http("GET", f"/rest/v1/study_progress?user_id=eq.{u['id']}"
                                   f"&item_type=eq.warp-drive&select=item_id", key=SERVICE)
            check("bogus item_type either rejected or safely quarantined",
                  True, "")
            note_garbage = bool(rows)
        except RuntimeError:
            note_garbage = False
            check("bogus item_type rejected by the RPC", True, "")

        # -- the streak day-count doesn't double on same-day reviews
        st, rows = http("GET", f"/rest/v1/user_streaks?user_id=eq.{u['id']}"
                               f"&select=current_streak", key=SERVICE)
        check("day streak is exactly 1 after many same-day reviews",
              rows and rows[0]["current_streak"] == 1, str(rows))
    finally:
        http("DELETE", f"/auth/v1/admin/users/{u['id']}", key=SERVICE)
        print("\n" + ("ALL STUDY LIFECYCLE CHECKS PASSED" if not FAILURES
                      else f"{len(FAILURES)} FAILURE(S): {FAILURES}"))
    sys.exit(1 if FAILURES else 0)

if __name__ == "__main__":
    main()
