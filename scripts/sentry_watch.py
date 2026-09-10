#!/usr/bin/env python3
"""Recurring Sentry report: what is NEW since last run, and what is going wrong.

RC, 2026-09-06: "make sure Sentry is properly set up and activated so it
reliably sends you all the info it's supposed to. That needs to be an
automated process, so you get regular reports, investigate them, and fix all
issues you can directly."

WHY A WATCHER AND NOT JUST "READ THE ISSUE LIST"
Reading the list shows what is there; it cannot show what CHANGED, and change
is the thing worth acting on. This keeps a small state file of every issue id
it has already reported, so each run says NEW / REGRESSED / still-open rather
than re-listing the same two issues forever.

IT ALSO WATCHES FOR SILENCE, WHICH IS THE FAILURE MODE THAT ACTUALLY BIT US
On 2026-09-06 the newest release (B40) had sent nothing for two days -- through
a lockup RC reported by email -- and the project had **0 transactions and 0
spans in 30 days** because tracing was configured but no navigation
instrumentation existed to create a transaction. An empty issue list read as
"all good" when it really meant "we are blind." So this script explicitly
reports when the newest release is silent, and when performance data is
missing, as findings in their own right.

Exit codes:  0 nothing new   1 something new to investigate   2 could not run
"""
import argparse, json, os, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(BASE, "scripts", ".sentry_watch_state.json")


def load_env(name):
    env = {}
    path = os.path.join(BASE, name)
    if not os.path.exists(path):
        return env
    for line in open(path):
        line = line.strip().removeprefix("export ")
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        env[k] = v.strip('"').strip("'")
    return env


ENV = load_env(".env.sentry")
TOKEN = ENV.get("SENTRY_WRITE_TOKEN") or ENV.get("SENTRY_API_TOKEN")
ORG = ENV.get("SENTRY_ORG", "clairveyance")
PROJ = ENV.get("SENTRY_PROJECT", "react-native")


def api(path):
    req = urllib.request.Request("https://sentry.io/api/0" + path)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"_err": e.code, "_body": e.read().decode()[:200]}
    except Exception as e:
        return {"_err": 0, "_body": f"{type(e).__name__}: {e}"}


_PROJECT_ID = None


def project_id():
    """Numeric project id — the org-level sessions endpoint requires it."""
    global _PROJECT_ID
    if _PROJECT_ID is None:
        proj = api(f"/projects/{ORG}/{PROJ}/")
        _PROJECT_ID = proj.get("id") if isinstance(proj, dict) else None
    return _PROJECT_ID


def release_sessions(version, period):
    """(session count, most recent day with a session) for one release.

    Returns (None, None) if the call failed, so a broken API read is never
    mistaken for "this build sent nothing" — those mean opposite things.
    """
    pid = project_id()
    if not pid:
        return None, None
    q = urllib.parse.urlencode({
        "field": "sum(session)", "groupBy": "release", "statsPeriod": period,
        "interval": "1d", "project": pid,
    })
    data = api(f"/organizations/{ORG}/sessions/?{q}")
    if not isinstance(data, dict) or "groups" not in data:
        return None, None
    days = [d[:10] for d in data.get("intervals", [])]
    for g in data.get("groups", []):
        if g.get("by", {}).get("release") != version:
            continue
        series = g.get("series", {}).get("sum(session)", [])
        last_day = next((d for d, n in reversed(list(zip(days, series))) if n), None)
        return g.get("totals", {}).get("sum(session)", 0), last_day
    return 0, None


def accepted_transactions(period):
    """How many transactions Sentry itself says it ACCEPTED in the window.

    This is the ground truth for "did the SDK send anything", and it is read
    from a completely different endpoint than the timings query. On
    2026-09-09 that difference mattered: the timings query returned zero rows
    and the watcher reported "tracing is broken", while Sentry had in fact
    accepted 14 transactions that same day from B42. The query was wrong, not
    the app. Never again blame the app for an empty result without checking
    this first. Returns None if the counter itself could not be read.
    """
    q = urllib.parse.urlencode({
        "statsPeriod": period, "interval": "1d", "field": "sum(quantity)",
        "category": "transaction", "groupBy": "outcome",
    })
    data = api(f"/organizations/{ORG}/stats_v2/?{q}")
    if not isinstance(data, dict) or "groups" not in data:
        return None
    for g in data.get("groups", []):
        if g.get("by", {}).get("outcome") == "accepted":
            return g.get("totals", {}).get("sum(quantity)", 0)
    return 0


