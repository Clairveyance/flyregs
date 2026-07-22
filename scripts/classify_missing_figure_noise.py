#!/usr/bin/env python3
"""
Free (no API cost) classifier for the missing-figures residual (BB-062).
Applies three confirmed noise patterns found by spot-checking real cases
before spending more Vision money on the whole residual:

1. Cross-document citation -- the mention cites a DIFFERENT document's
   table/figure (e.g. "OpSpec/MSpec A025, Table 2") rather than this AC's
   own content. Detected via nearby doc-number-shaped tokens (OpSpec/MSpec
   codes, "AC NN-NN" patterns) within ~60 chars before the match.
2. Removal/relocation language -- the AC's own text says the item was
   removed, rescinded, or relocated elsewhere (e.g. "this change removes
   Table 1... now found on the FAA website"). Detected via a keyword list
   within ~150 chars before the match.
3. Naming collision -- the bare label appears immediately after a MORE
   specific compound label on the same line (e.g. "Table 3-1. Sample D097
   Table 1 -- Aging Aircraft..."), meaning it's naming something INSIDE
   another table's caption, not its own distinct entry.

Everything that doesn't match one of these three patterns is left
unclassified -- a real candidate for further investigation, not assumed
noise. This is a heuristic triage tool, not a final verdict generator;
read flagged results before treating them as settled.

Usage: python3 scripts/classify_missing_figure_noise.py
Reads the missing-figures list fresh from the DB (same query as the audit).
"""
import re
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import SUPABASE_URL, HEADERS
import requests

REMOVAL_KEYWORDS = re.compile(
    r"\b(removes?|removed|rescind(?:ed|s)?|deleted?|no longer (?:included|applicable|available)|"
    r"relocated|now found (?:on|at)|has been (?:removed|deleted|rescinded))\b",
    re.IGNORECASE,
)
CROSS_DOC_RE = re.compile(
    r"\b(OpSpec|MSpec|AC\s+\d+[.\-]\d+|Advisory Circular \d+[.\-]\d+)\b",
    re.IGNORECASE,
)
COMPOUND_LABEL_RE = re.compile(
    r"\b(Figure|Table)\s+[A-Za-z]?\d+[A-Za-z]?(?:[-.·]\d+[A-Za-z]?)?\.?\s+[A-Za-z][^.]{0,60}?\b(Figure|Table)\s+[0-9]",
    re.IGNORECASE,
)


def load_env_file(path):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def sql_query(query: str):
    import subprocess
    result = subprocess.run(
        ["python3", os.path.join(os.path.dirname(__file__), "supabase_mgmt_api.py"), "query", query],
        capture_output=True, text=True, check=True,
    )
    import json
    return json.loads(result.stdout)


QUERY = r"""
WITH refs AS (
  SELECT
    ac.id, ac.document_number, ac.pdf_text,
    (regexp_matches(ac.pdf_text, '\y(FIGURE|Figure|TABLE|Table)\s+([0-9][0-9A-Za-z.\-]*)\y', 'g'))[1] AS kind_raw,
    (regexp_matches(ac.pdf_text, '\y(FIGURE|Figure|TABLE|Table)\s+([0-9][0-9A-Za-z.\-]*)\y', 'g'))[2] AS num_raw
  FROM advisory_circulars ac
  WHERE ac.status = 'active' AND ac.pdf_text IS NOT NULL
),
norm_refs AS (
  SELECT DISTINCT id, document_number, pdf_text,
    CASE WHEN upper(left(kind_raw,1)) = 'F' THEN 'Figure' ELSE 'Table' END AS kind,
    regexp_replace(num_raw, '\.$', '') AS num
  FROM refs
),
existing AS (
  SELECT ac_id, lower(regexp_replace(trim(label), '\s+', ' ', 'g')) AS norm_label
  FROM ac_figures
)
SELECT nr.document_number, nr.kind, nr.num, nr.pdf_text
FROM norm_refs nr
WHERE NOT EXISTS (
  SELECT 1 FROM existing e
  WHERE e.ac_id = nr.id
    AND e.norm_label = lower(regexp_replace(nr.kind || ' ' || nr.num, '\s+', ' ', 'g'))
)
ORDER BY nr.document_number, nr.kind, nr.num;
"""


def main():
    print("Fetching current missing-figures list from the DB...")
    rows = sql_query(QUERY)
    print(f"{len(rows)} references to classify\n")

    # Group by doc to avoid re-scanning pdf_text repeatedly for nothing
    buckets = {"removal_language": [], "cross_doc_citation": [], "naming_collision": [], "unclassified": []}

    for row in rows:
        doc = row["document_number"]
        kind, num = row["kind"], row["num"]
        text = row["pdf_text"] or ""
        label = f"{kind} {num}"

        pattern = re.compile(re.escape(label), re.IGNORECASE)
        m = pattern.search(text)
        if not m:
            buckets["unclassified"].append((doc, label, "(label not found in pdf_text at all -- odd, flag for manual check)"))
            continue

        before = text[max(0, m.start() - 150):m.start()]
        after = text[m.end():m.end() + 150]
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.end())
        line = text[line_start:line_end if line_end != -1 else m.end() + 150]

        if REMOVAL_KEYWORDS.search(before) or REMOVAL_KEYWORDS.search(after[:60]):
            buckets["removal_language"].append((doc, label, before[-80:] + "[[" + label + "]]" + after[:80]))
        elif CROSS_DOC_RE.search(before[-80:]):
            buckets["cross_doc_citation"].append((doc, label, before[-80:] + "[[" + label + "]]" + after[:80]))
        elif COMPOUND_LABEL_RE.search(line):
            buckets["naming_collision"].append((doc, label, line.strip()[:160]))
        else:
            buckets["unclassified"].append((doc, label, before[-80:] + "[[" + label + "]]" + after[:80]))

    for bucket, items in buckets.items():
        print(f"=== {bucket}: {len(items)} ===")
        for doc, label, ctx in items[:5]:
            print(f"  {doc} {label}: ...{ctx}...")
        if len(items) > 5:
            print(f"  ... and {len(items) - 5} more")
        print()

    total = sum(len(v) for v in buckets.values())
    noise = len(buckets["removal_language"]) + len(buckets["cross_doc_citation"]) + len(buckets["naming_collision"])
    print(f"Total: {total}. Classified as confirmed noise: {noise} ({100*noise/total:.0f}%). Unclassified (needs real attention): {len(buckets['unclassified'])}.")

    import json
    with open("/tmp/noise_classification.json", "w") as f:
        json.dump(buckets, f, indent=2)
    print("\nFull classification written to /tmp/noise_classification.json")


if __name__ == "__main__":
    main()
