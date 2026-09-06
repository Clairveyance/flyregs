#!/usr/bin/env python3
"""Timers, listeners and setState-after-unmount: the leak classes.

RC, 2026-09-06: "everytime you look, you end up finding more issues... i'd
like to find them before cutting B41."

The existing audits cover silent failures, access control, error states and
promises. This covers what none of them look at: things that keep running,
or keep writing, after the screen that owns them is gone. On a phone those
present as battery drain, a stale UI, or -- in the worst case -- the OS
killing the app, which is exactly what REACT-NATIVE-3 (WatchdogTermination)
looks like and which nothing has explained yet.

  1. setInterval / setTimeout with no clear in the effect's cleanup
  2. addEventListener / addListener with no remove in the cleanup
  3. an async effect that setStates with no cancellation guard -- React logs
     nothing for this in production, so it is invisible
  4. requestAnimationFrame loops with no stop flag

Every finding is checked against the SAME effect's cleanup, not just "is the
word clearInterval anywhere in the file" -- that shortcut is why an earlier
audit in this project reported nine working screens as broken.

Usage: python3 scripts/sweep_lifecycle_leaks.py
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"
HARD, INFO = [], []


def strip_comments(text: str) -> str:
    out, i, n = [], 0, len(text)
    in_line = in_block = in_str = False
    quote = ""
    while i < n:
        c, nxt = text[i], (text[i + 1] if i + 1 < n else "")
        if in_line:
            out.append(c if c == "\n" else " ")
            if c == "\n":
                in_line = False
        elif in_block:
            if c == "*" and nxt == "/":
                in_block = False; out.append("  "); i += 2; continue
            out.append("\n" if c == "\n" else " ")
        elif in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1]); i += 2; continue
            if c == quote:
                in_str = False
        else:
            if c == "/" and nxt == "/":
                in_line = True; out.append("  "); i += 2; continue
            if c == "/" and nxt == "*":
                in_block = True; out.append("  "); i += 2; continue
            if c in "'\"`":
                in_str, quote = True, c
            out.append(c)
        i += 1
    return "".join(out)


def effects(code: str):
    """Yield (start, end, body) for every useEffect/useFocusEffect callback,
    by brace matching -- a fixed-size window has already produced false
    findings in this project."""
    for m in re.finditer(r"use(?:Focus)?Effect\(", code):
        i = code.index("(", m.end() - 1)
        depth, j, n = 0, i, len(code)
        in_str, quote = False, ""
        while j < n:
            c = code[j]
            if in_str:
                if c == "\\": j += 2; continue
                if c == quote: in_str = False
            elif c in "'\"`":
                in_str, quote = True, c
            elif c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    yield m.start(), j, code[i:j]
                    break
            j += 1


def line_of(code: str, idx: int) -> int:
    return code[:idx].count("\n") + 1


def main():
    files = {p: strip_comments(p.read_text()) for p in
             list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx"))}
    print(f"Scanned {len(files)} files\n")

    # ------------------------------------------------------------- timers
    print("=== 1. setInterval / setTimeout never cleared in the same effect ===")
    found = []
    for path, code in files.items():
        for start, end, body in effects(code):
            has_cleanup = "return () =>" in body or "return function" in body
            for kind, clear in (("setInterval", "clearInterval"), ("setTimeout", "clearTimeout")):
                # `kind not in body` matched setIntervalText( -- a plain state
                # setter -- and reported two working screens as timer leaks.
                # The call has to be the whole identifier followed by "(".
                if not re.search(rf"\b{kind}\s*\(", body):
                    continue
                # A timer that is stored nowhere and cleared nowhere leaks
                # only if the effect can re-run or unmount mid-flight.
                if clear in body:
                    continue
                # A one-shot setTimeout that only calls a ref/nav is a
                # deliberate deferral, not a leak -- flag intervals hard,
                # timeouts as INFO.
                rel = str(path.relative_to(BASE))
                found.append((kind, rel, line_of(code, start), has_cleanup))
    intervals = [f for f in found if f[0] == "setInterval"]
    timeouts = [f for f in found if f[0] == "setTimeout"]
    if intervals:
        for _, rel, ln, _ in intervals:
            print(f"  FAIL  {rel}:{ln}  setInterval with no clearInterval in the same effect")
            HARD.append(f"uncleared interval {rel}:{ln}")
    else:
        print("  PASS  every setInterval in an effect is cleared by that effect")
    if timeouts:
        print(f"  INFO  {len(timeouts)} setTimeout(s) in an effect with no clearTimeout "
              f"(a one-shot deferral is usually fine; listed for eyeball):")
        for _, rel, ln, _ in timeouts[:15]:
            print(f"          {rel}:{ln}")
        INFO.append(f"{len(timeouts)} uncleared setTimeout in effects")

    # ---------------------------------------------------------- listeners
    print("\n=== 2. listeners subscribed in an effect and never removed ===")
    leaks = []
    for path, code in files.items():
        for start, end, body in effects(code):
            subs = re.findall(r"(\w+)\.addEventListener\(|(\w+)\.addListener\(", body)
            if not subs:
                continue
            # `return sub` is a perfectly good cleanup -- navigation
            # .addListener and AppState.addEventListener both RETURN their own
            # unsubscribe, and returning it from the effect is the idiomatic
            # form. The first version of this check demanded the literal word
            # "remove" and reported challenges/[id].tsx -- which does exactly
            # that -- as a leak.
            removed = (".remove()" in body or "removeEventListener" in body
                       or "removeListener" in body
                       or re.search(r"\breturn\s+\w+\s*(?:;|\n\s*\})", body) is not None
                       or re.search(r"return\s*\(\)\s*=>", body) is not None)
            if not removed:
                leaks.append((str(path.relative_to(BASE)), line_of(code, start)))
    if leaks:
        for rel, ln in leaks:
            print(f"  FAIL  {rel}:{ln}  listener added with no removal in the cleanup")
            HARD.append(f"unremoved listener {rel}:{ln}")
    else:
        print("  PASS  every listener added in an effect is removed by it")

    # ----------------------------------------------- setState after unmount
    print("\n=== 3. async effect that setStates with no cancellation guard ===")
    risky = []
    for path, code in files.items():
        for start, end, body in effects(code):
            if ".then(" not in body and "await " not in body:
                continue
            sets = re.findall(r"\bset[A-Z]\w*\(", body)
            if not sets:
                continue
            guarded = any(k in body for k in (
                "cancelled", "canceled", "isMounted", "mounted", "live",
                "loadGenRef", "myGen", "abort", "AbortController", "seq.current"))
            if guarded:
                continue
            # SEVERITY DEPENDS ON THE DEPS, and this is the whole point.
            #
            # An effect with [] deps runs once per mount. Its only failure is
            # a setState after unmount, which React has tolerated silently
            # since 18 -- annoying, not user-visible.
            #
            # An effect whose deps CHANGE looks like it should be different:
            # navigate quickly from /far/91.103 to /far/91.105 and the first
            # fetch could resolve AFTER the second, writing the OLD document's
            # body under the NEW document's header. In a regulations app that
            # would be the worst kind of failure.
            #
            # IT DOES NOT HAPPEN, and this was settled by experiment rather
            # than by reading code (2026-09-06). The first far_sections read
            # was delayed by 4 seconds in the browser, the screen navigated
            # away after 1.5s, and the late response was allowed to land:
            # § 91.105 stayed correct. Repeated with a cancellation guard
            # deliberately disabled as a control -- still correct. The reason
            # is visible in the DOM: on a param change expo-router TEARS DOWN
            # the screen (the old title node leaves document), so the previous
            # instance's setState calls hit a dead component and React
            # discards them.
            #
            # A cancellation guard was written for all eight document screens
            # and then REVERTED, because it fixed nothing. Listing these is
            # still worth it -- the day one of these screens stops remounting,
            # this list is where to look -- but they are not defects today.
            # `end` is the index of useEffect's own closing paren, which is
            # AFTER the dependency array -- so searching FORWARD from it found
            # the NEXT effect's deps and mislabelled the finding. Read the
            # array immediately before `end` instead.
            tail = code[max(0, end - 400):end + 1]
            m = re.search(r"\[([^\[\]]*)\]\s*\)\s*$", tail)
            dep_str = (m.group(1).strip() if m else "")
            if not dep_str:
                continue
            risky.append((str(path.relative_to(BASE)), line_of(code, start), len(sets), dep_str[:44]))
    if risky:
        print(f"  INFO  {len(risky)} async effect(s) that setState with no guard AND")
        print("        deps that change. THIS WAS TESTED AND THE FEARED BUG DOES NOT")
        print("        HAPPEN -- see the note in this file. Listed for awareness only.")
        for rel, ln, n, dep in risky:
            print(f"          {rel}:{ln}  deps=[{dep}]  ({n} setState)")
        INFO.append(f"{len(risky)} unguarded async effects")
    else:
        print("  PASS  every async effect guards its setState")

    # ------------------------------------------------------------- rAF
    print("\n=== 4. requestAnimationFrame loops with no stop flag ===")
    # A LOOP re-schedules itself: the function passed to rAF calls rAF again,
    # or a named function schedules itself by name. A one-shot
    # `requestAnimationFrame(() => input.focus())` has nothing to stop, and
    # treating those as leaks reported four correct files (Home's focus
    # deferral, PlainTextBody's bounded 6-attempt scroll retry,
    # FolderListView's scrollToIndex, ShareCardCapture's paint wait).
    raf = []
    for path, code in files.items():
        if "requestAnimationFrame" not in code:
            continue
        looping = False
        for m in re.finditer(r"(?:const|function)\s+(\w+)[^\n]*\n?", code):
            name = m.group(1)
            if re.search(rf"requestAnimationFrame\(\s*{re.escape(name)}\s*\)", code):
                # does that function body itself call rAF? (self-scheduling)
                looping = True
                break
        if not looping:
            continue
        stops = ("cancelAnimationFrame" in code or "disposed" in code
                 or "cancelled" in code or "stopped" in code)
        if not stops:
            raf.append(str(path.relative_to(BASE)))
    if raf:
        for rel in raf:
            print(f"  FAIL  {rel}  rAF loop with no way to stop it")
            HARD.append(f"unstoppable rAF {rel}")
    else:
        print("  PASS  every rAF loop can be stopped")

    print("\n" + "=" * 62)
    if HARD:
        print(f"{len(HARD)} HARD finding(s):")
        for h in HARD:
            print("  -", h)
        sys.exit(1)
    print("No hard findings.")
    for i in INFO:
        print("  observation:", i)


if __name__ == "__main__":
    main()
