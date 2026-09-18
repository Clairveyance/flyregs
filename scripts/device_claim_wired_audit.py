#!/usr/bin/env python3
"""Every way a session can begin must claim the device first.

This guards the 2026-08-26 real-data-loss incident, which is the worst thing
that has happened to this app so far. The device carries a "whose data is this"
tag (syncOwner). If a session starts and that tag still names the PREVIOUS
account, every guarded local read -- bookmarks, folders, notes, recents --
correctly returns [] for the account that just signed in. The damage is what
happens next: addBookmark does setItem(KEY, [bookmark, ...list]) where `list` is
that empty array, so ONE bookmark tap overwrites the other account's real saved
items, and the new account still cannot see its own write.

claimDeviceIfMismatched() is what prevents that, and it only works if it runs on
EVERY path that can start a session. There are exactly two:

  1. cold launch, restoring a stored session   (supabase.auth.getSession)
  2. a live sign-in event                      (onAuthStateChange)

...and (2) has already been wrong once in the way that matters. It was gated on
SIGNED_IN alone, but supabase-js fires PASSWORD_RECOVERY -- not SIGNED_IN -- for
a recovery link. So somebody who reinstalled, forgot their password and came
back through a reset email skipped the device claim entirely: precisely the
person most likely to be signing in on a phone that still holds someone else's
data. TOKEN_REFRESHED must stay excluded (it fires roughly hourly, and
re-running a destructive ownership check on a timer is what widened the original
incident's blast radius).

Source-level, no network.

Usage: python3 scripts/device_claim_wired_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    auth = (ROOT / "src/context/auth.tsx").read_text()

    # Count real invocations only. The import names it without parentheses, and
    # several comments name it followed by "'s" -- neither is a call site. An
    # earlier draft subtracted the import line from a regex the import could not
    # match in the first place, and under-counted by one: a check that miscounts
    # in the SAFE direction is the dangerous kind, because the fix is to relax
    # it and a relaxed check is how this stops guarding anything.
    calls = sum(
        1 for line in auth.splitlines()
        if re.search(r"\bclaimDeviceIfMismatched\s*\(", line)
        and not line.lstrip().startswith(("//", "*", "/*"))
    )
    check("the device claim is invoked from BOTH session-start paths "
          "(cold launch and a live sign-in)", calls >= 2, f"found {calls} call(s)")

    check("a stored session restored at cold launch claims the device",
          re.search(r"getSession\(\)[\s\S]{0,3000}?claimDeviceIfMismatched\s*\(", auth)
          is not None,
          "no claim between getSession() and the end of that handler")

    check("a live sign-in claims the device",
          re.search(r"isRealSignIn\)\s*await\s+claimDeviceIfMismatched\s*\(", auth)
          is not None)

    check("PASSWORD RECOVERY counts as a real sign-in (the 2026-08-26 gap)",
          re.search(r"isRealSignIn\s*=\s*event === 'SIGNED_IN'\s*\|\|\s*"
                    r"event === 'PASSWORD_RECOVERY'", auth) is not None,
          "isRealSignIn no longer covers PASSWORD_RECOVERY")

    check("TOKEN_REFRESHED is still NOT treated as a sign-in",
          "TOKEN_REFRESHED" not in re.search(
              r"const isRealSignIn = .*", auth).group(0),
          "a destructive ownership check must not run on the refresh timer")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("device_claim_wired_audit -- every session-start path claims the device")


if __name__ == "__main__":
    main()
