#!/usr/bin/env python3
"""
Careful, individually-checked classification of the 300-reference residual
left after both Vision passes (BB-062). Built after a first attempt to "fix"
the detection regex directly in SQL backfired (a greedy whitespace-tolerant
rewrite over-matched and inflated the count to 4630) -- this instead checks
each of the existing, validated 300 references one at a time in Python,
where every classification is printable/auditable, rather than trusting a
single complex regex rewrite.

Four buckets:
1. truncated_compound_artifact -- the bare number is immediately followed
   (skipping whitespace) by a hyphen/dot + another alphanumeric, meaning the
   real label is a compound number (e.g. real "Figure 3-2", bare "Figure 3"
   extracted from an OCR/kerning artifact like "Figure 3- 2"). Verified only
   when the corresponding compound-numbered label ALSO already has a real
   ac_figures row -- if it doesn't, this is NOT auto-classified as noise,
   since that would be assuming the fix rather than proving it.
2. removal_language / cross_doc_citation / naming_collision -- same patterns
   as classify_missing_figure_noise.py.
3. genuinely_unresolved -- everything else. This is the real number.

Usage: python3 scripts/classify_residual_final.py
Reads /tmp/full_residual_detail.json (list of {document_number, kind, num}).
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import SUPABASE_URL, HEADERS
import requests

REMOVAL_KEYWORDS = re.compile(
    r"\b(removes?|removed|rescind(?:ed|s)?|deleted?|no longer (?:included|applicable|available)|"
    r"relocated|now found (?:on|at)|has been (?:removed|deleted|rescinded))\b",
    re.IGNORECASE,
)
CROSS_DOC_RE = re.compile(r"\b(OpSpec|MSpec|AC\s+\d+[.\-]\d+|Advisory Circular \d+[.\-]\d+)\b", re.IGNORECASE)
COMPOUND_LABEL_RE = re.compile(
    r"\b(Figure|Table)\s+[A-Za-z]?\d+[A-Za-z]?(?:[-.·]\d+[A-Za-z]?)?\.?\s+[A-Za-z][^.]{0,60}?\b(Figure|Table)\s+[0-9]",
    re.IGNORECASE,
)
TRUNCATION_FOLLOW_RE = re.compile(r"^\s{0,3}[-.·]\s{0,3}[0-9A-Za-z]")


def main():
    refs = json.load(open("/tmp/full_residual_detail.json"))
    print(f"{len(refs)} references to classify\n")

    text_cache = {}
    existing_cache = {}

    buckets = {"truncated_compound_artifact": [], "removal_language": [], "cross_doc_citation": [], "naming_collision": [], "genuinely_unresolved": []}

    for ref in refs:
        doc = ref["document_number"]
        kind, num = ref["kind"], ref["num"]
        label = f"{kind} {num}"

        if doc not in text_cache:
            resp = requests.get(f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{doc}&select=id,pdf_text", headers=HEADERS, timeout=30)
            row = resp.json()[0]
            text_cache[doc] = row["pdf_text"] or ""
            r2 = requests.get(f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{row['id']}&select=label", headers=HEADERS, timeout=30)
            existing_cache[doc] = {r["label"] for r in r2.json()}

        text = text_cache[doc]
        existing = existing_cache[doc]

        pattern = re.compile(re.escape(label), re.IGNORECASE)
        m = pattern.search(text)
        if not m:
            buckets["genuinely_unresolved"].append((doc, label, "(label not found in pdf_text at all)"))
            continue

        after = text[m.end():m.end() + 20]
        classified = False

        # Bucket 1: truncated compound number -- only counted as resolved
        # noise if the real compound label demonstrably already has a row.
        if TRUNCATION_FOLLOW_RE.match(after):
            has_compound_row = any(
                lbl.lower().startswith(f"{kind.lower()} {num}-") or lbl.lower().startswith(f"{kind.lower()} {num}.")
                for lbl in existing
            )
            if has_compound_row:
                buckets["truncated_compound_artifact"].append((doc, label, f"...{after[:20]}... (compound row confirmed present)"))
                classified = True

        if not classified:
            before = text[max(0, m.start() - 150):m.start()]
            after150 = text[m.end():m.end() + 150]
            line_start = text.rfind("\n", 0, m.start()) + 1
            line_end = text.find("\n", m.end())
            line = text[line_start:line_end if line_end != -1 else m.end() + 150]

            if REMOVAL_KEYWORDS.search(before) or REMOVAL_KEYWORDS.search(after150[:60]):
                buckets["removal_language"].append((doc, label, before[-60:] + "[[" + label + "]]" + after150[:60]))
            elif CROSS_DOC_RE.search(before[-80:]):
                buckets["cross_doc_citation"].append((doc, label, before[-60:] + "[[" + label + "]]" + after150[:60]))
            elif COMPOUND_LABEL_RE.search(line):
                buckets["naming_collision"].append((doc, label, line.strip()[:160]))
            else:
                buckets["genuinely_unresolved"].append((doc, label, before[-60:] + "[[" + label + "]]" + after150[:60]))

    for bucket, items in buckets.items():
        print(f"=== {bucket}: {len(items)} ===")
        for doc, label, ctx in items[:8]:
            print(f"  {doc} {label}: ...{ctx}...")
        if len(items) > 8:
            print(f"  ... and {len(items) - 8} more")
        print()

    total = sum(len(v) for v in buckets.values())
    noise = total - len(buckets["genuinely_unresolved"])
    print(f"Total: {total}. Confirmed noise/artifacts: {noise} ({100*noise/total:.0f}%). Genuinely unresolved: {len(buckets['genuinely_unresolved'])}.")

    with open("/tmp/residual_final_classification.json", "w") as f:
        json.dump(buckets, f, indent=2)
    print("\nWritten to /tmp/residual_final_classification.json")


if __name__ == "__main__":
    main()
