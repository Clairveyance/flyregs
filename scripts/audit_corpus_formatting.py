#!/usr/bin/env python3
"""Corpus-wide formatting audit, re-runnable, read-only.

Built 2026-08-12 out of the thin-parse backlog work: two documents fixed
that night (150/5320-5D, 21.101-1B) both turned out to have the SAME root
issue independently -- a repeating page-footer/header boilerplate string
(a date + the doc's own number, e.g. "UFC Draft AC 150/5320-5D 8/1/2006
8/15/2013" or "03/11/16 AC 21.101-1B") bled into the extracted body text
and, worse, sat BETWEEN a heading number and its title in a way that could
defeat naive heading-detection regexes. Finding it twice independently
in unrelated documents is a real signal this is corpus-wide, not a
one-off -- this script finds every AC where it happens, so it doesn't
keep getting rediscovered by hand one document at a time.

Checks:
1. FOOTER BOILERPLATE: a short (15-90 char) substring containing both a
   date-like token and the document's own number/part of it, repeating
   3+ times in body text. High-confidence, low-noise -- a real page
   footer/header artifact, not prose (prose essentially never repeats a
   15+ char span verbatim 3 times).
2. OVERSIZED BLOCKS: blocks whose body is both >8000 chars AND >6x that
   document's own median block length (a document-relative threshold,
   not a fixed one -- some ACs are legitimately dense throughout, this
   only flags a block that's an outlier WITHIN ITS OWN document).

Deliberately does NOT re-flag "thin parse" as a blanket proxy the way an
earlier attempt did (see run_all_audits.sh's own header comment) -- that
heuristic was too noisy against legitimately dense technical docs. Both
checks here are corroborated by two real, independently-found fixes
before being written as a general rule, not a guess.

Usage: python3 scripts/audit_corpus_formatting.py
"""
import json
import re
import statistics
import urllib.request

MGMT = {}
with open(".env.supabase-mgmt") as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        k, _, v = line.partition("=")
        MGMT[k] = v


def mgmt_sql(query):
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{MGMT['SUPABASE_PROJECT_REF']}/database/query",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {MGMT['SUPABASE_MANAGEMENT_TOKEN']}",
                 "Content-Type": "application/json", "User-Agent": "curl/8.0"},
        method="POST")
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())


DATE_RE = re.compile(r"\d{1,2}/\d{1,2}/\d{2,4}")


def find_footer_boilerplate(doc_number, full_text):
    """Look for a repeating short span containing a date AND (part of) the
    doc's own number. Scans candidate windows anchored on date matches."""
    candidates = {}
    for m in DATE_RE.finditer(full_text):
        # widen a window around the date hit and see if a stable-length
        # substring around it repeats elsewhere with the doc number nearby
        window = full_text[max(0, m.start() - 60):m.end() + 60]
        # only consider windows that also contain some digit-heavy token
        # resembling the doc's own number (loose: any 2+ digit run from it)
        doc_digits = re.findall(r"\d{2,}", doc_number)
        if not doc_digits or not any(d in window for d in doc_digits):
            continue
        # normalize whitespace, take a stable ~40-char core around the date
        core_start = max(0, m.start() - 20)
        core = re.sub(r"\s+", " ", full_text[core_start:m.end() + 20]).strip()
        if len(core) < 15:
            continue
        candidates[core] = candidates.get(core, 0) + 1
    real = {k: v for k, v in candidates.items() if v >= 3}
    return real


def main():
    print("Fetching all active ACs with pdf_text + pdf_blocks...")
    rows = mgmt_sql("""
        select document_number, title, pdf_text,
               (select array_agg(length(b->>'body')) from jsonb_array_elements(pdf_blocks) b) as block_lens,
               (select array_agg(b->>'body') from jsonb_array_elements(pdf_blocks) b) as block_bodies
        from advisory_circulars
        where status = 'active' and pdf_text is not null and pdf_blocks is not null
    """)
    print(f"{len(rows)} ACs loaded.\n")

    footer_hits = []
    oversized_hits = []

    for row in rows:
        doc = row["document_number"]
        text = row["pdf_text"] or ""
        boilerplate = find_footer_boilerplate(doc, text)
        if boilerplate:
            top = max(boilerplate.items(), key=lambda kv: kv[1])
            footer_hits.append((doc, row["title"], top[0], top[1]))

        lens = [l for l in (row["block_lens"] or []) if l]
        if len(lens) >= 5:
            median = statistics.median(lens)
            worst = max(lens)
            if worst > 8000 and median > 0 and worst > median * 6:
                oversized_hits.append((doc, row["title"], worst, int(median), len(lens)))

    print(f"=== FOOTER BOILERPLATE bleeding into body text: {len(footer_hits)} ACs ===")
    for doc, title, snippet, count in sorted(footer_hits, key=lambda x: -x[3])[:60]:
        print(f"  {doc:<16} x{count:<3} {snippet[:70]!r}  ({title[:40]})")

    print(f"\n=== OVERSIZED BLOCKS (document-relative outlier, real candidate for a manual split): {len(oversized_hits)} ACs ===")
    for doc, title, worst, median, n in sorted(oversized_hits, key=lambda x: -x[2])[:60]:
        print(f"  {doc:<16} worst={worst:<7} median={median:<6} n_blocks={n:<4} {title[:50]}")

    with open("scripts/audit_reports/corpus_formatting_latest.json", "w") as f:
        json.dump({
            "footer_boilerplate": [{"doc": d, "title": t, "snippet": s, "count": c} for d, t, s, c in footer_hits],
            "oversized_blocks": [{"doc": d, "title": t, "worst": w, "median": m, "n_blocks": n} for d, t, w, m, n in oversized_hits],
        }, f, indent=1)
    print(f"\nFull results: scripts/audit_reports/corpus_formatting_latest.json")


if __name__ == "__main__":
    main()
