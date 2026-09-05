#!/usr/bin/env python3
"""Whole-app static sweep for the defect CLASSES this codebase keeps repeating.

RC, 2026-09-05: "there have been too many issues w you saying something is
'fixed' when it isn't. i need you to scour everything."

This is deliberately NOT a re-run of the existing audits. Each section below
is a class of bug that has actually shipped in this app at least once, written
so it finds every instance rather than the one that was reported:

  1. .catch() on a supabase call -- those APIs RESOLVE {data, error}; a
     .catch() there catches nothing and reads as if it does. Found live in
     aircraftImage.ts on 2026-09-05.
  2. A promise-returning call used as a statement with no await and no .catch
     -- an unhandled rejection, and on RN it is invisible.
  3. `?? true` / `?? []` / `?? 0` applied to a value read from the network,
     where "we could not read it" becomes a confident answer. This is the
     shape behind BOTH the getStatsVisible bug (2026-09-05) and the
     shared-folder deletion bug (2026-09-04).
  4. Alert.alert -- a silent no-op on react-native-web, so any dialog written
     that way is untestable in the preview and invisible in it.
  5. Exported lib functions with no call site anywhere -- built and never
     wired, the "AD compliance single entry point" class.
  6. router.push/replace targets that do not correspond to a real route file.
  7. Screens with a network load and no visible error state.

Exit 1 if any HARD finding exists. Softer observations print as INFO with a
count so they stay visible without failing the run.

Usage: python3 scripts/sweep_static_defects.py
"""
import os
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"
APP = SRC / "app"

HARD: list[str] = []
INFO: list[str] = []


def files(root: pathlib.Path):
    for p in sorted(root.rglob("*.ts")) + sorted(root.rglob("*.tsx")):
        yield p


def rel(p: pathlib.Path) -> str:
    return str(p.relative_to(BASE))


def strip_comments(text: str) -> str:
    """Blank out // and /* */ comments so a pattern DESCRIBED in a comment is
    never reported as a pattern USED in code. Every finding below is about
    real code; this app's comments quote the bugs they fixed verbatim, so
    without this the sweep is mostly false positives quoting itself."""
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
            if c == "\\":
                if i + 1 < n:
                    out.append(text[i + 1])
                    i += 2
                    continue
            elif c == quote:
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


# ---------------------------------------------------------------- 1
def check_catch_on_resolving_api(src_map):
    print("=== 1. .catch() on a supabase call (those APIs RESOLVE) ===")
    # A .catch() whose receiver chain started at `supabase.` on the same
    # logical statement. Storage and PostgREST builders both resolve.
    # PRECISION MATTERS MORE THAN REACH HERE.
    #
    # The first version of this check matched any `.catch(` within 400
    # characters of the word `supabase` and reported NINE findings, of which
    # SIX were false: a properly-bound `const { data, error } = await
    # supabase...` followed a few lines later by an unrelated
    # `AsyncStorage.setItem(...).catch(...)`, or a local async helper's own
    # `.catch()`. An audit that cries wolf six times out of nine gets ignored,
    # and the three real ones (avatar.ts x2, aircraftImage.ts) go with it.
    #
    # So: the chain must START at `supabase.` and reach `.catch(` without
    # passing a `;`, a blank line, another identifier's `(`-call, or a
    # `.then(` (which returns a genuinely rejectable promise).
    hits = []
    chain = re.compile(
        r"supabase\s*(?:\.\w+\([^()]*\)|\.\w+|\s)*?\.catch\(", re.S)
    for path, code in src_map.items():
        for m in chain.finditer(code):
            frag = m.group(0)
            if ";" in frag or "\n\n" in frag or ".then(" in frag:
                continue
            # Anything of the form `name(` that is not a supabase builder step
            # means the .catch belongs to a different call.
            inner = frag[len("supabase"):-len(".catch(")]
            if re.search(r"\b(?!from|rpc|select|insert|update|upsert|delete|eq|in|is|storage|auth|functions|remove|upload|order|limit|single|maybeSingle|neq|gt|gte|lt|lte|like|ilike|not|or|filter|range|match|contains|overlaps|textSearch|throwOnError|abortSignal|csv|geojson|explain|returns|setHeader|invoke|getUser|getSession|updateUser|signOut|refreshSession|createSignedUrl|getPublicUrl|list|download|copy|move)\w+\(", inner):
                continue
            line = code[: m.start()].count("\n") + 1
            hits.append(f"{rel(path)}:{line}")
    if hits:
        for h in hits:
            print(f"  FAIL  {h}")
            HARD.append(f"catch-on-resolving-supabase-call {h}")
    else:
        print("  PASS  no .catch() attached directly to a supabase builder")
    print()


