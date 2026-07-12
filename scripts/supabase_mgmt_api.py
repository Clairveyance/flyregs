#!/usr/bin/env python3
"""Supabase Management API helper (different from the regular service-role key
used everywhere else via .env.scraper — this one manages the PROJECT itself:
storage/database status, settings, etc., not table data).
Reads ac-app/.env.supabase-mgmt for credentials.

Usage:
  python3 scripts/supabase_mgmt_api.py status
  python3 scripts/supabase_mgmt_api.py query "select 1;"
"""
import sys
import json
import urllib.request

ENV_PATH = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/.env.supabase-mgmt"


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
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}: {e.read().decode()}"


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "status":
        print(request(""))
    elif cmd == "query":
        print(request("/database/query", {"query": sys.argv[2]}))
    else:
        print("Usage: status | query \"<sql>\"")
