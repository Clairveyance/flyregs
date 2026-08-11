#!/usr/bin/env python3
"""Detects and (optionally) strips OCR-artifact garbage lines from
document body_text: runs of consecutive lines that are almost entirely
non-alphabetic symbol noise (~, ·, runs of .-;:_ etc.), zero real words,
sandwiched inside otherwise-normal prose. This is a DIFFERENT pattern
than the word-splitting garbling loi_quality_scan.py measures ("Thi s is
i n response") -- that's individual words getting spurious spaces; this
is whole LINES of pure symbol garbage, typically from the OCR engine
trying to read a graphic (FAA seal/letterhead logo, a page-break
watermark/margin) as text.

Built 2026-08-11 after RC screenshotted 2 such blocks in the Van West
2018 LOI (one at the very top, from the FAA letterhead seal graphic; one
mid-document, most likely a page-break/margin artifact) and asked for a
corpus-wide hunt across LOI *and* all other doc-sourced content (AC, AD).

Detection is conservative by design -- would rather under-strip than
risk deleting real content:
  - a line is "junk" only if it has ZERO words of length >= 3 AND either
    contains a weird/non-prose symbol (~ · _ • etc.) or a run of 4+
    punctuation-only characters
  - a "run" requires 2+ consecutive junk lines, OR a single junk line
    directly adjacent to a near-empty line (a lone quote mark, "i", a
    single period) that's clearly part of the same garbled block, not
    real content on its own
  - never touches a line with 2+ real words, no matter what symbols
    surround it

Usage:
  python3 scripts/ocr_artifact_scan.py <table> [--limit N] [--apply]
  <table>    legal_interpretations | advisory_circulars | airworthiness_directives
  (no --apply) dry run: reports every doc with a detected run + before/after preview
  --apply    writes the cleaned body_text back for every doc with a detected run
"""
import json
import os
import re
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = {}
with open(os.path.join(BASE, ".env.scraper")) as f:
    for line in f:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
