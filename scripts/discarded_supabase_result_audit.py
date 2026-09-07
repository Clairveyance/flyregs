#!/usr/bin/env python3
"""Find Supabase calls whose {data, error} result is thrown away.

WHY THIS CLASS EXISTS
supabase-js RESOLVES `{data, error}` on failure -- it does not throw. A call
whose result is never inspected therefore cannot fail loudly, and cannot look
failed to the app either: it looks like it worked. Found after noticing
disclaimer_acknowledgments had zero rows a month after shipping, because the
write that fills it is a bare `.upsert()` inside a `.then()` with no error
branch.

HOW IT DECIDES -- and why it is written this defensively
The first version of this file reported 166 hits and nearly all were false. It
read code out of COMMENTS, it broke its own `= await` match by rstrip()ing the
context before anchoring on it, and it did not know that a chain sitting in a
ternary or an argument list flows its result to whoever evaluates it. So:

  * comments and string bodies are blanked out (offsets preserved) before any
    matching, so no prose can be read as code;
  * the enclosing STATEMENT is recovered by walking backwards to the previous
    statement boundary at depth 0, rather than by peeking a fixed number of
    characters;
  * a result counts as inspected if the statement binds it (const/let/var),
    returns it, awaits it inside a larger expression, hands it to a .then/
    .catch that names data or error, or sits in argument/ternary/property
    position where the value flows onward.

Anything it cannot PROVE is discarded is not reported.
"""
import os, re, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Optional path argument so the audit can be pointed at a fixture directory
# and PROVED to fail on the broken shape -- a clean run means nothing unless
# the check is known to be capable of failing.
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(BASE, "src")

def blank_noncode(text):
    """Replace comment and string CONTENT with spaces, keeping every offset and
    newline, so line numbers and brace depth stay exact."""
    out = list(text)
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == "/" and i + 1 < n and text[i+1] == "/":
            while i < n and text[i] != "\n":
                out[i] = " "; i += 1
            continue
        if c == "/" and i + 1 < n and text[i+1] == "*":
            while i < n and not (text[i] == "*" and i + 1 < n and text[i+1] == "/"):
                if text[i] != "\n": out[i] = " "
                i += 1
            for _ in range(2):
                if i < n:
                    out[i] = " "; i += 1
            continue
        if c in "\"'`":
            quote = c; i += 1
            while i < n:
                if text[i] == "\\":
                    out[i] = " "
                    if i + 1 < n: out[i+1] = " "
                    i += 2; continue
                if text[i] == quote: break
                # keep ${...} in template literals as real code
                if quote == "`" and text[i] == "$" and i + 1 < n and text[i+1] == "{":
                    d = 0
                    while i < n:
                        if text[i] == "{": d += 1
                        elif text[i] == "}":
                            d -= 1
                            if d == 0: i += 1; break
                        i += 1
                    continue
                if text[i] != "\n": out[i] = " "
                i += 1
            i += 1; continue
        i += 1
    return "".join(out)

START = re.compile(r"\bsupabase\s*\.\s*(?:from|rpc|auth|storage|functions)\b")
# Only PostgrestBuilder -- what supabase.from() and supabase.rpc() return -- is
# LAZY. It is a thenable: the HTTP request is issued inside .then(), so a
# builder that is never awaited and never .then()-ed sends NOTHING. By
# contrast supabase.auth.*, supabase.storage.* and supabase.functions.* are
# ordinary async methods that fire immediately; discarding one of those loses
# the error, but the request still happens. The two are different severities
# and this audit must not blur them.
LAZY = re.compile(r"\bsupabase\s*\.\s*(?:from|rpc)\b")
WRITE = re.compile(r"\.(?:insert|upsert|update|delete|signOut|updateUser|"
                   r"upload|remove|invoke)\s*\(")
# A read that is never executed is just as silent as a write that is never
# executed -- the screen simply renders nothing, with no error to report. So
# reads are checked for the NEVER-EXECUTED case. They are deliberately NOT
# checked for the discarded-result case: a read whose result is ignored is
# usually a prefetch, and reporting those would bury the real findings.
READ = re.compile(r"\.(?:select|single|maybeSingle)\s*\(")

