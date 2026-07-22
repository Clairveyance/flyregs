#!/usr/bin/env python3
"""
Weekly-sync figure-coverage check for touched (new/updated) ACs — the
follow-up to BB-062 (the 180-doc catalog-wide missing-figures gap). Without
this, extract_figures.py's free bold/ALL-CAPS caption heuristic (sync.sh
step 5) is the only figure-extraction step that ever runs for a newly
scraped AC — and BB-062 proved that heuristic has real, silent blind spots
(non-bold/non-ALL-CAPS captions it simply never detects). A brand-new AC
published with one of those caption styles would get the exact same
silent gap 180 old docs had, forever, unless something checks.

Scoped ONLY to the docs sync.sh step 4 actually touched this run (0-5 docs
in a normal week) — this is NOT a catalog-wide sweep, that's
audit-full-coverage.mjs's job, run manually/occasionally.

Per touched doc:
  1. Find "Figure N"/"Table N" mentions in pdf_text with no matching
     ac_figures row (same detection as audit-full-coverage.mjs check 3).
  2. Filter out the confirmed-noise patterns found closing out BB-062:
     truncated-compound-number PDF artifacts (real label already has a
     row), cross-document citations, "this was removed/relocated" language,
     naming collisions. See classify_residual_final.py for the original,
     more thorough version of this same logic.
  3. Whatever's left gets ONE targeted Vision locate-and-verify attempt
     (reusing llm_locate_missing_figures.py's process_doc directly, not
     reimplemented) — same cheap method validated during BB-062, not
     brute-force page transcription.
  4. Whatever's STILL unresolved after that gets logged to
     figure_recovery_log and causes a non-zero exit — same alerting
     mechanism as audit-parser.mjs's hard findings and the scraper's
     vision-recovery circuit breaker (see sync.sh's header).

Hard circuit breaker (SYNC_FIGURE_MAX_CALLS) independent of everything
above, matching faa_scraper.py's VISION_MAX_PAGES_PER_RUN pattern — this
step should only ever spend a few cents in a normal week; if something
unanticipated makes it want to spend a lot more (e.g. run against --full
mode's hundreds of touched docs), it stops and flags rather than running
away.

Usage: python3 scripts/sync_check_figures.py --docs-file=path [--dry-run]
"""
from __future__ import annotations
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import SUPABASE_URL, HEADERS
import requests
import llm_locate_missing_figures as locator

SYNC_FIGURE_MAX_CALLS = 60  # generous for a normal week (0-5 touched docs), nowhere near a --full run's scale

REMOVAL_KEYWORDS = re.compile(
    r"\b(removes?|removed|rescind(?:ed|s)?|deleted?|no longer (?:included|applicable|available)|"
    r"relocated|now found (?:on|at)|has been (?:removed|deleted|rescinded))\b",
    re.IGNORECASE,
)
CROSS_DOC_RE = re.compile(r"\b(OpSpec|MSpec|AC\s+\d+[.\-]\d+|Advisory Circular \d+[.\-]\d+|RTCA|DO-\d|ICAO)\b", re.IGNORECASE)
COMPOUND_LABEL_RE = re.compile(
    r"\b(Figure|Table)\s+[A-Za-z]?\d+[A-Za-z]?(?:[-.·]\d+[A-Za-z]?)?\.?\s+[A-Za-z][^.]{0,60}?\b(Figure|Table)\s+[0-9]",
    re.IGNORECASE,
)
TRUNCATION_FOLLOW_RE = re.compile(r"^\s{0,3}[-.·]\s{0,3}[0-9A-Za-z]")
FIGURE_RE = re.compile(r"\b(FIGURE|Figure|TABLE|Table)\s+([0-9][0-9A-Za-z.\-]*)\b")