SUPABASE_URL = env["SUPABASE_URL"]
SERVICE_KEY = env["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

TABLES = {
    "legal_interpretations": ("id", "slug", "body_text"),
    "advisory_circulars": ("id", "document_number", "pdf_text"),
    "airworthiness_directives": ("id", "ad_number", "body_text"),
}

WORD_RE = re.compile(r"[A-Za-z]+")
WEIRD_CHARS = set("~^·¬±¤¦«»¶†‡")
# `` and '' are standard federal-register/typewriter-era stylized open/
# close quotes ("`AD 2015-20-13''") -- extremely common in AD citation
# text, not OCR noise. Backtick was in WEIRD_CHARS and wrongly flagged
# real citations as garbage -- found by dry-running against AD before
# ever applying anything there.
PUNCT_RUN_RE = re.compile(r"[.\-·~:;,'\"_]{4,}")
# A short line with real structure -- "(c)", "(ii)", "2.", "Re:" -- never
# gets swallowed into a removal run. A BARE lone letter with no
# parens/colon/digit ("I", "l", "c" on its own line) does NOT match this
# and stays bridgeable, since that's much more likely OCR noise (a stray
# vertical scan artifact) than a real structural marker.
STRUCTURAL_RE = re.compile(r"^(\([a-zA-Z0-9]{1,4}\)\.?|[0-9]{1,4}\.?|[A-Za-z]{2,3}:)$")


def is_junk_line(line):
    s = line.strip()
    if not s:
        return "blank"
    words = WORD_RE.findall(s)
    real_words = sum(1 for w in words if len(w) >= 3)
    if real_words >= 2:
        return False
    no_space = re.sub(r"\s+", "", s)
    has_letter = re.search(r"[A-Za-z]", no_space) is not None
    has_digit = re.search(r"[0-9]", no_space) is not None
    weird = sum(1 for c in s if c in WEIRD_CHARS)
    punct_run = PUNCT_RUN_RE.search(s) is not None
    # Pure punctuation/symbol content -- zero letters AND zero digits --
    # is junk even without 4 *consecutive* junk chars (". ,. -.; " has no
    # single 4-run since spaces break it up, but is unambiguously not
    # prose). Requiring "no digits either" is what keeps this from
    # swallowing real citations/list markers/page numbers: "§
    # 91.185(c)(3)(ii)", "(2)", "1.", "- 2 -" all have zero LETTERS too
    # but every one of them has a digit, which pure OCR-graphic garbage
    # essentially never does.
    pure_symbols = not has_letter and not has_digit and len(no_space) >= 2
    if real_words == 0 and (weird > 0 or punct_run or pure_symbols) and len(s) < 60:
        return "junk"
    if real_words == 0 and len(s) <= 4:
        if STRUCTURAL_RE.match(s):
            # "(c)", "(ii)", "2.", "Re:" -- a short but real structural
            # marker (subsection label, page number, list number). Never
            # silently swallowed into a run just for being short and
            # adjacent to garbage -- found via a real case: FAR 91.119(b)/
            # (c) quoted with their actual text lost to bad OCR, leaving
            # "(b)" / dots / "(c)" / dots -- an earlier version of this
            # bridge logic deleted the "(c)" label itself along with the
            # dots, silently turning "a, b(missing), c(missing), d" into
            # what reads like "a, d" with no sign b/c ever existed. That's
            # worse than leaving the dots -- a reader should be able to
            # tell content is missing, not have it erased.
            return "protected"
        return "tiny"  # e.g. a lone "'", ". i", "I" -- bridgeable, likely noise
    return False


def find_runs(text):
    lines = text.split("\n")
    kinds = [is_junk_line(l) for l in lines]
    runs = []
    i = 0
    while i < len(lines):
        if kinds[i] == "junk":
            start = i
            end = i
            j = i + 1
            gap = 0
            # Bridge across tiny/blank lines toward another junk line, but
            # only across a SHORT gap (<=1 line) -- otherwise a run can
            # greedily swallow real short content sitting between two
            # unrelated junk blocks (found via a real case: "(b) ......"
            # then "(c)" -- a genuine subsection label, not garbage --
            # then more dots; a gap of only 1 kept "(c)" itself as the
            # sole tiny line in the middle, but an unbounded bridge would
            # have merged that with anything short nearby too).
            while j < len(lines) and gap <= 1:
                if kinds[j] == "junk":
                    end = j
                    j += 1
                    gap = 0
                elif kinds[j] in ("tiny", "blank"):
                    j += 1
                    gap += 1
                else:
                    break
            # also absorb a leading tiny/blank line immediately before start
            k = start - 1
            while k >= 0 and kinds[k] in ("tiny", "blank"):
                start = k
                k -= 1
            runs.append((start, end))
            i = end + 1
        else:
            i += 1
    return lines, runs


def clean_text(text):
    lines, runs = find_runs(text)
    if not runs:
        return text, 0
    keep = [True] * len(lines)
    for start, end in runs:
        for idx in range(start, end + 1):
            keep[idx] = False
    cleaned_lines = [l for l, k in zip(lines, keep) if k]
    # collapse resulting runs of 3+ blank lines down to 2 (one blank
    # paragraph break), don't obsess over exact spacing beyond that
    cleaned = "\n".join(cleaned_lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned, len(runs)


def fetch_all(table, select):
    rows = []
    offset = 0
    page = 1000
    while True:
        r = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/{table}?select={select}&limit={page}&offset={offset}",
            headers=HEADERS,
        )
        batch = json.loads(urllib.request.urlopen(r).read().decode())
        if not batch:
            break
        rows.extend(batch)
        offset += page
        if len(batch) < page:
            break
    return rows


def main():
    args = sys.argv[1:]
    apply = "--apply" in args
    args = [a for a in args if a != "--apply"]
    limit = None
    if "--limit" in args:
        idx = args.index("--limit")
        limit = int(args[idx + 1])
        args = args[:idx] + args[idx + 2:]
    table = args[0] if args else "legal_interpretations"
    id_col, label_col, text_col = TABLES[table]

    print(f"Fetching {table} ({text_col})...")
    rows = fetch_all(table, f"{id_col},{label_col},{text_col}")
    if limit:
        rows = rows[:limit]
    print(f"{len(rows)} rows fetched.\n")

    affected = []
    for r in rows:
        text = r.get(text_col)
        if not text:
            continue
        cleaned, n_runs = clean_text(text)
        if n_runs:
            affected.append((r, text, cleaned, n_runs))

    print(f"=== {len(affected)}/{len(rows)} docs have >=1 detected junk-line run ===\n")
    total_runs = sum(a[3] for a in affected)
    print(f"Total runs across corpus: {total_runs}\n")

    for r, orig, cleaned, n_runs in affected[:15]:
        print(f"--- {r[label_col]} ({n_runs} run(s), {len(orig)-len(cleaned)} chars removed) ---")
        # show first removed run in context
        lines, runs = find_runs(orig)
        s, e = runs[0]
        ctx_before = " ".join(l.strip() for l in lines[max(0, s-2):s] if l.strip())
        ctx_after = " ".join(l.strip() for l in lines[e+1:e+3] if l.strip())
        removed = " | ".join(repr(l) for l in lines[s:e+1] if l.strip())
        print(f"  BEFORE: ...{ctx_before[-80:]} [[{removed}]] {ctx_after[:80]}...")
        print()

    if apply:
        print(f"--apply: writing cleaned {text_col} for {len(affected)} rows...")
        for r, orig, cleaned, n_runs in affected:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/{table}?{id_col}=eq.{r[id_col]}",
                data=json.dumps({text_col: cleaned}).encode(),
                headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
                method="PATCH",
            )
            urllib.request.urlopen(req)
        print(f"Done, {len(affected)} rows updated.")
    else:
        print("Dry run only -- pass --apply to write cleaned text back.")


if __name__ == "__main__":
    main()
