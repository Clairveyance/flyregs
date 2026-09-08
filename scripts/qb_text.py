#!/usr/bin/env python3
"""Dump live reg text for authoring, or list sections that have no authored questions yet."""
import os, sys, re
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
from access_matrix_sweep import mgmt

TBL = {"far": ("far_sections", "section_number", "title"),
       "aim": ("aim_paragraphs", "paragraph_number", "title"),
       "cfr49": ("cfr49_sections", "section_number", "title"),
       "ac": ("advisory_circulars", "document_number", "title")}

def main():
    mode, item_type = sys.argv[1], sys.argv[2]
    tbl, col, tcol = TBL[item_type]
    if mode == "todo":
        limit = sys.argv[3] if len(sys.argv) > 3 else "60"
        where = sys.argv[4] if len(sys.argv) > 4 else "true"
        body = "pdf_text" if item_type == "ac" else "body_text"
        rows = mgmt(f"""select s.{col} as id, s.{tcol} as title, length(s.{body}) as len
                        from {tbl} s
                        where {where} and length(s.{body}) > 700
                          and not exists (select 1 from study_facts f
                                          where f.item_type='{item_type}' and f.item_id = s.{col}
                                            and f.origin='authored')
                        order by length(s.{body}) desc limit {limit}""")
        for r in rows:
            print(f"{r['id']:<12} {r['len']:>6}  {(r['title'] or '')[:80]}")
    else:
        ids = ",".join("'%s'" % i for i in sys.argv[3:])
        body = "pdf_text" if item_type == "ac" else "body_text"
        for r in mgmt(f"select {col} as id, {tcol} as title, {body} as body from {tbl} where {col} in ({ids})"):
            print(f"\n===== {r['id']} — {r['title']} =====")
            print(re.sub(r"\n{3,}", "\n\n", r["body"] or "")[:7000])

main()
