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

# Screen-open budget, ms. A screen open over this is worth looking at.
# Overridable from the command line so a change to the detector can be PROVED
# to have narrowed it rather than silenced it: drop it to 500 and every real
# row must still fire.
SLOW_MS = 2000


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


def release_session_health(version, period):
    """{session.status: count} for one release, or None if the read failed.

    Why this exists. A crash BEFORE Sentry.init() sends nothing at all — no
    session, no error — so it is indistinguishable from "nobody launched the
    build" if you only count arrivals. That ambiguity was being handed back to
    a human on every silent run.

    The shape of the release's session HISTORY breaks the tie, because the
    binary is immutable once shipped. A build that has started dying at launch
    almost always leaves crashed/abnormal sessions from the launches that did
    get past init before it went quiet. An all-healthy history with nothing
    arriving since is the unused-build shape, not the dying-build shape.

    This is corroboration, not proof — a pre-init crash that has NEVER let a
    single launch through would still read as all-healthy zero-sessions, and a
    conditional onset (e.g. an OS point release) leaves no Sentry trace at all.
    So it narrows the wording; it does not cancel the finding.
    """
    pid = project_id()
    if not pid:
        return None
    q = urllib.parse.urlencode({
        "field": "sum(session)", "groupBy": "session.status",
        "query": f'release:"{version}"', "statsPeriod": period,
        "interval": "1d", "project": pid,
    })
    data = api(f"/organizations/{ORG}/sessions/?{q}")
    if not isinstance(data, dict) or "groups" not in data:
        return None
    out = {}
    for g in data.get("groups", []):
        status = g.get("by", {}).get("session.status")
        if status:
            out[status] = g.get("totals", {}).get("sum(session)", 0) or 0
    return out or None


def releases_active_after(exclude_version, day, period):
    """[(release, sessions)] for OTHER releases that sent sessions after `day`.

    Why this exists. The ingest counters read by ingest_outcomes() are
    PROJECT-WIDE: they cannot tell you which release an event came from. So
    "this release went quiet but events still arrived" was being printed on
    the strength of events belonging to a DIFFERENT build, and the wording
    ("session tracking specifically may be off") invented a reporting fault
    that was not there. On 2026-09-17 B42 read as a pipeline problem when the
    plain truth was that the device had gone back to B40, which was still
    sending sessions two days earlier.

    A build nobody is running any more is the ordinary explanation for a
    silent build, and it is the one the project-wide counters are structurally
    incapable of seeing. So attribute the traffic per release before blaming
    the pipeline. Days are counted STRICTLY AFTER `day` — the last day this
    release was alive is not part of its own silence window.

    Returns None if the read failed, so an unanswered call is never mistaken
    for "no other build is running".
    """
    pid = project_id()
    if not pid or not day:
        return None
    q = urllib.parse.urlencode({
        "field": "sum(session)", "groupBy": "release", "statsPeriod": period,
        "interval": "1d", "project": pid,
    })
    data = api(f"/organizations/{ORG}/sessions/?{q}")
    if not isinstance(data, dict) or "groups" not in data:
        return None
    days = [d[:10] for d in data.get("intervals", [])]
    out = []
    for g in data.get("groups", []):
        rel = g.get("by", {}).get("release")
        if not rel or rel == exclude_version:
            continue
        series = g.get("series", {}).get("sum(session)", [])
        after = sum(n or 0 for d, n in zip(days, series) if d > day)
        if after:
            out.append((rel, after))
    return sorted(out, key=lambda r: -r[1])


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