def chain_end(text, i):
    depth, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in "([{": depth += 1
        elif c in ")]}":
            depth -= 1
            if depth < 0: return i
        elif depth == 0 and c in ";,\n":
            j = i
            while j < n and text[j] in " \t\r\n": j += 1
            if j < n and text[j] == ".": i = j; continue
            return i
        i += 1
    return n

def statement_start(text, i):
    """Walk back to the start of the enclosing statement, returning
    (start_index, opened_by) where opened_by is the bracket that encloses the
    chain, or "" at statement level.

    Returning the bracket matters: a chain wrapped as `withTimeout(supabase
    .storage.upload(...))` is in ARGUMENT position -- its result flows to the
    wrapper, which the caller then destructures. An earlier version stopped at
    that "(" and returned only the text after it, throwing away the one piece
    of evidence that proved the result was used, and reported two clean call
    sites in feedback.tsx as bugs."""
    depth = 0
    j = i - 1
    while j >= 0:
        c = text[j]
        if c in ")]}": depth += 1
        elif c in "([{":
            if depth == 0: return j + 1, c
            depth -= 1
        elif depth == 0 and c == ";": return j + 1, ""
        j -= 1
    return 0, ""

# the statement, with the chain removed, tells us where the value goes
BINDS   = re.compile(r"(?:const|let|var)\s*(?:\{[^}]*\}|\[[^\]]*\]|[\w$]+)\s*=\s*(?:await\s+)?\s*$")
# `return` must be on the SAME line as the chain. This is not a heuristic:
# JavaScript's automatic-semicolon-insertion rule terminates a `return` at a
# newline, so `if (!userId) return` followed by a chain on the next line does
# NOT return that chain -- and reading it as one hid the very bug that
# prompted this audit (InfoPopup's disclaimer write). An arrow `=>` has no
# such rule and may legally wrap.
RETURNS = re.compile(r"\breturn[ \t]+(?:await[ \t]+)?[ \t]*$|=>\s*(?:await\s+)?\s*$")
FLOWS   = re.compile(r"[=(,:\[?&|]\s*(?:await\s+)?\s*$|\b(?:await|yield)\s+$")

findings = []
for root, _d, files in os.walk(SRC):
    for fn in sorted(files):
        if not fn.endswith((".ts", ".tsx")): continue
        p = os.path.join(root, fn)
        raw = open(p, encoding="utf-8").read()
        text = blank_noncode(raw)
        for m in START.finditer(text):
            i = m.start()
            end = chain_end(text, i)
            chain = text[i:end]
            is_write = bool(WRITE.search(chain))
            if not is_write and not READ.search(chain): continue
            start, opened_by = statement_start(text, i)
            # inside ( or [ = argument / array-element position: the value is
            # handed to whatever encloses it, so it is not discarded here.
            if opened_by in "([": continue
            lead = text[start:i]
            if BINDS.search(lead) or RETURNS.search(lead) or FLOWS.search(lead): continue
            # `async` before the handler is common and must not defeat this
            # (it produced a false positive on pcg/[id].tsx while testing).
            if re.search(r"\.then\s*\(\s*(?:async\s*)?\(?\s*"
                         r"(?:\{[^}]*\b(?:error|data)\b|[\w$]+\s*\))", chain): continue
            if ".catch(" in chain: continue
            line = raw.count("\n", 0, i) + 1
            executed = (".then(" in chain) or (".catch(" in chain)
            never_ran = bool(LAZY.match(chain)) and not executed
            # reads are reported ONLY when they never ran (see READ above)
            if not never_ran and not is_write: continue
            findings.append((os.path.relpath(p, BASE), line,
                             " ".join(raw[i:end].split())[:130], never_ran))

never = [x for x in findings if x[3]]
silent = [x for x in findings if not x[3]]

print(f"=== NEVER EXECUTED -- lazy builder, no await/.then(): {len(never)} ===")
print("    The request is not sent at all. This is the disclaimer_acknowledgments")
print("    bug: zero rows for a month, no error anywhere, because there was no\n"
      "    request to fail.\n")
for f, line, snip, _ in never:
    print(f"  {f}:{line}\n      {snip}\n")

print(f"=== EXECUTED but {{data, error}} discarded: {len(silent)} ===")
print("    The write happens; a failure is invisible. Fine for deliberate\n"
      "    fire-and-forget analytics, not for anything a user relies on.\n")
for f, line, snip, _ in silent:
    print(f"  {f}:{line}\n      {snip}\n")

sys.exit(1 if never else 0)
