#!/usr/bin/env python3
"""Nothing but the user may change a user's stored preference.

WHY THIS EXISTS
RC, 2026-09-11, about his own production account: "my duel alerts was off. i
never turned it off. i always had it on. which means something in our system
did it." It had, and it took an hour to find because the code that did it
looked like a permission check rather than a write.

`trg_enforce_duel_push_pro_gate` was a BEFORE INSERT **OR UPDATE** trigger on
push_tokens that did:

    IF NEW.duel_notifications_enabled AND NOT has_pro_access(NEW.user_id) THEN
      NEW.duel_notifications_enabled := false;

registerPushToken() upserts push_tokens on EVERY app foreground, and
has_pro_access() reads user_entitlements -- a row written AFTER sign-in by
syncEntitlements(). So any foreground during the window where the entitlement
row was absent or stale (fresh install, the first seconds after sign-in, a
RevenueCat hiccup, an upgrade mid-flight) silently flipped the user's setting
off. PERMANENTLY: the register path preserves the prior value on later runs,
so once false it stayed false, and the 2026-09-04 "default every toggle ON"
change only applied to users with NO prior row, so it repaired nobody.

The tell, on RC's row: `enabled`, `reg_of_day_enabled` and `word_of_day_enabled`
were all still true. The only column that was false was the only column that
trigger touched.

THE RULE THIS ENFORCES
A tier/permission check may REFUSE an action or FILTER a send. It may not
rewrite the stored preference. Enforce entitlement where the value is USED
(get_duel_push_target now does), never by mutating what the user chose -- so a
lapsed subscriber gets their own settings back the moment they are entitled
again, instead of silently losing them.

WHAT THIS CHECKS
Every non-internal trigger on a table that stores user preferences, for a
function body that assigns to one of those preference columns (`NEW.<col> :=`
or `NEW.<col>=`). A trigger that only RAISES (refuses the write) is fine and is
not flagged -- refusing is honest, silently rewriting is not.

KNOWN LIMIT, stated rather than papered over: this reads trigger functions, so
a preference rewritten by an RPC, an edge function, or a scheduled job is not
caught here. Those are user-invoked or auditable code paths; a BEFORE-UPDATE
trigger is the uniquely silent one, which is why it is the one that hid.
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent

# table -> the columns on it that are a USER'S OWN CHOICE, not derived state.
PREFERENCE_COLUMNS = {
    "push_tokens": [
        "enabled",
        "duel_notifications_enabled",
        "reg_of_day_enabled",
        "word_of_day_enabled",
    ],
    "user_streaks": ["leaderboard_opt_in", "stats_visible"],
    "synced_folders": ["collab_mode"],
    "folder_collaborators": ["collab_mode"],
    "aircraft_collaborators": ["role"],
}

SQL = """
select c.relname as table_name, t.tgname as trigger_name,
       pg_get_triggerdef(t.oid) as trigger_def, p.prosrc as body
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_proc p on p.oid = t.tgfoid
where not t.tgisinternal
  and c.relname in (%s)
""" % ", ".join("'%s'" % t for t in PREFERENCE_COLUMNS)


def mgmt(sql):
    r = subprocess.run(
        ["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
        capture_output=True, text=True, cwd=str(BASE),
    )
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def assignments_to_preferences(body, columns):
    """Columns this trigger body ASSIGNS to (not merely reads)."""
    hits = []
    for col in columns:
        # NEW.col := ...   or   NEW.col = ...   (any spacing, any case)
        if re.search(rf"\bnew\.{re.escape(col)}\s*:?=", body, re.I):
            hits.append(col)
    return hits


def main():
    rows = mgmt(SQL)
    offenders, checked = [], 0
    for r in rows:
        table = r["table_name"]
        cols = PREFERENCE_COLUMNS.get(table, [])
        checked += 1
        hits = assignments_to_preferences(r["body"] or "", cols)
        if hits:
            offenders.append((table, r["trigger_name"], hits, r["trigger_def"]))

    print("=== triggers on preference-bearing tables ===")
    print(f"  {checked} trigger(s) checked across {len(PREFERENCE_COLUMNS)} tables")
    print()
    if offenders:
        print("FAIL: these triggers silently rewrite a user's own setting --")
        for table, name, hits, _def in offenders:
            print(f"  {table}.{name}  assigns: {', '.join(hits)}")
        print()
        print("  A permission check may REFUSE a write (raise) or FILTER a send.")
        print("  It may not rewrite what the user chose. Enforce the entitlement")
        print("  where the value is READ instead -- see")
        print("  sync/migrations_duel_push_pref_not_destroyed.sql for the pattern.")
        sys.exit(1)

    print("No trigger rewrites a user preference; settings change only when the user changes them.")
    sys.exit(0)


if __name__ == "__main__":
    main()