# ---------------------------------------------------------------- 2
def check_floating_promises(src_map):
    print("=== 2. promise used as a bare statement (unhandled rejection) ===")
    # Statement-position call to a known-async local helper, with no await,
    # no void, no .then/.catch, and not assigned.
    async_names = set()
    for path, code in src_map.items():
        async_names.update(re.findall(r"export async function (\w+)", code))
        async_names.update(re.findall(r"const (\w+)\s*=\s*async\b", code))
    hits = []
    for path, code in src_map.items():
        for i, raw in enumerate(code.split("\n"), start=1):
            line = raw.strip()
            m = re.match(r"^(\w+)\(", line)
            if not m:
                continue
            name = m.group(1)
            if name not in async_names:
                continue
            if line.startswith(("await ", "void ", "return ")):
                continue
            if ".then(" in line or ".catch(" in line:
                continue
            if not line.endswith((")", ");")):
                continue
            hits.append(f"{rel(path)}:{i}  {line[:90]}")
    if hits:
        print(f"  INFO  {len(hits)} bare async call(s) -- each is an unhandled")
        print("        rejection if it ever rejects. Listed, not failed: many are")
        print("        deliberately fire-and-forget with their own internal catch.")
        for h in hits[:25]:
            print(f"          {h}")
        INFO.append(f"{len(hits)} floating promise statements")
    else:
        print("  PASS  none")
    print()


# ---------------------------------------------------------------- 3
def check_fabricated_defaults(src_map):
    print("=== 3. a failed read defaulting to a confident answer ===")
    # `?? true|false|0|[]` on the SAME line as, or within 3 lines of, a
    # supabase read whose `error` was not bound.
    hits = []
    for path, code in src_map.items():
        lines = code.split("\n")
        for i, line in enumerate(lines):
            if "await supabase" not in line and "supabase" not in line:
                continue
            if "const { data" not in line:
                continue
            if "error" in line:
                continue  # error IS bound -- the caller can tell
            window = "\n".join(lines[i : i + 6])
            m = re.search(r"\?\?\s*(true|false|0|\[\]|\{\})", window)
            if not m:
                continue
            # SEVERITY DEPENDS ENTIRELY ON WHAT THE DEFAULT FEEDS.
            #
            # All 11 sites this found on 2026-09-05 were read one by one. Every
            # one renders a list or a label: a failed read shows an empty
            # section, which is degraded but recoverable on the next load. NONE
            # of them drives a delete -- the destructive path (folder/[id].tsx's
            # self-heal) is guarded twice over, by sharedFolders.mustRows (which
            # THROWS instead of returning []) and by the resolvedCount === 0
            # refusal added on 2026-09-04. Both were re-verified in this sweep.
            #
            # So this is an INFO list, not a failure -- failing on it would
            # duplicate audit_unchecked_supabase_errors.py, which already fails
            # the build for exactly the destructive-adjacent case, and would
            # make a green run impossible for a trade-off the app makes on
            # purpose in 11 places.
            nearby = "\n".join(lines[max(0, i - 4) : i + 20])
            destructive = any(k in nearby for k in (
                ".delete(", "deleted: true", "removeMany", "removeManyFromFolder", "selfHeal("))
            entry = f"{rel(path)}:{i+1}  defaults to {m.group(1)} after an unchecked read"
            hits.append((entry, destructive))
    dangerous = [h for h, d in hits if d]
    benign = [h for h, d in hits if not d]
    if dangerous:
        for h in dangerous:
            print(f"  FAIL  {h}  <-- feeds a DESTRUCTIVE action")
            HARD.append(f"fabricated-default-before-delete {h}")
    else:
        print("  PASS  no fabricated default feeds a delete")
    if benign:
        print(f"  INFO  {len(benign)} display-only site(s) where a failed read renders as empty:")
        for h in benign:
            print(f"          {h}")
        INFO.append(f"{len(benign)} display-only fabricated defaults")
    print()


# ---------------------------------------------------------------- 4
def check_alert_alert(src_map):
    print("=== 4. Alert.alert (a silent no-op on react-native-web) ===")
    hits = []
    for path, code in src_map.items():
        for m in re.finditer(r"\bAlert\.alert\s*\(", code):
            hits.append(f"{rel(path)}:{code[: m.start()].count(chr(10)) + 1}")
    if hits:
        for h in hits:
            print(f"  FAIL  {h}")
            HARD.append(f"Alert.alert {h}")
    else:
        print("  PASS  none -- everything routes through useConfirm")
    print()


