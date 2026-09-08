#!/usr/bin/env python3
"""Insert hand-authored questions into study_facts, grounded-checked first.

RC, 2026-09-01: "if we just build the bank outside the app, then insert it, we
could create much better Qs, then just place them into the banks for diff
filters." 2026-09-07: "build it all out... i want 100s or 1000s of Qs."

REFUSES TO WRITE ANYTHING THAT IS NOT GROUNDED. Every row must carry a
source_quote that appears VERBATIM in the live reg text, and every number in
the answer must appear in that text too. A question bank that invents a number
is worse than no question bank -- this project has had three separate
escalations from RC about bad questions, and all of them were generated rows
that no one checked against the source.

Idempotent: study_facts has UNIQUE (item_type, item_id, question), so
re-running cannot duplicate. Rows land as origin='authored', which both
surfaces already prefer (create_challenge orders by it; study.ts filters on
it), so they win over the generated bank for the same section.
"""
import argparse, json, os, re, subprocess, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "scripts"))
from access_matrix_sweep import mgmt, http, SERVICE, URL   # noqa: E402
from inane_question_sweep import classify as classify_inane   # noqa: E402

MODEL_TAG = "claude-opus-5 (authored in-session, verified against far_sections.body_text)"


def norm(s: str) -> str:
    s = (s.replace("—", "-").replace("’", "'")
          .replace("“", '"').replace("”", '"').replace("Sec. ", "§ "))
    return re.sub(r"\s+", " ", s).strip().lower()


def body_texts(item_type, ids):
    tbl, col = {"far": ("far_sections", "section_number"),
                "aim": ("aim_paragraphs", "paragraph_number"),
                "cfr49": ("cfr49_sections", "section_number")}[item_type]
    q = ",".join("'%s'" % i.replace("'", "''") for i in sorted(set(ids)))
    return {r[col]: r["body_text"] for r in
            mgmt(f"select {col}, body_text from {tbl} where {col} in ({q})")}


def check(rows, item_type):
    bodies = body_texts(item_type, [r["item_id"] for r in rows])
    problems = []
    for i, q in enumerate(rows, 1):
        b = bodies.get(q["item_id"])
        if not b:
            problems.append(f"#{i} {q['item_id']}: section not in the corpus"); continue
        nb = norm(b)
        if norm(q["source_quote"]) not in nb:
            problems.append(f"#{i} {q['item_id']}: source_quote not found verbatim in the live text")
        for n in set(re.findall(r"\b\d[\d,]*\b", q["answer"])):
            if n.replace(",", "") not in nb.replace(",", ""):
                problems.append(f"#{i} {q['item_id']}: answer contains '{n}', absent from the reg text")
        if len(q.get("distractors") or []) != 3:
            problems.append(f"#{i} {q['item_id']}: needs exactly 3 distractors")
        if q.get("q_type") not in ("recall", "scenario"):
            problems.append(f"#{i} {q['item_id']}: q_type must be recall or scenario")
        if not q.get("category"):
            problems.append(f"#{i} {q['item_id']}: no category (this is the filter box)")
        # RC, 2026-09-07: "def fix any issue that would cause those inane Qs to
        # be allowed into the DB. none of those types can be allowed in." The
        # same classifier that swept 1,195 of them out of the generated bank now
        # stands in front of authoring, so a hand-written question cannot
        # reintroduce a class we just spent the afternoon removing.
        bad = classify_inane(q.get("question", ""), q.get("answer", ""))
        if bad:
            problems.append(f"#{i} {q['item_id']}: inane ({', '.join(bad)}) -- "
                            f"rewrite so the ANSWER teaches the rule, not a lookup")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--item-type", default="far")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    rows = json.load(open(a.file))
    problems = check(rows, a.item_type)
    if problems:
        print(f"REFUSING TO INSERT -- {len(problems)} grounding problem(s):")
        for p in problems:
            print("  -", p)
        return 1
    print(f"  {len(rows)} row(s), all grounded against the live reg text")
    if a.dry_run:
        print("  --dry-run, nothing written")
        return 0

    payload = [{
        "item_type": a.item_type, "item_id": r["item_id"],
        "question": r["question"], "answer": r["answer"],
        "distractors": r["distractors"], "source_quote": r["source_quote"],
        "explanation": r["explanation"], "category": r["category"],
        "q_type": r["q_type"], "origin": "authored",
        "status": "live", "model": MODEL_TAG,
    } for r in rows]

    # IGNORE duplicates, never merge them.
    #
    # study_facts has UNIQUE (item_type, item_id, question). A question whose
    # text already exists -- almost always because the generated bank reached
    # the same phrasing first -- must be LEFT ALONE. Merging would rewrite that
    # existing row's origin/model/category to this batch's values, quietly
    # relabelling generated content as authored. Skipping costs one duplicate;
    # merging corrupts the provenance of a row nobody reviewed.
    #
    # on_conflict is required explicitly: without it PostgREST does not know
    # which constraint the resolution applies to and returns a plain 409.
    st, body = http("POST",
                    "/rest/v1/study_facts?on_conflict=item_type,item_id,question",
                    key=SERVICE,
                    headers={"Prefer": "resolution=ignore-duplicates,return=representation"},
                    body=payload)
    if st not in (200, 201, 204):
        print(f"  insert -> HTTP {st} {str(body)[:200]}")
        return 1
    written = len(body) if isinstance(body, list) else 0
    skipped = len(payload) - written
    print(f"  inserted {written}" + (f", skipped {skipped} already-present question(s)" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
