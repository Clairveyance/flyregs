#!/usr/bin/env python3
"""Watch the latest GitHub Actions run for a workflow, print its status/log.

Usage:
  python3 scripts/gh_run_watch.py <workflow-file.yml> [--wait] [--log]

Reads ac-app/.env.github for GITHUB_TOKEN.
"""
import io
import json
import os
import re
import sys
import time
import urllib.request
import zipfile

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "Clairveyance/flyregs"


def env():
    e = {}
    with open(os.path.join(BASE, ".env.github")) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            e[k] = v.strip('"').strip("'")
    return e


H = {"Authorization": "Bearer " + env()["GITHUB_TOKEN"],
     "Accept": "application/vnd.github+json"}


def api(path, raw=False):
    r = urllib.request.urlopen(urllib.request.Request(
        "https://api.github.com" + path, headers=H))
    return r.read() if raw else json.load(r)


def latest(workflow):
    d = api(f"/repos/{REPO}/actions/workflows/{workflow}/runs?per_page=1")
    return d["workflow_runs"][0] if d["workflow_runs"] else None


def main():
    workflow = sys.argv[1]
    wait = "--wait" in sys.argv
    show_log = "--log" in sys.argv

    run = latest(workflow)
    if not run:
        print("no runs")
        return
    print(f"run #{run['run_number']} {run['html_url']}")

    while wait and run["status"] != "completed":
        time.sleep(15)
        run = latest(workflow)
        print(f"  ... {run['status']}")

    print(f"status={run['status']} conclusion={run['conclusion']} sha={run['head_sha'][:8]}")

    if show_log and run["status"] == "completed":
        z = zipfile.ZipFile(io.BytesIO(
            api(f"/repos/{REPO}/actions/runs/{run['id']}/logs", raw=True)))
        for n in z.namelist():
            if "/" in n:
                continue
            for line in z.read(n).decode("utf8", "replace").splitlines():
                if re.search(r"Step \d/|ERROR|Traceback|error:|complete|"
                             r"link counts|classified|Resolved|Deduped|Wrote|"
                             r"vocabulary|associations|->", line):
                    print("   " + re.sub(r"^\S+Z ", "", line)[:160])
    sys.exit(0 if run["conclusion"] in (None, "success") else 1)


if __name__ == "__main__":
    main()
