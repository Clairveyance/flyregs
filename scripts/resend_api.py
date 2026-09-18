#!/usr/bin/env python3
"""Resend API helper. Reads ac-app/.env.resend for RESEND_API_KEY.

Resend is the SMTP provider behind every account-confirmation, password-reset
and welcome email, so its sending limits -- not Supabase's -- are the real
ceiling on how many people can sign up. See
memory/flyregs_email_rate_limit.md.

Usage:
  python3 scripts/resend_api.py domains          # domain + DNS/verification state
  python3 scripts/resend_api.py emails [N]       # recent sends and their status
  python3 scripts/resend_api.py keys             # API keys on the account
  python3 scripts/resend_api.py GET /some/path   # anything else
"""
import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(ROOT, ".env.resend")


def key():
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line.startswith("RESEND_API_KEY="):
                return line.split("=", 1)[1]
    raise RuntimeError(f"RESEND_API_KEY not found in {ENV_PATH}")


def request(method, path, body=None):
    # The User-Agent is load-bearing. Python-urllib's default gets a 403 from
    # Resend, which reads exactly like "this key lacks permission" and sent me
    # hunting for a restricted key that did not exist -- while the identical
    # request through curl returned 200. Same trap the Supabase Management API
    # sets (see supabase_mgmt_api.py and memory/supabase_edge_logs_api_access.md);
    # when two clients disagree about a 403, suspect the headers before the key.
    # Content-Type is sent only with a body.
    headers = {"Authorization": f"Bearer {key()}", "User-Agent": "curl/8.0"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"https://api.resend.com{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:500]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "domains":
        st, d = request("GET", "/domains")
        print(f"HTTP {st}")
        for dom in (d.get("data", []) if isinstance(d, dict) else []):
            print(f"  {dom.get('name'):28} status={dom.get('status'):10} "
                  f"region={dom.get('region')}  created={dom.get('created_at','')[:10]}")
    elif cmd == "emails":
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 20
        st, d = request("GET", f"/emails?limit={n}")
        print(f"HTTP {st}")
        rows = d.get("data", []) if isinstance(d, dict) else []
        if not rows:
            print("  (no rows returned — this endpoint needs a paid plan on some tiers)")
        for e in rows:
            print(f"  {e.get('created_at','')[:19]}  {str(e.get('last_event')):12} "
                  f"{str(e.get('to'))[:40]:42} {str(e.get('subject'))[:40]}")
    elif cmd == "keys":
        st, d = request("GET", "/api-keys")
        print(f"HTTP {st}")
        for k in (d.get("data", []) if isinstance(d, dict) else []):
            print(f"  {k.get('name'):28} created={k.get('created_at','')[:10]}")
    else:
        st, d = request(cmd, sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)
        print(f"HTTP {st}")
        print(json.dumps(d, indent=2)[:4000] if isinstance(d, (dict, list)) else d)


if __name__ == "__main__":
    main()
