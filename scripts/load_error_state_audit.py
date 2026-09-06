#!/usr/bin/env python3
"""Every screen that fetches a document must be able to say "it didn't load".

RC, 2026-09-05: "fix those 29 screens with no error state."

THE ACTUAL BUG, which is worse than "no error state"
All eight document screens rendered the same shape:

    loading ? <spinner> : !doc ? "Section not found." : <the document>

and `doc` stays null whether the row is genuinely absent OR the fetch failed,
because supabase-js resolves {data: null, error} instead of throwing. So a
dead connection told the reader **"Section not found."** -- a confident, false
claim about the corpus, on an app whose whole value is that the corpus is
right. A blank screen would have been more honest.

The fix is one distinction: PostgREST's PGRST116 is the real "no rows";
anything else is a failure to read, and gets a retry instead of a verdict.

WHAT THIS AUDIT CHECKS -- all four pieces, because any three of them compile
and do nothing:
  1. a loadFailed state
  2. it is actually SET from the response's error code
  3. <LoadFailed> is rendered before the not-found branch
  4. reloadKey is in the deps of the effect that sets it, so Try Again retries

Point 4 is not hypothetical: two of these eight (pcg, ac) were wired with the
first three and a dep array that never changed, so the button did nothing.

Usage: python3 scripts/load_error_state_audit.py
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
APP = BASE / "src" / "app"

# Screens that fetch a single document and can therefore say "not found".
DOC_SCREENS = [
    "far/[id].tsx", "aim/[id].tsx", "cfr49/[id].tsx", "pcg/[id].tsx",
    "ad/[id].tsx", "loi/[slug].tsx", "ac/[id].tsx", "dictionary/[slug].tsx",
]

# Screens NOT required to have one, each with the reason on the record so
# "not covered" is a decision rather than an oversight.
EXEMPT = {
    "confirm.tsx": "an auth callback, not a data screen",
    "reset-password.tsx": "a form; failures surface in its own dialog",
    "manage-subscription.tsx": "a form; failures surface in its own dialog",
    "paywall.tsx": "purchase failures surface in the purchase dialog",
    "account.tsx": "a settings form; each write reports its own failure",
    "(tabs)/notes.tsx": "local-first -- notes come from AsyncStorage, not the network",
    "(tabs)/recents.tsx": "local-first -- recents come from AsyncStorage",
    "(tabs)/index.tsx": "a dashboard of independent cards; one failing card is not a failed screen",
    "folder/[id].tsx": "local-first, and already has its own not-found state",
}

# Browse lists: these paint cached data first, then refresh. They must be able
# to say the refresh failed WHEN there is nothing cached to fall back on --
# and, unlike the document screens, they retry by calling their own `load`
# useCallback directly, so there is no reloadKey to check.
LIST_SCREENS = [
    "cfr49/part/[part].tsx", "far/part/[part].tsx", "pcg/index.tsx",
    "pcg/letter/[letter].tsx", "dictionary/index.tsx", "loi/year/[year].tsx",
    "aim/chapter/[chapter].tsx", "dictionary/letter/[letter].tsx",
    "ad/index.tsx", "loi/index.tsx", "ref-packets/[code].tsx",
]

# Screens whose error state is scoped to one SECTION rather than the whole
# screen -- checked by name because the generic "is it wired to load" test
# does not fit a per-section retry.
SECTION_SCREENS = {
    "(tabs)/saved.tsx": ("sharedFailed", "setSharedReloadKey"),
}

FAILURES = []


def check_lists():
    print("\n=== browse lists: can they say the refresh failed? ===")
    for rel in LIST_SCREENS:
        p = APP / rel
        if not p.exists():
            FAILURES.append(f"{rel}: file not found")
            print(f"  FAIL  {rel}: file not found")
            continue
        s = p.read_text()
        missing = []
        if "const [loadFailed" not in s:
            missing.append("loadFailed state")
        # It must be set from something that ACTUALLY FIRES on a failure.
        # A bare try/catch around direct supabase calls does not: supabase-js
        # resolves {data, error} instead of throwing. So either the screen
        # reads the response's own `error`, or it calls a lib helper that is
        # documented to throw -- ref-packets/[code].tsx is the second kind,
        # and demanding the first shape from it would have been the audit
        # forcing working code to match a crude rule.
        reads_error = re.search(r"setLoadFailed\(!!\w+", s) is not None
        throwing_helper = ("setLoadFailed(true)" in s
                           and re.search(r"await (getRefPacket|getRefPackets)\(", s) is not None)
        if not reads_error and not throwing_helper:
            missing.append("never set from anything that fires on failure")
        if "<LoadFailed" not in s:
            missing.append("<LoadFailed> not rendered")
        # The retry must call something that actually re-runs the fetch --
        # either the load callback directly, or a reloadKey the effect depends
        # on. A button wired to neither is the failure this file exists for.
        wired_direct = re.search(r"<LoadFailed[^>]*onRetry=\{(load\w*)\}", s, re.S)
        wired_key = "setReloadKey" in s and re.search(r"reloadKey\]\)", s)
        if not wired_direct and not wired_key:
            missing.append("retry is wired to nothing -- the button is dead")
        if missing:
            FAILURES.append(f"{rel}: {'; '.join(missing)}")
            print(f"  FAIL  {rel}: {'; '.join(missing)}")
        else:
            print(f"  PASS  {rel}")


def main():
    print("=== document screens: all four pieces of a working error state ===")
    for rel in DOC_SCREENS:
        p = APP / rel
        if not p.exists():
            FAILURES.append(f"{rel}: file not found")
            print(f"  FAIL  {rel}: file not found")
            continue
        s = p.read_text()
        has_state = "const [loadFailed" in s
        is_set = re.search(r"setLoadFailed\((?!false\))", s) is not None
        renders = "<LoadFailed" in s
        # the retry must actually re-run the effect that sets loadFailed
        retries = False
        for m in re.finditer(r"setLoadFailed\((?!false\))", s):
            nxt = s.find("\n  }, [", m.end())
            if nxt == -1:
                continue
            deps = s[nxt: s.index("]", nxt)]
            if "reloadKey" in deps:
                retries = True
                break
        missing = []
        if not has_state: missing.append("loadFailed state")
        if not is_set: missing.append("never set from an error")
        if not renders: missing.append("<LoadFailed> not rendered")
        if not retries: missing.append("reloadKey NOT in the deps of the effect that sets it -- Try Again is dead")
        if missing:
            FAILURES.append(f"{rel}: {'; '.join(missing)}")
            print(f"  FAIL  {rel}: {'; '.join(missing)}")
        else:
            print(f"  PASS  {rel}")

    check_lists()

    print("\n=== screens with a per-section error state ===")
    for rel, (flag, retry) in SECTION_SCREENS.items():
        src = (APP / rel).read_text() if (APP / rel).exists() else ""
        missing = [n for n, ok in (
            (f"{flag} state", f"const [{flag}" in src),
            (f"{flag} set on failure", f"set{flag[0].upper()}{flag[1:]}(true)" in src),
            ("<LoadFailed> rendered", "<LoadFailed" in src),
            ("retry re-runs the effect", f"{retry}" in src and re.search(r"ReloadKey\]\)", src) is not None),
        ) if not ok]
        if missing:
            FAILURES.append(f"{rel}: {'; '.join(missing)}")
            print(f"  FAIL  {rel}: {'; '.join(missing)}")
        else:
            print(f"  PASS  {rel}")

    print("\n=== deliberately exempt (recorded, not forgotten) ===")
    for rel, why in EXEMPT.items():
        exists = (APP / rel).exists()
        print(f"  {'PASS' if exists else 'FAIL'}  {rel} -- {why}")
        if not exists:
            FAILURES.append(f"{rel}: exempt entry points at a file that no longer exists")

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("every document screen can report a failed load, and its retry works")


if __name__ == "__main__":
    main()
