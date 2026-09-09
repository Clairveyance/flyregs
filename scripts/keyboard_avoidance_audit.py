#!/usr/bin/env python3
"""A modal with a text input must move out from under the keyboard.

WHY THIS EXISTS
RC, real device, twice:
  B39-ish, HobbsUpdateModal: "the numeric keypad covered the input box AND the
    Save button entirely, leaving only the bare keypad on screen."
  B42, AdComplianceModal: "i can't test the AD compliance flow b/c the damn
    keyboard won't get out of the way."
Same bug, same shape, two different files. The first was fixed in place and
never swept for, so it shipped again in a different modal five builds later.

WHY IT SURVIVES REVIEW AND BROWSER TESTING
A bottom-anchored modal (`justifyContent: 'flex-end'`) renders perfectly with
no keyboard. React Native does NOT move it when the OS keyboard opens unless a
KeyboardAvoidingView is in the tree. The web preview has no OS keyboard, so the
defect is completely invisible there -- which is exactly how it passed a full
browser pass both times.

WHAT THIS CHECKS
A <Modal> that is `transparent` -- i.e. an overlay card or bottom sheet floating
over the screen -- containing a <TextInput>, with no KeyboardAvoidingView.

Why only transparent ones: a FULL-SCREEN modal (no `transparent` prop) lays out
like a normal page, with its input near the top under a header. The keyboard
covers the list below it, which is correct and expected. Flagging those would
make this audit cry wolf -- my-aircraft/[id].tsx's Add Equipment search is
exactly that shape and is not a bug. An overlay card is the opposite: it is
positioned against the bottom or centre of the viewport, so the keyboard lands
directly on top of it and nothing moves.

KNOWN LIMITS, stated rather than papered over:
  * a modal whose input lives in an imported child component is not detected,
    because this reads one file at a time;
  * a full-screen modal with a genuinely bottom-anchored input would be missed.
It catches the shape both real bugs had. It is not a proof of absence.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"


def modal_spans(text):
    """Yield (start, end) index pairs for each <Modal ...> ... </Modal>."""
    spans = []
    for m in re.finditer(r"<Modal[\s>]", text):
        depth, i = 0, m.start()
        while i < len(text):
            nxt_open = text.find("<Modal", i + 1)
            nxt_close = text.find("</Modal>", i + 1)
            if nxt_close == -1:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1
                i = nxt_open
            else:
                if depth == 0:
                    spans.append((m.start(), nxt_close))
                    break
                depth -= 1
                i = nxt_close
    return spans


def main():
    offenders, checked = [], 0
    for path in sorted(SRC.rglob("*.tsx")):
        text = path.read_text()
        if "<Modal" not in text or "<TextInput" not in text:
            continue
        for start, end in modal_spans(text):
            body = text[start:end]
            if "<TextInput" not in body:
                continue          # a modal with no input cannot be covered
            # Only overlay modals float over the viewport where the keyboard
            # lands on them. See the header for why full-screen ones are not
            # a defect.
            opening = body[:body.find(">") + 1]
            if "transparent" not in opening:
                continue
            checked += 1
            if "KeyboardAvoidingView" in body:
                continue
            line = text[:start].count("\n") + 1
            offenders.append((path.relative_to(BASE), line))

    print("=== overlay modals (transparent) containing a text input ===")
    print(f"  {checked} checked, {len(offenders)} without keyboard avoidance")
    print()
    if offenders:
        print("FAIL: these modals put a text input under the keyboard with no way out --")
        for rel, line in offenders:
            print(f"  {rel}:{line}")
        print()
        print("  Fix: wrap the modal's backdrop in")
        print("    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>")
        print("  as HobbsUpdateModal.tsx and FolderPicker.tsx already do.")
        sys.exit(1)

    print("Every modal that can raise the keyboard also moves out from under it.")
    sys.exit(0)


if __name__ == "__main__":
    main()
