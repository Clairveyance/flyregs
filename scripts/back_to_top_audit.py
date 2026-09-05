#!/usr/bin/env python3
"""Every long scrolling list has a working Back to Top control.

RC asked for this twice -- "Suggest a feature" 2026-09-03, and again on
2026-09-05 after the first pass only reached the browse lists:

  "Probably anywhere in the app where we have a long scrolling list of items
   where the top bar disappears or the search field itself disappears with a
   scroll, will want to have this back to the top button available for people."

WHY A STATIC AUDIT AND NOT A BROWSER TEST
I tried to verify this in the web preview and could not. A synthetic
`scroll` event does not reach react-native-web's onScroll, so the button never
appears -- and it does not appear on pcg/letter/[letter] either, a screen that
has shipped this control for days. The measurement was wrong, not the code.
Rather than report a browser check that proves nothing, this checks the three
things that must ALL be present for the control to work, which is exactly what
was getting missed screen by screen:

  1. a ref on the list
  2. onScroll wired to makeBackToTopScrollHandler
  3. <BackToTop> rendered in the header

A screen with two of the three compiles, renders, and silently does nothing.

Usage:  python3 scripts/back_to_top_audit.py
"""
import os
import re
import sys

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "app")

# Screens whose list is genuinely long enough to need it. A screen is on this
# list because scrolling it past the header is a normal thing to do -- not
# merely because it uses a FlatList.
REQUIRED = [
    "(tabs)/saved.tsx", "(tabs)/notes.tsx", "(tabs)/recents.tsx",
    "far/index.tsx", "far/part/[part].tsx",
    "aim/index.tsx", "aim/chapter/[chapter].tsx",
    "pcg/index.tsx", "pcg/letter/[letter].tsx",
    "dictionary/index.tsx", "dictionary/letter/[letter].tsx",
    "cfr49/part/[part].tsx",
    "loi/index.tsx", "loi/year/[year].tsx",
    "ac/library.tsx", "series/[prefix].tsx",
    "ad/index.tsx",
    "folder/[id].tsx", "folder/shared/[id].tsx",
    "(tabs)/search.tsx",
]

# Known and deliberate: these have a list but it is short by nature, or the
# screen is a form/dashboard rather than a browse list. Listed explicitly so
# "not covered" is a decision on the record rather than an oversight.
DELIBERATELY_EXEMPT = {
    "(tabs)/index.tsx": "Home is a dashboard of cards, not a long list",
    "challenges/index.tsx": "a player has a handful of duels, not hundreds",
    "ready-room.tsx": "leaderboard is capped at its top N",
    "parts-lookup.tsx": "results are capped and the search field stays pinned",
    "updates.tsx": "header lives in the parent screen, lists in two child tabs "
                   "-- needs state lifted through both; tracked, not silently skipped",
}

FAILURES = []


def check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}   {detail}")
        FAILURES.append(f"{label} :: {detail}")


def main():
    print("=== screens that must offer Back to Top ===")
    for rel in REQUIRED:
        path = os.path.join(APP, rel)
        if not os.path.exists(path):
            check(rel, False, "file not found -- was it renamed?")
            continue
        src = open(path).read()
        has_import = "components/BackToTop" in src
        has_render = "<BackToTop" in src
        has_handler = "makeBackToTopScrollHandler" in src
        # The ref has to be on a list, and the SAME name the button scrolls.
        #
        # Match every `<name>.current?.scroll...` in the file, not just one
        # inside a single-expression onPress. loi/index.tsx legitimately
        # scrolls TWO refs from one multi-line handler (its two lists are
        # mutually exclusive), and a regex anchored to `onPress={() =>`
        # reported that correct screen as broken -- the audit was wrong, not
        # the screen. A narrow pattern that flags working code is worse than
        # no audit, because the obvious next move is to "fix" the code.
        scrolled = set(re.findall(r"(\w+)\.current\?\.(?:scrollToOffset|getScrollResponder|scrollTo)", src))
        refd = set(re.findall(r"ref=\{(\w+)\}", src))
        matched = scrolled & refd
        ref_name = ", ".join(sorted(scrolled)) or "?"
        has_ref = bool(matched)

        missing = []
        if not has_import: missing.append("import")
        if not has_render: missing.append("<BackToTop>")
        if not has_handler: missing.append("onScroll handler")
        if not has_ref: missing.append(f"ref={{{ref_name or '?'}}} on a list")
        check(rel, not missing, "missing " + ", ".join(missing))

    print("\n=== deliberately exempt (recorded, not forgotten) ===")
    for rel, why in DELIBERATELY_EXEMPT.items():
        path = os.path.join(APP, rel)
        exists = os.path.exists(path)
        check(f"{rel} -- {why}", exists, "file not found")

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("back to top: every long list has all three pieces wired")


if __name__ == "__main__":
    main()
