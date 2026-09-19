#!/usr/bin/env python3
"""No committed script may hardcode a path that only exists on one machine.

This has already cost this project once. memory/gotcha_hardcoded_local_path_broke_ci.md:
supabase_mgmt_api.py hardcoded `/Users/rc/...`, so every mgmt()-backed audit died
instantly on the CI runner with FileNotFoundError -- 13 of 51 audits were
structurally unable to run while the suite still reported a total.

Found again 2026-09-18, a different flavour: NINE scripts wrote their output to
`/private/tmp/claude-501/<session-id>/scratchpad/...` -- an assistant session's
temp directory, baked in as a literal. Four pointed at a session that had been
dead for weeks. None was in CI and only one had been wired into the audit suite
(by me, in error), so nothing was breaking -- but every one of them would fail
the next time anybody ran it, for a reason that has nothing to do with what the
script does.

The rule: a script in scripts/ is run by other people, on other machines, in CI,
in a future session. Its paths must be relative to the repo (derive from
__file__ / import.meta.url) or come from configuration. An absolute path to
somebody's home directory or to a session-scoped temp directory is a bug even
when it currently works.

Usage: python3 scripts/no_machine_specific_paths_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []

# Patterns that can only ever resolve on one machine or in one session.
BAD = [
    (re.compile(r"""["']/private/tmp/claude-\d+/"""), "an assistant session's temp directory"),
    (re.compile(r"""["']/Users/[A-Za-z0-9._-]+/"""), "a specific user's home directory"),
    (re.compile(r"""["']/home/[A-Za-z0-9._-]+/"""), "a specific user's home directory"),
]
# Comments and docstrings legitimately QUOTE these paths when explaining the bug
# -- patch_ios_space_paths.py's own docstring says "This project lives at
# /Users/rc/..." as prose. The first draft of this audit flagged that, which is
# a check crying wolf about a sentence. Strip docstrings before scanning, and
# skip comment lines.
SKIP_LINE = re.compile(r"^\s*(#|//|\*|/\*)")

# Scripts whose ENTIRE PURPOSE is a location on RC's machine. Named, with the
# reason, rather than pattern-exempted -- the point of this audit is that a path
# like this is a decision, and a decision should be legible.
EXEMPT = {
    "relink_premiere_project.py":
        "a personal video-editing utility: its job IS to search RC's own media "
        "folders (Desktop/05_FlyRegs, the iMovie library) to relink a Premiere "
        "project. It is not app code and never runs anywhere else.",
}


def main():
    hits = []
    checked = 0
    for f in sorted((ROOT / "scripts").glob("*")):
        if f.suffix not in (".py", ".mjs", ".cjs", ".ts", ".sh"):
            continue
        if f.name == "no_machine_specific_paths_audit.py":
            continue
        if f.name in EXEMPT:
            continue
        checked += 1
        body = f.read_text(errors="ignore")
        # Blank out triple-quoted docstrings so prose describing a path is not
        # mistaken for code using one.
        body = re.sub(r'"""[\s\S]*?"""', lambda m: "\n" * m.group(0).count("\n"), body)
        for i, line in enumerate(body.splitlines(), 1):
            if SKIP_LINE.match(line):
                continue
            for pat, why in BAD:
                if pat.search(line):
                    hits.append(f"{f.name}:{i}  ({why})  {line.strip()[:60]}")

    print(f"  checked {checked} script(s) in scripts/")
    for h in hits:
        print(f"    {h}")
    if hits:
        FAILURES.append(f"{len(hits)} hardcoded machine/session path(s)")

    if checked < 50:
        print(f"  FAIL  only {checked} scripts scanned — the glob is broken, not the repo")
        sys.exit(1)

    print()
    if FAILURES:
        print("FAILED:")
        for x in FAILURES:
            print("  - " + x)
        print("\n  Derive the path from __file__ (Python) or import.meta.url (JS),")
        print("  or read it from config. See memory/gotcha_hardcoded_local_path_broke_ci.md.")
        sys.exit(1)
    print("no_machine_specific_paths -- every script's paths resolve anywhere")


if __name__ == "__main__":
    main()
