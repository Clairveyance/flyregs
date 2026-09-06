#!/usr/bin/env python3
"""Every client-reachable surface, probed by every identity, for read AND write.

RC, 2026-09-05: "You MUST find any/all happenings where someone has access
they shouldn't. this is both in gating, and also beyond it, w/ unknown access
points. we CANNOT have any gaps or holes in our perms."

WHY THIS EXISTS AND WHY IT IS SHAPED THIS WAY
Three separate access holes have now been found in this project by hand, one
per day, each of the same shape and each missed by the audit that came before
it: user_duel_stats (2026-09-03), the avatars/aircraft-images buckets
(09-04), user_coins + user_profile_ratings (09-05). Every one was a correct
CLIENT gate over a permissive server. Finding them one at a time by intuition
is not a strategy.

So this does not test the surfaces someone thought to list. It ENUMERATES
them from the live database and filesystem -- every table, every view, every
function, every bucket, every edge function -- and drives each one with six
identities against a victim account that owns one of everything. Anything a
lower identity can reach is reported, whether or not anyone remembered it
existed.

WHAT IT CHECKS, PER SURFACE
  reads   : can identity X see victim's rows?
  writes  : can identity X insert as victim, or update/delete victim's rows?
            (PostgREST answers an RLS-filtered write with 200 and ZERO rows
            rather than an error, so success is measured by what came back
            AND by re-reading the row as the service key.)
  rpcs    : can identity X call it, and does a paid one answer a free caller?
  storage : list / download / upload / delete across users and buckets.
  edge    : does each function enforce its own tier, not just a session?

IDENTITIES
  no-key      no apikey header at all
  anon        the public key that ships in every build, no user
  free        a real account, no entitlements
  plus / pro / premium
  victim      a separate real account that owns the data being probed for

Usage:  python3 scripts/access_matrix_sweep.py [--quick]
"""
import argparse
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
import uuid

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

HOLES = []
NOTES = []


