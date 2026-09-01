"""Retire study questions whose supporting text no longer exists in the reg.

Runs off content_revisions: for every live study_fact attached to a document
that has a logged revision, check whether that fact's source_quote is still
present in the CURRENT body_text. If the evidence is gone, the question can no
longer be trusted and is set status='stale' (the gated view only serves 'live',
so it stops being served immediately).

Deliberately conservative in both directions:
  * It does NOT try to guess a corrected answer. A wrong regulatory answer is
    worse than a missing question.
  * It does NOT flag a question merely because its section was revised. Most
    revisions touch a different paragraph -- measured 2026-09-01: of 105
    questions on revised sections, 96 still had their exact supporting text.

Depends on revision_log.py logging only REAL changes; before its 2026-09-01
normalization fix, a corpus re-scrape logged 121 false revisions and this sweep
would have had 1,049 questions to chew through, nearly all of them fine.

Run after any scrape that logs revisions. --apply to write, default is a report.
"""
import sys, re, argparse
sys.path.insert(0, "scripts")
from author_fact_deck import mgmt_sql

SRC = {
    "far":   ("far_sections",        "section_number"),
    "aim":   ("aim_paragraphs",      "paragraph_number"),
    "cfr49": ("cfr49_sections",      "section_number"),
}

def norm(t): return re.sub(r"\s+", " ", t or "").strip().lower()

def sweep(apply_changes=False):
    suspect = []
    for doc_type, (table, key) in SRC.items():
        rows = mgmt_sql(f"""
            select sf.id::text as id, sf.item_id, sf.question, sf.source_quote, s.body_text
            from content_revisions cr
            join study_facts sf on sf.item_type = cr.doc_type and sf.item_id = cr.doc_key
                                and sf.status = 'live'
            join {table} s on s.{key} = sf.item_id
            where cr.doc_type = '{doc_type}'""")
        for r in rows:
            q = norm(r["source_quote"])
            # 120 chars is enough to be specific without tripping on a trailing
            # punctuation or whitespace difference deep in a long quote.
            if not q or q[:120] not in norm(r["body_text"]):
                suspect.append((doc_type, r))
        print(f"  {doc_type}: {len(rows)} live questions on revised docs")
    print(f"\nsuspect (supporting text no longer present): {len(suspect)}")
    for dt, r in suspect:
        print(f"   {dt} {r['item_id']:<10} {r['question'][:70]}")
    if apply_changes and suspect:
        ids = ",".join("'" + r["id"] + "'" for _, r in suspect)
        mgmt_sql(f"""update study_facts set status='stale',
            flag_reason='source_quote no longer present in current body_text after a logged revision (stale_question_sweep.py)'
            where id in ({ids})""")
        print(f"\nmarked {len(suspect)} questions stale")
    elif suspect:
        print("\n(report only -- pass --apply to mark these stale)")
    return suspect

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--apply", action="store_true")
    sweep(ap.parse_args().apply)
