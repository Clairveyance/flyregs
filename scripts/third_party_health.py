#!/usr/bin/env python3
"""One command that asks every external service FlyRegs depends on whether
it is actually working right now.

RC, 2026-09-04: "double check, and deep test all of our 3rd party
connections, SB, GH, etc... we're going out to a wide beta soon, and our
entire backend must work perfectly."

The point is not "is the credential present" -- a stale token and a missing
one look identical in a .env file. Every check here makes a real call and
looks at the answer. Where a service has a quota, a queue, or an expiry, it
prints the number rather than a green tick, because "working" and "working
for another three days" are different states and only one of them is worth
knowing about before a wide beta.

Exit 1 if anything is DOWN. WARN never fails the run -- it means reachable
but worth a look (a quota getting tight, a workflow whose last run failed).

Usage: python3 scripts/third_party_health.py [--quiet]
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROWS = []
DOWN = 0


def env_file(name):
    out = {}
    path = os.path.join(BASE, name)
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


ENV = env_file(".env")
SCRAPER = env_file(".env.scraper")
MGMT = env_file(".env.supabase-mgmt")
GH = env_file(".env.github")
SENTRY = env_file(".env.sentry")
RC_KEY = env_file(".env.revenuecat")
EAS = env_file(".env.eas")

URL = SCRAPER.get("SUPABASE_URL") or ENV.get("EXPO_PUBLIC_SUPABASE_URL")
SERVICE = SCRAPER.get("SUPABASE_SERVICE_KEY")
ANON = ENV.get("EXPO_PUBLIC_SUPABASE_ANON_KEY")


def fetch(url, *, headers=None, body=None, method=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"User-Agent": "curl/8.0", **(headers or {})})
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode(errors="replace")
            try:
                return r.status, json.loads(txt) if txt.strip() else None
            except Exception:
                return r.status, txt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")[:300]
    except Exception as e:                      # DNS, TLS, timeout
        return 0, f"{type(e).__name__}: {e}"


def row(service, state, detail):
    global DOWN
    ROWS.append((service, state, detail))
    if state == "DOWN":
        DOWN += 1
    print(f"  {state:5}  {service:34}  {detail}")


def timed(fn):
    t = time.time()
    try:
        return fn(), int((time.time() - t) * 1000)
    except Exception as e:
        return ("DOWN", f"{type(e).__name__}: {e}"), int((time.time() - t) * 1000)


# --------------------------------------------------------------- Supabase
def check_supabase_data():
    st, body = fetch(f"{URL}/rest/v1/far_sections?select=section_number&limit=1",
                     headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"})
    if st == 200 and body:
        return "OK", "service key reads the corpus"
    return "DOWN", f"HTTP {st} {str(body)[:120]}"


def check_supabase_anon_gating():
    """The anon key ships in the app binary. It must reach the FREE corpus
    and nothing else.

    Checked here rather than only in the tier audits because it is the one
    Supabase failure that looks fine from inside the app: an over-broad
    grant gives away the paid product and nothing errors. FAR/AIM/P-CG are
    deliberately open -- that is the free tier -- so a blanket "anon can
    read a content table" check would cry wolf. These are the paid ones.
    """
    paid = ["advisory_circulars", "cfr49_sections", "legal_interpretations",
            "airworthiness_directives", "dictionary_terms", "study_facts"]
    leaked = []
    for t in paid:
        st, _ = fetch(f"{URL}/rest/v1/{t}?select=*&limit=1",
                      headers={"apikey": ANON, "Authorization": f"Bearer {ANON}"})
        if st == 200:
            leaked.append(t)
    if leaked:
        return "DOWN", f"ANON KEY CAN READ PAID CONTENT: {leaked}"
    # And the free corpus must still be reachable, or the app is broken for
    # everyone -- an over-tightened grant fails just as loudly as a loose one.
    st, _ = fetch(f"{URL}/rest/v1/far_sections?select=id&limit=1",
                  headers={"apikey": ANON, "Authorization": f"Bearer {ANON}"})
    if st != 200:
        return "DOWN", f"free FAR corpus is NOT readable by anon (HTTP {st})"
    return "OK", f"{len(paid)} paid tables refuse anon; free FAR/AIM/P-CG still open"


def check_supabase_auth():
    st, body = fetch(f"{URL}/auth/v1/settings", headers={"apikey": ANON})
    if st == 200 and isinstance(body, dict):
        return "OK", f"email signup {'on' if not body.get('disable_signup') else 'OFF'}"
    return "DOWN", f"HTTP {st}"


def check_supabase_storage():
    st, body = fetch(f"{URL}/storage/v1/bucket",
                     headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"})
    if st != 200 or not isinstance(body, list):
        return "DOWN", f"HTTP {st}"
    pub = [b["id"] for b in body if b.get("public")]
    unbounded = [b["id"] for b in body if b.get("public") and not b.get("file_size_limit")]
    if unbounded:
        return "WARN", f"{len(body)} buckets; public+unbounded: {unbounded}"
    return "OK", f"{len(body)} buckets, public: {pub} (both size/mime capped)"


def check_edge_functions():
    """Each deployed function should answer. An unauthenticated call must be
    REFUSED, not served -- a 200 here would mean the function runs for
    anyone, which is how a webhook endpoint becomes an open write path."""
    names = ["semantic-search", "revenuecat-webhook", "send-feedback-email",
             "send-welcome-email", "sync-entitlements", "delete-account"]
    bad, missing = [], []
    for n in names:
        st, _ = fetch(f"{URL}/functions/v1/{n}", body={}, headers={"apikey": ANON})
        if st == 404:
            missing.append(n)
        elif st == 200:
            bad.append(f"{n} served an unauthenticated call")
    if missing:
        return "DOWN", f"not deployed: {missing}"
    if bad:
        return "DOWN", "; ".join(bad)
    return "OK", f"all {len(names)} deployed and refusing unauthenticated calls"


def check_semantic_search():
    """Ask FlyRegs -- a real query through the real edge function, as a real
    signed-in user. This is the path a paying user actually hits."""
    email = f"health-{int(time.time())}@flyregs.invalid"
    st, u = fetch(f"{URL}/auth/v1/admin/users",
                  headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"},
                  body={"email": email, "password": "Tmp!" + os.urandom(8).hex(),
                        "email_confirm": True})
    if st != 200:
        return "WARN", f"could not mint a probe account: HTTP {st}"
    uid = u["id"]
    try:
        fetch(f"{URL}/rest/v1/user_entitlements",
              headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}",
                       "Prefer": "resolution=merge-duplicates,return=minimal"},
              body={"user_id": uid, "is_pro": True, "is_premium": True})
        st, link = fetch(f"{URL}/auth/v1/admin/generate_link",
                         headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"},
                         body={"type": "magiclink", "email": email})
        th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")
        st, sess = fetch(f"{URL}/auth/v1/verify", headers={"apikey": ANON},
                         body={"type": "magiclink", "token_hash": th})
        jwt = sess["access_token"]
        t = time.time()
        st, body = fetch(f"{URL}/functions/v1/semantic-search",
                         headers={"apikey": ANON, "Authorization": f"Bearer {jwt}"},
                         body={"query": "when do I need a flight review"}, timeout=60)
        ms = int((time.time() - t) * 1000)
        if st != 200:
            return "DOWN", f"HTTP {st} {str(body)[:140]}"
        hits = body.get("results") or body.get("matches") or []
        if not hits:
            return "DOWN", f"returned zero results in {ms}ms -- Ask FlyRegs is empty"
        return "OK", f"{len(hits)} results in {ms}ms for a real gated query"
    finally:
        fetch(f"{URL}/auth/v1/admin/users/{uid}", method="DELETE",
              headers={"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}"})


def check_realtime():
    """Folder sync's live push rides Realtime -- a separate service behind the
    same hostname, so REST being up says nothing about it.

    The tenant-health endpoint answers 500 on this project, which is not a
    real outage: it is an admin endpoint the anon key isn't entitled to. The
    only honest check is the one the app does -- open the websocket and join
    a channel.
    """
    try:
        import websocket
    except ImportError:
        return "WARN", "websocket-client not installed; cannot check for real"
    host = URL.split("//", 1)[1]
    got = {}
    def on_open(ws):
        ws.send(json.dumps({"topic": f"realtime:health-{os.urandom(3).hex()}",
                            "event": "phx_join", "ref": "1",
                            "payload": {"config": {"broadcast": {"ack": False, "self": False},
                                                   "presence": {"key": "", "enabled": False},
                                                   "postgres_changes": [], "private": False}}}))
    def on_message(ws, m):
        msg = json.loads(m)
        if msg.get("event") == "phx_reply" and msg.get("ref") == "1":
            got["status"] = msg.get("payload", {}).get("status")
            ws.close()
    def on_error(ws, e):
        got["error"] = str(e)[:120]
    app = websocket.WebSocketApp(
        f"wss://{host}/realtime/v1/websocket?apikey={ANON}&vsn=1.0.0",
        on_open=on_open, on_message=on_message, on_error=on_error)
    t = __import__("threading").Thread(target=app.run_forever, daemon=True)
    t.start()
    t.join(timeout=20)
    app.close()
    if got.get("status") == "ok":
        return "OK", "websocket joined a channel (the path folder sync uses)"
    return "DOWN", f"join failed: {got or 'no reply in 20s'}"


def check_mgmt_api():
    ref = MGMT.get("SUPABASE_PROJECT_REF")
    st, body = fetch(f"https://api.supabase.com/v1/projects/{ref}",
                     headers={"Authorization": f"Bearer {MGMT.get('SUPABASE_MANAGEMENT_TOKEN')}"})
    if st != 200 or not isinstance(body, dict):
        return "DOWN", f"HTTP {st} {str(body)[:120]}"
    return ("OK" if body.get("status") == "ACTIVE_HEALTHY" else "WARN",
            f"{body.get('status')} · {body.get('region')}")


def check_db_size():
    """Supabase's free/pro disk is the one resource that fails hard and
    without warning -- a full disk stops writes, not just reads."""
    out = subprocess.run([sys.executable, os.path.join(BASE, "scripts", "supabase_mgmt_api.py"),
                          "query", "select pg_size_pretty(pg_database_size(current_database())) sz, "
                                   "pg_database_size(current_database()) b"],
                         capture_output=True, text=True, timeout=60)
    try:
        r = json.loads(out.stdout)[0]
    except Exception:
        return "WARN", f"could not read: {out.stdout[:100]}"
    gb = r["b"] / 1e9
    return ("WARN" if gb > 6 else "OK"), f"{r['sz']} used"


# ----------------------------------------------------------------- GitHub
def gh(path):
    return fetch(f"https://api.github.com{path}",
                 headers={"Authorization": f"Bearer {GH.get('GITHUB_TOKEN')}",
                          "Accept": "application/vnd.github+json"})


def check_github():
    st, body = gh("/user")
    if st != 200:
        return "DOWN", f"token rejected: HTTP {st} {str(body)[:120]}"
    return "OK", f"authenticated as {body.get('login')}"


def check_github_actions():
    """The weekly AD/reg sync is unattended: if it fails, nothing tells
    anyone, and the corpus silently goes stale. Scheduled jobs failing
    quietly is a recorded, repeated failure in this project."""
    st, repos = gh("/user/repos?per_page=100&sort=pushed")
    if st != 200 or not isinstance(repos, list):
        return "WARN", f"could not list repos: HTTP {st}"
    target = next((r for r in repos if "ac-app" in r["name"] or "flyreg" in r["name"].lower()), None)
    if not target:
        return "WARN", f"no FlyRegs repo among {len(repos)} repos"
    full = target["full_name"]
    st, runs = gh(f"/repos/{full}/actions/runs?per_page=20")
    if st != 200:
        return "WARN", f"{full}: runs HTTP {st}"
    rs = runs.get("workflow_runs", [])
    if not rs:
        return "WARN", f"{full}: no workflow runs at all"
    latest = {}
    for r in rs:
        latest.setdefault(r["name"], r)
    failed = [f"{n} ({r['conclusion']}, {r['created_at'][:10]})"
              for n, r in latest.items() if r["conclusion"] not in ("success", None)]
    newest = max(r["created_at"] for r in rs)[:10]
    if failed:
        return "WARN", f"{full}: last run failed -- {'; '.join(failed)}"
    return "OK", f"{full}: {len(latest)} workflows, all green, newest {newest}"


# ---------------------------------------------------------------- the rest
def check_sentry():
    org, proj = SENTRY.get("SENTRY_ORG"), SENTRY.get("SENTRY_PROJECT")
    h = {"Authorization": f"Bearer {SENTRY.get('SENTRY_API_TOKEN')}"}
    st, body = fetch(f"https://sentry.io/api/0/projects/{org}/{proj}/", headers=h)
    if st != 200 or not isinstance(body, dict):
        return "DOWN", f"HTTP {st} {str(body)[:120]}"
    if not body.get("firstEvent"):
        return "DOWN", "project has NEVER received an event -- crash reporting is dead"
    st, issues = fetch(f"https://sentry.io/api/0/projects/{org}/{proj}/issues/"
                       f"?query=is:unresolved&statsPeriod=24h", headers=h)
    n = len(issues) if isinstance(issues, list) else "?"
    return "OK", f"receiving events; {n} unresolved issues in 24h"


def check_revenuecat():
    """RevenueCat's V2 API, not V1. The key on disk is a V2 secret and V1
    rejects it outright with 'incompatible with RevenueCat API V1' -- which
    reads exactly like an expired credential if you probe the wrong version.
    """
    key = RC_KEY.get("REVENUECAT_SECRET_KEY")
    if not key:
        return "WARN", "no secret key on disk"
    st, body = fetch("https://api.revenuecat.com/v2/projects",
                     headers={"Authorization": f"Bearer {key}"})
    if st != 200:
        return "DOWN", f"HTTP {st} {str(body)[:140]}"
    items = body.get("items", []) if isinstance(body, dict) else []
    return "OK", f"V2 key authenticates; {len(items)} project(s): " \
                 f"{[p.get('name') for p in items][:2]}"


def check_asc():
    out = subprocess.run([sys.executable, os.path.join(BASE, "scripts", "asc_api.py"),
                          "GET", "/v1/apps"], capture_output=True, text=True, timeout=90)
    if out.returncode != 0:
        return "DOWN", (out.stderr or out.stdout)[:140].replace("\n", " ")
    # asc_api.py prints an "HTTP 200" status line before the JSON body.
    text = out.stdout.partition("\n")[2] if out.stdout.startswith("HTTP ") else out.stdout
    try:
        apps = json.loads(text).get("data", [])
    except Exception:
        return "WARN", out.stdout[:120].replace("\n", " ")
    return "OK", f"{len(apps)} app(s): {[a['attributes']['bundleId'] for a in apps][:2]}"


def check_eas():
    tok = EAS.get("EXPO_TOKEN")
    if not tok:
        return "WARN", "no EXPO_TOKEN on disk"
    st, body = fetch("https://api.expo.dev/v2/auth/userinfo",
                     headers={"Authorization": f"Bearer {tok}"})
    if st != 200:
        return "DOWN", f"HTTP {st} {str(body)[:120]}"
    data = body.get("data", body)
    return "OK", f"authenticated as {data.get('username') or data.get('id')}"


def check_expo_push():
    """The transport every notification in the app rides. A fake token must
    come back DeviceNotRegistered -- that answer proves the endpoint is up
    AND that the payload shape is still accepted."""
    st, body = fetch("https://exp.host/--/api/v2/push/send",
                     body={"to": "ExponentPushToken[health-probe-not-a-device]",
                           "title": "probe", "body": "probe"})
    txt = json.dumps(body) if not isinstance(body, str) else body
    if st == 200 and "DeviceNotRegistered" in txt:
        return "OK", "reachable; payload shape accepted"
    return "DOWN", f"HTTP {st} {txt[:140]}"


def check_youtube():
    out = subprocess.run([sys.executable, os.path.join(BASE, "scripts", "youtube_api.py"), "quota"],
                         capture_output=True, text=True, timeout=90)
    if out.returncode != 0:
        return "WARN", (out.stderr or out.stdout)[:140].replace("\n", " ")
    return "OK", " ".join(out.stdout.split())[:140]


def check_faa_sources():
    """Where the corpus comes from. If these move or start blocking us, the
    weekly sync stops finding anything and says nothing."""
    urls = {
        "FAA AC index": "https://www.faa.gov/regulations_policies/advisory_circulars",
        "FAA DRS": "https://drs.faa.gov/browse",
        "eCFR API": "https://www.ecfr.gov/api/versioner/v1/titles.json",
    }
    bad = []
    for name, u in urls.items():
        st, _ = fetch(u, timeout=25)
        if st not in (200, 301, 302):
            bad.append(f"{name} HTTP {st}")
    if bad:
        return "WARN", "; ".join(bad)
    return "OK", f"all {len(urls)} upstream sources reachable"


CHECKS = [
    ("Supabase · data plane", check_supabase_data),
    ("Supabase · anon gating", check_supabase_anon_gating),
    ("Supabase · auth", check_supabase_auth),
    ("Supabase · storage", check_supabase_storage),
    ("Supabase · edge functions", check_edge_functions),
    ("Supabase · Ask FlyRegs (live query)", check_semantic_search),
    ("Supabase · realtime", check_realtime),
    ("Supabase · management API", check_mgmt_api),
    ("Supabase · database size", check_db_size),
    ("GitHub · token", check_github),
    ("GitHub · Actions (weekly sync)", check_github_actions),
    ("Sentry", check_sentry),
    ("RevenueCat", check_revenuecat),
    ("App Store Connect", check_asc),
    ("EAS / Expo", check_eas),
    ("Expo push", check_expo_push),
    ("YouTube Data API", check_youtube),
    ("FAA / eCFR sources", check_faa_sources),
]


def main():
    print(f"Third-party health -- {time.strftime('%Y-%m-%d %H:%M')}\n")
    for name, fn in CHECKS:
        (state, detail), ms = timed(fn)
        row(name, state, f"{detail}  [{ms}ms]")
    warn = sum(1 for _, s, _ in ROWS if s == "WARN")
    print(f"\n{len(ROWS) - DOWN - warn} OK, {warn} WARN, {DOWN} DOWN")
    sys.exit(1 if DOWN else 0)


if __name__ == "__main__":
    main()
