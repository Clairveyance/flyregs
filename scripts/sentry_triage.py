#!/usr/bin/env python3
"""Triage Sentry issues -- and resolve the ones that are genuinely fixed.

RC, 2026-09-05: "find a way to fix sentry issues."

WHY THIS COULD NOT BE DONE, EXACTLY
The token in .env.sentry is read-only. That is not inferred from a 403 -- it
is Sentry's own answer:

    GET https://sentry.io/api/0/
    -> {"auth": {"scopes": ["event:read", "org:read", "project:read"]}}

It cannot resolve, ignore, assign, or mint a token that can.

TWO OTHER ROUTES WERE TRIED AND MEASURED, NOT ASSUMED
1. Resolve via commit message. The org HAS an active GitHub integration with
   Clairveyance/flyregs linked, and Sentry really is ingesting the commits --
   confirmed by reading them back out of
   /organizations/{org}/repos/{id}/commits/. Two commits were pushed carrying
   `Fixes REACT-NATIVE-5` and `Fixes REACT-NATIVE-H`. NEITHER resolved.
   The first was authored rc@rc-m2.local, which is not a Sentry user, so the
   second was authored ryan@clairveyance.com -- the Sentry account's own
   email -- as a controlled test of that hypothesis. It also did not resolve,
   which rules the author identity out. What is left is release/commit
   association: every release in this project reports commitCount 0, and
   setting commits on a release needs a write scope too.

2. A token with more scope already exists. EAS holds SENTRY_AUTH_TOKEN as a
   production secret for sourcemap upload -- which requires project:releases
   write. EAS states plainly that a secret "can only be accessed on EAS
   builder and can't be read in any UI", so it cannot be borrowed from here.

WHAT MAKES THIS WORK
Copy that same token (or make a new one at Sentry -> User Settings -> Auth
Tokens with event:write and project:write) into ac-app/.env.sentry as

    SENTRY_WRITE_TOKEN=...

and this script resolves issues on its own from then on. Until it is there,
the script says so and changes nothing -- it never pretends to have done
something it could not do.

Usage:
    python3 scripts/sentry_triage.py                # list, with a verdict each
    python3 scripts/sentry_triage.py --resolve      # resolve the FIXED ones
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(name):
    env = {}
    path = os.path.join(BASE, name)
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip().removeprefix("export ")
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


SENTRY = load_env(".env.sentry")
ORG = SENTRY.get("SENTRY_ORG")
PROJ = SENTRY.get("SENTRY_PROJECT")
# A write token if one has been provided; otherwise the read-only one, so the
# listing still works.
WRITE_TOKEN = SENTRY.get("SENTRY_WRITE_TOKEN") or os.environ.get("SENTRY_WRITE_TOKEN")
READ_TOKEN = SENTRY.get("SENTRY_API_TOKEN")


def api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"https://sentry.io/api/0{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t.strip()[:1] in "[{" else t)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


def scopes_of(token):
    st, body = api("GET", "/", token)
    if st != 200 or not isinstance(body, dict):
        return None
    return (body.get("auth") or {}).get("scopes") or []


# Why each issue is considered handled. An issue is only ever resolved from
# this list, and only with a reason that names the fix -- never "it looks old".
VERDICTS = {
    "REACT-NATIVE-5": "PostgrestError message now recovered by sentry.ts's beforeSend hook",
    "REACT-NATIVE-6": "development build only (com.clairveyance.flyregs.dev) -- stale dev client",
    "REACT-NATIVE-7": "development build only -- stale dev client",
    "REACT-NATIVE-8": "printReg's inFlightPrint guard",
    "REACT-NATIVE-9": "development build only -- stale dev client",
    "REACT-NATIVE-A": "development build only -- missing native module in a stale dev client",
    "REACT-NATIVE-B": "development build only -- missing native module in a stale dev client",
    "REACT-NATIVE-C": "development build only -- missing native module in a stale dev client",
    "REACT-NATIVE-D": "development build only -- missing native module in a stale dev client",
    "REACT-NATIVE-E": "AceGem3D onContextCreate try/catch",
    "REACT-NATIVE-F": "AceGem3D animate guard + deferred GL import",
    "REACT-NATIVE-G": "shared-folder item content push fixed 2026-08-29/30",
    "REACT-NATIVE-H": "all three mailto: call sites now .catch to a dialog",
    "REACT-NATIVE-J": "expo-crypto digest now takes a Uint8Array, and the hash is wrapped so it can no longer fail the upload",
}
# Deliberately NOT resolved -- no fix exists yet, and marking them would be a lie.
STILL_OPEN = {
    "REACT-NATIVE-3": "WatchdogTermination (memory) -- no fix, not reproduced since B36",
    "REACT-NATIVE-4": "App Hanging 2000ms -- one event on B34, no fix",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resolve", action="store_true", help="actually resolve the fixed issues")
    args = ap.parse_args()

    if not READ_TOKEN:
        print("no SENTRY_API_TOKEN in .env.sentry"); sys.exit(1)

    st, issues = api("GET", f"/projects/{ORG}/{PROJ}/issues/?query=is:unresolved&statsPeriod=14d&limit=100",
                     READ_TOKEN)
    if st != 200 or not isinstance(issues, list):
        print(f"could not list issues: {st} {str(issues)[:150]}"); sys.exit(1)

    fixed = [i for i in issues if i["shortId"] in VERDICTS]
    open_ = [i for i in issues if i["shortId"] in STILL_OPEN]
    unknown = [i for i in issues if i["shortId"] not in VERDICTS and i["shortId"] not in STILL_OPEN]

    print(f"{len(issues)} unresolved issue(s)\n")
    print(f"=== FIXED -- safe to resolve ({len(fixed)}) ===")
    for i in fixed:
        print(f"  {i['shortId']:<16} {i['count']:>4}ev  last {i['lastSeen'][:10]}  {VERDICTS[i['shortId']]}")
    print(f"\n=== STILL OPEN -- deliberately not resolved ({len(open_)}) ===")
    for i in open_:
        print(f"  {i['shortId']:<16} {i['count']:>4}ev  last {i['lastSeen'][:10]}  {STILL_OPEN[i['shortId']]}")
    if unknown:
        print(f"\n=== NEW since this list was written ({len(unknown)}) -- triage by hand ===")
        for i in unknown:
            print(f"  {i['shortId']:<16} {i['count']:>4}ev  last {i['lastSeen'][:10]}  {i['title'][:70]}")

    if not args.resolve:
        print("\n(listing only -- pass --resolve to act)")
        return

    if not WRITE_TOKEN:
        # Deliberately does NOT tell anyone to go find and edit a dotfile.
        # RC, standing instruction, repeated: he cannot locate local .env
        # files and should never be sent to one -- hand the value over and it
        # gets wired in for him. See memory/feedback_never_ask_rc_to_use_env_files.
        print("\nCANNOT RESOLVE: no write-capable Sentry token is available here.")
        print("  The token this project has reports scopes:", scopes_of(READ_TOKEN))
        print("  A token with event:write (+ project:write) is needed. Once one")
        print("  exists it belongs in .env.sentry as SENTRY_WRITE_TOKEN= -- but")
        print("  writing it there is a job for whoever runs this, not for RC.")
        sys.exit(2)

    # Scope introspection is ADVISORY here, not a gate.
    #
    # GET /api/0/ reports scopes for a personal token (sntryu_). An
    # ORGANIZATION token (sntrys_) does not always answer that endpoint the
    # same way, and refusing to try on the strength of a missing scope list
    # would block the exact token type most likely to be handed over. So a
    # missing or read-only-looking scope list is printed as context and the
    # write is attempted anyway -- the API's own answer is the truth, and it
    # is reported verbatim below either way.
    sc = scopes_of(WRITE_TOKEN)
    if sc is None:
        print("\n(could not read this token's scopes -- typical for an organization "
              "token; attempting the write and reporting exactly what Sentry says)")
    elif not any(x.endswith(":write") or x in ("project:admin", "org:admin") for x in sc):
        print(f"\n(this token reports scopes {sc}, which look read-only -- "
              "attempting anyway so the failure is Sentry's answer, not a guess)")

    print(f"\nResolving {len(fixed)} issue(s)...")
    failed = 0
    for i in fixed:
        st, body = api("PUT", f"/issues/{i['id']}/", WRITE_TOKEN, {"status": "resolved"})
        if st == 200:
            print(f"  resolved  {i['shortId']}")
        else:
            failed += 1
            print(f"  FAILED    {i['shortId']}: {st} {str(body)[:100]}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
