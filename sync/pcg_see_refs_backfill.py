#!/usr/bin/env python3
"""
P/CG-mentions-P/CG-by-name backfill for empty see_refs
========================================================
Corpus-wide investigation (2026-08-10) triggered by RC flagging "IFR TAKEOFF
MINIMUMS AND DEPARTURE PROCEDURES" showing zero MagicLinks despite its own
prose plainly saying "...FAA/DoD Instrument Approach Procedures (IAPs)
Charts..." and "...departure procedures, DPs...". Its see_refs is [] --
the FAA's own glossary source has no structured "See ..." line for it, even
though INSTRUMENT APPROACH PROCEDURE and DEPARTURE PROCEDURE are both real,
separately-defined pcg_terms entries.

This is a DIFFERENT gap from the two existing pcg cross-reference
mechanisms:
  - sync/pcg_citations.py extracts AC/FAR/AIM/AD mentions FROM pcg prose
    (regex on document numbers) -- deliberately does not touch pcg->pcg.
  - sync/pcg_term_links.py extracts P/CG-glossary-phrase mentions found
    INSIDE far/aim/ac/ad/loi prose (the other direction entirely).
Neither one scans a P/CG term's own prose for OTHER P/CG terms' names.
That's what this script does, writing straight into pcg_terms.see_refs --
the existing, intended mechanism for pcg->pcg cross-references (rendered by
pcg/[id].tsx's own "See also" section) -- rather than inventing a second,
parallel mechanism via document_citations.

Reuses pcg_term_links.py's own term index + longest-first, non-overlapping,
word-boundary phrase matcher (import, not reimplementation) for the
multi-word half of its precision rules -- but deliberately does NOT reuse
its single-word allowance (MIN_SINGLE_LEN + doc_freq <= MAX_SINGLE_DF).
Confirmed live by inspecting the first dry-run output before writing
anything: single-word P/CG headwords collide constantly with the SAME word
used in its ordinary English sense inside an unrelated definition --
"DYNAMIC" (real term: "Continuous review, evaluation, and change to meet
demands" -- an ATC flow-control concept) falsely matched inside AIRPLANE's
"...supported by the dynamic reaction of the air..." and inside AIRPORT
ARRIVAL/DEPARTURE RATE's "a dynamic parameter specifying..."; "CONNECTION"
(real term: a CPDLC data-link session) falsely matched inside GROUND
COMMUNICATION OUTLET's "...VHF radio to a telephone connection...". Both
pass pcg_term_links.py's own genericity filter (long enough, corpus
doc_freq low enough against FAR/AIM/AC/AD) because that filter was tuned
against THAT corpus, not against P/CG's own prose, which turns out to
reuse plain-English senses of single-word headwords far more often. Multi-
word phrases carry none of this risk -- pcg_term_links.py's own docstring
already states multi-word terms are "always eligible... unambiguous
wherever they appear," confirmed true again here on manual review of every
2+-word match in the dry run. So this script keeps only nwords >= 2 hits.

SCOPE, deliberately narrow -- measured before touching anything (2026-08-10):
of 1,332 pcg_terms, 926 have a non-null definition; of those, only 8 are
genuinely covered by pcg_citations.py's AC/FAR/AIM/AD regex extraction
(the vast majority of P/CG prose simply doesn't contain a dotted section
number, AIM paragraph, or AD number -- confirmed by manual sample, not a
regex bug; 8 is itself the count AFTER this same session widened AC_RE to
catch slash-form AC numbers, up from 4 before) and 316 already carry
curated, non-empty see_refs from the FAA's own glossary source. This
script only touches the remaining rows: non-null definition AND empty
see_refs AND at least one real, non-self phrase match. A term that already
has curated see_refs keeps them completely untouched -- this fills gaps,
it does not second-guess or append to existing curation.

Uses the plain PostgREST API (SUPABASE_URL + SUPABASE_SERVICE_KEY), NOT the
Supabase Management API -- deliberately, even though the Management API
(mgmt_sql, see scripts/author_fact_deck.py) would have been a few lines
shorter. This script has to run inside sync_pcg.sh's weekly GitHub Actions
job (see that file's own comment for why re-running it every week is
required, not optional), and that workflow's secrets only ever provision
SUPABASE_URL/SUPABASE_SERVICE_KEY (.env.scraper) -- never the management
token, which is deliberately not a CI secret (see pcg_term_links.py's own
header for the same reasoning). A script that only works with the
management token can only ever be run by hand, which is exactly the trap
sync/fix_pcg_see_refs.py fell into (see sync_pcg.sh for that story).

Usage:
  python3 pcg_see_refs_backfill.py --dry-run
  python3 pcg_see_refs_backfill.py
"""
from __future__ import annotations

import argparse
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pcg_term_links import build_term_index, fetch_all, find_terms, MAX_TERM_WORDS  # noqa: E402

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}

MAX_REFS_PER_TERM = 6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
        sys.exit(1)

    idx = build_term_index()
    maxlen = min(max(len(k) for k in idx), MAX_TERM_WORDS)

    all_rows = fetch_all("pcg_terms", "id,slug,term,definition,see_refs")
    rows = [r for r in all_rows if r.get("definition") and not r.get("see_refs")]
    print(f"Scanning {len(rows)} pcg_terms rows with a definition and empty see_refs "
          f"(of {len(all_rows)} total)...")

    updates: list[tuple[str, str, list[str]]] = []
    for r in rows:
        hits = find_terms(r["definition"], idx, maxlen)
        # Exclude self-reference (a term's own headword phrase appearing
        # inside its own prose, e.g. restating part of its own name), and
        # exclude single-word hits entirely -- see module docstring for the
        # confirmed real false positives (DYNAMIC, CONNECTION, ...) that
        # single-word matching produces in THIS specific corpus.
        hits = [h for h in hits if h[0] != r["slug"] and h[2] >= 2]
        if not hits:
            continue
        refs = [h[1] for h in hits[:MAX_REFS_PER_TERM]]
        updates.append((r["id"], r["slug"], refs))

    print(f"{len(updates)} rows would gain see_refs entries.")

    if args.dry_run:
        for pid, slug, refs in updates[:40]:
            print(f"  {slug}: {refs!r}")
        return

    for pid, slug, refs in updates:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/pcg_terms",
            headers={**HEADERS, "Prefer": "return=minimal"},
            params={"id": f"eq.{pid}"},
            json={"see_refs": refs},
            timeout=30,
        )
        resp.raise_for_status()
    print(f"Updated {len(updates)} rows.")


if __name__ == "__main__":
    main()
