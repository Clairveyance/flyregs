#!/usr/bin/env python3
"""A screen-owned modal must be a <ScreenModal>, never a raw <Modal>.

WHY THIS EXISTS
A modal's `visible` flag is state on the screen component, and expo-router
keeps that screen mounted in the stack when you navigate away. React Native's
<Modal> renders into a native window above the whole app and does not care
which screen is focused, so navigating away leaves the sheet on screen, fully
interactive, floating over something unrelated.

Found 2026-09-10 on the first real-device sweep: with Edit Aircraft open on
my-aircraft/[id], a deep link to Study Mode navigated underneath and left the
Edit Aircraft card sitting on top of it, through eight consecutive deep links.

WHY A GUARD AND NOT JUST A FIX
There were 34 <Modal> sites across 26 files. Fixing them is a codemod; keeping
them fixed is this. A new modal added next month is a raw <Modal> by default,
because that is what every React Native example shows -- nothing about writing
one tells you the app has a wrapper, so the only thing that will remember is a
check that runs.

THE ONE ALLOWED EXEMPTION
ConfirmDialog.tsx. Its provider wraps <Stack> in _layout.tsx, so it is owned by
the app rather than by a screen; focus-gating the app's only confirm dialog
would be wrong, not safer. ScreenModal.tsx itself obviously wraps the real one.

KNOWN LIMIT, stated rather than papered over: this checks the JSX tag, not
whether a modal is genuinely screen-owned. A future genuinely-global modal
would have to be added to ALLOWED with its reason, the same way ConfirmDialog
is -- which is the point: the exemption becomes a decision someone writes down.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

ALLOWED = {
    "src/components/ConfirmDialog.tsx": "app-level provider above <Stack>, not owned by any screen",
    "src/components/ScreenModal.tsx": "the wrapper itself",
}


def blank_comments(text):
    """Blank comment bodies, preserving byte offsets.

    src/ mentions the literal '<Modal>' 44 times in prose. Scanning raw text
    reports every one of those as a violation, which is how a first draft of
    the sibling modal audit managed to both miss real bugs and invent fake
    ones at the same time.
    """
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        two = text[i:i + 2]
        if two == "/*":
            end = text.find("*/", i + 2)
            end = n if end == -1 else end + 2
            for j in range(i, end):
                if out[j] != "\n":
                    out[j] = " "
            i = end
        elif two == "//" and not (i > 0 and text[i - 1] == ":"):
            end = text.find("\n", i)
            end = n if end == -1 else end
            for j in range(i, end):
                out[j] = " "
            i = end
        else:
            i += 1
    return "".join(out)


def main():
    offenders, wrapped = [], 0
    for path in sorted(SRC.rglob("*.tsx")):
        rel = path.relative_to(BASE).as_posix()
        text = blank_comments(path.read_text())
        wrapped += len(re.findall(r"<ScreenModal(?=[\s>])", text))
        if rel in ALLOWED:
            continue
        for m in re.finditer(r"<Modal(?=[\s>])", text):
            offenders.append((rel, text[: m.start()].count("\n") + 1))

    print("=== screen-owned modals ===")
    print(f"  {wrapped} <ScreenModal>, {len(offenders)} raw <Modal> outside the allowlist")
    print()
    if offenders:
        print("FAIL: these modals stay on screen when a deep link navigates away --")
        for rel, line in offenders:
            print(f"  {rel}:{line}")
        print()
        print("  Fix: use <ScreenModal> from '@/components/ScreenModal' instead of")
        print("  react-native's <Modal>. It is a drop-in -- same props -- and only")
        print("  withholds `visible` while the owning screen is blurred.")
        print()
        print("  If a modal is genuinely app-level and not owned by any screen,")
        print("  add it to ALLOWED in this file WITH its reason, as ConfirmDialog is.")
        sys.exit(1)

    print("Every screen-owned modal hides itself when its screen is blurred.")
    for rel, why in sorted(ALLOWED.items()):
        print(f"  exempt: {rel} -- {why}")
    sys.exit(0)


if __name__ == "__main__":
    main()
