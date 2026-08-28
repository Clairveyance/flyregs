#!/usr/bin/env python3
"""Ensure every FAA JO 7340.2P (Contractions) dictionary entry's definition
actually spells out the letter-for-letter expansion, not just a description.

RC (2026-08-28, in-app feedback, real screenshot of JTST/JTSTR on the
Dictionary letter-J browse screen): "When you have acronyms like this in the
dictionary, you can't just give the definition of what it means you have to
actually spell out the entire acronym make sure this is fixed corpus wide."

Root cause: `sync/author_contractions_definitions.py` (2026-08-26) rewrote
3,116 of 3,282 Contractions entries' bare letter-expansions (e.g. JTST's
original FAA-source text "jet stream") into real descriptive definitions
("narrow band of high-speed winds..."), per its own system prompt's explicit
instruction to REPLACE the expansion with a description. That fixed the
opposite complaint (definitions that were only an expansion, no explanation)
but as a side effect dropped the literal expansion from every entry it
touched -- confirmed directly: the cached FAA source HTML
(sync/.dictionary_contractions_source.html) still has JTST -> "jet stream"
/ JTSTR -> "jet stream" verbatim, matching neither entry's current live text.

Fix: re-parse the same cached FAA source used at original load time (zero
LLM cost, zero drift risk -- it's the exact ground-truth table this whole
dictionary tier is built from) to get the real (term, usage) -> expansion
map, then for every live Contractions sense whose current definition text
doesn't already contain that expansion, prepend it. Entries the Aug 26 pass
intentionally left untouched (plain-English contractions, and the 126
"unsure" acronyms) already show their bare expansion as the whole
definition -- these are skipped, nothing to fix.

Usage:
  python3 scripts/fix_contraction_missing_expansion.py --dry-run   # report only
  python3 scripts/fix_contraction_missing_expansion.py             # apply
"""
import argparse
import datetime
import html
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from author_fact_deck import rest, rest_get_all, SUPABASE_URL, SERVICE_KEY  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE, "sync"))
from load_dictionary_contractions import fetch_html, parse_entries, merge_by_term  # noqa: E402

SOURCE = "FAA JO 7340.2P (Contractions)"


def parse_raw_map():
    """term -> {usage: [ordered raw FAA expansions]}, via the SAME parse/merge
    code path used for the original load -- guarantees identical dedup and
    ordering to what's actually stored in dictionary_terms.senses, so a term
    with multiple same-usage senses (e.g. "A" has 3 distinct NWS meanings)
    matches each DB sense to the right raw expansion, not just the first."""
    rows = merge_by_term(parse_entries(fetch_html()))
    raw = {}
    for r in rows:
        by_usage = {}
        for s in r["senses"]:
            # the source HTML has a handful of un-decoded entities (e.g.
            # AOC/ICAO's "&amp;") that the original loader's regex-only
            # parser never unescapes, plus at least one embedded literal
            # newline (EXEC-2F's cell breaks mid-phrase) -- fix both here
            # rather than touch the loader, since dictionary_terms.senses
            # already stores its copy as-is and re-running that loader is
            # out of scope for this content fix.
            cleaned = " ".join(html.unescape(s["definition"]).split())
            by_usage.setdefault(s["usage"], []).append(cleaned)
        raw[r["term"]] = by_usage
    return raw


def fetch_all_rows():
    return rest_get_all(
        f"/rest/v1/dictionary_terms?source=eq.{urllib.parse.quote(SOURCE)}"
        f"&select=id,term,slug,senses&order=term.asc"
    )


def titlecase_expansion(raw):
    # FAA source text is lowercase free text (e.g. "jet stream", or
    # "tornado/water spout" -- the source itself puts a stray space in some
    # slash-joined compounds). Title-case every alphabetic word wherever it
    # falls (not just space-separated tokens), leave existing all-caps runs
    # (acronyms-within-expansions, e.g. "VOR") and short connector words
    # alone unless they open the string.
    small = {"a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "at", "by", "with"}
    first_word_seen = False

    def cap(m):
        nonlocal first_word_seen
        w = m.group(0)
        is_first = not first_word_seen
        first_word_seen = True
        if m.start() > 0 and raw[m.start() - 1] in "'’":
            return w.lower()  # possessive/contraction remainder, e.g. "President's"
        if w.isupper() and len(w) > 1:
            return w
        if not is_first and w.lower() in small:
            return w.lower()
        return w[:1].upper() + w[1:]

    return re.sub(r"[A-Za-z]+", cap, raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    raw_map = parse_raw_map()
    print(f"Parsed {len(raw_map)} terms from cached FAA source.")

    rows = fetch_all_rows()
    print(f"Fetched {len(rows)} live Contractions entries from dictionary_terms.")

    to_update = []
    no_raw_match = []
    for r in rows:
        senses = r["senses"] or []
        by_usage = raw_map.get(r["term"], {})
        used_idx = {}  # usage -> how many of this usage's raw expansions consumed so far
        new_senses = []
        changed = False
        for s in senses:
            usage = s.get("usage")
            definition = s.get("definition") or ""
            expansions = by_usage.get(usage, [])
            idx = used_idx.get(usage, 0)
            used_idx[usage] = idx + 1
            if idx >= len(expansions):
                no_raw_match.append((r["term"], usage))
                new_senses.append(s)
                continue
            expansion = expansions[idx]
            if expansion.strip().lower() in definition.strip().lower():
                new_senses.append(s)  # already contains the expansion verbatim
                continue
            pretty = titlecase_expansion(expansion.strip())
            new_def = f"{pretty} — {definition}" if definition else pretty
            new_senses.append({**s, "definition": new_def})
            changed = True
        if changed:
            to_update.append({"id": r["id"], "term": r["term"], "slug": r["slug"],
                               "old_senses": senses, "new_senses": new_senses})

    print(f"\n{len(to_update)} entries need the expansion prepended.")
    print(f"{len(no_raw_match)} (term, usage) pairs had no match in the raw source (left untouched).")
    if no_raw_match[:10]:
        print("  sample unmatched:", no_raw_match[:10])

    print("\nSample of planned changes:")
    for t in to_update[:8]:
        print(f"  {t['term']}:")
        for old, new in zip(t["old_senses"], t["new_senses"]):
            if old["definition"] != new["definition"]:
                print(f"    [{old.get('usage')}] BEFORE: {old['definition']!r}")
                print(f"    [{new.get('usage')}] AFTER:  {new['definition']!r}")

    if args.dry_run:
        print("\n--dry-run: no writes made.")
        return

    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    updated = 0
    for t in to_update:
        status, body = rest(
            "PATCH",
            f"/rest/v1/dictionary_terms?id=eq.{t['id']}",
            body={"senses": t["new_senses"], "updated_at": now},
            prefer="return=minimal",
        )
        if status not in (200, 204):
            print(f"  FAILED {t['term']} ({t['id']}): {status} {str(body)[:200]}")
        else:
            updated += 1
    print(f"\nUpdated {updated}/{len(to_update)} entries.")


if __name__ == "__main__":
    main()