def ingest_outcomes(period):
    """Every ingest outcome by category — what Sentry did with what it RECEIVED.

    This is what separates the two readings of a silent build, which the
    watcher used to hand to a human as "worth confirming which":

      nothing arrived at all   -> every outcome is 0. The SDK is not sending
                                  because the app is not being launched. Not a
                                  defect; do not send anyone hunting for one.
      arrived and was discarded-> a non-accepted outcome is non-zero. The app
                                  IS reporting and Sentry is throwing it away
                                  (rate limit, quota, malformed payload). That
                                  is a REAL pipeline fault and looks exactly
                                  like the healthy case if you only ever read
                                  the accepted counter.

    `*_indexed` categories are excluded from the discard signal on purpose:
    dynamic sampling emits a `filtered transaction_indexed` that mirrors the
    accepted count one-for-one on a perfectly healthy project, so counting it
    would raise an alarm on every single run. A watcher that cries wolf gets
    ignored, which defeats the thing it was built for.

    Returns (day_labels, {(outcome, category): per-day series}) or None.
    """
    q = urllib.parse.urlencode({
        "statsPeriod": period, "interval": "1d", "field": "sum(quantity)",
        "groupBy": ["outcome", "category"],
    }, doseq=True)
    data = api(f"/organizations/{ORG}/stats_v2/?{q}")
    if not isinstance(data, dict) or "groups" not in data:
        return None
    days = [str(i)[:10] for i in data.get("intervals", [])]
    out = {}
    for g in data.get("groups", []):
        by = g.get("by", {})
        series = g.get("series", {}).get("sum(quantity)", [])
        if any(series):
            out[(by.get("outcome"), by.get("category"))] = series
    return days, out


def discard_signal(outcomes, after_day):
    """(anything_arrived, [discard rows]) counting ONLY days after `after_day`.

    Filtering by explicit date rather than by statsPeriod length is the whole
    point. The first version of this check sized the window as
    floor(hours_silent / 24) and promptly cried wolf on its first real run: a
    5-day window around a last-session-day of 09-12 still *included* 09-12, so
    3 malformed spans from the build's last live session were reported as an
    active "pipeline fault". A window meant to cover only silence must start
    strictly after the last day that had traffic; anything else re-reads the
    live period and calls it a fault.
    """
    if outcomes is None:
        return None, []
    days, series_by_key = outcomes
    idx = [i for i, d in enumerate(days) if after_day is None or d > after_day]
    totals = {}
    for key, series in series_by_key.items():
        total = sum(series[i] for i in idx if i < len(series))
        if total:
            totals[key] = total
    arrived = any(v for (_oc, cat), v in totals.items()
                  if not str(cat).endswith("_indexed"))
    discards = [(oc, cat, v) for (oc, cat), v in sorted(totals.items())
                if oc != "accepted" and not str(cat).endswith("_indexed")]
    return arrived, discards


def device_split(version, period):
    """(transactions from physical devices, transactions from simulators).

    A locally built app run in the iOS Simulator registers its own Sentry
    release, and `/releases/` sorts by date created -- so on 2026-09-10 a
    simulator build (1.0.0+1, Xcode's default build number) became "newest
    release" and hid the actually-shipped B42 from the silence check. It also
    poisoned the timings: simulator cold starts ran 93s against 0.9s on real
    hardware, and the watcher reported three fake SLOW screens.

    `device.simulator` is populated on transaction (segment) rows, so this is
    the cheap way to tell a shipped build from a laptop one. Returns None if
    the query itself failed -- never conflate that with a real zero.
    """
    counts = {}
    for label, sim in (("real", "false"), ("sim", "true")):
        q = urllib.parse.urlencode({
            "field": ["count()"], "statsPeriod": period, "dataset": "spans",
            "query": f'is_transaction:true device.simulator:{sim} release:"{version}"',
            "project": project_id() or "",
        }, doseq=True)
        data = api(f"/organizations/{ORG}/events/?{q}")
        if not isinstance(data, dict) or "data" not in data:
            return None, None
        counts[label] = sum(r.get("count()", 0) for r in data.get("data", []))
    return counts["real"], counts["sim"]


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


