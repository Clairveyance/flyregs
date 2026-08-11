#!/usr/bin/env python3
"""Corpus-wide LOI text-quality scan. Fetches every legal_interpretations
row via the service key (bypasses RLS/gated view redaction), scores each
for OCR-garbling signals (dictionary-miss ratio + spurious mid-word-space
splitting + junk symbol runs), and reports the worst offenders + aggregate
stats. No external API, no cost -- pure local text analysis against
/usr/share/dict/words (macOS built-in; on Linux, `apt install wamerican`
or point DICT_PATH elsewhere).

Built 2026-08-11 after RC reported "messy symbols and misspelled words" in
LOIs around FAR 91.185 -- confirmed real and widespread (see
PROJECT_NOTES/flyregs_pending.md's entry that day): ~40% of the 1055-doc
corpus scores badness >= 3.0, worst cases have nearly every word split by
spurious spaces ("Thi s is i n response t o your..."). Root cause: the
scraper (loi_scraper.py) extracts the PDF's own embedded OCR text layer
as-is (PyMuPDF's page.get_text()) -- there's no independent re-OCR, so
whatever quality the FAA's own DRS system baked in at scan time is what
ships. No code-level parsing fix is possible; a bad scan's text is bad at
the source. This script is for finding/prioritizing which documents would
actually benefit from a Vision-based re-extraction pass -- NEVER run
Vision without asking first, it costs real money (see memory/
feedback_ask_before_vision.md).

Usage: python3 scripts/loi_quality_scan.py [--backfill]
  (no args)   Print the report only.
  --backfill  Also write each row's score to legal_interpretations.
              ocr_quality_score (adds the column if missing).
"""
import json
import re
import os
import sys
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICT_PATH = "/usr/share/dict/words"

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

with open(DICT_PATH) as f:
    DICT = set(w.strip().lower() for w in f if w.strip())

# Common aviation/legal/regulatory jargon and abbreviations that a general
# dictionary won't have -- without this, every LOI would score as "bad"
# just for being about aviation, drowning out the real signal.
EXTRA_WORDS = set(w.lower() for w in [
    "faa", "atc", "ifr", "vfr", "cfr", "pic", "sic", "atp", "cfi", "cfii",
    "faq", "notam", "tfr", "afm", "poh", "ads-b", "adsb", "gps", "rnav",
    "far", "nprm", "usc", "dot", "faaa", "flightdeck", "airman", "airmen",
    "aeronautical", "avionics", "faasteam", "faasafety", "vnav", "lnav",
    "eta", "etop", "etops", "mel", "kts", "agl", "msl", "mvfr", "sigmet",
    "airmet", "metar", "taf", "squawk", "transponder", "loi", "sfar",
])
DICT |= EXTRA_WORDS


def fetch_all(table, select, extra=""):
    rows = []
    offset = 0
    page = 1000
    while True:
        r = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/{table}?select={select}{extra}&limit={page}&offset={offset}",
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


WORD_RE = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
JUNK_RUN_RE = re.compile(r"[^\w\s.,;:'\"()\[\]§/-]{2,}")
LONE_LETTER_EXCEPT = {"a", "i"}


def score(text):
    if not text:
        return None
    words = WORD_RE.findall(text)
    if len(words) < 20:
        return None
    total = len(words)
    lone_letters = sum(1 for w in words if len(w) == 1 and w.lower() not in LONE_LETTER_EXCEPT)
    non_dict = sum(1 for w in words if len(w) > 1 and w.lower() not in DICT)
    junk_runs = len(JUNK_RUN_RE.findall(text))
    lone_ratio = lone_letters / total
    non_dict_ratio = non_dict / total
    junk_per_1000 = junk_runs / (len(text) / 1000) if text else 0
    # Composite badness score -- weighted sum, tuned so "A via ti on"-style
    # spurious-spacing garbling (high lone_letter_ratio) and genuine OCR
    # noise (high non_dict_ratio + junk_runs) both surface near the top.
    badness = lone_ratio * 40 + non_dict_ratio * 10 + min(junk_per_1000, 5) * 2
    return {
        "total_words": total,
        "lone_letter_ratio": lone_ratio,
        "non_dict_ratio": non_dict_ratio,
        "junk_runs_per_1000chars": junk_per_1000,
        "text_len": len(text),
        "badness": badness,
    }


def main():
    backfill = "--backfill" in sys.argv

    print("Fetching full LOI corpus (service key, bypasses redaction)...")
    rows = fetch_all("legal_interpretations", "id,slug,title,cfr_section_reference,text_quality,body_text")
    print(f"Fetched {len(rows)} rows total.\n")

    scored = []
    no_body = 0
    for r in rows:
        s = score(r.get("body_text"))
        if s is None:
            no_body += 1
            continue
        s["id"] = r["id"]
        s["slug"] = r["slug"]
        s["title"] = r["title"]
        s["cfr"] = r.get("cfr_section_reference")
        s["text_quality"] = r.get("text_quality")
        scored.append(s)

    print(f"{no_body} rows had no/too-short body_text (excluded from scoring).")
    print(f"{len(scored)} rows scored.\n")

    scored.sort(key=lambda s: -s["badness"])
    print("=== Worst 30 by composite badness score ===")
    for s in scored[:30]:
        print(f"  [{s['badness']:.2f}] {s['slug']} | cfr={s['cfr']} | lone={s['lone_letter_ratio']:.3f} non_dict={s['non_dict_ratio']:.3f} junk/1k={s['junk_runs_per_1000chars']:.2f}")
        print(f"      title: {s['title']}")

    thresholds = [0.5, 1.0, 2.0, 3.0, 5.0]
    print("\n=== How many LOIs exceed each badness threshold ===")
    for t in thresholds:
        n = sum(1 for s in scored if s["badness"] >= t)
        print(f"  >= {t}: {n} ({100*n/len(scored):.1f}%)")

    if backfill:
        print("\n--backfill: writing ocr_quality_score for all scored rows...")
        print("(requires the ocr_quality_score column to already exist -- see")
        print(" sync/migrations_add_loi_ocr_quality_score.sql)")
        # One PATCH per row via the REST API (service key, bypasses RLS) --
        # simplest approach and plenty fast for ~1000 rows.
        for s in scored:
            req = urllib.request.Request(
                f"{SUPABASE_URL}/rest/v1/legal_interpretations?id=eq.{s['id']}",
                data=json.dumps({"ocr_quality_score": round(s["badness"], 3)}).encode(),
                headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
                method="PATCH",
            )
            urllib.request.urlopen(req)
        print(f"Backfilled {len(scored)} rows.")


if __name__ == "__main__":
    main()