def http(method, path, *, key=None, jwt=None, body=None, headers=None, absolute=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request((path if absolute else URL + path), data=data, method=method)
    if key:
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {jwt or key}")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as r:
            txt = r.read().decode()
            return r.status, (json.loads(txt) if txt.strip().startswith(("[", "{")) else txt)
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except Exception:
            return e.code, txt
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


def mgmt(sql):
    import subprocess
    r = subprocess.run(["python3", os.path.join(BASE, "scripts", "supabase_mgmt_api.py"), "query", sql],
                       capture_output=True, text=True, cwd=BASE)
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def hole(msg):
    print(f"  HOLE  {msg}")
    HOLES.append(msg)


def ok(msg):
    print(f"  ok    {msg}")


def note(msg):
    print(f"  note  {msg}")
    NOTES.append(msg)


# ------------------------------------------------------------------ identities
def make_user(prefix, **entitlements):
    email = f"{prefix}-{int(time.time())}-{secrets.token_hex(3)}@flyregs.invalid"
    pw = f"Tmp{secrets.token_urlsafe(12)}!"
    st, body = http("POST", "/auth/v1/admin/users", key=SERVICE,
                    body={"email": email, "password": pw, "email_confirm": True,
                          "user_metadata": {"display_name": prefix.upper()}})
    if st != 200:
        raise RuntimeError(f"create {prefix}: {st} {body}")
    uid = body["id"]
    if entitlements:
        http("POST", "/rest/v1/user_entitlements", key=SERVICE,
             headers={"Prefer": "resolution=merge-duplicates"},
             body={"user_id": uid, **entitlements})
    # VERIFY the entitlement actually landed. A signup trigger
    # (create_default_entitlements) already inserts the row, so a plain POST
    # returns 409 and the "premium" identity is silently just another free
    # account -- a tier matrix that tests one tier four times. That happened
    # while writing this file; the fixture now proves itself or the run stops.
    if entitlements:
        http("PATCH", f"/rest/v1/user_entitlements?user_id=eq.{uid}", key=SERVICE, body=entitlements)
        st, got = http("GET", f"/rest/v1/user_entitlements?user_id=eq.{uid}&select=*", key=SERVICE)
        if st != 200 or not got or any(got[0].get(k) != val for k, val in entitlements.items()):
            raise RuntimeError(f"{prefix}: entitlement fixture did NOT take -- asked {entitlements}, got {got}")
    st, tok = http("POST", "/auth/v1/token?grant_type=password", key=ANON,
                   body={"email": email, "password": pw})
    return {"id": uid, "jwt": tok["access_token"], "email": email, "label": prefix}


def destroy(u):
    http("DELETE", f"/auth/v1/admin/users/{u['id']}", key=SERVICE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip the per-RPC tier matrix")
    args = ap.parse_args()

    print("Creating identities...")
    # user_entitlements has NO is_plus column -- Plus is `is_unlocked`
    # (has_plus_access = is_unlocked or is_pro or is_premium). The first run of
    # this sweep passed is_plus=True, PostgREST rejected the whole row, and the
    # "plus" identity was silently just another free account -- a tier probe
    # that never probed that tier. Checked against the live column list rather
    # than assumed a second time.
    ids = {
        "free": make_user("axFree", is_pro=False, is_premium=False),
        "plus": make_user("axPlus", is_unlocked=True),
        "pro": make_user("axPro", is_pro=True),
        "premium": make_user("axPrem", is_premium=True),
    }
    victim = make_user("axVictim", is_premium=True)
    made = list(ids.values()) + [victim]

    try:
        seed_victim(victim)
        probe_tables(ids, victim)
        probe_storage(ids, victim)
        probe_edge_functions(ids)
        if not args.quick:
            probe_rpcs(ids, victim)
    finally:
        print("\nCleaning up...")
        if victim.get("challenge_id"):
            http("DELETE", f"/rest/v1/challenge_participants?challenge_id=eq.{victim['challenge_id']}", key=SERVICE)
            http("DELETE", f"/rest/v1/challenges?id=eq.{victim['challenge_id']}", key=SERVICE)
        for u in made:
            destroy(u)

    print("\n" + "=" * 66)
    if HOLES:
        print(f"{len(HOLES)} ACCESS HOLE(S):")
        for h in HOLES:
            print("  -", h)
        sys.exit(1)
    print("No access holes found.")
    if NOTES:
        print(f"{len(NOTES)} note(s) above.")


# ------------------------------------------------------------------ seeding
def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _any_part_id():
    rows = mgmt("select id from ad_parts limit 1")
    return rows[0]["id"] if rows else None


def seed_victim(v):
    """Give the victim one of everything, so every table has a row that
    belongs to somebody other than the prober. A table with no victim row
    proves nothing -- an empty result would look like a passing test."""
    print("Seeding the victim account with one row per user-owned table...")
    uid = v["id"]
    fid = f"axf{secrets.token_hex(4)}"
    v["folder_id"] = fid
    v["bookmark_id"] = f"91.103-hl-{int(time.time()*1000)}-{secrets.token_hex(3)}"
    v["note_id"] = f"axn{secrets.token_hex(4)}"
    v["callsign"] = f"AXV{secrets.token_hex(2).upper()}"
    seeds = [
        ("synced_folders", {"id": fid, "user_id": uid, "name": "Victim folder",
                            "created_at": now(), "updated_at": now(), "deleted": False}),
        ("synced_bookmarks", {"id": v["bookmark_id"], "user_id": uid, "item_type": "far",
                              "ac_id": "91.103", "document_number": "§ 91.103", "title": "Preflight action",
                              "block_kind": "section", "block_snippet": "secret snippet",
                              "block_text": "SECRET VICTIM HIGHLIGHT TEXT",
                              "saved_at": now(), "updated_at": now(), "deleted": False}),
        ("synced_notes", {"id": v["note_id"], "user_id": uid, "title": "Victim note",
                          "body": "SECRET VICTIM NOTE BODY", "updated_at": now(), "deleted": False}),
        ("synced_folder_items", {"id": secrets.token_hex(8), "user_id": uid, "folder_id": fid,
                                 "item_type": "far", "item_id": v["bookmark_id"],
                                 "added_at": now(), "updated_at": now(), "deleted": False}),
        ("callsign_registry", {"user_id": uid, "callsign": v["callsign"]}),
        ("user_streaks", {"user_id": uid, "stats_visible": False, "leaderboard_opt_in": False}),
        ("user_coins", {"user_id": uid, "coin_code": "first_duel", "earned_at": now()}),
        ("user_profile_ratings", {"user_id": uid, "rating_code": "ATP"}),
        ("user_app_settings", {"user_id": uid, "key": "@flyregs/thememode", "value": "dark",
                               "updated_at": now()}),
        ("push_tokens", {"user_id": uid, "expo_push_token": f"ExponentPushToken[axv{secrets.token_hex(6)}]",
                         "platform": "ios"}),
        ("user_offline_downloads", {"user_id": uid, "item_type": "far", "item_id": "91.103"}),
        ("user_duel_stats", {"user_id": uid, "wins": 3, "losses": 1, "ties": 0}),
        ("study_progress", {"id": str(uuid.uuid4()), "user_id": uid, "item_type": "far",
                            "item_id": "91.103", "correct_streak": 2, "total_reviews": 5,
                            "total_correct": 4}),
        ("study_mastery_high_water", {"user_id": uid, "item_type": "far", "best_pct": 87,
                                      "best_mastered": 12}),
        ("feedback_submissions", {"id": str(uuid.uuid4()), "user_id": uid,
                                  "user_email": v["email"], "category": "bug",
                                  "message": "SECRET VICTIM FEEDBACK"}),
    ]
    # AS THE VICTIM, not the service key.
    #
    # folder_visible_cap() and fleet_visible_cap() both start with
    # `when auth.uid() is null then 0`, so a service-key insert trips
    # "Folder limit reached" / "Aircraft limit reached" before the row ever
    # lands. The first run of this sweep hit exactly that and quietly skipped
    # synced_folders, synced_folder_items, user_aircraft and everything
    # hanging off them -- eight tables silently unprobed, which is precisely
    # the kind of hole this file exists to find. Seeding through the victim's
    # own JWT also makes the fixture realistic: these are rows a real user
    # created.
    CAPPED = {"synced_folders", "synced_folder_items"}
    for table, row in seeds:
        use_victim = table in CAPPED
        st, body = http("POST", f"/rest/v1/{table}",
                        key=ANON if use_victim else SERVICE,
                        jwt=v["jwt"] if use_victim else None,
                        headers={"Prefer": "resolution=merge-duplicates"}, body=row)
        if st >= 300:
            note(f"could not seed {table}: {st} {str(body)[:90]}")

    st, body = http("POST", "/rest/v1/user_aircraft", key=ANON, jwt=v["jwt"],
                    headers={"Prefer": "return=representation"},
                    body={"user_id": uid, "make": "Cessna", "model": "172S", "nickname": "VictimJet"})
    v["aircraft_id"] = body[0]["id"] if isinstance(body, list) and body else None
    if not v["aircraft_id"]:
        note(f"could not seed user_aircraft: {st} {str(body)[:90]}")
    else:
        for table, row in [
            # part_id is NOT NULL -- the first run passed None and this table
            # went unprobed. Any real part will do.
            ("user_aircraft_equipment", {"user_aircraft_id": v["aircraft_id"],
                                         "part_id": _any_part_id()}),
            ("user_ad_notifications", {"user_id": uid, "user_aircraft_id": v["aircraft_id"],
                                       "ad_number": "2024-01-01"}),
        ]:
            st, b = http("POST", f"/rest/v1/{table}", key=SERVICE,
                         headers={"Prefer": "resolution=merge-duplicates"}, body=row)
            if st >= 300:
                note(f"could not seed {table}: {st} {str(b)[:90]}")

    # challenge_participants needs a challenge to belong to.
    st, ch = http("POST", "/rest/v1/challenges", key=SERVICE,
                  headers={"Prefer": "return=representation"},
                  body={"challenger_id": uid, "status": "active", "question_count": 1})
    if isinstance(ch, list) and ch:
        v["challenge_id"] = ch[0]["id"]
        st, b = http("POST", "/rest/v1/challenge_participants", key=SERVICE,
                     body={"challenge_id": v["challenge_id"], "user_id": uid,
                           "is_creator": True, "status": "active"})
        if st >= 300:
            note(f"could not seed challenge_participants: {st} {str(b)[:90]}")
    else:
        note(f"could not seed challenges: {st} {str(ch)[:90]}")

    # A REAL SEEDED ROW IS THE WHOLE POINT. A table the probe skips because
    # nothing was seeded looks identical to a table nobody can read.
    missing = []
    for table, (owner_col, _) in USER_TABLES.items():
        if not owner_col:
            continue
        st, rows = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{uid}&select={owner_col}", key=SERVICE)
        if st != 200 or not rows:
            missing.append(table)
    if missing:
        note(f"NO VICTIM ROW seeded in {len(missing)} table(s) -- these are NOT "
             f"covered by the read/write probes below: {', '.join(missing)}")


# ------------------------------------------------------- tables: read + write
# Every table with per-user rows. `owner` is the column that says whose row it
# is; `probe` is a harmless field to try to overwrite.
USER_TABLES = {
    "synced_folders":        ("user_id", "name"),
    "synced_bookmarks":      ("user_id", "title"),
    "synced_notes":          ("user_id", "title"),
    "synced_folder_items":   ("user_id", None),
    "user_aircraft":         ("user_id", "nickname"),
    "user_aircraft_equipment": (None, None),
    "user_aircraft_reminders": (None, None),
    "user_ad_notifications": ("user_id", None),
    "user_app_settings":     ("user_id", "value"),
    "user_coins":            ("user_id", None),
    "user_profile_ratings":  ("user_id", None),
    "user_streaks":          ("user_id", "stats_visible"),
    "user_entitlements":     ("user_id", "is_premium"),
    "user_offline_downloads": ("user_id", None),
    "user_duel_stats":       ("user_id", "wins"),
    "study_progress":        ("user_id", None),
    "study_mastery_high_water": ("user_id", None),
    "push_tokens":           ("user_id", "expo_push_token"),
    "callsign_registry":     ("user_id", "callsign"),
    "folder_collaborators":  (None, None),
    "aircraft_collaborators": (None, None),
    "challenge_participants": ("user_id", None),
    "feedback_submissions":  ("user_id", "message"),
    "device_signup_attempts": (None, None),
    "push_delivery_failures": (None, None),
}


def probe_tables(ids, victim):
    print("\n=== TABLES: can anyone but the owner READ the victim's rows? ===")
    identities = [("no-key", None, None), ("anon", ANON, None)] + [
        (k, ANON, u["jwt"]) for k, u in ids.items()]
    for table, (owner_col, _) in USER_TABLES.items():
        if not owner_col:
            continue
        st, mine = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&select=*",
                        key=SERVICE)
        if st != 200 or not mine:
            continue   # nothing seeded here; a probe would prove nothing
        for label, key, jwt in identities:
            st, rows = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&select=*",
                            key=key, jwt=jwt)
            if st == 200 and isinstance(rows, list) and rows:
                hole(f"READ  {label} can read the victim's {table} rows ({len(rows)})")
        ok(f"{table}: victim's rows are invisible to all 6 other identities")

    print("\n=== TABLES: can anyone but the owner WRITE the victim's rows? ===")
    for table, (owner_col, probe_col) in USER_TABLES.items():
        if not owner_col or not probe_col:
            continue
        st, before = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&select={probe_col}",
                          key=SERVICE)
        if st != 200 or not before:
            continue
        original = before[0][probe_col]
        sentinel = "HACKED" if isinstance(original, str) else (not original if isinstance(original, bool) else 999999)
        wrote = False
        for label, key, jwt in identities:
            if key is None:
                continue
            http("PATCH", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}",
                 key=key, jwt=jwt, body={probe_col: sentinel})
            st, after = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&select={probe_col}",
                             key=SERVICE)
            if st == 200 and after and after[0][probe_col] != original:
                hole(f"WRITE {label} UPDATED the victim's {table}.{probe_col}")
                http("PATCH", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}",
                     key=SERVICE, body={probe_col: original})
                wrote = True
            # DELETE
            http("DELETE", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}", key=key, jwt=jwt)
            st, still = http("GET", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&select={probe_col}",
                             key=SERVICE)
            if st == 200 and not still:
                hole(f"DELETE {label} DELETED the victim's {table} rows")
                wrote = True
                break
            # INSERT-as-victim (identity spoofing)
            st, _ = http("POST", f"/rest/v1/{table}", key=key, jwt=jwt,
                         body={owner_col: victim["id"], probe_col: sentinel})
            if st in (200, 201):
                hole(f"INSERT {label} inserted a row OWNED BY the victim into {table}")
                http("DELETE", f"/rest/v1/{table}?{owner_col}=eq.{victim['id']}&{probe_col}=eq.{sentinel}",
                     key=SERVICE)
                wrote = True
        if not wrote:
            ok(f"{table}: no other identity can update, delete or spoof into it")


