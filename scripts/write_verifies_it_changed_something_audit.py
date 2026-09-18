#!/usr/bin/env python3
"""A write whose whole purpose is to change something must check that it did.

PostgREST answers an UPDATE or DELETE that matches ZERO rows with a SUCCESS,
and supabase-js passes that straight through as `{ error: null }`. So
`if (error) throw` cannot tell "done" apart from "RLS silently refused you".

This has now bitten three times, each time looking like a different bug:
  * aircraft "Remove Access" reported success while the collaborator kept full
    access -- the table simply had no UPDATE policy for the owner;
  * a READ-ONLY collaborator's "remove item" returned HTTP 204 and changed
    nothing, so the screen showed it gone and the next refresh brought it back
    (proven live 2026-09-18);
  * leaveSharedAircraft was a silent no-op for a different reason (a swallowed
    auth error) and its own comment still records it.

THE RULE: any exported function whose NAME promises a consequential change --
remove/delete/revoke/leave/unshare/transfer -- and which issues .update() or
.delete(), must ask for the affected rows back with .select() and then do
something with the answer. "Something" is deliberately loose, because zero rows
is not always an error: for an idempotent remove it means "already gone" and
warning is right, while for an access-control action it means "you were
refused" and throwing is right. What is never acceptable is not looking.

Local-only clearing (an AsyncStorage cache) is out of scope -- there is no
server to refuse it.

Usage: python3 scripts/write_verifies_it_changed_something_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []
VERB = re.compile(
    r"export async function (remove\w*|delete\w*|revoke\w*|leave\w*|unshare\w*|"
    r"transfer\w*|unlink\w*)\s*\(", re.I)


def main():
    checked = 0
    for f in sorted(list((ROOT / "src").glob("**/*.ts")) + list((ROOT / "src").glob("**/*.tsx"))):
        txt = f.read_text()
        for m in VERB.finditer(txt):
            name = m.group(1)
            nxt = txt.find("\nexport ", m.end())
            body = txt[m.start(): nxt if nxt > 0 else len(txt)]
            # Only server writes. A local cache clear has nothing to refuse it.
            if not re.search(r"supabase[\s\S]{0,400}?\.(delete|update)\(", body):
                continue
            checked += 1
            line = txt[:m.start()].count("\n") + 1
            asked = ".select(" in body
            # Three legitimate ways to "act on" the count, and the third cost
            # this audit a false positive on its first run: throw, warn, or
            # RETURN it so the caller decides. removeSharedHighlight does the
            # last one -- `return Array.isArray(data) && data.length > 0` -- and
            # all eight of its call sites branch on the result. A check that
            # only recognises its author's favourite idiom manufactures work.
            acted = bool(re.search(
                r"if\s*\(\s*!\w*\??\.?length"
                r"|\.length\s*===\s*0"
                r"|if\s*\(\s*!data\?\.length"
                r"|return[^\n]*\.length\s*>\s*0", body))
            ok = asked and acted
            print(f"  {'PASS' if ok else 'FAIL'}  {name} ({f.relative_to(ROOT)}:{line})"
                  + ("" if ok else
                     f"   {'no .select() — cannot tell refused from done' if not asked else 'reads rows back but never checks the count'}"))
            if not ok:
                FAILURES.append(f"{name} at {f.relative_to(ROOT)}:{line}")

    print()
    if checked < 8:
        print(f"FAIL  the audit only found {checked} functions to check — it has "
              f"probably been disarmed by a rename")
        sys.exit(1)
    if FAILURES:
        print(f"{len(FAILURES)} of {checked} consequential writes do not verify they changed anything:")
        for x in FAILURES:
            print("  - " + x)
        sys.exit(1)
    print(f"write_verifies_it_changed_something -- all {checked} consequential "
          f"writes check what they actually changed")


if __name__ == "__main__":
    main()