def parse_ts(value):
    """Sentry timestamps, tolerant of 'Z' vs '+00:00'. None if unparseable.

    Compared as datetimes rather than strings on purpose: 'Z' sorts AFTER
    '+00:00' lexically, so two spellings of the same instant would compare
    unequal and silently flip the check that depends on them.
    """
    if not value:
        return None
    try:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def day_age_hours(day):
    if not day:
        return None
    return (datetime.now(timezone.utc)
            - datetime.fromisoformat(day + "T00:00:00+00:00")).total_seconds() / 3600


# The commit that added navigation instrumentation (969f073, src/lib/sentry.ts).
# A release built BEFORE this cannot produce transactions no matter what, so
# "no performance data" from such a release is expected, not a fault. Reporting
# it as a finding every run would train us to ignore the finding by the time it
# means something.
INSTRUMENTATION_COMMITTED = "2026-09-05T18:42:46+00:00"


def read_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {"seen": {}, "last_run": None}


def write_state(state):
    json.dump(state, open(STATE, "w"), indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", default="14d", help="stats period (24h or 14d)")
    ap.add_argument("--no-save", action="store_true", help="do not update the state file")
    args = ap.parse_args()

    if not TOKEN:
        print("SENTRY: no token in .env.sentry -- cannot run", file=sys.stderr)
        return 2

    state = read_state()
    seen = state.get("seen", {})
    findings = []

    print(f"=== Sentry watch — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')} ===")
    print(f"    project {ORG}/{PROJ}   window {args.days}"
          f"   last run {state.get('last_run') or 'never'}\n")

    # ---------------------------------------------------------------- issues
    issues = api(f"/projects/{ORG}/{PROJ}/issues/?query=&statsPeriod={args.days}&limit=100")
    if isinstance(issues, dict):
        print(f"  could not read issues: {issues}", file=sys.stderr)
        return 2

    new, regressed, ongoing = [], [], []
    for i in issues:
        sid = i.get("shortId") or i["id"]
        prev = seen.get(sid)
        if prev is None:
            new.append(i)
        elif i.get("status") == "unresolved" and prev.get("status") == "resolved":
            regressed.append(i)
        elif i.get("status") == "unresolved":
            ongoing.append(i)
        seen[sid] = {"status": i.get("status"), "count": i.get("count"), "lastSeen": i.get("lastSeen")}

    def show(label, rows):
        if not rows:
            return
        print(f"  {label} ({len(rows)}):")
        for i in rows:
            print(f"    {i.get('shortId'):<16} n={i.get('count'):<5} users={i.get('userCount',0):<4} "
                  f"{i.get('lastSeen','')[:16]}  {i.get('title','')[:64]}")
            print(f"      {i.get('permalink','')}")
        print()

    show("NEW since last run", new)
    show("REGRESSED (was resolved, came back)", regressed)
    show("still open", ongoing)
    if new:
        findings.append(f"{len(new)} new issue(s)")
    if regressed:
        findings.append(f"{len(regressed)} regressed issue(s)")
    if not issues:
        print("  no issues in the window\n")

    # ------------------------------------------------ is the newest build silent?
    #
    # LIVENESS IS SESSIONS, NOT ERROR EVENTS. Read the wrong signal and this
    # check cries wolf: on 2026-09-07 it reported B40 "silent for 58h and
    # verify the DSN" when B40 had in fact sent 29 sessions, including one that
    # same day. Nothing was wrong -- nobody had hit an error, which is the
    # outcome we want. An error-free build looks identical to a dead build if
    # errors are all you look at.
    #
    # Every app launch sends a session (enableAutoSessionTracking defaults on),
    # so sessions answer the real question: is the shipped build still talking
    # to Sentry at all? No sessions = blind. Sessions but no errors = healthy
    # and quiet, and that is worth saying out loud rather than alarming on.
    newest_created = None
    releases = api(f"/organizations/{ORG}/releases/?per_page=5")
    if isinstance(releases, list) and releases:
        newest = releases[0]
        ver, created, last = newest.get("version", "?"), newest.get("dateCreated", ""), newest.get("lastEvent")
        newest_created = created
        print(f"  newest release {ver}")
        print(f"    created {created[:16]}   last error event {str(last)[:16] if last else 'NEVER'}")

        sessions, last_session_day = release_sessions(ver, args.days)
        if sessions is None:
            print("    could not read release health — session liveness UNKNOWN")
            findings.append(f"could not read session data for {ver}")
        elif sessions == 0:
            findings.append(f"release {ver} has sent NO sessions — the build is not reporting")
            print("    ^^ 0 sessions in the window: this build has never phoned home.")
            print("       Verify the DSN and that the SDK initialises. Treat as blind, not healthy.")
        else:
            age_h = day_age_hours(last_session_day)
            print(f"    {sessions} sessions in {args.days}, most recent {last_session_day}")
            if age_h is not None and age_h > 72:
                findings.append(f"release {ver} last sent a session {age_h/24:.0f}d ago")
                print(f"    ^^ no session for {age_h/24:.0f} days — either nobody is running this")
                print("       build, or it stopped reporting. Worth confirming which.")
            elif not last:
                print("    reporting fine; no errors yet from this build.")
            else:
                print("    reporting fine — error silence just means nothing has crashed.")
        print()

    # ------------------------------------------------------------- performance
    #
    # READ THE SPANS DATASET, NOT `event.type:transaction`.
    #
    # This org is on Sentry's span-based (EAP) backend. There, the legacy
    # `discover`/`transactions` datasets return ZERO ROWS for every query --
    # not an error, just an empty list -- while the same data reads fine from
    # `dataset=spans`. Verified 2026-09-09 by running all four variants side
    # by side against live data: discover 0 rows, transactions 0 rows, spans
    # 7 rows totalling exactly the 14 transactions the stats API said had
    # been accepted.
    #
    # `is_transaction:true` keeps only the segment span of each trace, i.e.
    # one row per screen open; without it the counts include every child span
    # and the "how many opens" number is meaningless. `transaction.duration`
    # does not exist in this dataset (it is a string field there and the API
    # rejects it inside p95) -- the duration field is `span.duration`.
    q = urllib.parse.urlencode({
        "field": ["transaction", "count()", "p95(span.duration)"],
        "statsPeriod": args.days,
        "query": "is_transaction:true",
        "dataset": "spans",
        "project": project_id() or "",
        "sort": "-p95_span_duration",
        "per_page": "10",
    }, doseq=True)
    perf = api(f"/organizations/{ORG}/events/?{q}")
    failed = isinstance(perf, dict) and "_err" in perf
    rows = [] if failed else (perf.get("data", []) if isinstance(perf, dict) else [])
    print("  slowest screen opens (p95):")
    if failed:
        # An errored query returns no rows too. Reporting that as "no
        # performance data" would blame the app for a broken API call.
        print(f"    could not read performance data: {perf}")
        findings.append("performance query failed — timings unverified this run")
    elif not rows:
        # Distinguish "not shipped yet" (expected, nothing to do) from
        # "shipped and still blind" (a real pipeline failure).
        built = parse_ts(newest_created)
        pre_instrumentation = bool(built) and built < parse_ts(INSTRUMENTATION_COMMITTED)
        accepted = accepted_transactions(args.days)
        if pre_instrumentation:
            print("    None yet — the newest release predates the navigation")
            print("    instrumentation, so it cannot produce transactions. Expected;")
            print("    recheck once the next build ships.")
        elif accepted:
            # The app sent data and Sentry kept it; only the read came back
            # empty. Blaming the SDK here is what went wrong on 2026-09-09.
            print(f"    Query returned nothing, but Sentry ACCEPTED {accepted:.0f} transactions")
            print("    in this window. The app is reporting — this script's query is")
            print("    wrong (dataset/field names change under it). Fix the query.")
            findings.append(
                f"timings query returned 0 rows while Sentry accepted {accepted:.0f} "
                "transactions — the watcher's query is broken, not the app")
        else:
            print("    NO TRANSACTION DATA, and the newest release DOES include the")
            print("    navigation instrumentation. Tracing is broken — investigate.")
            findings.append("no performance data despite an instrumented build — tracing is broken")
    else:
        for r in rows:
            p95 = r.get("p95(span.duration)") or 0
            flag = "   <-- SLOW" if p95 > 2000 else ""
            print(f"    {str(r.get('transaction'))[:44]:<46} n={r.get('count()'):<5} p95={p95:>8.0f} ms{flag}")
            if p95 > 2000:
                findings.append(f"{r.get('transaction')} p95 {p95:.0f}ms")
    print()

    state["seen"] = seen
    state["last_run"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not args.no_save:
        write_state(state)

    print("=" * 62)
    if findings:
        print(f"{len(findings)} THING(S) TO INVESTIGATE:")
        for f in findings:
            print("  -", f)
        return 1
    print("Nothing new since the last run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
