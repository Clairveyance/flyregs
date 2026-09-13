#!/usr/bin/env python3
"""A .web.ts shim must export everything its native sibling exports.

WHY THIS EXISTS
Metro resolves `@/lib/foo` to `foo.web.ts` on web and `foo.ts` everywhere else.
TypeScript does not: `tsc` only ever follows the native file. So an export added
to the native module and forgotten in the web shim is invisible to the
typechecker, to every editor, and to CI -- and becomes `undefined is not a
function`, or worse a silently undefined property, only in the web build.

This has bitten twice in this repo:

  * `getSubscriptionStatus` gained an `ok` flag on 2026-09-01 so a RevenueCat
    outage could not read as a downgrade. The web shim was not updated, so
    `status.ok` was `undefined`, all three guards in auth.tsx failed, and the
    ENTIRE web build read as Free with the ?tier= override doing nothing. The
    shim's own comment records it: "tsc cannot catch this."
  * `getEntitlementGrace` was added on 2026-09-12 for the same file. It would
    have been the second instance; this audit was written alongside it.

WHAT THIS CHECKS
For every `<name>.web.ts(x)` next to a `<name>.ts(x)`: every top-level exported
binding in the native file has a same-named export in the shim. Names only --
signatures are deliberately out of scope, since a shim's whole job is to have a
different body, and its return shape is often a narrower literal type.

KNOWN LIMIT, stated rather than papered over: a shim CAN export the right name
with the wrong shape (a function returning an object missing a field, which is
exactly what the `ok` bug was once the name existed). This catches the missing
name, not the missing field. Shape parity would need type-level comparison
across two module resolutions, which tsc will not do; the mitigation is the
convention that a shim returns a whole literal of the native type.
"""
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "src"

# RUNTIME exports only. `type` and `interface` are erased before Metro ever
# sees the file, and a consumer's `import type { X }` is resolved by tsc against
# the NATIVE module regardless of platform -- so a shim that omits a type
# cannot break anything, and flagging it is noise that buries the real finding.
# (First draft did flag them, and reported 10 gaps where 4 were real.)
EXPORT = re.compile(
    r"^export\s+(?:declare\s+)?(?:default\s+)?"
    r"(?:async\s+)?(?:function|const|let|var|class|enum)\s+"
    r"([A-Za-z_$][\w$]*)",
    re.M,
)
# `export { a, b as c }`
EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)


def exported_names(text: str) -> set:
    names = set(EXPORT.findall(text))
    for block in EXPORT_LIST.findall(text):
        for part in block.split(","):
            part = part.strip()
            if not part:
                continue
            # `a as b` exports b
            names.add(part.split(" as ")[-1].strip())
    return names


def main():
    failures, checked = [], 0
    for shim in sorted(SRC.rglob("*.web.ts")) + sorted(SRC.rglob("*.web.tsx")):
        stem = shim.name.replace(".web.", ".")
        native = shim.with_name(stem)
        if not native.exists():
            # A .web-only module with no native sibling is legitimate.
            continue
        checked += 1
        native_names = exported_names(native.read_text())
        shim_names = exported_names(shim.read_text())
        missing = sorted(native_names - shim_names)
        if missing:
            failures.append(
                f"{shim.relative_to(BASE)} is missing {len(missing)} export(s) its "
                f"native sibling has: {', '.join(missing)}"
            )

    if failures:
        print("FAIL web_shim_parity_audit")
        for f in failures:
            print("  - " + f)
        print("\n  Metro serves the .web file on web; tsc only ever reads the native")
        print("  one, so this gap cannot fail the typecheck -- only the web build.")
        return 1
    print(f"PASS web_shim_parity_audit -- all {checked} web shim(s) export every name "
          f"their native sibling does")
    return 0


if __name__ == "__main__":
    sys.exit(main())