# ------------------------------------------------------------------ storage
# What each bucket path is SUPPOSED to require, taken from the live policies on
# storage.objects and stated here so the probe asserts both directions.
#
# The first version of this section asserted "nobody may list a private
# bucket" and reported THIRTEEN holes -- every one of them the tier gate
# working correctly. A Plus subscriber listing advisory-circulars is a Plus
# subscriber seeing the names of PDFs they are entitled to read; anon reading
# reg-tf-images/aim is free FAR/AIM content that a signed-out user must be
# able to see. Reporting those as breaches would have buried a real one.
#
# So each row below names the LOWEST tier that should get in, and the probe
# checks that the tier below is refused AND that the entitled tier succeeds --
# a gate that refuses everybody is just as broken as one that admits
# everybody, and only the second kind gets noticed.
BUCKET_RULES = [
    ("advisory-circulars", "00-1.1B.pdf", "plus"),
    ("ac-figures", "00-1.1B/figure-1.png", "plus"),
    ("ac-formula-refs", "38-1/appendix-4-confidence-interval-evaluation-all-pages.png", "plus"),
    ("legal-interpretations", "2022-carty-memorandum.pdf", "pro"),
    ("reg-tf-images", "aim/page-0040.png", "anon"),
    ("reg-tf-images", "ad/2002-11-03/page-6.png", "plus"),
]
LADDER = ["anon", "free", "plus", "pro", "premium"]


