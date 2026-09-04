#!/usr/bin/env python3
"""Flag supabase reads that ignore `error` AND feed a destructive decision.

WHY THIS EXISTS
---------------
supabase-js RESOLVES `{data: null, error}` on a network failure -- it does not
reject (verified in node_modules/@supabase/postgrest-js/dist/index.cjs:328,
`if (!this.shouldThrowOnError) res = res.catch(...)`), and nothing in this
codebase calls .throwOnError(). So:

    const { data } = await supabase.from(...).select(...)
    ...
    (data ?? []).map(...)

turns "the network blinked" into "the server says these rows do not exist".

That is harmless on a browse screen (an empty list is degraded UX). It is
CATASTROPHIC anywhere "absent" drives a delete. On 2026-09-04 exactly that
shape, in sharedFolders.ts's three resolvers, could permanently soft-delete
every collaborator-contributed row in a shared folder -- for everyone -- from
a single flaky read, because folder/[id].tsx treats "did not resolve" as
"orphaned" and self-heals by removing it. See flyregs_gotchas.md's 2026-09-04
entry and memory/gotcha_failed_read_treated_as_deletion.md.

WHAT IT CHECKS
--------------
Every `const { data... } = await supabase...` with no `error` binding, then
narrows to the ones whose following ~14 lines contain a destructive marker
(.delete(, deleted: true, removeMany, remove(). Only those FAIL the run.
Read-only ones are printed as INFO so the number is visible without being
noise -- a browse list that renders empty on failure is a real trade-off this
app makes deliberately in many places, not a bug to chase corpus-wide.

Exit 1 if any destructive-adjacent unchecked read exists.

Usage: python3 scripts/audit_unchecked_supabase_errors.py
"""
import pathlib, re, sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"
READ_RE = re.compile(r"const \{\s*data[^}]*\}\s*=\s*await supabase")
DESTRUCTIVE = (".delete(", "deleted: true", "removeMany", "remove(")

def main() -> int:
    destructive, readonly = [], []
    for f in sorted(SRC.rglob("*.ts*")):
        lines = f.read_text().split("\n")
        for i, ln in enumerate(lines):
            if not READ_RE.search(ln) or "error" in ln:
                continue
            # a multi-line destructure may bind error a line or two down
            tail = "\n".join(lines[i:i + 8])
            after_call = tail.split("await supabase")[-1][:400]
            if "error" in after_call:
                continue
            window = "\n".join(lines[i:i + 14])
            rec = (str(f.relative_to(BASE)), i + 1, ln.strip()[:100])
            (destructive if any(k in window for k in DESTRUCTIVE) else readonly).append(rec)

    print(f"INFO: {len(readonly)} unchecked-error supabase reads on read-only paths "
          f"(an empty render on failure -- degraded, not destructive)")
    if not destructive:
        print("PASS: no unchecked-error read feeds a destructive decision.")
        return 0
    print(f"\nFAIL: {len(destructive)} unchecked-error read(s) feed a delete/remove:\n")
    for path, line, src in destructive:
        print(f"  {path}:{line}\n      {src}")
    print("\nA read that fails must never be read as 'these rows are gone'.")
    return 1

if __name__ == "__main__":
    sys.exit(main())
