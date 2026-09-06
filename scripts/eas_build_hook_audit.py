#!/usr/bin/env python3
"""The Sentry commit-association hook is wired, and cannot fail a build.

RC, 2026-09-06: "wire it into the build."

Sentry only auto-resolves `Fixes REACT-NATIVE-x` when it knows which commits
belong to the release. Every release in this project reported commitCount 0,
which is why two commits carrying exactly that line resolved nothing. The hook
fixes that on every build -- but a hook that runs AFTER a successful compile
must never be able to turn that build into a failure, and a hook that is
silently unwired is worse than none at all. Both are checked here.

Usage: python3 scripts/eas_build_hook_audit.py
"""
import json
import os
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def strip_js_comments(text: str) -> str:
    """Comments out, code only.

    The first run of this audit failed on "looks like it builds the release
    string itself" -- because the word `buildNumber` appears in the script's
    own COMMENT explaining why it does not build the release string. An audit
    that reads a comment as the code it warns about is the same false-positive
    class this project has hit five times now.
    """
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


def check(label, cond, detail=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    pkg = json.loads((BASE / "package.json").read_text())
    scripts = pkg.get("scripts", {})
    hook = scripts.get("eas-build-on-success", "")
    check("package.json declares an eas-build-on-success hook", bool(hook), str(scripts.keys()))
    check("the hook points at the set-commits script",
          "eas-sentry-set-commits" in hook, hook)

    src_path = BASE / "scripts" / "eas-sentry-set-commits.js"
    check("the script it points at exists", src_path.exists(), str(src_path))
    if not src_path.exists():
        finish()
        return
    src = strip_js_comments(src_path.read_text())

    # It must be incapable of failing a build.
    check("it always exits 0 (cannot fail a build)",
          "process.exit(0)" in src and "process.exit(1)" not in src,
          "found a non-zero exit")
    check("the sentry-cli call is wrapped in try/catch",
          re.search(r"try\s*\{[^}]*execFileSync", src, re.S) is not None)
    check("main() has a .catch so a rejection cannot escape",
          ".catch(" in src and ".finally(" in src)

    # It must not guess the release name.
    check("the release comes FROM Sentry, not reconstructed from app.json",
          "/releases/?per_page=" in src and "buildNumber" not in src,
          "looks like it builds the release string itself")
    check("a stale release is refused rather than mis-attributed",
          "SENTRY_SET_COMMITS_MAX_AGE_MIN" in src and "maxAgeMin" in src)

    # Both worker shapes are handled.
    check("handles a worker WITH .git (--auto)", "'--auto'" in src)
    check("handles a worker WITHOUT .git (explicit repo@sha)",
          "EAS_BUILD_GIT_COMMIT_HASH" in src and "--commit" in src)

    # It must verify what actually landed, not just that the CLI exited 0.
    check("it re-reads commitCount from Sentry afterwards",
          "commitCount" in src, "no post-hoc verification")

    # The org/project must come from the same place the sourcemap upload uses.
    app = json.loads((BASE / "app.json").read_text())["expo"]
    sentry_plugin = next((p for p in app.get("plugins", [])
                          if isinstance(p, list) and "sentry" in str(p[0])), None)
    check("app.json still declares the Sentry expo plugin with org+project",
          bool(sentry_plugin) and sentry_plugin[1].get("organization") and sentry_plugin[1].get("project"),
          str(sentry_plugin))
    check("the script reads org/project from that plugin config",
          "organization" in src and "plugins" in src)

    finish()


def finish():
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  -", f)
        sys.exit(1)
    print("the commit-association hook is wired and cannot fail a build")


if __name__ == "__main__":
    main()
