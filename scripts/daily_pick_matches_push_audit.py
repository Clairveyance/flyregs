#!/usr/bin/env python3
"""The DailyReg/DailyWord the app shows must be the one the push announced.

RC, 2026-09-18: "the DW/DR that i'm getting a popup alerts are diff from the
ones being displayed in the app. They should be the same."

They already shared a function. get_reg_of_the_day() and get_word_of_the_day()
are deliberately called by BOTH the push sender and the app, with comments in
both saying so, precisely so the picks could not diverge. What diverged was the
DATE.

Both sides called the RPC with no argument, so both got `CURRENT_DATE` -- and
CURRENT_DATE is the DATABASE's date, which is UTC. The push goes out at 13:00
UTC, the morning of that calendar date across the Americas. But UTC rolls over
at 17:00 Pacific / 20:00 Eastern, so from late afternoon until local midnight
the app asked for "today", was handed TOMORROW, and showed a different item
from the push received that morning.

Reproduced live at 17:07 PDT on 2026-09-18, with the database already on the
19th:
    push that morning : AC 150/5230-4C   ·  "Net All-Wave Radiation"
    app at that moment: AC 170-14        ·  "CTAF"

The app now passes the DEVICE's local date. This audit fails if a call site
goes back to omitting it, and checks the underlying rotation is still
date-stable rather than random -- because if it ever became random per call,
sharing the function would stop being enough on its own.

Usage: python3 scripts/daily_pick_matches_push_audit.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from supabase_mgmt_api import request                            # noqa: E402

FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def q(sql):
    raw = request("/database/query", {"query": sql})
    if raw.startswith("HTTP "):
        raise RuntimeError(raw[:160])
    return json.loads(raw)


def main():
    src = (ROOT / "src/lib/notifications.ts").read_text()

    check("the device-local date helper exists", "export function deviceLocalDate" in src)
    check("it is NOT built from toISOString (that is UTC -- the bug itself)",
          not re.search(r"deviceLocalDate[\s\S]{0,400}?toISOString", src))

    for fn in ("get_reg_of_the_day", "get_word_of_the_day"):
        m = re.search(rf"supabase\.rpc\('{fn}'([^)]*)\)", src)
        check(f"the app passes an explicit date to {fn}",
              m is not None and "for_date" in (m.group(1) or ""),
              "omitting it means the DATABASE's UTC date, not the user's")

    print()
    # The rotation must be a pure function of the date. If it were random per
    # call, two calls on the same date would differ and sharing the function
    # would guarantee nothing.
    for fn in ("get_reg_of_the_day", "get_word_of_the_day"):
        rows = q(f"select slug from {fn}(current_date) union all select slug from {fn}(current_date);")
        slugs = [r["slug"] for r in rows]
        check(f"{fn} returns the same pick twice for one date (deterministic)",
              len(set(slugs)) == 1, str(slugs))
        a = q(f"select slug from {fn}(date '2026-01-01');")[0]["slug"]
        b = q(f"select slug from {fn}(date '2026-01-02');")[0]["slug"]
        check(f"{fn} actually rotates between days", a != b, f"{a} == {b}")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("daily_pick_matches_push -- the app asks for the user's date, and the "
          "rotation is a pure function of it")


if __name__ == "__main__":
    main()
