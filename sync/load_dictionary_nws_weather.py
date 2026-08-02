#!/usr/bin/env python3
"""Aviation Dictionary weather tier: NOAA/National Weather Service's own
public Glossary (forecast.weather.gov/glossary.php) -- 2000+ terms.

Why this source: the Aviation Weather Handbook (FAA-H-8083-28B) has NO
standalone glossary -- only Appendix E's acronym list (already loaded by
load_dictionary_weather_appendix_e.py). RC (2026-08-01), after spotting
real weather concept terms missing from search ("virga", "cumulonimbus",
"isobar", "dew point", etc. all confirmed absent): "i'm sure there are
more Wx related terms, we'll need to find them somewhere. That's a big
one." NWS's glossary is the authoritative government source for exactly
this content -- official NOAA terminology, not a third-party wordlist,
same sourcing standard as every other tier here.

No LLM used: forecast.weather.gov/glossary.php?letter=X is clean, static
`<dt><b>Term</b></dt><dd>Definition</dd>` HTML, parsed directly.

Usage:
  python3 sync/load_dictionary_nws_weather.py --dry-run
  python3 sync/load_dictionary_nws_weather.py
"""
import argparse, os, re, sys, time, urllib.request

from bs4 import BeautifulSoup

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import rest, mgmt_sql  # noqa: E402

LETTERS = list("abcdefghijklmnopqrstuvwxyz") + ["number"]
BASE_URL = "https://forecast.weather.gov/glossary.php?letter={}"
SOURCE = "NOAA/National Weather Service Glossary (forecast.weather.gov/glossary.php)"

# NWS's mandate covers river/flood forecasting as well as weather -- this
# glossary mixes in real hydrology jargon (dams, reservoirs, streamflow)
# that has nothing to do with aviation. RC flagged the weather-term gap
# ("that's a big one") but an Aviation Dictionary entry for "Arch Dam" or
# "Bankfull Stage" would be noise, not signal. Checked live (2026-08-01):
# 246 of 2,540 new terms match one of these -- kept deliberately narrow
# (specific hydrology infrastructure/measurement terms) after "irrigation"
# and "water supply" alone turned out to false-positive on legitimate
# climate terms like "Arid".
HYDROLOGY_MARKERS = [
    "dam ", "dam,", "dam.", "dam)", "reservoir", "streamflow", "stream flow",
    "river stage", "watershed", "gage height", "gauge height", "flood stage",
    "runoff", "drainage basin", "levee", "spillway", "hydrograph", "aquifer",
    "stream gauge", "stream gage", "hydroelectric", "backwater",
]


def slugify(term):
    s = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return s or "term"


def fetch_letter(letter):
    req = urllib.request.Request(BASE_URL.format(letter), headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", errors="replace")
    soup = BeautifulSoup(html, "html.parser")
    entries = []
    for dt in soup.find_all("dt"):
        b = dt.find("b")
        if not b:
            continue
        term = b.get_text(strip=True)
        dd = dt.find_next_sibling("dd")
        if not term or not dd:
            continue
        defn = dd.get_text(" ", strip=True)
        defn = re.sub(r"\s+", " ", defn).strip()
        if term and defn:
            entries.append((term, defn))
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    all_entries = []
    for letter in LETTERS:
        entries = fetch_letter(letter)
        print(f"  {letter}: {len(entries)} entries")
        all_entries.extend(entries)
        time.sleep(0.3)  # polite to a government server, not a rate-limit workaround

    print(f"Total: {len(all_entries)} raw entries.")

    def is_hydrology(term, defn):
        low = f"{term} {defn}".lower()
        return any(m in low for m in HYDROLOGY_MARKERS)

    hydro_count = sum(1 for t, d in all_entries if is_hydrology(t, d))
    all_entries = [(t, d) for t, d in all_entries if not is_hydrology(t, d)]
    print(f"Excluded {hydro_count} hydrology-only entries (dams/reservoirs/streamflow -- not aviation-relevant).")

    existing = {r["term"].lower() for r in mgmt_sql("select term from dictionary_terms")}
    merged = {}
    for term, defn in all_entries:
        key = term.lower()
        if key in existing:
            continue
        merged.setdefault(key, {"term": term, "defs": []})
        if defn.lower() not in {d.lower() for d in merged[key]["defs"]}:
            merged[key]["defs"].append(defn)

    rows = [{
        "term": e["term"],
        "slug": f"wx-{slugify(e['term'])}",
        "letter": e["term"][0].upper() if e["term"][0].isalpha() else "#",
        "category": "handbook",
        "senses": [{"definition": d, "usage": None} for d in e["defs"]],
        "source": SOURCE,
    } for e in merged.values()]
    print(f"{len(rows)} new terms not already covered by an earlier tier.")

    if args.dry_run:
        for r in rows[:15]:
            print(f"  {r['term']}: {r['senses'][0]['definition'][:100]}")
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
    print(f"Upserted {upserted} rows.")


if __name__ == "__main__":
    main()
