"""Build curated ACS task -> regulation links into `acs_task_reg_links`.

Replaces the runtime keyword search that put AC 90-117 "Data Link
Communications" on CFI Task I.A "Effects of Human Behavior and Communication on
the Learning Process". See scripts/acs_relevance.py for why a rank threshold
cannot fix that and what replaces it.

Pipeline per task:
  1. task text  = title + objective + every Knowledge/Risk/Skill element body.
                  Title and knowledge elements are weighted above skill
                  boilerplate ("Deliver instruction on at least two of...").
  2. FAR gate   = only sections inside the parts the ACS itself cites in its
                  References field. Cites no part -> the task gets NO FAR links.
                  That is the FAA saying the subject is not regulatory, and it
                  is ground truth we should not argue with.
  3. AC gate    = ACs the References field names outright are always kept
                  (authoritative). Keyword-discovered ACs are kept only for
                  tasks whose References cite SOMETHING regulatory, and must
                  still clear the same evidence rules.
  4. AIM        = kept only where References names the AIM.
  5. evidence   = >=2 distinct significant terms, >=1 of them specific,
                  score >= 35% of that task's best. No absolute threshold.

Idempotent: recomputes every row and replaces the table contents in one pass.
Read-only against every source corpus.
"""
import os
import re
import sys
import json
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from access_matrix_sweep import mgmt, SERVICE, URL  # noqa: E402
import acs_relevance as R  # noqa: E402

DRY = "--write" not in sys.argv


# ACS document -> knowledge level, so a Private Pilot ACS never links a
# CFI-only section. Derived from the document TITLE, which states the
# certificate outright ("Private Pilot for Airplane Category ACS"). Checked in
# specificity order: "Flight Instructor - Instrument Rating" is a CFI document,
# not an instrument one, so "instructor" must be tested before "instrument".
DOC_LEVEL = [
    ("flight instructor", "cfi"),
    ("airline transport pilot", "atp"),
    ("remote pilot", "remote_pilot"),
    ("instrument rating", "instrument"),
    ("commercial pilot", "commercial"),
    ("private pilot", "private"),
    ("aviation mechanic", "mechanic"),
]




def doc_level(title):
    t = (title or "").lower()
    for needle, lvl in DOC_LEVEL:
        if needle in t:
            return lvl
    return None


def cited_far_parts(rt):
    parts = []
    for m in re.finditer(r"14\s*CFR\s*parts?\s+([0-9;,.\s()a-z-]+)", rt or "", re.I):
        for tok in m.group(1).split(","):
            n = re.match(r"^\s*(\d{1,3})", tok)
            if n and n.group(1) not in parts:
                parts.append(n.group(1))
    return parts


def cited_acs(rt):
    return [m.group(1).rstrip(".,;")
            for m in re.finditer(r"\bAC\s+(\d[\w./-]*)", rt or "", re.I)]


def resolve_ac(num, ac_index):
    """Map an ACS citation like "AC 61-65" onto the document the corpus
    actually holds, "61-65K".

    The ACS cites BASE numbers; advisory_circulars stores the specific
    revision. An exact-match lookup therefore failed for essentially every
    cited AC and emitted links to documents that do not exist -- caught by
    acs_reg_link_audit.py, 315 dead links. Anchored so "61-65" can never
    match "61-650"; newest revision wins when several are held.
    """
    u = num.upper()
    if u in ac_index:
        return u
    pat = re.compile(rf"^{re.escape(u)}[A-Z]$")
    hits = sorted(d for d in ac_index if pat.match(d))
    return hits[-1] if hits else None


def cites_aim(rt):
    return bool(re.search(r"\bAIM\b", rt or ""))


def fetch_all(table, cols, where="", page=1000):
    """PostgREST caps at 1000 rows/request (see memory: postgrest_1000_row_cap),
    so page explicitly rather than trusting a single select."""
    out, off = [], 0
    while True:
        q = f"select {cols} from {table} {where} order by 1 limit {page} offset {off}"
        rows = mgmt(q)
        out.extend(rows)
        if len(rows) < page:
            return out
        off += page


