#!/usr/bin/env python3
"""Load the Aviation Dictionary's first tier: FAA Order JO 7340.2's official
Contractions decode table (dictionary_terms, category='contraction').

RC (2026-08-01): "the scope/schema for the A/D - large, compendium-sized,
full mastery. All terms, all acronyms, all obscure words, phrases,
references, oddities." This is the highest-value, zero-LLM-cost tier: JO
7340.2 is a public-domain FAA order that's ALREADY term -> definition pairs
(3,326 unique contractions, 3,629 total senses -- e.g. "A" legitimately
means 4 different things depending on GEN/NWS/ATC/ICAO context), so it loads
as structured data with no authoring pass needed. See
sync/migrations_dictionary_terms.sql for why this is its own table rather
than folded into pcg_terms.

Source: https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap2_section_1.html
(fetched 2026-08-01, JO 7340.2P effective 7/9/2026, Change 3)

Usage:
  python3 sync/load_dictionary_contractions.py --dry-run   # parse + report counts only
  python3 sync/load_dictionary_contractions.py             # actually upsert
"""
import argparse, json, os, re, sys, urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, SUPABASE_URL, SERVICE_KEY  # noqa: E402

SOURCE_URL = "https://www.faa.gov/air_traffic/publications/atpubs/cnt_html/chap2_section_1.html"
CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".dictionary_contractions_source.html")
USAGE_CODES = {"GEN", "NWS", "ATC", "ICAO", "METAR", "METAR/TAF", "TAF"}


def fetch_html():
    if os.path.exists(CACHE_PATH):
        return open(CACHE_PATH, encoding="utf-8").read()
    req = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", errors="ignore")
    with open(CACHE_PATH, "w", encoding="utf-8") as f:
        f.write(html)
    return html


def parse_entries(html):
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.DOTALL)
    entries = []
    for row in rows:
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)]
        cells = [c.replace("\xad", "") for c in cells]  # strip soft-hyphen line-break artifacts (never eat real spaces around them)
        if len(cells) == 3 and cells[0] and cells[0] != "Contraction" and cells[1] != "Definition" and cells[2] in USAGE_CODES:
            entries.append({"term": cells[0], "definition": cells[1], "usage": cells[2]})
    return entries


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def merge_by_term(entries):
    merged = {}
    for e in entries:
        merged.setdefault(e["term"], []).append({"definition": e["definition"], "usage": e["usage"]})
    rows = []
    for term, senses in merged.items():
        # de-dupe identical (definition, usage) pairs -- a handful of contractions
        # are listed twice verbatim in the source table
        seen, uniq = set(), []
        for s in senses:
            key = (s["definition"], s["usage"])
            if key not in seen:
                seen.add(key)
                uniq.append(s)
        rows.append({
            "term": term,
            "slug": f"cnt-{slugify(term)}",
            "letter": term[0].upper() if term[0].isalpha() else "#",
            "category": "contraction",
            "senses": uniq,
            "source": "FAA JO 7340.2P (Contractions)",
        })

    # A handful of distinct terms slugify to the same string once symbols/case
    # are stripped (e.g. "+FC" and "FC" both -> "cnt-fc") -- disambiguate with
    # a stable numeric suffix rather than let one silently overwrite the other.
    seen_slugs = {}
    for r in rows:
        base = r["slug"]
        seen_slugs[base] = seen_slugs.get(base, 0) + 1
        if seen_slugs[base] > 1:
            r["slug"] = f"{base}-{seen_slugs[base]}"
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    html = fetch_html()
    entries = parse_entries(html)
    rows = merge_by_term(entries)
    print(f"Parsed {len(entries)} raw senses -> {len(rows)} unique contraction terms.")

    multi = [r for r in rows if len(r["senses"]) > 1]
    print(f"{len(multi)} terms have multiple senses (e.g. {multi[0]['term']!r}: {len(multi[0]['senses'])} senses)" if multi else "")

    if args.dry_run:
        print("Sample rows:")
        for r in rows[:3]:
            print(" ", json.dumps(r, indent=2))
        return

    BATCH = 500
    upserted = 0
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        status, body = rest("POST", "/rest/v1/dictionary_terms?on_conflict=slug",
                             body=chunk, prefer="resolution=merge-duplicates,return=minimal")
        if status not in (200, 201, 204):
            print(f"  chunk {i}: HTTP {status}: {str(body)[:300]}")
        else:
            upserted += len(chunk)
    print(f"Upserted {upserted} rows into dictionary_terms.")


if __name__ == "__main__":
    main()
