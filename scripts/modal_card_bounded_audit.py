#!/usr/bin/env python3
"""A modal's card must be bounded by the screen, or it takes its own exit with it.

WHY THIS EXISTS
`modal_primary_action_reachability_audit.py` next to this file checks that a
modal does not bury its primary action at the bottom of an inner ScrollView.
That is a different shape from this one, and the gap between them shipped the
same bug twice:

  ConfirmDialog.tsx (fixed 2026-09-10) -- a `choices: data.map(...)` dialog with
  17 Airworthiness Directives rendered a ~1070pt card on an 812pt screen. Title
  off the top, Cancel off the bottom, no scroll.

  AircraftDowngradeGate.tsx (fixed 2026-09-12, from RC's real iPad report: "i
  was getting a whole popup about my a/c count... i couldn't really do anything,
  then it locked up"). This one PASSED the reachability audit, correctly: its
  buttons are pinned outside the inner ScrollView, exactly as that audit asks.
  The card itself had no maxHeight. Measured on a 360x780 screen from its own
  style values: 742pt at default Text Size with 4 aircraft, 918pt at 1.3x,
  1266pt at 1.75x, against the 732pt the scrim leaves. Past that the title
  clipped off the top and "Not now" -- the only non-destructive way out -- sat
  46pt to 220pt BELOW the screen, unreachable, because only the inner aircraft
  list scrolled and the card did not.

Pinning the action inside an UNBOUNDED card does not make it reachable. It just
moves where it goes off-screen. Both properties are needed, so both get an
audit.

WHAT THIS CHECKS
A styled "card" container rendered inside a <Modal>/<ScreenModal> must be
bounded: its style needs a `maxHeight`, or a `height`, or `flex: 1`. That is the
one property that makes the difference between clipping and scrolling, and it is
cheap to state. A bounded card that then overflows scrolls (or can be made to);
an unbounded one silently extends past the viewport in both directions, because
the scrim centres it.

HOW a card is identified: a StyleSheet key named card/sheet/dialog/panel/modal*
that sets a width or maxWidth and a padding or borderRadius -- i.e. the framed
box inside the scrim, not the scrim itself and not a row.

KNOWN LIMITS, stated rather than papered over:
  * A card whose content is genuinely fixed and short is still flagged. Bounding
    it is correct anyway (font scale goes to 1.75x in this app, which is what
    turned the Downgrade Gate from "10pt over" into "220pt of the exit missing"),
    so this is a conservative direction to be wrong in.
  * Reads one file at a time: a card style imported from elsewhere is not seen.
  * A bound may live in the StyleSheet or inline at the usage site; both count
    (AvatarEditModal uses the inline form and is correctly bounded).
  * It checks that a bound EXISTS, not that the content then scrolls. The two
    known bugs were both missing the bound entirely.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

CARD_KEY = re.compile(r"^\s*(card|sheet|dialog|panel|modalCard|modalBox|modalContent)\b\s*:\s*\{", re.I | re.M)
BOUND = re.compile(r"\b(maxHeight|height|flex)\s*:", re.I)
FRAME = re.compile(r"\b(width|maxWidth)\s*:", re.I)
LOOKS_FRAMED = re.compile(r"\b(padding|paddingVertical|borderRadius)\s*:", re.I)

# Blanking comments first is mandatory: several screens discuss <Modal> in prose
# (my-aircraft/[id].tsx mentions it 11 times in comments alone), and a scan that
# counts those decides the wrong thing about the wrong file.
BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
LINE_COMMENT = re.compile(r"^\s*//.*$", re.M)


def blank_comments(text: str) -> str:
    text = BLOCK_COMMENT.sub(lambda m: "\n" * m.group(0).count("\n"), text)
    return LINE_COMMENT.sub("", text)


def style_block(text: str, start: int) -> str:
    """The { ... } body of one StyleSheet entry, brace-matched."""
    depth, i = 0, start
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
        i += 1
    return text[start:start + 400]


def bounded_inline(code: str, key: str) -> bool:
    """A bound applied at the usage site, not in the StyleSheet.

    AvatarEditModal does exactly this -- `style={[styles.card, { ...,
    maxHeight: '85%' }]}` -- which is a perfectly correct bound and which the
    first draft of this audit reported as a defect. A style-block-only scan
    decides on half the evidence.
    """
    for m in re.finditer(r"styles\." + re.escape(key) + r"\b", code):
        # The enclosing style={[ ... ]} array, if there is one.
        tail = code[m.end():m.end() + 400]
        arr_end = tail.find("]")
        if arr_end == -1:
            continue
        if BOUND.search(tail[:arr_end]):
            return True
    return False


def main():
    offenders, checked = [], 0
    for path in sorted(SRC.rglob("*.tsx")):
        raw = path.read_text()
        code = blank_comments(raw)
        # Only files that actually render a modal.
        if not re.search(r"<(Modal|ScreenModal)\b", code):
            continue
        for m in CARD_KEY.finditer(code):
            body = style_block(code, m.end() - 1)
            if not FRAME.search(body) or not LOOKS_FRAMED.search(body):
                continue  # not the framed card box
            checked += 1
            if not BOUND.search(body) and not bounded_inline(code, m.group(1)):
                offenders.append((path.relative_to(BASE), m.group(1), " ".join(body.split())[:110]))

    if offenders:
        print("FAIL modal_card_bounded_audit")
        for rel, key, body in offenders:
            print(f"  - {rel}  style `{key}` has no maxHeight/height/flex")
            print(f"      {body}")
        print("\n  A scrim centres its card, so an unbounded card grows off BOTH ends")
        print("  of the screen -- taking its own dismiss control with it.")
        return 1
    print(f"PASS modal_card_bounded_audit -- all {checked} modal card style(s) are "
          f"bounded by the screen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