def testflight_builds(limit=8):
    """[(build_number, external_state, [group names]), ...], newest first.

    WHY THIS LIVES IN THE SENTRY WATCHER. Sentry can only tell us a release
    EXISTS. It cannot tell us whether anyone is allowed to install it, and those
    are different questions -- 2026-09-18: B42 had been sitting at
    `READY_FOR_BETA_SUBMISSION`, in the Internal group only, for ten days. It was
    never submitted for external beta, so both real testers were still on B40
    (cut 2026-09-04) and every fix in between reached nobody. The watcher saw
    "B42 is not the build in use" and stopped one step short of the cause.

    The second-order cost is the one that hides: tracing landed AFTER B40 was
    cut, so the only build testers could run emitted no performance data at all.
    A distribution gap silently becomes a telemetry gap for exactly the people
    we most need telemetry from.

    Returns None on any failure -- an unreadable ASC is UNKNOWN, never clean,
    the same discipline the session reads above use. pyjwt / .env.asc missing is
    a failed read, not evidence of good distribution.
    """
    try:
        sys.path.insert(0, os.path.join(BASE, "scripts"))
        import asc_api
        app_id = asc_api.load_env().get("ASC_APP_ID")
        if not app_id:
            return None
        status, text = asc_api.request(
            "GET", f"/v1/builds?filter[app]={app_id}&limit={limit}&sort=-version"
            "&include=buildBetaDetail,betaGroups")
        if status != 200:
            return None
        data = json.loads(text)
    except Exception:
        return None
    inc = {(i["type"], i["id"]): i for i in data.get("included", [])}
    out = []
    for b in data.get("data", []):
        rel = b.get("relationships", {})
        ext = None
        ref = (rel.get("buildBetaDetail") or {}).get("data")
        if ref:
            det = inc.get(("buildBetaDetails", ref["id"]))
            if det:
                ext = det["attributes"].get("externalBuildState")
        groups = [inc.get(("betaGroups", g["id"]), {}).get("attributes", {}).get("name")
                  for g in ((rel.get("betaGroups") or {}).get("data") or [])]
        out.append((str(b["attributes"].get("version")), ext, [g for g in groups if g]))
    return out


def distributed_externally(entry):
    """Is this build actually installable by a non-internal tester?

    Both halves are required. `IN_BETA_TESTING` alone is not enough -- a build
    can be in beta testing with the Internal group only, which is precisely the
    state that fooled us.
    """
    _, ext, groups = entry
    return ext == "IN_BETA_TESTING" and any(
        g and g.lower() != "internal" for g in groups)


