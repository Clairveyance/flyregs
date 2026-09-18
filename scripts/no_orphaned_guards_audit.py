#!/usr/bin/env python3
"""No test or audit script may sit in no runner at all.

Found 2026-09-18 while sweeping for more instances of the day's defect classes.
scripts/ held 25 files named like tests or audits that run_all_audits.sh never
mentions -- and they were not in its deliberate-exclusion list either. Nobody
chose to skip them; they were never added.

That is not a tidiness complaint. sync_owner_claim_test.ts -- the deterministic
proof for BOTH client-side guards from the 2026-08-26 incident, where real user
data was destroyed -- had been DEAD for months. It did not fail; it did not even
transform, because sync.ts gained an import the test did not stub. Its own
comments record this happening twice before. Each time the fix was another stub,
when the actual problem was that nothing ran the file, so nothing noticed.

A guard nobody runs is not a guard. This audit fails when a new one appears.

Exemptions are explicit and few. Adding a name here should mean "this genuinely
is not app health", not "this one is inconvenient".

Usage: python3 scripts/no_orphaned_guards_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts/run_all_audits.sh"
FAILURES = []

# Not app health, or run by something other than the audit suite.
EXEMPT = {
    "youtube_description_audit": "YouTube channel content, not app health",
    "no_orphaned_guards_audit": "this file",
}

NAMEY = re.compile(r"(_test|_audit|_sweep|_check|_eval|_fuzzer)$")


def main():
    runner = RUNNER.read_text()
    # The header names the scripts it deliberately leaves out; those count as
    # accounted for, because somebody decided.
    header = runner.split("set -uo pipefail")[0]

    orphans = []
    total = 0
    for p in sorted((ROOT / "scripts").glob("*")):
        if p.suffix not in (".py", ".ts", ".mjs", ".cjs"):
            continue
        if not NAMEY.search(p.stem):
            continue
        total += 1
        if p.stem in EXEMPT:
            continue
        if p.stem in runner:          # invoked, or named in the exclusion list
            continue
        orphans.append(p.stem)

    print(f"  checked {total} test/audit script(s); "
          f"{len(EXEMPT)} exempt by name; {len(orphans)} unaccounted for")
    for o in orphans:
        print(f"    ORPHAN  {o}")
    if orphans:
        FAILURES.append(
            f"{len(orphans)} guard(s) in no runner and not deliberately excluded: "
            + ", ".join(orphans))

    print()
    if FAILURES:
        print("FAILED:")
        for f in FAILURES:
            print("  - " + f)
        print("\n  Either wire it into run_all_audits.sh, or name it in that")
        print("  script's exclusion header with the reason. Both are decisions;")
        print("  leaving it unmentioned is not.")
        sys.exit(1)
    print("no_orphaned_guards -- every test/audit script is either run or "
          "deliberately excluded")


if __name__ == "__main__":
    main()
