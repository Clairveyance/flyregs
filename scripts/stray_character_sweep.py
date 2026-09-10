#!/usr/bin/env python3
"""Does any live study card contain a character the reader will see as broken?

2026-09-09: a stray CJK character ("每") that I typed by accident reached the
live bank inside a 65.47 distractor. Nothing in the authoring gate looked at
the characters themselves -- only at the numbers, the phrasing and the
duplicates -- so it sailed through and would have rendered as mojibake on
RC's phone. Sweeping the whole live corpus then turned up 12 more rows,
including genuine UTF-8-read-as-Latin-1 damage ("â€œ") and invisible
zero-width and soft-hyphen artifacts that silently break word matching.

Both halves are now fixed, and this is the half that keeps them fixed:
`insert_authored_questions.py` refuses a new card with a visible stray
character and strips invisible ones on the way in; this audit re-checks the
whole live bank every run, so a row that arrives by some other path -- a
generated batch, a scraper, a direct SQL write -- is still caught.

Exit 0 when clean, 1 when anything is flagged.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt
from insert_authored_questions import stray_chars

FIELDS = ("question", "answer", "explanation", "source_quote")


def main():
    rows = mgmt(
        "select id, item_type, item_id, origin, question, answer, "
        "explanation, source_quote, distractors "
        "from study_facts where status='live'"
    )
    hits = []
    for r in rows:
        bad = stray_chars(*[r[f] for f in FIELDS], *(r["distractors"] or []))
        if bad:
            hits.append((r, bad))

    print(f"Scanned {len(rows):,} live study cards for characters that render as broken text.")
    if not hits:
        print("\nNo stray characters. Every live card is readable on a phone.")
        return 0

    print(f"\n{len(hits)} card(s) carry characters that are not regulation text:\n")
    for r, bad in hits[:40]:
        shown = "".join(bad)
        print(f"  {r['origin']:<10} {r['item_type']:<11} {r['item_id']:<28} {shown!r}")
    if len(hits) > 40:
        print(f"  ... and {len(hits) - 40} more")
    print("\nThese are typos, paste artifacts or encoding damage -- not content.")
    print("Fix the rows, then re-run. Authoring is already guarded; a hit here")
    print("means a row arrived by some other path.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