def report_distribution(newest_version, findings):
    """Say which build TESTERS can run, not just which build is newest."""
    builds = testflight_builds()
    if builds is None:
        print("  TestFlight distribution UNKNOWN — could not read App Store Connect")
        print("    (needs pyjwt + ac-app/.env.asc). Not evidence that it is fine.")
        findings.append("could not read TestFlight distribution state")
        return
    if not builds:
        return
    # The build number is the part after '+' in com.bundle.id@1.0.0+42.
    newest_num = str(newest_version).split("+")[-1] if newest_version else None
    shipped = next((b for b in builds if distributed_externally(b)), None)
    print("  TestFlight distribution:")
    for num, ext, groups in builds[:3]:
        mark = "  <-- testers can install this" if distributed_externally(
            (num, ext, groups)) else ""
        print(f"    build {num:<4} external={ext or '?':<28} groups={groups or 'NONE'}{mark}")
    if shipped is None:
        findings.append("NO build is distributed to external testers")
        print("    ^^ no build is externally distributed — testers have nothing to install.")
        return
    if newest_num and shipped[0] != newest_num:
        findings.append(
            f"build {newest_num} was never distributed externally — "
            f"testers are still on build {shipped[0]}")
        print(f"    ^^ build {newest_num} exists but testers cannot get it; the newest build")
        print(f"       they can install is {shipped[0]}. Every fix in between reaches nobody.")
        print("       Submitting or cutting a build is RC's call — report it, never do it.")


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
    ap.add_argument("--slow-ms", type=float, default=SLOW_MS,
                    help="screen-open budget in ms (default 2000)")
    args = ap.parse_args()
    slow_ms = args.slow_ms

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
        # Skip releases that ONLY ever ran in the Simulator. Those are local
        # builds from this machine; treating one as "the newest release"
        # silently stops watching the build real users are on. A release with
        # no transactions at all is NOT skipped -- that is the silent-build
        # case this section exists to catch.
        newest, skipped = releases[0], []
        for cand in releases:
            v = cand.get("version", "?")
            real, sim = device_split(v, args.days)
            # Skip ONLY on positive evidence of simulator-only traffic. A
            # release with nothing at all (real == sim == 0) is the silent
            # shipped build this section exists to catch -- never skip it.
            # A failed query (None) is not evidence either; keep the release.
            if real == 0 and sim:
                skipped.append((v, sim))
                continue
            newest = cand
            break
        for v, sim in skipped:
            print(f"  skipping {v} — {sim:.0f} simulator transactions, 0 from a real device (local build)")
        ver, created, last = newest.get("version", "?"), newest.get("dateCreated", ""), newest.get("lastEvent")
        newest_created = created
        print(f"  newest release {ver}")
        print(f"    created {created[:16]}   last error event {str(last)[:16] if last else 'NEVER'}")

        # Ask this BEFORE interpreting any silence below. "Nobody is running the
        # newest build" and "nobody was ever offered the newest build" produce
        # identical Sentry data, and only one of them is a problem we can act on.
        report_distribution(ver, findings)

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
                # Don't stop at "either nobody is running it or it broke" --
                # decide it. Pull a window comfortably longer than the silence,
                # then count only the days strictly after the last session day.
                span_days = max(2, int(age_h // 24) + 2)
                arrived, discards = discard_signal(
                    ingest_outcomes(f"{span_days}d"), last_session_day)
                print(f"    ^^ no session for {age_h/24:.0f} days.")
                if arrived is None:
                    findings.append(
                        f"release {ver} silent {age_h/24:.0f}d; ingest counters unreadable")
                    print("       Ingest counters unreadable — cause UNKNOWN, treat as blind.")
                elif discards:
                    findings.append(
                        f"release {ver} is reporting but Sentry is DISCARDING it — pipeline fault")
                    print("       Events ARE arriving and being thrown away — a real fault:")
                    for oc, cat, v in discards:
                        print(f"         {oc} {cat}: {v}")
                elif arrived:
                    # The counters behind `arrived` are project-wide. Before
                    # calling this a reporting fault, ask the one question they
                    # cannot answer: did those events belong to a DIFFERENT
                    # build? A newer release that nobody launches any more is
                    # silent for an entirely ordinary reason.
                    others = releases_active_after(ver, last_session_day, f"{span_days}d")
                    if others:
                        moved = ", ".join(f"{r} ({n:.0f})" for r, n in others[:3])
                        findings.append(
                            f"release {ver} is not the build in use — "
                            f"{others[0][0]} is still sending sessions")
                        print("       The events that arrived belong to OTHER builds, not to")
                        print(f"       {ver}: {moved}.")
                        print("       So the pipeline is fine and this build is simply not")
                        print("       being run. Confirm that is deliberate.")
                    elif others is None:
                        findings.append(
                            f"release {ver} sent no sessions in {age_h/24:.0f}d; "
                            f"could not attribute the events that did arrive")
                        print("       Other events arrived, but the per-release read failed, so")
                        print("       they cannot be attributed. Cause UNKNOWN, treat as blind.")
                    else:
                        findings.append(
                            f"release {ver} sent no sessions in {age_h/24:.0f}d but other events arrived")
                        print("       Other event types still arrived, and no other build is")
                        print("       sending sessions — session tracking specifically may be")
                        print("       off, rather than the app being unused.")
                else:
                    # Deliberately still a finding. "Nothing arrived" rules out
                    # a broken *transport*, but it cannot separate "nobody
                    # launched the app" from "the app dies before Sentry.init()
                    # runs" -- both send exactly zero bytes. So narrow the
                    # words, never the alarm: report it as low-urgency with the
                    # one check that settles it, rather than dropping it.
                    print("       Nothing arrived at all — no accepted events, and nothing")
                    print("       discarded either, so the transport is not broken.")
                    health = release_session_health(ver, args.days)
                    bad = (sum(v for k, v in health.items()
                               if k in ("crashed", "abnormal", "errored", "unhandled"))
                           if health else None)
                    if health:
                        print("       session history: "
                              + ", ".join(f"{k} {v}" for k, v in sorted(health.items()) if v)
                              + (" (all healthy)" if not bad else ""))
                    if bad is None:
                        # The health read FAILED. It did not come back clean.
                        # Falling through to the clean branch here would print
                        # "every session ended healthy" on the strength of a
                        # call that never answered — the failed-read-is-good-
                        # news trap. Say UNKNOWN and keep the old wording.
                        findings.append(
                            f"release {ver} silent {age_h/24:.0f}d, nothing discarded "
                            f"— likely unused, confirm the build still launches")
                        print("       Could not read session health — cannot tell an unused")
                        print("       build from one dying at launch. Confirm it still opens.")
                    elif bad:
                        findings.append(
                            f"release {ver} silent {age_h/24:.0f}d and its last live "
                            f"sessions include {bad} crashed/abnormal — check it still launches")
                        print("       ^^ this build DID have bad sessions before going quiet.")
                        print("          That is the dying-build shape, not the unused one.")
                    else:
                        findings.append(
                            f"release {ver} silent {age_h/24:.0f}d, nothing discarded, "
                            f"session history clean — build is unused, not broken")
                        print("       Every session this build ever logged ended healthy, so it")
                        print("       is not dying at launch — nobody has launched it. Still")
                        print("       reported, because a pre-init crash sends zero bytes and")
                        print("       would read the same if no launch ever got through.")
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
    #
    # `device.simulator:false` is REQUIRED, not a nicety. On 2026-09-10 a
    # local Simulator build shared this project and dragged __root's p95 to
    # 50s (93s cold start) while every physical device was under 1.1s -- three
    # fake SLOW findings. Written as an inclusive `:false` rather than
    # `!device.simulator:true` on purpose: the negated form also keeps rows
    # where the field is null, which is how child spans arrive, so it would
    # let simulator traffic back in the moment the field stops propagating.
    #
    # p50 IS READ ALONGSIDE p95 SO ONE BAD LAUNCH CANNOT MASQUERADE AS A
    # REGRESSION. With n=8 samples, p95 IS essentially the max, so a single
    # slow open becomes the headline. On 2026-09-12 `__root` reported p95
    # 7,417 ms while p50 was 685 ms: one warm start on RC's phone spent 6.5 s
    # in pre-main native time (before UIKit init, before any JS), and every
    # other phase of that same launch dilated proportionally -- a device that
    # was globally slow for a moment, not a code path that got slower. p50
    # separates "every open is slow" from "one open was slow". BOTH still
    # become findings; the classification changes the words, never the alarm.
    q = urllib.parse.urlencode({
        "field": ["transaction", "count()", "p50(span.duration)", "p95(span.duration)"],
        "statsPeriod": args.days,
        "query": "is_transaction:true device.simulator:false",
        "dataset": "spans",
        "project": project_id() or "",
        "sort": "-p95_span_duration",
        "per_page": "10",
    }, doseq=True)
    perf = api(f"/organizations/{ORG}/events/?{q}")
    failed = isinstance(perf, dict) and "_err" in perf
    rows = [] if failed else (perf.get("data", []) if isinstance(perf, dict) else [])
    print("  slowest screen opens (physical devices only):")
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
        # The simulator filter can legitimately empty this result: if the only
        # traffic in the window came from a laptop build, that is "nobody ran
        # the shipped app", not "tracing is broken". Check before alarming --
        # otherwise the filter added above becomes a new source of false
        # alarms, which is the bug it was meant to remove.
        sim_only = api(f"/organizations/{ORG}/events/?" + urllib.parse.urlencode({
            "field": ["count()"], "statsPeriod": args.days, "dataset": "spans",
            "query": "is_transaction:true device.simulator:true",
            "project": project_id() or "",
        }, doseq=True))
        sim_rows = sim_only.get("data", []) if isinstance(sim_only, dict) else []
        sim_n = sum(r.get("count()", 0) for r in sim_rows)
        if sim_n and not pre_instrumentation:
            print(f"    None from physical devices, but {sim_n:.0f} simulator transactions")
            print("    arrived. Tracing works; nobody ran the shipped build in this window.")
        elif pre_instrumentation:
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
            p50 = r.get("p50(span.duration)") or 0
            p95 = r.get("p95(span.duration)") or 0
            name = str(r.get("transaction"))
            n = r.get("count()") or 0
            # p50 over the threshold means the TYPICAL open is slow -- that is
            # the regression this watcher exists to catch. p50 under it with
            # p95 over means only the tail is slow: still reported, still
            # exit 1, but named an outlier so a one-off device hiccup is not
            # mistaken for the app getting slower.
            if p50 > slow_ms:
                flag, finding = "   <-- SLOW", f"{name} p50 {p50:.0f}ms (typical open is slow)"
            elif p95 > slow_ms:
                flag, finding = "   <-- SLOW TAIL", (
                    f"{name} p95 {p95:.0f}ms on n={n:.0f} but p50 {p50:.0f}ms "
                    "— tail only, check whether it repeats")
            else:
                flag, finding = "", None
            print(f"    {name[:36]:<38} n={n:<5.0f} p50={p50:>7.0f}  p95={p95:>7.0f} ms{flag}")
            if finding:
                findings.append(finding)
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
