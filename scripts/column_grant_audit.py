#!/usr/bin/env python3
"""Does the app ever select a column the client has no grant on?

Several corpus tables deliberately withhold their heavy/gated columns from
`authenticated` (pdf_text, body_text, senses, search_vector, ...) and serve
them through `_gated` views instead. That design is invisible in TypeScript:
a `.select('id, body_text')` against the raw table compiles, type-checks,
and fails at RUNTIME with a 403 -- which supabase-js RESOLVES rather than
throwing, so the screen just renders empty.

This has shipped at least twice:
  * folder/shared/[id].tsx read advisory_circulars.changed_block_indices from
    the raw table; it 403'd every time, so every shared-folder AC silently
    fell through to the highlight fallback (found in the 2026-08-23 sweep).
  * series/[prefix].tsx had the identical bug.

Both were found by a human noticing a screen looked wrong. This finds them by
comparing every `.select(...)` in the source against the live column grants.

Usage: python3 scripts/column_grant_audit.py
"""
import json
import pathlib
import re
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def strip_comments(text: str) -> str:
    """Blank out // and /* */ comments, preserving line numbers and string
    literals (the .select() argument is itself a string, so a naive strip
    would destroy what this audit reads)."""
    out = []
    i, n = 0, len(text)
    in_line = in_block = in_str = False
    quote = ""
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if in_line:
            if c == "\n":
                in_line = False
                out.append(c)
            else:
                out.append(" ")
        elif in_block:
            if c == "*" and nxt == "/":
                in_block = False
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
        elif in_str:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                in_str = False
        else:
            if c == "/" and nxt == "/":
                in_line = True
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                in_block = True
                out.append("  ")
                i += 2
                continue
            if c in "'\"`":
                in_str = True
                quote = c
            out.append(c)
        i += 1
    return "".join(out)


def q(sql):
    r = subprocess.run(["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
                       capture_output=True, text=True, cwd=str(BASE))
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)


def main():
    # Every column authenticated may SELECT, per table.
    granted = {}
    for row in q("""
        select table_name, column_name
        from information_schema.column_privileges
        where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'SELECT'
    """):
        granted.setdefault(row["table_name"], set()).add(row["column_name"])

    # Tables that exist but where authenticated has NO column grants at all
    # are simply not client-readable; a select against them is caught by the
    # sweep_db_posture probe, not here.
    all_cols = {}
    for row in q("""
        select table_name, column_name from information_schema.columns
        where table_schema = 'public'
    """):
        all_cols.setdefault(row["table_name"], set()).add(row["column_name"])

    # Find `.from('x')` ... `.select('a, b, c')` pairs. The select is normally
    # the next chained call; allow a few characters of whitespace/newline.
    pat = re.compile(r"\.from\(\s*['\"]([a-z0-9_]+)['\"]\s*\)\s*\n?\s*\.select\(\s*[`'\"]([^`'\"]*)[`'\"]", re.M)
    checked = 0
    for path in list((BASE / "src").rglob("*.ts")) + list((BASE / "src").rglob("*.tsx")):
        # Comments MUST be stripped first. This file's own first run flagged
        # saved.tsx for selecting pdf_blocks -- from a comment describing the
        # 2026-08-05 tier leak that removed exactly that select. An audit that
        # reports the fix as the bug is worse than no audit.
        text = strip_comments(path.read_text())
        for m in pat.finditer(text):
            table, cols = m.group(1), m.group(2)
            if table not in all_cols:
                continue  # a storage bucket, or a name built dynamically
            if table not in granted:
                continue  # no client grant at all -- a different check's job
            line = text[: m.start()].count("\n") + 1
            rel = path.relative_to(BASE)
            checked += 1
            if cols.strip() == "*":
                withheld = all_cols[table] - granted[table]
                if withheld:
                    FAILURES.append(
                        f"{rel}:{line}  .from('{table}').select('*') -- "
                        f"{len(withheld)} column(s) are NOT granted "
                        f"({', '.join(sorted(withheld))}); this 403s at runtime")
                continue
            # Strip embedded-resource syntax and aliases, keep bare names.
            names = []
            for part in re.split(r",(?![^()]*\))", cols):
                part = part.strip()
                if not part or "(" in part:
                    continue
                part = part.split(":")[-1].strip()
                names.append(part)
            missing = [n for n in names if n and n not in granted[table] and n in all_cols[table]]
            if missing:
                FAILURES.append(
                    f"{rel}:{line}  .from('{table}').select(...) asks for "
                    f"{', '.join(missing)} -- not granted to authenticated; "
                    f"this 403s at runtime and supabase-js resolves it as empty")

    print(f"Checked {checked} .from().select() pair(s) against live column grants.\n")
    if FAILURES:
        print(f"{len(FAILURES)} FINDING(S):")
        for f in FAILURES:
            print("  FAIL ", f)
        sys.exit(1)
    print("PASS  every column the app selects is granted to authenticated")


if __name__ == "__main__":
    main()
