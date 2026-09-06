#!/usr/bin/env python3
"""Every fire-and-forget async call, classified by whether it can actually reject.

RC, 2026-09-05: "audit and fix all promises, etc."

A bare `doThing()` statement whose function is async is a floating promise. On
React Native an unhandled rejection is a console warning nobody sees in a
release build -- so the failure is not just unhandled, it is INVISIBLE. But
most of the ones in this app are deliberate: syncPush* and friends swallow and
report their own errors on purpose, because a bookmark tap must never wait on
the network.

Blanket-flagging all of them is useless (111 findings, ~all fine). Blanket-
ignoring them is how a real one hides. So this classifies each callee:

  SAFE      its whole body is inside try/catch, or it is documented
            fire-and-forget -- it cannot reject
  CAN THROW it has a `throw`, or an unguarded `if (error) throw`, outside any
            catch -- a bare call is a silent, invisible failure

Only CAN THROW fails the run.

Usage: python3 scripts/floating_promise_audit.py
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"


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


def body_of(src: str, name: str):
    """The source of an async function, by brace matching.

    Finding the body's opening brace is not `[^{]*{`. A return type can
    contain one -- `): Promise<{ removed: number }> {` -- and that naive
    pattern matched the brace INSIDE the return type, brace-matched the wrong
    span, and produced a body with no `throw` in it. resyncAircraftAds, which
    is one line of `if (error) throw error`, was therefore classified SAFE.
    So: scan forward from the declaration and take the first `{` that appears
    while angle-bracket and paren depth are both zero.
    """
    m = re.search(rf"(?:export )?(?:async )?function {re.escape(name)}\b", src)
    if not m:
        m = re.search(rf"(?:const|let) {re.escape(name)}\s*=\s*async\b", src)
        if not m:
            return None
    i, n = m.end(), len(src)
    angle = paren = 0
    while i < n:
        c = src[i]
        if c == "<": angle += 1
        elif c == ">": angle = max(0, angle - 1)
        elif c == "(": paren += 1
        elif c == ")": paren = max(0, paren - 1)
        elif c == "{" and angle == 0 and paren == 0:
            break
        i += 1
    if i >= n:
        return None
    depth, n = 0, len(src)
    in_str, quote = False, ""
    while i < n:
        c = src[i]
        if in_str:
            if c == "\\": i += 2; continue
            if c == quote: in_str = False
        elif c in "'\"`":
            in_str, quote = True, c
        elif c == "{": depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[m.end() - 1:i + 1]
        i += 1
    return None


def can_reject(body: str) -> bool:
    """True when a throw is reachable without an enclosing catch.

    Approximated the honest way: if the function body's FIRST statement opens a
    try that spans essentially the whole body, nothing escapes. Otherwise any
    `throw` (including `if (error) throw error`) can escape.
    """
    if "throw" not in body:
        return False
    stripped = body.strip()[1:-1].strip()
    if stripped.startswith("try {"):
        # does the try cover to the end (a trailing catch/finally closes it)?
        tail = stripped[-200:]
        if "catch" in tail or re.search(r"\}\s*catch\s*[({]", stripped):
            # a whole-body try/catch with no rethrow inside the catch
            m = re.search(r"\}\s*catch\s*\([^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\s*$", stripped)
            if m and "throw" not in m.group(1):
                return False
    return True


def main():
    files = {p: strip_comments(p.read_text()) for p in
             list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx"))}
    all_src = "\n".join(files.values())

    async_names = set(re.findall(r"export async function (\w+)", all_src))
    async_names |= set(re.findall(r"const (\w+)\s*=\s*async\b", all_src))

    bodies = {}
    for name in async_names:
        for src in files.values():
            b = body_of(src, name)
            if b:
                bodies[name] = b
                break

    floating = []
    for path, code in files.items():
        lines = code.split("\n")
        for i, raw in enumerate(lines, start=1):
            line = raw.strip()
            m = re.match(r"^(\w+)\(", line)
            if not m:
                continue
            name = m.group(1)
            # RESOLVE THE NAME IN THIS FILE FIRST.
            #
            # Names repeat across screens. NoteEditor's `handleDone` is a plain
            # `() => {}`, but some other file has a `const handleDone = async`,
            # so a global name set reported a synchronous function as a
            # floating promise. If the file declares the name itself, that
            # local declaration is the truth; only fall back to the global set
            # when the name is imported from elsewhere.
            local_async = re.search(rf"(?:const|let|var)\s+{re.escape(name)}\s*=\s*async\b", code) is not None
            local_sync = re.search(rf"(?:const|let|var)\s+{re.escape(name)}\s*=\s*(?!async)\(?", code) is not None
            local_fn_async = re.search(rf"(?:export )?async function {re.escape(name)}\b", code) is not None
            local_fn_sync = re.search(rf"(?:export )?function {re.escape(name)}\b", code) is not None
            declared_here = local_async or local_sync or local_fn_async or local_fn_sync
            if declared_here:
                if not (local_async or local_fn_async):
                    continue
            elif name not in async_names:
                continue
            if line.startswith(("await ", "void ", "return ")):
                continue

            # It must be a STATEMENT, not an item in an argument list.
            #
            # The second version of this audit reported nine more findings that
            # were all entries inside `Promise.all([ ... ])` -- covered by the
            # outer chain's own .catch, and not floating at all. A trailing
            # comma, or a previous line that opens a call or an array, means
            # this is an argument.
            if line.rstrip().endswith(","):
                continue
            prev = ""
            for back in range(i - 2, max(-1, i - 4), -1):
                if lines[back].strip():
                    prev = lines[back].strip()
                    break
            if prev.endswith(("([", "[", "(", ",")):
                continue

            # READ THE WHOLE STATEMENT, not one line.
            #
            # The first version of this audit checked only the line the call
            # started on and reported 25 findings -- every single one a
            # multi-line `.then(...).catch(...)` chain whose handlers were on
            # the FOLLOWING lines. That is the entire idiom this codebase uses,
            # so the audit's output was 100% noise. A statement continues while
            # brackets are open or the next line begins with `.`, so follow it
            # to its end before deciding anything.
            stmt, depth, j = line, 0, i - 1
            while j < len(lines):
                cur = lines[j]
                depth += cur.count("(") + cur.count("[") + cur.count("{")
                depth -= cur.count(")") + cur.count("]") + cur.count("}")
                # Skip blank lines when looking for the continuation: comments
                # are blanked out above, and this codebase puts a paragraph of
                # them between a call and its own `.catch(...)`. Stopping at the
                # first blank line reported three handled chains as floating.
                nxt = ""
                for look in range(j + 1, min(j + 12, len(lines))):
                    if lines[look].strip():
                        nxt = lines[look].strip()
                        break
                if j > i - 1:
                    stmt += " " + cur.strip()
                if depth <= 0 and not nxt.startswith("."):
                    break
                j += 1
            if ".then(" in stmt or ".catch(" in stmt:
                continue
            floating.append((str(path.relative_to(BASE)), i, line[:80], name))

    risky, safe = [], []
    for rel, ln, line, name in floating:
        # Prefer a body declared in the SAME file. `fetchAll` exists as a
        # local helper inside two screens' effects AND as a throwing export in
        # lib/refPackets.ts; taking the global one classified both local
        # helpers as able to throw when neither contains a throw at all.
        own = files.get(BASE / rel)
        body = (body_of(own, name) if own else None) or bodies.get(name)
        # A body this parser could not find is treated as RISKY, not safe.
        # The alternative is a parsing failure quietly clearing something --
        # which is exactly how resyncAircraftAds (one line of `if (error)
        # throw error`) came back clean the first time.
        (risky if (body is None or can_reject(body)) else safe).append((rel, ln, line, name))

    print(f"{len(floating)} fire-and-forget async call(s) across {len(files)} files\n")
    print(f"=== SAFE: the callee cannot reject ({len(safe)}) ===")
    by_fn = {}
    for rel, ln, line, name in safe:
        by_fn.setdefault(name, 0)
        by_fn[name] += 1
    for name, n in sorted(by_fn.items(), key=lambda kv: -kv[1]):
        print(f"  {n:>3}x {name}()")

    print(f"\n=== CAN REJECT: a bare call here fails silently and invisibly ({len(risky)}) ===")
    for rel, ln, line, name in risky:
        print(f"  FAIL  {rel}:{ln}  {line}")

    print()
    if risky:
        print(f"{len(risky)} floating call(s) to a function that can throw.")
        sys.exit(1)
    print("every fire-and-forget call is to a function that handles its own errors")


if __name__ == "__main__":
    main()
