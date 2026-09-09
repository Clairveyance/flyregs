#!/usr/bin/env python3
"""A modal must never be a trap.

RC, B42: "Pro upgrade paywall didn't work and just locked the app. hard to
restart" / "it locks up and prevents you from closing it at all. you have to
restart the app."

AircraftDowngradeGate rendered at app root with onRequestClose={() => {}} and
offered only two paywall routes plus a destructive "Delete All". When the
paywall failed to open there was no non-destructive way out at all, and because
the component is mounted at root the whole app was unusable -- force-quit was
the only exit.

`onRequestClose={() => {}}` is the machine-detectable form of that mistake: it
is a deliberate statement that the OS dismiss gesture should do nothing. It is
never right on a modal a user could get stuck behind. If a modal genuinely must
persist, it still needs a visible way out that does not destroy data.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# onRequestClose={() => {}} with any inner whitespace
NOOP = re.compile(r"onRequestClose=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}")


def main():
    offenders = []
    scanned = 0
    for path in sorted(SRC.rglob("*.tsx")):
        text = path.read_text()
        if "<Modal" not in text:
            continue
        scanned += 1
        for m in NOOP.finditer(text):
            # A comment quoting the pattern is not a use of it.
            line_start = text.rfind("\n", 0, m.start()) + 1
            line = text[line_start:text.find("\n", m.start())]
            if line.lstrip().startswith(("//", "*", "/*")):
                continue
            offenders.append((path.relative_to(BASE), text[:m.start()].count("\n") + 1))

    print("=== modals with a no-op onRequestClose (an OS dismiss that does nothing) ===")
    print(f"  {scanned} file(s) with modals scanned, {len(offenders)} trap(s)")
    print()
    if offenders:
        print("FAIL: these modals swallow the dismiss gesture --")
        for rel, line in offenders:
            print(f"  {rel}:{line}")
        print()
        print("  Give onRequestClose a real handler. If the modal must persist,")
        print("  it still needs a visible non-destructive exit, or a failure in")
        print("  whatever it links to leaves the user with only a force-quit.")
        sys.exit(1)

    print("No modal swallows its own dismiss gesture.")
    sys.exit(0)


if __name__ == "__main__":
    main()
