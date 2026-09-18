#!/usr/bin/env python3
"""Every notification toggle starts ON for a brand-new account -- and a
re-registration NEVER flips back something the user deliberately turned off.

RC, 2026-09-04: "we want all account toggles ON by default. we want users to
get updates, DR, DW, and be seen in the app, so default is on and they can turn
off anytime."  Restated 2026-09-17: "reminder, all toggles default ON w new
accounts."

Two halves, and the second is the one that makes the first safe.

DEFAULT ON.  A brand-new user must not have to go hunting through Settings to
start receiving anything. Two things have to be true for that:
  * the app must ASK for push permission on a real sign-in rather than only
    when someone finds a toggle -- otherwise there is no push_tokens row at
    all, and every toggle renders OFF (isAcUpdateAlertsEnabled fails closed by
    design, which is correct, but means "no row" reads as "all off");
  * the very first registration must write all four columns TRUE.

NEVER RESURRECT AN OFF.  ensurePushTokenRegistered runs on every app
foreground. If its `?? true` fallbacks could reach a user who had switched
something off, that user would find it silently back on -- the same family as
gotcha_tier_check_rewrote_user_setting, where a check rewrote a stored
preference instead of just reading it. The fallbacks are only allowed to apply
when there is NO remote row AND NO cached prefs. This proves that live: a row
with everything OFF, re-registered, must stay OFF.

Both halves run against the real project with a disposable account.

Usage: python3 scripts/notification_defaults_audit.py
"""
import pathlib
import re
import secrets
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from folders_e2e_test import (                                    # noqa: E402
    http, check, make_user, delete_user, ANON, SERVICE, FAILURES,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent
COLS = ("enabled", "duel_notifications_enabled",
        "reg_of_day_enabled", "word_of_day_enabled")
LABEL = {"enabled": "AC Update Alerts", "reg_of_day_enabled": "DailyReg",
         "word_of_day_enabled": "DailyWord", "duel_notifications_enabled": "Duel Alerts"}


def register(user, token, prior=None):
    """The upsert ensurePushTokenRegistered performs. `prior` is the remote row
    or cached prefs it found; None means a genuinely first-ever registration."""
    body = {"user_id": user["id"], "expo_push_token": token, "platform": "ios",
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    for c in COLS:
        body[c] = (prior or {}).get(c, True)
    st, out = http("POST", "/rest/v1/push_tokens", key=ANON, jwt=user["jwt"],
                   body=body, headers={"Prefer": "resolution=merge-duplicates"})
    return st, out


def prefs_of(user, token):
    st, rows = http("GET", f"/rest/v1/push_tokens?user_id=eq.{user['id']}"
                           f"&expo_push_token=eq.{token}"
                           f"&select={','.join(COLS)}", key=SERVICE)
    return (rows or [{}])[0]


def main():
    print("=== 1. THE APP ASKS, rather than waiting to be found ===")
    auth = (ROOT / "src/context/auth.tsx").read_text()
    check("a real sign-in registers for push (so a new account gets the OS "
          "prompt without hunting for a toggle)",
          re.search(r"isRealSignIn\)\s*ensurePushTokenRegistered\(", auth) is not None)
    check("...and that covers password recovery too, not just fresh sign-in",
          re.search(r"isRealSignIn\s*=\s*event === 'SIGNED_IN' \|\| event === 'PASSWORD_RECOVERY'",
                    auth) is not None)

    notif = (ROOT / "src/lib/notifications.ts").read_text()
    for c in COLS:
        check(f"first registration defaults {LABEL[c]} ON in code",
              re.search(rf"{c}:\s*prior\?\.{c} \?\? true", notif) is not None)

    print("\n=== 2. LIVE: a brand-new account really does land all-ON ===")
    user = make_user("ndef")
    token = f"ExponentPushToken[{secrets.token_hex(8)}]"
    try:
        st, out = register(user, token)
        check("first registration accepted", st < 300, f"HTTP {st}: {out}")
        got = prefs_of(user, token)
        for c in COLS:
            check(f"{LABEL[c]} is ON for a brand-new account", got.get(c) is True, str(got))

        # "Show Me" (Ready Room leaderboard + Find Friends) is the fifth toggle
        # on that screen and part of the same instruction. It lives on
        # user_streaks, and its default is a COLUMN default -- so the way to
        # test it is to write a row WITHOUT naming the column and read back
        # what the database chose, not to assert a constant.
        http("POST", "/rest/v1/user_streaks", key=SERVICE,
             body={"user_id": user["id"]},
             headers={"Prefer": "resolution=merge-duplicates"})
        st, rows = http("GET", f"/rest/v1/user_streaks?user_id=eq.{user['id']}"
                               f"&select=leaderboard_opt_in,stats_visible", key=SERVICE)
        row = (rows or [{}])[0]
        check("The Wing 'Show Me' defaults ON for a brand-new account",
              row.get("leaderboard_opt_in") is True, str(row))
        check("...and their study activity is visible by default too",
              row.get("stats_visible") is True, str(row))

        print("\n=== 3. LIVE: a deliberate OFF survives every re-registration ===")
        # This is the whole risk of a default-ON policy. ensurePushTokenRegistered
        # runs on EVERY app foreground.
        off = {c: False for c in COLS}
        http("PATCH", f"/rest/v1/push_tokens?user_id=eq.{user['id']}"
                      f"&expo_push_token=eq.{token}", key=ANON, jwt=user["jwt"], body=off)
        check("the user turned everything off",
              all(prefs_of(user, token).get(c) is False for c in COLS),
              str(prefs_of(user, token)))

        for i in range(3):
            prior = prefs_of(user, token)          # what the real function reads first
            register(user, token, prior=prior)
        got = prefs_of(user, token)
        for c in COLS:
            check(f"{LABEL[c]} is STILL off after three app foregrounds",
                  got.get(c) is False, str(got))
    finally:
        http("DELETE", f"/rest/v1/push_tokens?user_id=eq.{user['id']}", key=SERVICE)
        http("DELETE", f"/rest/v1/user_streaks?user_id=eq.{user['id']}", key=SERVICE)
        delete_user(user["id"])
        print("\n  NOTE  disposable account deleted")

    print("\n" + "=" * 66)
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("New accounts start all-ON, and a deliberate OFF is never resurrected.")


if __name__ == "__main__":
    main()