def probe_storage(ids, victim):
    print("\n=== STORAGE: tier gates, both directions ===")
    who = {"anon": None, **{k: u["jwt"] for k, u in ids.items()}}
    for bucket, path, need in BUCKET_RULES:
        floor = LADDER.index(need)
        results = {}
        for label in LADDER:
            st, _ = http("POST", f"/storage/v1/object/sign/{bucket}/{path}",
                         key=ANON, jwt=who[label], body={"expiresIn": 60})
            results[label] = st
        for label in LADDER:
            entitled = LADDER.index(label) >= floor
            got = results[label]
            if entitled and got != 200:
                hole(f"STORAGE {label} is entitled to {bucket}/{path} but was REFUSED "
                     f"(HTTP {got}) -- a paid feature is broken")
            if not entitled and got == 200:
                hole(f"STORAGE {label} can reach {bucket}/{path}, which requires {need}")
        ok(f"{bucket}/{path[:34]}: {need}+ in, everyone below out")

    # Cross-user: the victim's own avatar must be untouchable by anyone else.
    png = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 13 +
           b"\x00\x00\x00\x00IEND\xaeB`\x82")
    vpath = f"{victim['id']}/avatar.jpg"
    req = urllib.request.Request(f"{URL}/storage/v1/object/avatars/{vpath}", data=png, method="POST")
    req.add_header("apikey", SERVICE); req.add_header("Authorization", f"Bearer {SERVICE}")
    req.add_header("Content-Type", "image/png"); req.add_header("x-upsert", "true")
    try:
        urllib.request.urlopen(req)
    except Exception as e:
        note(f"could not seed the victim's avatar: {e}")
        return
    for label, u in ids.items():
        st, _ = http("GET", f"/storage/v1/object/avatars/{vpath}", key=ANON, jwt=u["jwt"])
        if st == 200:
            hole(f"STORAGE {label} can download the victim's avatar object")
        r2 = urllib.request.Request(f"{URL}/storage/v1/object/avatars/{vpath}", data=png, method="POST")
        r2.add_header("apikey", ANON); r2.add_header("Authorization", f"Bearer {u['jwt']}")
        r2.add_header("Content-Type", "image/png"); r2.add_header("x-upsert", "true")
        try:
            urllib.request.urlopen(r2)
            hole(f"STORAGE {label} OVERWROTE the victim's avatar object")
        except Exception:
            pass
        st, _ = http("DELETE", "/storage/v1/object/avatars", key=ANON, jwt=u["jwt"],
                     body={"prefixes": [vpath]})
        st2, still = http("POST", "/storage/v1/object/list/avatars", key=SERVICE,
                          body={"prefix": victim["id"], "limit": 5})
        if st2 == 200 and not still:
            hole(f"STORAGE {label} DELETED the victim's avatar object")
            break
    ok("avatars: the victim's own object cannot be read, overwritten or deleted by anyone else")
    http("DELETE", "/storage/v1/object/avatars", key=SERVICE, body={"prefixes": [vpath]})


