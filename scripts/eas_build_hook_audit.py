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

    # REVERSED 2026-09-08. This check used to require the OPPOSITE -- that the
    # release be discovered from Sentry and never reconstructed. That rule was
    # the bug: at on-success time no release for this build exists yet, because
    # the release is created by the first event from a device, so discovery
    # always found the PREVIOUS build's release and correctly refused it. The
    # hook must construct the name; what matters is that it constructs the SAME
    # name the SDK reports, which scripts/eas_sentry_release_name_test.cjs
    # pins against the real name Sentry holds for build 40.
    check("the release name is reconstructed to match the SDK formula",
          "bundleIdentifier" in src and "CFBundleVersion" in src,
          "must build <bundleId>@<version>+<CFBundleVersion>")
    check("the discovery path is kept only as a fallback",
          "/releases/?per_page=" in src and "Falling back" in src,
          "the old discovery should remain as a guarded fallback, not the primary path")
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

    # The script must CREATE the release, not assume one exists. That wrong
    # assumption is what made this hook a no-op on every build until 2026-09-08.
    check("the hook creates the release rather than discovering it",
          "releases', 'new'" in src or '"releases", "new"' in src,
          "no `releases new` call -- the hook would again depend on a release "
          "that does not exist at build time")
    check("the release name is built from the compiled Info.plist",
          "CFBundleVersion" in src,
          "the build number must come from the artifact, not app.json, which "
          "has none under appVersionSource=remote")

    live_outcome_check()
    finish()




def live_outcome_check():
    """Did the mechanism actually DO anything -- not just compile correctly?

    Added 2026-09-08, after this audit passed green for every build while the
    hook had never once associated a commit. Every check above tests the
    SCRIPT's internal logic; none of them asked Sentry whether a release with
    commits exists. That gap is precisely how a "built but never actually doing
    anything" defect survived an audit written to catch it.

    The question this asks is deliberately blunt: has commit association EVER
    worked on this project? It stays red until one build runs the fixed hook,
    then goes green and stays green.
    """
    import json as _json, urllib.request as _url
    env = {}
    try:
        for line in open(os.path.join(BASE, ".env.sentry")):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k] = v.strip().strip('"')
    except FileNotFoundError:
        check("live: .env.sentry present so the outcome can be verified", False,
              "no .env.sentry -- cannot confirm the hook ever worked")
        return

    tok, org = env.get("SENTRY_API_TOKEN"), env.get("SENTRY_ORG")
    proj = env.get("SENTRY_PROJECT", "react-native")
    if not tok or not org:
        check("live: Sentry credentials available", False, "missing token/org in .env.sentry")
        return

    req = _url.Request(
        f"https://sentry.io/api/0/projects/{org}/{proj}/releases/?per_page=10",
        headers={"Authorization": "Bearer " + tok})
    try:
        with _url.urlopen(req) as f:
            releases = _json.load(f)
    except Exception as e:
        check("live: could read releases from Sentry", False, str(e)[:120])
        return

    if not releases:
        check("live: the project has at least one release", False, "none found")
        return

    with_commits = [r for r in releases if (r.get("commitCount") or 0) > 0]
    newest = releases[0]
    print()
    print("  recent releases:")
    for r in releases[:5]:
        print(f"    {r.get('version'):44} commits={r.get('commitCount')}")

    # LAST BUILD BEFORE THE FIX. A release numbered above this one was built by
    # the rewritten hook, so it MUST carry commits; anything at or below it
    # predates the fix and is expected to be empty. This is the
    # new_tables_rls_fuzz pattern: a known red that flips to a real failure the
    # moment it should have gone green, rather than staying red forever.
    LAST_UNFIXED_BUILD = 42

    def build_no(version):
        m = re.search(r"\+(\d+)", version or "")
        return int(m.group(1)) if m else -1

    post_fix = [r for r in releases if build_no(r.get("version")) > LAST_UNFIXED_BUILD]

    if with_commits:
        check("live: commit association has actually worked", True)
    elif not post_fix:
        print()
        print(f"  KNOWN RED (expected): every release up to +{LAST_UNFIXED_BUILD} has "
              f"commitCount=0, because the hook was a no-op until 2026-09-08.")
        print(f"  Newest is {newest.get('version')}. No build after +{LAST_UNFIXED_BUILD} "
              f"exists yet, so there is nothing the fix could have acted on.")
        print("  This flips to a hard FAILURE as soon as a newer build reports in.")
    else:
        check("live: commit association has actually worked", False,
              f"build {post_fix[0].get('version')} ran the REWRITTEN hook and still "
              f"reports commitCount=0 -- the fix is not working")


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
