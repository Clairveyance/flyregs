#!/usr/bin/env python3
"""A number the user is shown must be able to change.

`get_mastery_leaderboard` and the study-progress read both return `pct`, which
is mastered / total_available -- and total_available is the ENTIRE study corpus.
Measured 2026-09-18: 12,888 items, so a member must master 65 things before that
rounds off zero. Every surface driven by it was frozen:

  * the Ready Room Mastery board showed "0%" on every row, ranked invisibly;
  * The Wing's profile chip and another member's profile both showed "0%";
  * and worst, the Study Mode gauge -- RC's own spec is quoted in study.tsx,
    "this ring should be a 'duller' color to begin with, and 'grow' gold (and
    maybe even shimmer) as you increase your total % of mastery". The ring lerps
    on pct/100 and the shimmer is GATED on pct > 0, so the ring never grew, the
    shimmer never fired once, and the gauge read 0 for every user who has ever
    used the app.

The fix splits the number by what it is for: RETENTION (mastered / reviewed) on
your own gauge, because a gauge is meant to fill and that moves on the first
card; the mastered COUNT everywhere people are compared, because retention
rewards studying little and well and would rank 1-of-2 above 500-of-2000.

This audit fails if the corpus percentage comes back to any user-facing surface.

Usage: python3 scripts/mastery_number_is_reachable_audit.py
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAILURES = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(f"{label} :: {detail}")


def main():
    hits = []
    for f in list((ROOT / "src").glob("**/*.tsx")) + list((ROOT / "src").glob("**/*.ts")):
        for i, line in enumerate(f.read_text().splitlines(), 1):
            if line.lstrip().startswith(("//", "*", "/*")):
                continue
            # A mastery pct rendered, or used to drive a visual.
            if re.search(r"mastery[!?]?\.pct|mastery\?\.pct", line):
                hits.append(f"{f.relative_to(ROOT)}:{i}  {line.strip()[:70]}")
    check("no surface renders or animates on the corpus mastery percentage",
          not hits, "; ".join(hits[:4]))

    study = (ROOT / "src/lib/study.ts").read_text()
    check("the retention helper exists and is documented",
          "export function masteryRetentionPct" in study)

    sx = (ROOT / "src/app/study.tsx").read_text()
    check("the gauge number uses retention", "masteryRetentionPct(mastery)}" in sx)
    check("the ring colour grows on retention",
          re.search(r"lerpColor\(MASTERY_RING_DULL, tokens\.gold, masteryRetentionPct", sx) is not None)
    check("the shimmer is gated on retention, not the corpus pct",
          re.search(r"masteryRetentionPct\(mastery\) <= 0", sx) is not None)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED:")
        for f in FAILURES:
            print("  - " + f)
        sys.exit(1)
    print("mastery_number_is_reachable -- every mastery number shown can actually move")


if __name__ == "__main__":
    main()
