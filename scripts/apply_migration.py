#!/usr/bin/env python3
"""Apply a .sql file to the production Supabase DB via the Management API.

Usage: python3 scripts/apply_migration.py sync/migrations_duels_2.sql

Reads ac-app/.env.supabase-mgmt (same credentials as supabase_mgmt_api.py).
Prints the JSON result, or the HTTP error body and exits 1.
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(path):
    env = {}
    with open(os.path.join(BASE, ".env.supabase-mgmt")) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            k, _, v = line.partition("=")
            env[k] = v
    sql = open(path if os.path.isabs(path) else os.path.join(BASE, path)).read()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{env['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": f"Bearer {env['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    try:
        print(urllib.request.urlopen(req).read().decode()[:2000])
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:3000]}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