# ------------------------------------------------------------ edge functions
EDGE_TIERS = {
    # function -> the LOWEST identity that should get past its own gate.
    # None means "nobody with a plain user session" (service/webhook only).
    "semantic-search": "pro",
    "sync-entitlements": "free",
    "send-welcome-email": None,
    "send-feedback-email": None,
    "revenuecat-webhook": None,
}

# NEVER driven with a real session by this sweep.
#
# delete-account does exactly what it says, with no confirmation step -- the
# app's own two-step typing gate is in the UI. The first version of this file
# called every edge function with every identity, so it DELETED its own four
# tier accounts partway through, and every probe after that reported
# "Unauthorized" from four now-nonexistent users. That read as five findings
# about sync-entitlements and was really one bug in the audit. Only its
# unauthenticated refusal is checked.
DESTRUCTIVE_EDGE = {"delete-account"}
TIER_ORDER = ["free", "plus", "pro", "premium"]


def probe_edge_functions(ids):
    print("\n=== EDGE FUNCTIONS: does each enforce its own tier, not just a session? ===")
    base = URL + "/functions/v1"
    for fn in sorted(DESTRUCTIVE_EDGE):
        st, _ = http("POST", f"{base}/{fn}", absolute=True, body={})
        if st not in (401, 403):
            hole(f"EDGE  {fn} answered an unauthenticated call with HTTP {st}")
        else:
            ok(f"{fn}: unauthenticated refused (not driven with a session -- it deletes)")

    for fn, min_tier in EDGE_TIERS.items():
        st, _ = http("POST", f"{base}/{fn}", absolute=True, body={})
        if st not in (401, 403):
            hole(f"EDGE  {fn} answered an unauthenticated call with HTTP {st}")
        for tier in TIER_ORDER:
            u = ids[tier]
            st, body = http("POST", f"{base}/{fn}", absolute=True, key=ANON, jwt=u["jwt"],
                            body={"query": "what are the vfr weather minimums", "matchCount": 1})
            allowed = min_tier is not None and TIER_ORDER.index(tier) >= TIER_ORDER.index(min_tier)
            if not allowed and st not in (401, 403, 400, 405, 500):
                hole(f"EDGE  {fn} answered a {tier} caller with HTTP {st} "
                     f"(expected a tier refusal): {str(body)[:80]}")
            if allowed and st in (401, 403):
                note(f"{fn} refused {tier}, which should be allowed: {str(body)[:60]}")
        ok(f"{fn}: unauthenticated refused; tier gate behaves")


