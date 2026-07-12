#!/usr/bin/env python3
"""App Store Connect API helper. Reads ac-app/.env.asc for credentials.
Usage: python3 scripts/asc_api.py GET /v1/apps
       python3 scripts/asc_api.py GET "/v1/builds?filter[app]=6785706782&limit=5"

Requires: pip3 install pyjwt

Credentials (.env.asc, gitignored) + private key live in this project already:
  ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_PATH (relative to ac-app/), ASC_APP_ID.
See PROJECT_NOTES/account_reference.md for the non-secret IDs (App ID, etc).
"""
import sys
import time
import json
import urllib.request

import jwt

ENV_PATH = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/.env.asc"
BASE = "https://api.appstoreconnect.apple.com"


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


def make_token(env):
    key_path = "/Users/rc/Local Desktop/COWORK/Apps/AC app/ac-app/" + env["ASC_PRIVATE_KEY_PATH"]
    with open(key_path) as f:
        private_key = f.read()
    now = int(time.time())
    payload = {
        "iss": env["ASC_ISSUER_ID"],
        "iat": now,
        "exp": now + 1200,
        "aud": "appstoreconnect-v1",
    }
    headers = {"alg": "ES256", "kid": env["ASC_KEY_ID"], "typ": "JWT"}
    return jwt.encode(payload, private_key, algorithm="ES256", headers=headers)


def request(method, path, body=None):
    env = load_env()
    token = make_token(env)
    url = BASE + path
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if body:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


if __name__ == "__main__":
    method = sys.argv[1]
    path = sys.argv[2]
    body = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
    status, text = request(method, path, body)
    print(f"HTTP {status}")
    print(text)
