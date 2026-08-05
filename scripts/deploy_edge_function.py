#!/usr/bin/env python3
"""Deploy one Edge Function via the Supabase Management API.

Usage: python3 scripts/deploy_edge_function.py semantic-search

Single-file deploy (the function's index.ts and nothing else) -- these
functions deliberately avoid remote imports because esm.sh/jsr resolution
at cold start caused BOOT_ERROR with this endpoint. Reads
ac-app/.env.supabase-mgmt, same credentials as apply_migration.py.
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def main(name):
    env = {}
    for line in open(os.path.join(BASE, ".env.supabase-mgmt")):
        line = line.strip()
        if line and not line.startswith("#"):
            k, _, v = line.partition("="); env[k] = v
    ref = env["SUPABASE_PROJECT_REF"]; token = env["SUPABASE_MANAGEMENT_TOKEN"]
    src = open(os.path.join(BASE, "supabase", "functions", name, "index.ts")).read()

    boundary = "----flyregsdeploy"
    meta = json.dumps({"name": name, "entrypoint_path": "index.ts",
                       "verify_jwt": False})
    parts = []
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
                 f'Content-Type: application/json\r\n\r\n{meta}\r\n')
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\n'
                 f'Content-Type: application/typescript\r\n\r\n{src}\r\n')
    parts.append(f'--{boundary}--\r\n')
    body = "".join(parts).encode()

    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}/functions/deploy?slug={name}",
        data=body,
        headers={"Authorization": f"Bearer {token}",
                 # Cloudflare in front of api.supabase.com 403s (error 1010)
                 # on urllib's default UA -- same workaround apply_migration.py
                 # already uses.
                 "User-Agent": "curl/8.0",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST")
    try:
        r = json.loads(urllib.request.urlopen(req).read().decode())
        print(f"deployed {name}: version={r.get('version')} status={r.get('status')}")
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:1000]}"); sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2: print(__doc__); sys.exit(1)
    main(sys.argv[1])