def main():
    t0 = time.time()
    print("loading ACS tasks + elements ...")
    tasks = fetch_all("acs_tasks", "id,doc_code,area_number,task_letter,title,objective,references_text")
    els = fetch_all("acs_elements", "task_id,element_type,body_text")
    by_task = {}
    for e in els:
        by_task.setdefault(e["task_id"], []).append(e)
    print(f"  {len(tasks)} tasks, {len(els)} elements")

    all_parts = sorted({p for t in tasks for p in cited_far_parts(t["references_text"])})
    print(f"loading FAR sections for {len(all_parts)} cited parts ...")
    far = fetch_all("far_sections", "section_number,part,title,body_text",
                    "where part in (" + ",".join(f"'{p}'" for p in all_parts) + ")")
    far_by_part = {}
    for s in far:
        far_by_part.setdefault(s["part"], []).append(s)
    print(f"  {len(far)} sections")

    print("loading section levels ...")
    lv = fetch_all("far_sections",
                   "section_number, far_all_levels(part,subpart_letter,section_number) as levels",
                   "where part in (" + ",".join(f"'{p}'" for p in all_parts) + ")")
    levels = {r["section_number"]: set(r["levels"] or []) for r in lv}
    print(f"  {len(levels)} sections tagged")

    print("loading ACs + AIM ...")
    acs_docs = fetch_all("advisory_circulars", "document_number,title,description")
    aim = fetch_all("aim_paragraphs", "paragraph_number,title,body_text")
    print(f"  {len(acs_docs)} ACs, {len(aim)} AIM paragraphs")
    ac_index = {(a["document_number"] or "").upper() for a in acs_docs}
    ac_case = {(a["document_number"] or "").upper(): a["document_number"] for a in acs_docs}

    # IDF over the whole reg corpus we might link to, so "communication" is
    # correctly cheap and "chandelle" correctly expensive.
    print("building IDF ...")
    docs = ([R.term_set((s["title"] or "") + " " + (s["body_text"] or "")) for s in far]
            + [R.term_set((a["title"] or "") + " " + (a["description"] or "")) for a in acs_docs]
            + [R.term_set((p["title"] or "") + " " + (p["body_text"] or "")) for p in aim])
    idf, ndocs = R.build_idf(docs)
    med = sorted(idf.values())[len(idf) // 2]
    print(f"  {len(idf)} terms over {ndocs} docs, median idf {med:.3f}")

    doc_titles = {d["code"]: d["title"] for d in fetch_all("acs_documents", "code,title")}

    links, stats = [], {"far": 0, "ac": 0, "aim": 0, "tasks_with_far": 0,
                        "tasks_empty": 0, "level_filtered": 0,
                        "ac_unresolved": 0}

    for t in tasks:
        elements = by_task.get(t["id"], [])
        # Task-side weighting: the title states the subject, knowledge elements
        # enumerate it, skill elements are mostly instructional boilerplate.
        weighted = {}
        for text, w in ([(t["title"], 2.0), (t["objective"], 0.5)]
                        + [(e["body_text"], 1.5 if e["element_type"] == "knowledge" else 1.0)
                           for e in elements]):
            for term in R.term_set(text or ""):
                weighted[term] = max(weighted.get(term, 0.0), w)

        parts = cited_far_parts(t["references_text"])
        named = cited_acs(t["references_text"])
        want_aim = cites_aim(t["references_text"])
        key = dict(doc_code=t["doc_code"], area_number=t["area_number"], task_letter=t["task_letter"])

        # ---- FAR: hard-gated to the parts the ACS itself cites, then to the
        # certificate level the ACS document is for. Without the level gate a
        # Private Pilot ACS task citing part 61 can surface 61.195 "Flight
        # instructor limitations", which no private applicant needs.
        want_lvl = doc_level(doc_titles.get(t["doc_code"]))
        scored = []
        for p in parts:
            for s in far_by_part.get(p, []):
                if want_lvl:
                    sl = levels.get(s["section_number"]) or set()
                    if sl and sl != {"not_applicable"} and want_lvl not in sl:
                        stats["level_filtered"] += 1
                        continue
                sc, n, spec, th = R.score_candidate(weighted, s["title"], s["body_text"], idf, med)
                # require_title: a FAR section whose TITLE shares nothing with
                # the task is not the section to study for it. See
                # acs_relevance.passes_evidence -- this is what removed
                # § 91.611 "ferry flight with one engine inoperative" from the
                # ATP task "Normal Approach and Landing".
                if sc > 0 and R.passes_evidence(n, spec, th, require_title=True):
                    scored.append((sc, s["section_number"], p))
        if scored:
            scored.sort(reverse=True)
            cut = scored[0][0] * R.MIN_SCORE_FRACTION
            keep = [x for x in scored if x[0] >= cut][: R.MAX_PER_TYPE]
            # The ACS lists the governing part first; preserve that intent so a
            # part-61 eligibility section outranks an incidental part-91 hit.
            keep.sort(key=lambda x: (parts.index(x[2]), -x[0]))
            for rank, (sc, sec, _p) in enumerate(keep):
                links.append(dict(**key, cited_type="far", cited_id=sec, rank=rank, score=round(sc, 3), source="scored"))
            stats["far"] += len(keep)
            stats["tasks_with_far"] += 1

        # ---- AC: explicit citations are authoritative and never filtered
        seen_ac = set()
        for i, num in enumerate(named):
            doc = resolve_ac(num, ac_index)
            if doc is None:
                # The ACS names an AC this corpus does not hold (often cancelled
                # or superseded). Emitting the link anyway produced a dead tap
                # target, so skip it and count it instead.
                stats["ac_unresolved"] += 1
                continue
            if doc in seen_ac:
                continue
            seen_ac.add(doc)
            links.append(dict(**key, cited_type="ac", cited_id=ac_case[doc], rank=i, score=None, source="cited"))
            stats["ac"] += 1

        # ---- NO keyword-discovered ACs. AT ALL.
        #
        # 2026-09-10. The first version of this file kept the top 4 TF-IDF AC
        # matches on any task that cited a part. Auditing the OUTPUT rather than
        # the code, that turned out to be RC's original bug wearing new clothes:
        #
        #   "Normal Approach and Landing"      -> AC 150/5190-4B Airport Land Use
        #                                         Compatibility Planning
        #                                      -> AC 93-3 Lengthy Tarmac Delays
        #   "Communications, Light Signals..." -> AC 93-3 Lengthy Tarmac Delays
        #   "Navigation and Cross-Country..."  -> AC 43-215 Aircraft Magnetic
        #                                         Compass Swing procedures
        #   "Weather Information" (PPL)        -> AC 150/5300-18B Airport Survey
        #
        # AC 93-3 alone had reached 79 tasks. The cause is structural, not a
        # threshold that needs tightening: the AC corpus spans airport pavement
        # engineering to airline tarmac-delay contingency plans, AC titles are
        # broad, and TF-IDF over a title plus a one-line description cannot tell
        # "runway lighting SPECIFICATION for airport engineers" from "what the
        # runway lights mean to a pilot on approach".
        #
        # The ACS's own References field IS the authoritative list of which ACs
        # apply to a task -- the FAA wrote it for exactly this purpose. Where it
        # names none, the honest answer is none. That is the same reasoning that
        # already governs handbook-only tasks, applied one level further in.
        #
        # FAR and AIM still score, and should: the ACS cites PARTS ("14 CFR part
        # 91") and "AIM" generically, never sections or paragraphs, so scoring
        # is the only way to reach the right section -- and it demonstrably
        # works there (Task III.A "Pilot Qualifications" -> 61.3, 61.23, 61.195,
        # 61.51). The difference is that the search space is already narrowed to
        # the parts the ACS itself named.
        #
        # Cost of this decision, measured before taking it: 2,101 guessed rows
        # dropped, 417 authoritative rows kept across 324 tasks; 265 tasks lose
        # every AC they had. Every sampled one of those 265 was noise.

        # ---- AIM only where the References field names it
        if want_aim:
            a_scored = []
            for p in aim:
                sc, n, spec, th = R.score_candidate(weighted, p["title"], p["body_text"], idf, med)
                # require_title, same reasoning as the FAR branch above. Without
                # it the PPL task "Communications, Light Signals, and Runway
                # Lighting Systems" pulled in AIM 10-2-1 "Offshore Helicopter
                # Operations" and appendix_4 "FAA Form 7233-4 - International
                # Flight Plan", neither of which shares a word with the task's
                # own subject -- they matched on body prose alone.
                if sc > 0 and R.passes_evidence(n, spec, th, require_title=True):
                    a_scored.append((sc, p["paragraph_number"]))
            if a_scored:
                a_scored.sort(reverse=True)
                cut = a_scored[0][0] * R.MIN_SCORE_FRACTION
                for rank, (sc, num) in enumerate([x for x in a_scored if x[0] >= cut][: R.MAX_PER_TYPE]):
                    links.append(dict(**key, cited_type="aim", cited_id=num, rank=rank, score=round(sc, 3), source="scored"))
                    stats["aim"] += 1

        if not any(l["doc_code"] == t["doc_code"] and l["area_number"] == t["area_number"]
                   and l["task_letter"] == t["task_letter"] for l in links[-20:]):
            stats["tasks_empty"] += 1

    print(f"\ncomputed {len(links)} links in {time.time()-t0:.0f}s")
    print("  ", stats)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build", "acs_reg_links.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(links, f)
    print("  wrote", out)
    if DRY:
        print("\nDRY RUN -- pass --write to publish to acs_task_reg_links")
    return links


if __name__ == "__main__":
    main()