def find_missing_labels(ac_id: str, doc_num: str, pdf_text: str) -> list[tuple[str, str, str]]:
    """Returns [(kind, num, label)] for labels mentioned in pdf_text with no
    matching ac_figures row, after filtering the known confirmed-noise
    patterns from BB-062. Mirrors classify_residual_final.py's logic."""
    if not pdf_text:
        return []
    resp = requests.get(f"{SUPABASE_URL}/rest/v1/ac_figures?ac_id=eq.{ac_id}&select=label", headers=HEADERS, timeout=30)
    resp.raise_for_status()
    existing = {r["label"].lower().strip() for r in resp.json()}
    existing_raw = {r["label"] for r in resp.json()}

    # Keep the ORIGINAL match (position + as-printed text), not just the
    # normalized "Figure N" label -- re-finding the normalized label via
    # .find() is case-sensitive and silently misses every ALL-CAPS caption
    # ("FIGURE 5" in the text vs. "Figure 5" after normalizing), caught via
    # a synthetic test before this shipped. First occurrence per normalized
    # label wins, same as extract_figures.py's own dedup rule.
    seen = {}
    for m in FIGURE_RE.finditer(pdf_text):
        kind = "Figure" if m.group(1)[0].upper() == "F" else "Table"
        num = m.group(2).rstrip(".")
        label = f"{kind} {num}"
        if label not in seen:
            seen[label] = (kind, num, m.start(), m.end())

    genuinely_missing = []
    for label, (kind, num, idx, match_end) in seen.items():
        if label.lower() in existing:
            continue

        after = pdf_text[match_end:match_end + 20]

        # Context scoped to the current PARAGRAPH only (nearest blank-line
        # boundary), not a blind character window -- a fixed-width slice can
        # bleed an unrelated preceding sentence's content (e.g. a cross-doc
        # citation in the paragraph BEFORE this label) into the check and
        # wrongly suppress a genuinely missing figure. Caught via a synthetic
        # test before this shipped: "...OpSpec/MSpec A025, Table 2...\n\nFIGURE
        # 5. A Real New Diagram" incorrectly classified FIGURE 5 as a
        # cross-doc citation because "OpSpec" fell inside a fixed 80-char
        # lookback, even though it belonged to the previous paragraph.
        para_start = pdf_text.rfind("\n\n", 0, idx)
        para_start = 0 if para_start == -1 else para_start + 2
        para_start = max(para_start, idx - 300)  # still bounded, for very long paragraphs
        before = pdf_text[para_start:idx]
        para_end = pdf_text.find("\n\n", match_end)
        para_end = len(pdf_text) if para_end == -1 else para_end
        para_end = min(para_end, match_end + 300)
        after_para = pdf_text[match_end:para_end]

        if TRUNCATION_FOLLOW_RE.match(after):
            has_compound_row = any(
                lbl.lower().startswith(f"{kind.lower()} {num}-") or lbl.lower().startswith(f"{kind.lower()} {num}.")
                for lbl in existing_raw
            )
            if has_compound_row:
                continue  # confirmed truncated-compound artifact, not real

        if REMOVAL_KEYWORDS.search(before) or REMOVAL_KEYWORDS.search(after_para[:60]):
            continue
        if CROSS_DOC_RE.search(before):
            continue
        line_start = pdf_text.rfind("\n", 0, idx) + 1
        line_end = pdf_text.find("\n", match_end)
        line = pdf_text[line_start:line_end if line_end != -1 else match_end + 150]
        if COMPOUND_LABEL_RE.search(line):
            continue

        genuinely_missing.append((kind, num, label))

    return genuinely_missing


def log_figure_recovery(doc_num: str, attempted: int, resolved: int, still_missing: list[str]) -> None:
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/figure_recovery_log",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={
                "document_number": doc_num,
                "labels_attempted": attempted,
                "labels_resolved": resolved,
                "labels_still_missing": still_missing,
                "est_cost_usd": round(attempted * 0.01875, 4),
            },
            timeout=30,
        )
    except Exception as e:
        print(f"    (failed to write figure_recovery_log for {doc_num}: {e})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs-file", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    doc_nums = [s.strip() for s in open(args.docs_file).read().split("\n") if s.strip()]
    if not doc_nums:
        print("sync_check_figures: --docs-file was empty — nothing changed, nothing to check.")
        return

    print(f"Figure-coverage check: {len(doc_nums)} touched doc(s)")
    client = None if args.dry_run else locator.get_anthropic_client()
    total_calls = 0
    circuit_tripped = False
    needs_attention = []

    for doc_num in doc_nums:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{doc_num}&select=id,pdf_text,pdf_url_cached,pdf_url_faa",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if not rows:
            continue
        ac = rows[0]
        missing = find_missing_labels(ac["id"], doc_num, ac.get("pdf_text") or "")
        if not missing:
            print(f"  {doc_num}: no figure-coverage gaps found")
            continue

        pdf_url = ac.get("pdf_url_cached") or ac.get("pdf_url_faa")
        if not pdf_url:
            print(f"  {doc_num}: {len(missing)} gap(s) found but no PDF URL to recover from")
            needs_attention.append(f"{doc_num}: no PDF URL")
            continue

        if circuit_tripped or total_calls + len(missing) > SYNC_FIGURE_MAX_CALLS:
            circuit_tripped = True
            print(f"  {doc_num}: CIRCUIT BREAKER — skipping ({len(missing)} gap(s) would exceed the {SYNC_FIGURE_MAX_CALLS}-call/run cap)")
            needs_attention.append(f"{doc_num}: circuit breaker tripped, {len(missing)} unattempted")
            continue

        print(f"  {doc_num}: {len(missing)} genuine gap(s) found ({[l for _,_,l in missing]}) — attempting recovery")
        if args.dry_run:
            total_calls += len(missing)
            continue

        stats = {"vision_calls": 0, "resolved": 0, "unresolved": 0}
        locator.process_doc(client, ac["id"], doc_num, pdf_url, False, stats)
        total_calls += stats["vision_calls"]

        # Re-check what's still missing after the recovery attempt.
        resp2 = requests.get(f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{doc_num}&select=pdf_text", headers=HEADERS, timeout=30)
        fresh_text = resp2.json()[0]["pdf_text"] or ""
        still_missing_tuples = find_missing_labels(ac["id"], doc_num, fresh_text)
        still_missing = [l for _, _, l in still_missing_tuples]
        resolved_count = len(missing) - len(still_missing)
        log_figure_recovery(doc_num, len(missing), resolved_count, still_missing)
        if still_missing:
            needs_attention.append(f"{doc_num}: {still_missing}")

    print(f"\nFigure-coverage check done. {total_calls} Vision call(s) this run.")
    if needs_attention:
        print(f"\n✗ {len(needs_attention)} doc(s) still need attention after recovery attempts:")
        for item in needs_attention:
            print(f"  {item}")
        sys.exit(1)


if __name__ == "__main__":
    main()
