#!/usr/bin/env python3
"""A screen two people can look at together must refresh on ALL FOUR triggers.

WHY THIS EXISTS
RC, repeatedly, most recently 2026-09-17: "owners of shared material giving r/w
perms were then unable to see changes made by guests." Adriana's version, from a
TestFlight report: "I see your edits but you can't see mine after the file is
shared."

The server was never the problem -- folder_collab_matrix_test has asserted "the
OWNER sees the item the collaborator filed" for weeks and it passes. The problem
is the SCREEN not asking again.

A shared screen needs four triggers, each covering a hole the others leave:
  1. on navigation focus
  2. on OS foreground        (a phone is locked/unlocked constantly while the
                              screen stays the topmost route, so (1) never fires)
  3. realtime push           (instant, when the socket is alive)
  4. a PERIODIC FLOOR        (the one that gets forgotten)

(4) is not optional. Two people reviewing a shared folder or aircraft TOGETHER
sit on one screen without navigating and without backgrounding, so (1) and (2)
never fire -- and (3) can die silently on a Wi-Fi/carrier handoff. Without a
floor the window in which an owner cannot see a guest's edit is UNBOUNDED.

WHAT ACTUALLY HAPPENED, and why a hook replaced the pattern:
Both folder screens were given the floor on 2026-08-30. my-aircraft/[id].tsx was
not. Its own comment says it received "the same two-part fix as both folder
screens got earlier" -- true, and the folders got a THIRD part afterwards that
was never carried across. So a shared AIRCRAFT had the unbounded window for
another two and a half weeks, which is precisely the bug being reported.

All three now call useSharedScreenRefresh(), which cannot provide two of the
three. This audit checks nothing has drifted back.

KNOWN LIMITS, stated rather than papered over:
  * It matches SCREENS by their route path, not by proving they render shared
    content. A new shared surface at an unlisted path is not covered -- which is
    why SHARED_SCREENS is a literal list that a human must extend, not a guess.
  * It checks the hook is CALLED and a realtime subscription exists. It does not
    prove the load function they are handed actually refetches.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# Screens where two people can be looking at the same resource at once.
SHARED_SCREENS = [
    "app/folder/[id].tsx",
    "app/folder/shared/[id].tsx",
    "app/my-aircraft/[id].tsx",
]

BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)


def code_only(text: str) -> str:
    """Prose mentions these names constantly; only real calls count."""
    text = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return LINE_COMMENT.sub("", text)


def main():
    failures, checked = [], 0
    for rel in SHARED_SCREENS:
        path = SRC / rel
        if not path.exists():
            failures.append(f"{rel} -- listed as a shared screen but the file is gone; "
                            f"update SHARED_SCREENS or restore it")
            continue
        code = code_only(path.read_text())
        checked += 1

        if not re.search(r"\buseSharedScreenRefresh\s*\(", code):
            failures.append(
                f"{rel} -- does not call useSharedScreenRefresh(). Focus, OS foreground "
                f"and the 45s floor must come from the one hook; hand-rolling them is how "
                f"my-aircraft/[id].tsx ended up with two of the three."
            )
        if not re.search(r"\buse(Folder|Aircraft)Realtime\s*\(", code):
            failures.append(
                f"{rel} -- no realtime subscription, so a collaborator's edit waits for the "
                f"next focus/foreground/tick instead of arriving immediately."
            )
        # A screen that hand-rolls its own timer has drifted back off the hook.
        if re.search(r"setInterval\s*\(\s*(?:\(\s*\)\s*=>\s*)?load", code):
            failures.append(
                f"{rel} -- hand-rolls its own setInterval refresh. Use the hook so every "
                f"shared screen gets the same floor."
            )

    if failures:
        print("FAIL shared_screen_refresh_audit")
        for f in failures:
            print("  - " + f)
        print("\n  A shared screen missing the periodic floor leaves an UNBOUNDED window")
        print("  where an owner cannot see a read/write guest's edits.")
        return 1
    print(f"PASS shared_screen_refresh_audit -- all {checked} shared screen(s) refresh on "
          f"focus, foreground, realtime AND a periodic floor, from the one shared hook")
    return 0


if __name__ == "__main__":
    sys.exit(main())
