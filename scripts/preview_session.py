#!/usr/bin/env python3
"""Mint a real Supabase session for the web preview, at any tier.

WHY: the Browser-pane preview signs itself out whenever localStorage is
cleared, and several screens (AD/LOI bodies, the paywall's downgrade path,
Duels, shared folders, Study Mode) are tier-gated, so a signed-out preview
can only ever show the paywall. Saying "I could not see that screen" is not
acceptable -- RC: "there should be no layout you can't see. you built
everything, so you can access everything."

Passwords are never handled. This uses the admin API's own magic-link flow:
generateLink -> hashed_token -> verifyOtp -> a real session, exactly the
path the app itself uses for an email link.

Usage:
    python3 scripts/preview_session.py                      # premium matrix account
    python3 scripts/preview_session.py pro                  # tier matrix account
    python3 scripts/preview_session.py someone@example.com  # a specific account

Prints a single line of JavaScript. Paste/execute it in the preview, then
reload:

    localStorage.setItem('sb-<ref>-auth-token', '<session json>')

Tier accounts are the purpose-built tiermatrix-*@flyregs.invalid ones that
tier_matrix_test.py already maintains -- they hold real user_entitlements
rows, so the SERVER sees the right tier. That matters: the `?tier=` query
override is a web-client stub only and the server has never heard of it.
"""
import json, os, re, sys, urllib.error, urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = open(os.path.join(BASE, ".env")).read()
g = lambda k: re.search(rf"^{k}=(.*)$", env, re.M).group(1).strip()
URL, ANON = g("EXPO_PUBLIC_SUPABASE_URL"), g("EXPO_PUBLIC_SUPABASE_ANON_KEY")
SERVICE = re.search(r"^\s*(?:export\s+)?SUPABASE_SERVICE_KEY=(.+)$",
                    open(os.path.join(BASE, ".env.scraper")).read(), re.M).group(1).strip()
SVC = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}", "Content-Type": "application/json"}
# Derive the project ref WITHOUT new URL() -- see web_preview_restore_session.
REF = URL.replace("https://", "").replace("http://", "").split(".")[0]


def call(url, data=None, headers=None):
    r = urllib.request.Request(
        url, data=json.dumps(data).encode() if data is not None else None,
        headers=headers or {})
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip() else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main():
    arg = (sys.argv[1] if len(sys.argv) > 1 else "premium").strip()
    email = arg if "@" in arg else f"tiermatrix-{arg}@flyregs.invalid"

    st, link = call(f"{URL}/auth/v1/admin/generate_link",
                    {"type": "magiclink", "email": email}, SVC)
    if st != 200:
        raise SystemExit(f"generate_link failed for {email}: HTTP {st} {link}")
    th = link.get("hashed_token") or link.get("properties", {}).get("hashed_token")

    st, sess = call(f"{URL}/auth/v1/verify",
                    {"type": "magiclink", "token_hash": th},
                    {"apikey": ANON, "Content-Type": "application/json"})
    if st != 200 or not sess or "access_token" not in sess:
        raise SystemExit(f"verify failed: HTTP {st} {sess}")

    uid = sess.get("user", {}).get("id")
    st, ent = call(f"{URL}/rest/v1/user_entitlements?user_id=eq.{uid}"
                   f"&select=is_pro,is_premium,is_unlocked", headers=SVC)
    print(f"# account : {email}")
    print(f"# user_id : {uid}")
    print(f"# server-side entitlement: {ent}")
    print(f"# storage key: sb-{REF}-auth-token")
    print()
    print(f"localStorage.setItem('sb-{REF}-auth-token', {json.dumps(json.dumps(sess))}); "
          f"'signed in as {email}'")


if __name__ == "__main__":
    main()
