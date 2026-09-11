#!/usr/bin/env python3
"""No result row may print its type or its identifier twice.

WHY THIS EXISTS
RC, real device, B42, via the in-app bug report (2026-09-10): a screenshot of
an Ask FlyRegs result reading "AC AC 68-1A", with "Let's make sure this isn't
happening in other places in the app."

Two separate composition bugs produce that shape, and the code had already
been patched for it TWICE before, both times only where it was seen:
  * the type name twice -- a badge prints REG_TYPE.label, and the identifier
    beside it is formatted "AC 68-1A"/"AD 2005-05-53", already starting with
    that label. P/CG and LOI hit this first ("P/CG P/CG", "LOI LOI") and were
    fixed in place by returning null for those two types only.
  * the identifier twice -- all 4,188 FAR chunk titles begin with their own
    section number, so "FAR § 67.307" above "§ 67.307 Mental." prints it
    twice. Visible in RC's own screenshot, just less obvious than the AC one.

HOW THIS CHECKS IT -- the part that matters
It does NOT reimplement the rule in Python. A second copy of the logic drifts
from the first and then agrees with itself while the app is wrong. Instead it
transpiles the REAL src/lib/regTypes.ts with the repo's own TypeScript and
calls the REAL composeRegBadge / regIdentifierLabel / dropLeadingIdentifier
over REAL (source_type, source_id, title) rows from content_chunks -- the same
rows Ask FlyRegs renders. What it asserts is what a user would see:

  1. the composed badge never contains the type label twice;
  2. the composed title never still begins with the identifier the badge is
     already showing;
  3. no row renders an empty badge.

KNOWN LIMIT, stated rather than papered over: it checks the composition module,
not every screen's JSX. A screen that ignores these helpers and concatenates by
hand is not caught here -- that is what keeping the rule in one exported module
is for, and why the helpers live in regTypes.ts next to `label` itself rather
than in the screen that happened to need them first.
"""
import json
import os
import pathlib
import subprocess
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent


def mgmt(sql):
    """Same shape every other audit in this directory uses."""
    r = subprocess.run(
        ["python3", str(BASE / "scripts" / "supabase_mgmt_api.py"), "query", sql],
        capture_output=True, text=True, cwd=str(BASE),
    )
    out = r.stdout.strip()
    if not out.startswith("["):
        raise RuntimeError(out or r.stderr)
    return json.loads(out)

SAMPLE_SQL = """
select source_type, source_id, title
from (
  select distinct on (source_type, source_id) source_type, source_id, title
  from content_chunks
  order by source_type, source_id
) t
"""

RUNNER = r"""
const fs = require('fs')
const path = require('path')
const ts = require(path.join(process.argv[2], 'node_modules', 'typescript'))

// Transpile the REAL module, so this exercises shipped code, not a copy.
const srcPath = path.join(process.argv[2], 'src', 'lib', 'regTypes.ts')
const js = ts.transpileModule(fs.readFileSync(srcPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText

const mod = { exports: {} }
new Function('module', 'exports', js)(mod, mod.exports)
const { REG_TYPE, regIdentifierLabel, composeRegBadge, composeRegTitle } = mod.exports

const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const out = []
for (const r of rows) {
  if (!REG_TYPE[r.source_type]) continue  // a type the app does not badge
  const label = REG_TYPE[r.source_type].label
  const ident = regIdentifierLabel(r.source_type, r.source_id)
  const badge = composeRegBadge(r.source_type, ident)
  const title = composeRegTitle(r.title, ident)
  out.push({ type: r.source_type, id: r.source_id, label, ident, badge, title })
}
process.stdout.write(JSON.stringify(out))
"""


def main():
    rows = mgmt(SAMPLE_SQL)
    tmp = BASE / "build" / "_reg_badge_rows.json"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text(json.dumps(rows))
    runner = BASE / "build" / "_reg_badge_runner.js"
    runner.write_text(RUNNER)
    try:
        proc = subprocess.run(
            ["node", str(runner), str(BASE), str(tmp)],
            capture_output=True, text=True, timeout=180,
        )
    finally:
        for f in (tmp, runner):
            try:
                os.unlink(f)
            except OSError:
                pass
    if proc.returncode != 0:
        print("FAIL: could not run the real composition functions")
        print(proc.stderr.strip()[:2000])
        sys.exit(1)

    composed = json.loads(proc.stdout)
    dup_type, dup_ident, empty = [], [], []
    for c in composed:
        low_badge = c["badge"].lower()
        low_label = c["label"].lower()
        # "AC AC 68-1A" -- the label appears twice in the badge.
        if low_badge.count(low_label) > 1:
            dup_type.append(c)
        # "FAR § 67.307" over "§ 67.307 Mental." -- number in both lines.
        if c["ident"] and c["title"].lower().startswith(c["ident"].lower()):
            dup_ident.append(c)
        # An empty title is legitimate now -- the card renders no title
        # line, and the snippet carries the content. An empty BADGE is not:
        # the row would have no identity at all.
        if not c["badge"].strip():
            empty.append(c)

    by_type = {}
    for c in composed:
        by_type.setdefault(c["type"], 0)
        by_type[c["type"]] += 1

    print("=== composed result rows (real functions, real corpus) ===")
    print(f"  {len(composed)} documents across {len(by_type)} badged types")
    for t in sorted(by_type):
        ex = next(c for c in composed if c["type"] == t)
        print(f"    {t:<10} {by_type[t]:>5}   e.g. [{ex['badge']}] {ex['title'][:48]}")
    print()

    bad = False
    for name, items, why in (
        ("type name printed twice", dup_type, 'e.g. "AC AC 68-1A"'),
        ("identifier printed twice", dup_ident, "badge and title both lead with it"),
        ("empty badge", empty, "a row would have no identity"),
    ):
        if items:
            bad = True
            print(f"FAIL: {len(items)} row(s) -- {name} ({why})")
            for c in items[:8]:
                print(f"  {c['type']} {c['id']}:  [{c['badge']}]  {c['title'][:60]}")
            if len(items) > 8:
                print(f"  ... and {len(items) - 8} more")
            print()

    if bad:
        print("  Fix in src/lib/regTypes.ts -- composeRegBadge / dropLeadingIdentifier.")
        print("  Do NOT special-case the one type that showed the symptom; that is")
        print("  how this shipped three times (P/CG, LOI, then AC).")
        sys.exit(1)

    print("Every result row prints its type once and its identifier once.")
    sys.exit(0)


if __name__ == "__main__":
    main()
