#!/usr/bin/env python3
"""Every document screen that shows OTHER people's highlights must keep them current.

RC's spec: "all participants ... should be able to edit, add, delete and change
any highlights, and they must show up IMMEDIATELY on everybody's phone who is
participating."

All seven reader screens loaded shared highlights exactly once, in a useEffect
keyed on the document id, and never again. Reading § 91.155 while your CFI
highlighted a passage in a folder you share meant you never saw it -- not in 45
seconds, not ever, until you left the screen and came back.

That is the same defect as the shared-FOLDER refresh gap
(shared_screen_refresh_audit.py), on a different set of screens, and it is the
same reason: a feature applied to N similar files where nobody compared the N.
The folder screens got four refresh triggers; the reader screens got none.

They now share one hook, useSharedHighlights, which reloads on focus, on OS
foreground, and on a live synced_folder_items change -- that being the table
get_shared_highlights actually joins through, and one already in the
supabase_realtime publication. This audit fails if a reader screen goes back to
calling loadHighlightSets by hand, which is exactly how the drift would return.

Usage: python3 scripts/shared_highlights_refresh_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []
# dictionary/[slug].tsx deliberately has no highlight surface at all -- a
# glossary term is not a document you highlight passages of.
READERS = ["far", "aim", "ac", "ad", "loi", "pcg", "cfr49"]


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    hook = (ROOT / "src/lib/useSharedHighlights.ts")
    check("the shared hook exists", hook.exists())
    if hook.exists():
        h = hook.read_text()
        for trig, pat in (("focus", r"useFocusEffect"),
                          ("OS foreground", r"AppState\.addEventListener"),
                          ("a live change", r"postgres_changes")):
            check(f"the hook reloads on {trig}", re.search(pat, h) is not None)
        check("it listens on synced_folder_items -- the table the RPC joins "
              "through, and one already published for realtime",
              "synced_folder_items" in h)

    found = 0
    for name in READERS:
        matches = list((ROOT / "src/app" / name).glob("[[]*.tsx"))
        if not matches:
            check(f"{name} reader screen present", False, "no [id]/[slug] file")
            continue
        p = matches[0]
        src = p.read_text()
        if "loadHighlightSets" not in src and "useSharedHighlights" not in src:
            continue                       # no highlight surface on this screen
        found += 1
        uses_hook = "useSharedHighlights(" in src
        check(f"{name} keeps shared highlights current via the shared hook", uses_hook,
              "still loads them once by hand")
        # A hand-rolled reload is how the folder screens drifted the first time.
        hand = re.search(r"useEffect\([^)]*\{[^}]*loadHighlightSets\(", src, re.S)
        check(f"{name} does not hand-roll its own highlight load", hand is None,
              "loadHighlightSets inside a useEffect -- use the hook")

    check("the audit actually checked the reader screens", found >= 6, f"found {found}")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print(f"shared_highlights_refresh -- all {found} reader screens refresh shared "
          f"highlights from one hook")


if __name__ == "__main__":
    main()
