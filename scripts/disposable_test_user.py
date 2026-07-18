#!/usr/bin/env python3
"""Create/delete a disposable Supabase auth user for browser-preview testing.

Used repeatedly across sessions to sign into the web preview as a fresh
Premium account (the web build's RevenueCat stub — src/lib/revenuecat.web.ts —
treats every signed-in user as isPro/isPremium regardless of real subscription
status, so any real account works for exercising Pro/Premium-gated screens).

NEVER use review@flyregs.com or any real account for this kind of ad-hoc
testing — always create a throwaway user, verify, then delete it in the same
session. Reads ac-app/.env.scraper for the Supabase service-role key.

Usage:
    python3 scripts/disposable_test_user.py create [email-prefix]
        -> creates <prefix or "temp-test">-<unix-timestamp>@flyregs.com,
           prints "id=<uuid>" and "email=<address>" and "password=<password>"
    python3 scripts/disposable_test_user.py delete <user-id>
        -> deletes the user by id (cascades to every app table via each
           table's ON DELETE CASCADE on user_id -> auth.users(id))
"""
import sys
import time
import json
import secrets
import urllib.request

ENV_PATH = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/.env.scraper"


def load_env():
    env = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            k, _, v = line.partition("=")
            env[k] = v.strip('"').strip("'")
    return env


def request(method, path, env, body=None):
    url = env["SUPABASE_URL"] + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", env["SUPABASE_SERVICE_KEY"])
    req.add_header("Authorization", f"Bearer {env['SUPABASE_SERVICE_KEY']}")
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def create(prefix):
    env = load_env()
    email = f"{prefix}-{int(time.time())}@flyregs.com"
    password = f"Tmp{secrets.token_urlsafe(12)}!"
    status, text = request(
        "POST",
        "/auth/v1/admin/users",
        env,
        {"email": email, "password": password, "email_confirm": True},
    )
    if status != 200:
        print(f"HTTP {status}")
        print(text)
        sys.exit(1)
    data = json.loads(text)
    print(f"id={data['id']}")
    print(f"email={email}")
    print(f"password={password}")


def delete(user_id):
    env = load_env()
    status, text = request("DELETE", f"/auth/v1/admin/users/{user_id}", env)
    print(f"HTTP {status}")
    print(text or "(deleted)")


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in ("create", "delete"):
        print(__doc__)
        sys.exit(1)
    if sys.argv[1] == "create":
        create(sys.argv[2] if len(sys.argv) > 2 else "temp-test")
    else:
        if len(sys.argv) < 3:
            print("delete requires a user id")
            sys.exit(1)
        delete(sys.argv[2])
