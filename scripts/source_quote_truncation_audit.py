#!/usr/bin/env python3
"""Does any live study card quote the regulation mid-word?

`source_quote` is shown verbatim to Pro users underneath the answer. A quote that
starts or ends in the middle of a word ("...cause premature dis") reads as a bug
even though it is a perfectly valid substring of the reg text -- which is exactly
why the grounding check in insert_authored_questions.py never caught it: that
check only asks whether the quote APPEARS in body_text, not whether it appears
at word boundaries.

Found 2026-09-09, after several authored rows were built from `body_text[:900]`
dumps that had themselves been cut mid-sentence.

Exit 0 = clean, 1 = truncated quotes found.
"""
import re
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from access_matrix_sweep import mgmt  # noqa: E402

# corpus -> (table, id column, text column)
SOURCES = {
    "far":   ("far_sections",        "section_number",   "body_text"),
    "aim":   ("aim_paragraphs",      "paragraph_number", "body_text"),
    "cfr49": ("cfr49_sections",      "section_number",   "body_text"),
    "ac":    ("advisory_circulars",  "document_number",  "pdf_text"),
}

LETTER = re.compile(r"[A-Za-z]")
DIGIT = re.compile(r"[0-9]")


def cuts_a_word(a, b):
    """True only when `a` and `b` are the same character class -- a real
    mid-word cut. A letter beside a digit is a scraper footnote marker
    ("reasonable time1"), and expanding into it makes the quote worse."""
    return bool((LETTER.match(a) and LETTER.match(b))
                or (DIGIT.match(a) and DIGIT.match(b)))


def norm(s):
    """Same normalisation the insert gate uses, so we match the way it matched."""
    s = (s.replace("—", "-").replace("’", "'")
          .replace("“", '"').replace("”", '"'))
    return re.sub(r"\s+", " ", s).strip()


def main():
    rows = mgmt("""
        select id, item_type, item_id, source_quote
        from study_facts
        where status = 'live'
          and source_quote is not null
          and length(trim(source_quote)) > 0
        order by item_type, item_id
    """)
    print(f"Checking {len(rows)} live source_quote(s) for mid-word truncation.\n")

    by_type = {}
    for r in rows:
        by_type.setdefault(r["item_type"], []).append(r)

    bad = []
    unmatched = 0
    for item_type, group in sorted(by_type.items()):
        if item_type not in SOURCES:
            continue
        tbl, idcol, txtcol = SOURCES[item_type]
        ids = sorted({r["item_id"] for r in group})
        texts = {}
        # chunk the IN list so a single query never gets absurd
        for i in range(0, len(ids), 400):
            chunk = ids[i:i + 400]
            q = ",".join("'%s'" % x.replace("'", "''") for x in chunk)
            for row in mgmt(f"select {idcol} as k, {txtcol} as t from {tbl} where {idcol} in ({q})"):
                texts[row["k"]] = row["t"] or ""

        for r in group:
            body = norm(texts.get(r["item_id"], ""))
            quote = norm(r["source_quote"])
            if not body or not quote:
                continue
            pos = body.find(quote)
            if pos < 0:
                unmatched += 1
                continue
            before = body[pos - 1] if pos > 0 else " "
            after_i = pos + len(quote)
            after = body[after_i] if after_i < len(body) else " "
            head_cut = cuts_a_word(before, quote[0])
            tail_cut = cuts_a_word(quote[-1], after)
            if head_cut or tail_cut:
                where = []
                if head_cut:
                    where.append("start")
                if tail_cut:
                    where.append("end")
                bad.append((r, "/".join(where), body, pos))

    for r, where, body, pos in bad:
        q = norm(r["source_quote"])
        tail = body[pos + len(q):pos + len(q) + 40]
        print(f"  TRUNCATED ({where})  {r['item_type']} {r['item_id']}  id={r['id']}")
        print(f"      quote: ...{q[-60:]!r}")
        print(f"      continues: {tail!r}\n")

    if unmatched:
        print(f"note: {unmatched} quote(s) could not be located in their source text "
              f"(stale reg text -- stale_question_sweep covers that separately)\n")

    if bad:
        print(f"FAIL  {len(bad)} source_quote(s) cut a word in half")
        return 1
    print("PASS  every source_quote begins and ends on a word boundary")
    return 0


if __name__ == "__main__":
    sys.exit(main())