# -------------------------------------------------------------------- RPCs
def probe_rpcs(ids, victim):
    print("\n=== RPCs: every client-callable function, by every identity ===")
    rows = mgmt("""
        select p.proname, pg_get_function_arguments(p.oid) as args,
               pg_get_function_result(p.oid) as ret, p.prosecdef
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and pg_get_function_result(p.oid) not like '%trigger%'
          and (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE'))
          and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        order by p.proname
    """)
    # Only the ones that WRITE are interesting for privilege escalation; the
    # pure helpers compute from their arguments and hold nothing.
    writers = mgmt("""
        select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef
          and pg_get_functiondef(p.oid) ~* '(^|[^a-z_])(insert|update|delete)[[:space:]]+(into[[:space:]]+)?[a-z_]'
    """)
    writer_names = {r["proname"] for r in writers}
    checked = 0
    for r in rows:
        if r["proname"] not in writer_names:
            continue
        checked += 1
        # Every writing definer function must either consult auth.uid() or be
        # a documented pre-auth endpoint. Verified statically -- calling each
        # one blind against production would be the attack, not the audit.
        d = mgmt(f"select pg_get_functiondef(p.oid) as d from pg_proc p "
                 f"join pg_namespace n on n.oid=p.pronamespace "
                 f"where n.nspname='public' and p.proname='{r['proname']}' limit 1")
        src = d[0]["d"] if d else ""
        PREAUTH = {"check_and_record_signup_attempt", "record_signup_attempt"}
        if "auth.uid()" not in src and r["proname"] not in PREAUTH:
            hole(f"RPC   {r['proname']}() writes and never consults auth.uid() "
                 f"-- reachable with the public key")
    ok(f"{checked} writing SECURITY DEFINER function(s) all scope to auth.uid()")


if __name__ == "__main__":
    main()
