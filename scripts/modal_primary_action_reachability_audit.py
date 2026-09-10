#!/usr/bin/env python3
"""A modal's primary action must not be the last row of its own scroll body.

WHY THIS EXISTS
`keyboard_avoidance_audit.py` next to this file checks that a modal MOVES when
the keyboard opens. That is a different guarantee from the one users actually
care about, and the gap between the two shipped a bug twice:

  B42, AdComplianceModal -- fixed with a KeyboardAvoidingView, which put the
  CARD above the keyboard. Verified on a real device 2026-09-10: the card was
  indeed above the keyboard, and "Save compliance record" still was not on
  screen, because the card is height-capped and Save was the last row inside
  its inner ScrollView. The user had to know to scroll a form that looked
  complete. Two more modals were found with the identical shape in the same
  sweep (Track Part, Edit Aircraft).

So: keyboard avoidance keeps the card visible; it says nothing about the
BUTTON. A capped card plus a scrolling body plus the action as the last scroll
child means the action's visibility depends on content length and keyboard
height -- i.e. on the device and the data, which is why it reads fine in a
screenshot and on a big phone.

WHAT THIS CHECKS
Inside a <Modal>: a <ScrollView> whose LAST element is a Pressable whose label
looks like a primary action (Save / Submit / Add / Create / Done / Send /
Confirm / Update). The fix in every case is to close the ScrollView first and
render the action after it, so it is pinned to the card.

HOW, and why not "is it the last element"
The first draft asked whether the primary label fell in the last ~400
characters of the scroll body. That caught 1 of the 3 known bugs and missed the
two I had just fixed on a device: AdComplianceModal's Save was followed by a
paragraph of fine print, and Track Part's modal nests a second <Modal> that
threw the span scan off. A magic character window is the wrong instrument.

What it asks instead is positional-free and structural: does this modal put a
primary action INSIDE a scroll body and nowhere outside it? A modal that pins
its action has a primary-labelled Pressable as a sibling of the ScrollView, so
it passes however long its form is. A modal that scrolls its action has one
only inside. That is the actual defect, stated directly.

KNOWN LIMITS, stated rather than papered over:
  * a button rendered by an imported child component is not detected -- this
    reads one file at a time, same limit the sibling audit documents;
  * a modal that is genuinely short enough never to scroll is still flagged,
    because whether it scrolls depends on font scale and device. Pinning it
    is correct there too, so this is a conservative direction to be wrong in.
It catches the shape all three real bugs had. It is not a proof of absence.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# Deliberately anchored to the START of the label: "Add a photo" and
# "Add a due date for anything you want a nudge on" are prose, not buttons,
# and matching them made the first draft of this audit useless.
PRIMARY = re.compile(
    r">\s*(Save(?:\s+\w+){0,2}|Submit\w*|Create\s+\w+|Add\s+\w+|Done|Send\w*|"
    r"Confirm\w*|Update\s+\w+)\s*<",
    re.IGNORECASE,
)


def blank_comments(text):
    """Replace comment bodies with spaces, preserving every byte offset.

    This file's own subject matter is discussed at length in comments -- there
    are eleven mentions of the literal string "<Modal>" in
    my-aircraft/[id].tsx's prose alone. The nesting counter in modal_spans
    happily counted those, walked past the real closing tag, and produced a
    span that swallowed the rest of the file, which is exactly how the Track
    Part sheet went unreported by the first two drafts of this audit while its
    bug was sitting there confirmed on a device. Offsets are preserved so
    reported line numbers still point at the real source.

    `//` is only treated as a comment when it is not part of a `://` scheme,
    so URLs in string literals survive.
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


def modal_spans(text):
    """Yield (start, end) index pairs for each <Modal ...> ... </Modal>.

    Scans from the OUTSIDE in: for each `<Modal`, walk forward counting nested
    opens so the matching close is found even when a modal contains another
    one (my-aircraft/[id].tsx nests DatePickerModal inside the Track Part
    sheet, and getting this wrong is what hid that file from the first draft).
    """
    spans = []
    for m in re.finditer(r"<Modal[\s>]", text):
        depth, i = 0, m.start()
        while True:
            nxt_open = text.find("<Modal", i + 1)
            nxt_close = text.find("</Modal>", i + 1)
            if nxt_close == -1:
                break
            if nxt_open != -1 and nxt_open < nxt_close:
                depth += 1
                i = nxt_open
                continue
            if depth == 0:
                spans.append((m.start(), nxt_close))
                break
            depth -= 1
            i = nxt_close
    return spans


def scroll_spans(body):
    """Yield (start, end) pairs for each <ScrollView> ... </ScrollView>."""
    spans = []
    for m in re.finditer(r"<ScrollView[\s>]", body):
        end = body.find("</ScrollView>", m.start())
        if end != -1:
            spans.append((m.start(), end))
    return spans


def main():
    offenders, checked = [], 0
    for path in sorted(SRC.rglob("*.tsx")):
        raw = path.read_text()
        if "<Modal" not in raw or "<ScrollView" not in raw:
            continue
        text = blank_comments(raw)
        for m_start, m_end in modal_spans(text):
            modal = text[m_start:m_end]
            spans = scroll_spans(modal)
            if not spans:
                continue

            # Everything in this modal that is NOT inside one of its scroll
            # bodies. A pinned action lives here; a scrolled one does not.
            outside, cursor = [], 0
            for s_start, s_end in spans:
                outside.append(modal[cursor:s_start])
                cursor = s_end
            outside.append(modal[cursor:])
            pinned = any(PRIMARY.search(chunk) for chunk in outside)

            for s_start, s_end in spans:
                block = modal[s_start:s_end]
                if "<Pressable" not in block:
                    continue
                checked += 1
                hit = PRIMARY.search(block)
                if not hit or pinned:
                    continue
                line = text[: m_start + s_start].count("\n") + 1
                offenders.append((path.relative_to(BASE), line, hit.group(1).strip()))

    print("=== modal scroll bodies containing a pressable ===")
    print(f"  {checked} checked, {len(offenders)} end in a primary action")
    print()
    if offenders:
        print("FAIL: these modals can scroll their own primary action out of reach --")
        for rel, line, label in offenders:
            print(f"  {rel}:{line}  (\"{label}\")")
        print()
        print("  Fix: close the </ScrollView> first, then render the action")
        print("  after it inside the card, as AdComplianceModal.tsx does:")
        print("    </ScrollView>")
        print("    <View style={{ borderTopWidth: StyleSheet.hairlineWidth, ... }}>")
        print("      <Pressable ...>Save</Pressable>")
        print("    </View>")
        print("  and give the ScrollView flexShrink: 1 so it, not the footer,")
        print("  is what gives up height at the card's maxHeight.")
        sys.exit(1)

    print("Every modal's primary action is pinned outside its scroll body.")
    sys.exit(0)


if __name__ == "__main__":
    main()
