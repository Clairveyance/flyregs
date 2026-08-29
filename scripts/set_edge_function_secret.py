#!/usr/bin/env python3
"""Set (or rotate) a project-level Edge Function secret via the Supabase
Management API -- what Deno.env.get('NAME') reads inside any edge function.

Usage: python3 scripts/set_edge_function_secret.py NAME VALUE

The value is a runtime argument, never embedded in this file -- pass it on
the command line or pipe it in, don't paste a real secret into a script
that gets committed. See PROJECT_NOTES/flyregs_gotchas.md's 2026-08-29
"webhook secrets committed in plaintext" entry for why this script exists:
before it, rotating one of these meant hand-editing a migration file with
the literal value inline, which is exactly how that incident happened.
Reads ac-app/.env.supabase-mgmt, same credentials as apply_migration.py /
deploy_edge_function.py.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main(name, value):
    env = {}
    for line in open(os.path.join(BASE, ".env.supabase-mgmt")):
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, v = line.partition("="); env[k] = v
    ref = env["SUPABASE_PROJECT_REF"]; token = env["SUPABASE_MANAGEMENT_TOKEN"]

    body = json.dumps([{"name": name, "value": value}]).encode()
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/secrets",
        data=body,
        headers={"Authorization": f"Bearer {token}",
                 "User-Agent": "curl/8.0",  # same Cloudflare-403 workaround as the other mgmt scripts
                 "Content-Type": "application/json"},
        method="POST")
    try:
        urllib.request.urlopen(req)
        print(f"set secret {name} (value not echoed)")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:500]}"); sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(1)
    main(sys.argv[1], sys.argv[2])
