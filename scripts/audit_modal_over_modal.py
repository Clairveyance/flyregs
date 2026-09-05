#!/usr/bin/env python3
"""Never present a Modal from inside a still-open dialog again.

THE BUG THIS EXISTS FOR
-----------------------
B40, reported by RC within minutes of installing: My Fleet -> tap an AD chip
-> "Mark Complied" -> nothing happened and the app locked up completely.

ConfirmDialog's runChoice used to `await c.onPress()` with the dialog STILL
MOUNTED, then close afterwards. Harmless while every choice merely navigated
or opened another confirm -- and B40 was the first build where a choice opens
a DIFFERENT <Modal> (AdComplianceModal, newly reachable from the chip menu).
openComplianceModal is async: it awaits a reminders fetch, so the second Modal
mounted a tick later while the first was still on screen.

iOS refuses to present a Modal while another is presented, and it fails
SILENTLY -- no exception, no Sentry event, just an app that stops responding
to touches. That is exactly what RC saw, and why nothing was logged.

WHAT THIS CHECKS
----------------
Two source-level invariants that together make the class unreachable:

  1. ConfirmDialog.runChoice closes BEFORE running the choice. If someone
     reverts that ordering, every async choice becomes a freeze again.
  2. No onConfirm handler awaits and THEN opens a modal. onConfirm keeps its
     spinner deliberately (it is an action, not a picker), so it cannot just
     close first -- which means the call site has to not open a modal from
     inside it. Synchronous state-setting is fine: React batches it into the
     same commit as the close, so the two Modals never coexist.

Read-only. Exit 1 on a violation.

Usage: python3 scripts/audit_modal_over_modal.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "src"
FAILURES = []

# State setters that drive a <Modal visible={...}> somewhere in the app.
MODAL_OPENERS = [
    "setPartPickerVisible", "setTrackingTarget", "setFolderSheetVisible",
    "setPickerNote", "setOpenNote", "setComplianceAd", "setComplianceTarget",
    "setZoomedImage", "setHobbsEditing", "setReminderTarget", "setShareTarget",
]


def body_of(text, brace_index):
    """The handler body, by brace matching.

    A fixed-size window is not good enough here: my first pass used 900
    characters, spilled past three handlers, and reported three bugs that did
    not exist. I nearly "fixed" all three.
    """
    depth, i = 0, brace_index
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[brace_index:i]
        i += 1
    return text[brace_index:]


def check_runchoice_closes_first():
    p = ROOT / "components" / "ConfirmDialog.tsx"
    src = p.read_text()
    m = re.search(r"const runChoice = [^\n]*\n", src)
    if not m:
        FAILURES.append("ConfirmDialog: runChoice not found at all")
        return
    body = body_of(src, src.index("{", m.end() - 2))
    close_at = body.find("close()")
    press_at = body.find("c.onPress()")
    if close_at < 0:
        FAILURES.append("ConfirmDialog.runChoice no longer closes the dialog")
    elif press_at < 0:
        FAILURES.append("ConfirmDialog.runChoice no longer calls the choice")
    elif close_at > press_at:
        FAILURES.append(
            "ConfirmDialog.runChoice runs the choice BEFORE closing -- this is the "
            "exact ordering that froze B40 on Mark Complied")
    else:
        print("  PASS  runChoice closes the dialog before running the choice")


def check_no_await_then_modal():
    offenders = []
    for f in sorted(ROOT.rglob("*.tsx")):
        text = f.read_text()
        for m in re.finditer(r"onConfirm:\s*(?:async\s*)?\(\)\s*=>\s*", text):
            j = text.find("{", m.end())
            if j < 0 or j > m.end() + 4:
                continue
            body = body_of(text, j)
            opens = [s for s in MODAL_OPENERS if re.search(rf"\b{s}\(", body)]
            if not opens:
                continue
            first = min(body.index(s) for s in opens)
            if "await " in body[:first]:
                line = text[:m.start()].count("\n") + 1
                offenders.append(f"{f.relative_to(ROOT.parent)}:{line} awaits, then opens {opens[0]}")
    if offenders:
        for o in offenders:
            FAILURES.append(f"onConfirm presents a Modal after an await -- {o}")
    else:
        print("  PASS  no onConfirm handler awaits and then opens a modal")


# Native UI that iOS will not present while an RN <Modal> is up. A confirm
# whose action launches one of these MUST set closeFirst.
NATIVE_LAUNCHERS = [
    "confirmSubscribe", "purchaseSubscription", "purchaseUnlock",
    "restorePurchases", "launchImageLibraryAsync", "launchCameraAsync",
    "Share.share", "printAsync", "shareAsync",
]


def check_native_launchers_close_first():
    """RC's second B40 freeze: downgrade to Pro did nothing and wedged the app.

    onConfirm awaited confirmSubscribe() with the dialog still presented, so
    StoreKit's purchase sheet had nowhere to go. Linking.openSettings is
    deliberately NOT in the list -- it backgrounds the app entirely rather
    than presenting over it, and those call sites have always worked.
    """
    offenders = []
    for f in sorted(ROOT.rglob("*.tsx")):
        text = f.read_text()
        for m in re.finditer(r"onConfirm:\s*(?:async\s*)?\(\)\s*=>\s*", text):
            after = text[m.end():]
            block = after[:200].split("\n")[0] if not after.startswith("{") else body_of(text, text.index("{", m.end()))
            launcher = next((n for n in NATIVE_LAUNCHERS if re.search(rf"\b{re.escape(n)}\b", block)), None)
            if not launcher:
                continue
            # closeFirst sits in the same options object, just above onConfirm.
            window = text[max(0, m.start() - 600):m.start()]
            if "closeFirst: true" not in window and "setTimeout" not in block:
                line = text[:m.start()].count("\n") + 1
                offenders.append(f"{f.relative_to(ROOT.parent)}:{line} launches {launcher} without closeFirst")
    if offenders:
        for o in offenders:
            FAILURES.append(f"native UI opened from inside a dialog -- {o}")
    else:
        print("  PASS  every confirm that opens native UI closes first")


def main():
    print("Modal-over-modal guard (the B40 Mark Complied freeze)\n")
    check_runchoice_closes_first()
    check_no_await_then_modal()
    check_native_launchers_close_first()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("A second Modal can no longer be presented while the first is still up.")


if __name__ == "__main__":
    main()