# ---------------------------------------------------------------- 5
def check_unused_lib_exports(src_map):
    print("=== 5. exported lib functions nothing calls (built, never wired) ===")
    all_code = "\n".join(src_map.values())
    hits = []
    for path, code in src_map.items():
        if "/lib/" not in rel(path):
            continue
        for m in re.finditer(r"export (?:async )?function (\w+)", code):
            name = m.group(1)
            uses = len(re.findall(r"\b%s\b" % re.escape(name), all_code))
            if uses <= 1:  # only its own declaration
                hits.append(f"{rel(path)}  {name}()")
    if hits:
        print(f"  INFO  {len(hits)} exported function(s) with no caller:")
        for h in hits:
            print(f"          {h}")
        INFO.append(f"{len(hits)} uncalled lib exports")
    else:
        print("  PASS  every exported lib function has at least one caller")
    print()


# ---------------------------------------------------------------- 6
def check_routes(src_map):
    print("=== 6. router.push/replace targets that have no route file ===")
    routes = set()
    for p in APP.rglob("*.tsx"):
        r = str(p.relative_to(APP)).removesuffix(".tsx")
        r = r.removesuffix("/index") if r.endswith("/index") else r
        if r == "index":
            r = ""
        routes.add("/" + r)
    # (tabs) and other groups are transparent in the URL
    expanded = set(routes)
    for r in routes:
        expanded.add(re.sub(r"/\([^)]+\)", "", r) or "/")
    hits = []
    for path, code in src_map.items():
        # `[^$]` used to cut a template literal at its first ${...}, so
        # `/folder/${id}` was reported as the target `/folder` -- 13 phantom
        # findings, every one of them a working route. Capture the whole
        # literal and turn each interpolation into a wildcard segment instead.
        for m in re.finditer(r"router\.(?:push|replace)\(\s*[`'\"]([^`'\"]+)", code):
            target = m.group(1).split("?")[0].rstrip("/")
            if not target.startswith("/"):
                continue
            if "${" in target:
                target = re.sub(r"\$\{[^}]*\}", "X", target)
            # Reduce a concrete path to its route shape: /far/61.3 -> /far/[id]
            candidates = {target}
            parts = target.split("/")
            for i in range(1, len(parts)):
                shape = "/".join(parts[:i] + ["[" + "x" + "]"])
                candidates.add(shape)
            ok = False
            for route in expanded:
                rx = "^" + re.sub(r"\[[^\]]+\]", r"[^/]+", re.escape(route).replace(r"\[", "[").replace(r"\]", "]")) + "$"
                rx = re.sub(r"\\\[[^\]]*\\\]", "[^/]+", rx)
                if re.match(rx.replace("\\[", "[").replace("\\]", "]"), target):
                    ok = True
                    break
                if route == target:
                    ok = True
                    break
            if not ok:
                line = code[: m.start()].count("\n") + 1
                hits.append(f"{rel(path)}:{line}  ->  {target}")
    if hits:
        print(f"  INFO  {len(hits)} navigation target(s) this matcher could not")
        print("        resolve to a route file. Dynamic segments make this")
        print("        approximate -- each is listed for eyeball, not failed.")
        for h in hits[:30]:
            print(f"          {h}")
        INFO.append(f"{len(hits)} unresolved nav targets")
    else:
        print("  PASS  every literal navigation target maps to a route")
    print()


# ---------------------------------------------------------------- 7
def check_error_states(src_map):
    print("=== 7. screens that load from the network with no error state ===")
    hits = []
    for path, code in src_map.items():
        r = rel(path)
        if "/app/" not in r or r.endswith("_layout.tsx"):
            continue
        loads = "supabase" in code or "await get" in code
        if not loads:
            continue
        has_err = any(k in code for k in ("loadError", "setError", "Try Again", "Couldn't load", "could not load", "Retry"))
        if not has_err:
            hits.append(r)
    if hits:
        print(f"  INFO  {len(hits)} screen(s) with a network load and no visible")
        print("        error/retry affordance -- a failure renders as 'empty':")
        for h in hits:
            print(f"          {h}")
        INFO.append(f"{len(hits)} screens without an error state")
    else:
        print("  PASS  every loading screen can report a failure")
    print()


def main():
    src_map = {}
    for p in files(SRC):
        src_map[p] = strip_comments(p.read_text())

    print(f"Scanned {len(src_map)} source files under src/\n")
    check_catch_on_resolving_api(src_map)
    check_floating_promises(src_map)
    check_fabricated_defaults(src_map)
    check_alert_alert(src_map)
    check_unused_lib_exports(src_map)
    check_routes(src_map)
    check_error_states(src_map)

    print("=" * 60)
    if HARD:
        print(f"{len(HARD)} HARD finding(s):")
        for h in HARD:
            print("  -", h)
        sys.exit(1)
    print("No hard findings.")
    if INFO:
        print("Observations to read (not failures):")
        for i in INFO:
            print("  -", i)


if __name__ == "__main__":
    main()
