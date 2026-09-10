#!/usr/bin/env python3
"""Extend every mid-word `source_quote` out to its word boundaries.

Companion repair for source_quote_truncation_audit.py. A quote like
"...cause premature dis" is a valid substring of the reg text but reads as a
bug to the Pro user who sees it. The fix is purely additive: grow the quote
left and/or right until it starts and ends on a word boundary, taking the
characters verbatim from the live source text so the result is still a literal
substring.

Nothing is shortened and nothing is invented -- if the expansion cannot be
located in the raw source text, the row is left alone and reported.

  python3 repair_truncated_source_quotes.py --dry-run
  python3 repair_truncated_source_quotes.py
"""
import argparse
import json
import re
import sys
import urllib.request

HERE = __file__.rsplit("/", 1)[0]
sys.path.insert(0, HERE)
sys.path.insert(0, HERE + "/../sync")
from access_matrix_sweep import mgmt, http, SERVICE, URL  # noqa: E402

# content_snapshot reads its credentials from the environment; access_matrix_sweep
# already resolved them from the scraper config, so hand them over rather than
# asking RC to hunt for a .env file.
import os  # noqa: E402
os.environ.setdefault("SUPABASE_URL", URL)
os.environ.setdefault("SUPABASE_SERVICE_KEY", SERVICE)

SOURCES = {
    "far":   ("far_sections",       "section_number",   "body_text"),
    "aim":   ("aim_paragraphs",     "paragraph_number", "body_text"),
    "cfr49": ("cfr49_sections",     "section_number",   "body_text"),
    "ac":    ("advisory_circulars", "document_number",  "pdf_text"),
}
LETTER = re.compile(r"[A-Za-z]")
DIGIT = re.compile(r"[0-9]")


def cuts_a_word(a, b):
    """True only when `a` and `b` are the same character class -- a real
    mid-word cut. A letter beside a digit is a scraper footnote marker
    ("reasonable time1"), and expanding into it makes the quote worse."""
    return bool((LETTER.match(a) and LETTER.match(b))
                or (DIGIT.match(a) and DIGIT.match(b)))


def flexible(quote):
    """Regex that matches `quote` in raw text regardless of whitespace runs
    and the curly/straight punctuation the insert gate normalises away."""
    out = []
    for tok in quote.split():
        piece = ""
        for ch in tok:
            if ch in "'’":
                piece += "['’]"
            elif ch in '"“”':
                piece += '["“”]'
            elif ch in "-—–":
                piece += "[-—–]"
            else:
                piece += re.escape(ch)
        out.append(piece)
    return re.compile(r"\s+".join(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = mgmt("""
        select id, item_type, item_id, source_quote
        from study_facts
        where status = 'live' and source_quote is not null
          and length(trim(source_quote)) > 0
        order by item_type, item_id
    """)

    by_type = {}
    for r in rows:
        by_type.setdefault(r["item_type"], []).append(r)

    fixes, skipped = [], []
    for item_type, group in sorted(by_type.items()):
        if item_type not in SOURCES:
            continue
        tbl, idcol, txtcol = SOURCES[item_type]
        ids = sorted({r["item_id"] for r in group})
        texts = {}
        for i in range(0, len(ids), 400):
            q = ",".join("'%s'" % x.replace("'", "''") for x in ids[i:i + 400])
            for row in mgmt(f"select {idcol} as k, {txtcol} as t from {tbl} where {idcol} in ({q})"):
                texts[row["k"]] = row["t"] or ""

        for r in group:
            body = texts.get(r["item_id"], "")
            quote = (r["source_quote"] or "").strip()
            if not body or not quote:
                continue
            m = flexible(quote).search(body)
            if not m:
                continue                      # stale text; a different audit owns that
            s, e = m.start(), m.end()
            head_cut = s > 0 and cuts_a_word(body[s - 1], body[s])
            tail_cut = e < len(body) and cuts_a_word(body[e - 1], body[e])
            if not (head_cut or tail_cut):
                continue                      # already clean
            ns, ne = s, e
            if head_cut:
                while ns > 0 and cuts_a_word(body[ns - 1], body[ns]):
                    ns -= 1
            if tail_cut:
                while ne < len(body) and cuts_a_word(body[ne - 1], body[ne]):
                    ne += 1
            new = re.sub(r"\s+", " ", body[ns:ne]).strip()
            if not new or new == quote:
                skipped.append((r, "expansion produced no change"))
                continue
            fixes.append((r, quote, new))

    print(f"{len(fixes)} row(s) to repair, {len(skipped)} skipped.\n")
    for r, old, new in fixes[:12]:
        print(f"  {r['item_type']} {r['item_id']}")
        print(f"    - {old[-70:]!r}")
        print(f"    + {new[-70:]!r}\n")
    if len(fixes) > 12:
        print(f"  ... and {len(fixes) - 12} more\n")
    for r, why in skipped:
        print(f"  SKIP {r['item_type']} {r['item_id']}: {why}")

    if not fixes:
        print("nothing to do")
        return 0
    if args.dry_run:
        print("--dry-run, nothing written")
        return 0

    # SNAPSHOT BEFORE ANY WRITE -- if this raises, nothing has been touched.
    from content_snapshot import snapshot_rows
    path = snapshot_rows(
        "study_facts", "id", [r["id"] for r, _, _ in fixes],
        columns="id,item_type,item_id,question,answer,source_quote,status,origin",
        label="source_quote_truncation",
    )
    print(f"\nsnapshot: {path}")

    ok = 0
    for r, _old, new in fixes:
        st, body = http(
            "PATCH", f"/rest/v1/study_facts?id=eq.{r['id']}",
            key=SERVICE, body={"source_quote": new},
            headers={"Prefer": "return=minimal"},
        )
        if st in (200, 204):
            ok += 1
        else:
            print(f"  FAILED {r['id']}: {st} {body}")
    print(f"\nrepaired {ok}/{len(fixes)}")
    return 0 if ok == len(fixes) else 1


if __name__ == "__main__":
    sys.exit(main())
