#!/usr/bin/env python3
"""Supabase Management API helper (different from the regular service-role key
used everywhere else via .env.scraper — this one manages the PROJECT itself:
storage/database status, settings, etc., not table data).
Reads ac-app/.env.supabase-mgmt for credentials.

Usage:
  python3 scripts/supabase_mgmt_api.py status
  python3 scripts/supabase_mgmt_api.py query "select 1;"
"""
import os
import sys
import json
import time
import urllib.error
import urllib.request

# Resolved from THIS FILE's location, never a hardcoded absolute path.
# `/Users/rc/...` here meant every mgmt()-backed audit died on the CI
# runner with FileNotFoundError, so the Weekly Master Audit had been
# structurally unable to run its whole database-facing half -- 13 of 51
# audits -- while still reporting a total. Found 2026-09-10.
ENV_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env.supabase-mgmt")


def load_env():
    env = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v
    return env


def request(path, body=None):
    env = load_env()
    url = f"https://api.supabase.com/v1/projects/{env['SUPABASE_PROJECT_REF']}{path}"
    headers = {"Authorization": f"Bearer {env['SUPABASE_MANAGEMENT_TOKEN']}", "User-Agent": "curl/8.0"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if body else "GET")

    # Retry on 429, and on the 5xx family. The Management API is rate limited
    # per token, and `run_all_audits.sh` fires dozens of queries per audit
    # across 51 audits.
    #
    # This only started biting on 2026-09-10, and the reason is worth keeping:
    # the mgmt()-backed audits used to die INSTANTLY on a hardcoded-path
    # FileNotFoundError, so on CI they made zero API calls. Fixing the path made
    # them actually run, and together they blew the limit -- four audits failed
    # with `ThrottlerException: Too Many Requests`. Locally the same sweep passes
    # only because ~850ms of round-trip latency per call throttles it by
    # accident; the runner is faster and has no such luck.
    #
    # Honour Retry-After when the server sends one, otherwise back off
    # exponentially. Returning the error string unretried made a transient
    # limit look identical to a broken query.
    delays = [1, 2, 4, 8, 16]
    for attempt in range(len(delays) + 1):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read().decode()
        except urllib.error.HTTPError as e:
            body_text = e.read().decode()
            retryable = e.code == 429 or 500 <= e.code < 600
            if not retryable or attempt == len(delays):
                return f"HTTP {e.code}: {body_text}"
            wait = delays[attempt]
            hdr = e.headers.get("Retry-After") if e.headers else None
            if hdr:
                try:
                    wait = max(wait, min(60, int(float(hdr))))
                except ValueError:
                    pass
            print(f"[supabase_mgmt_api] HTTP {e.code}; retrying in {wait}s "
                  f"(attempt {attempt + 1}/{len(delays)})", file=sys.stderr)
            time.sleep(wait)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "status":
        print(request(""))
    elif cmd == "query":
        print(request("/database/query", {"query": sys.argv[2]}))
    else:
        print("Usage: status | query \"<sql>\"")
