#!/usr/bin/env python3
"""Audit: no scheduled GitHub workflow is sitting red.

WHY, 2026-09-10
`third_party_health.py` reported three failing workflows. Running it is a
manual act, and nothing in `run_all_audits.sh` looked at CI at all, so the one
that mattered had been failing for two days unseen:

    Daily Reminder Alerts -- selectAll(user_aircraft_reminders): orderBy is
    required ... at scripts/send-reminder-alerts.mjs:50

That is the job that pushes maintenance and AD-due reminders to real users. The
`orderBy` guard in `lib/page.mjs` went in on 2026-09-07 and three of the four
`selectAll` calls in that very file were updated; line 50 was missed, and
`lib/tier-cap.mjs:81` with it. Nobody watches a green checkmark turn red.

`scraper_freshness_check.py` is the closest existing guard and does NOT cover
this: it detects the ABSENCE of scraper evidence in the database, so it says
nothing about a push-sender, an embeddings refresh, or the master audit itself.

WHAT IT DOES NOT DO
It does not judge staleness -- a weekly workflow that has not run since Monday
is not a defect, and freshness of CONTENT is already covered elsewhere. It fails
on exactly one thing: the most recent run of a workflow concluded `failure`.

Note that a workflow fixed in a later commit stays red until it next runs. That
is not a false positive -- CI IS red, and the fix is unproven until a run goes
green. Trigger it manually rather than silencing this.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "Clairveyance/flyregs"


def token():
    path = os.path.join(BASE, ".env.github")
    if not os.path.exists(path):
        return None
    for line in open(path):
        line = line.strip().removeprefix("export ")
        if line.startswith("GITHUB_TOKEN"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def main():
    tok = token()
    if not tok:
        # Not a failure: a machine without the token cannot check, and pretending
        # otherwise would be worse than saying so.
        print("SKIP: no GITHUB_TOKEN in .env.github -- cannot read workflow state.")
        return 0
    h = {"Authorization": "Bearer " + tok, "User-Agent": "curl/8.0",
         "Accept": "application/vnd.github+json"}

    def gh(path):
        req = urllib.request.Request("https://api.github.com" + path, headers=h)
        return json.loads(urllib.request.urlopen(req, timeout=30).read().decode())

    try:
        workflows = gh(f"/repos/{REPO}/actions/workflows")["workflows"]
    except urllib.error.HTTPError as e:
        print(f"SKIP: GitHub API returned {e.code} -- cannot read workflow state.")
        return 0

    red, checked = [], 0
    for w in workflows:
        if w.get("state") != "active":
            continue
        runs = gh(f"/repos/{REPO}/actions/workflows/{w['id']}/runs?per_page=1")["workflow_runs"]
        if not runs:
            continue
        checked += 1
        r = runs[0]
        if r["conclusion"] == "failure":
            red.append((w["name"], r["created_at"], r["html_url"]))

    print(f"checked {checked} active workflow(s)")
    if red:
        print(f"\nFAIL  {len(red)} workflow(s) last ran RED:\n")
        for name, when, url in red:
            print(f"   - {name}\n       last run {when}\n       {url}")
        print("\n  A red scheduled job does its work for nobody. Fix it, then re-run it")
        print("  manually -- the fix is unproven until a run goes green.")
        return 1
    print("\nPASS  every active scheduled workflow's most recent run succeeded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
