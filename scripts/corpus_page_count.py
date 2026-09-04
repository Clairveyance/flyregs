#!/usr/bin/env python3
"""How many pages of source material is FlyRegs actually carrying?

RC, 2026-09-04: "the 50,000 pages info, you DID do a approx page count a
long while back... it would be good to test that number again."

The number goes on the website, so it has to survive someone asking how it
was arrived at. This measures it from the live database, and -- the part
that matters -- measures the characters-per-page conversion from real FAA
PDFs rather than assuming one.

WHY THE CONVERSION HAD TO BE MEASURED
-------------------------------------
Nothing in the corpus is stored as pages; it is stored as sections,
paragraphs and documents. Pages have to be derived from characters, and the
whole answer rests on the chars-per-page figure. A plausible-sounding
desk estimate (500 words x 6 chars = 3,000) turns out to be ~45% too high
for this material, because FAA documents carry figures, tables, headers and
white space that consume page area without contributing characters. Guessing
it would have understated the corpus by roughly a third.

So --measure downloads a random sample of real Advisory Circular PDFs,
counts their actual page objects, and divides by the characters we hold for
those same documents. Measured 2026-09-04 across 33 ACs and 1,124 real
pages: 2,060 characters per page.

That density is applied to the PDF-derived corpora it was measured on (AC,
AD, LOI -- together ~91% of all characters). The web-derived text (FAR,
AIM, 49 CFR, P/CG, dictionary) keeps the conservative 3,000, because it has
no page furniture and no measurement of its own; assuming it is as sparse
as a scanned AC would inflate the total.

Both directions of error are deliberate: every unmeasured choice here
rounds AGAINST the headline number, and the published claim is then rounded
down to the nearest 5,000. What goes on the site should be a floor the
corpus has cleared, not a ceiling it is reaching for.

Usage:
  python3 scripts/corpus_page_count.py            # count, using the cached density
  python3 scripts/corpus_page_count.py --measure  # re-measure density from real PDFs
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Measured 2026-09-04: 33 Advisory Circulars, 1,124 real PDF pages,
# 2,314,971 characters. Re-derive with --measure.
PDF_CHARS_PER_PAGE = 2060
# Web-derived text has no page furniture, so it is denser per page. Left as
# the conservative desk estimate rather than a measured one, which biases
# the total DOWN -- see the module docstring.
TEXT_CHARS_PER_PAGE = 3000

SOURCES = [
    # (label, table, text expression, which density applies)
    ("Advisory Circulars",       "advisory_circulars",       "length(coalesce(pdf_text,''))", "pdf"),
    ("Airworthiness Directives", "airworthiness_directives", "length(coalesce(body_text,''))", "pdf"),
    ("Legal Interpretations",    "legal_interpretations",    "length(coalesce(body_text,''))", "pdf"),
    ("FAR (14 CFR)",             "far_sections",             "length(coalesce(body_text,''))", "text"),
    ("AIM",                      "aim_paragraphs",
     "length(coalesce(body_text,'')) + length(coalesce(reference_text,''))", "text"),
    ("49 CFR",                   "cfr49_sections",           "length(coalesce(body_text,''))", "text"),
    ("Pilot/Controller Glossary", "pcg_terms",               "length(coalesce(definition,''))", "text"),
    ("Aviation dictionary",      "dictionary_terms",         "length(coalesce(senses::text,''))", "text"),
]


def sql(query):
    out = subprocess.run(
        [sys.executable, os.path.join(BASE, "scripts", "supabase_mgmt_api.py"), "query", query],
        capture_output=True, text=True, timeout=180)
    try:
        return json.loads(out.stdout)
    except Exception:
        raise SystemExit(f"query failed: {out.stdout[:300]}{out.stderr[:300]}")


def env(key, path=".env.scraper"):
    m = re.search(rf"^\s*(?:export\s+)?{key}=(.+)$", open(os.path.join(BASE, path)).read(), re.M)
    return m.group(1).strip()


def measure_density(sample_size=35):
    """Download real AC PDFs and count their actual pages.

    Page objects are counted straight out of the PDF bytes (`/Type /Page`
    not followed by an `s`, which would be the /Pages tree node) rather
    than with a PDF library -- no dependency, and it is exact for every
    linearised FAA PDF checked by hand against a viewer.
    """
    url, key = env("SUPABASE_URL"), env("SUPABASE_SERVICE_KEY")
    req = urllib.request.Request(
        f"{url}/rest/v1/advisory_circulars"
        f"?select=document_number,pdf_url_faa,pdf_text&pdf_text=not.is.null&limit=1000",
        headers={"apikey": key, "Authorization": f"Bearer {key}"})
    rows = json.loads(urllib.request.urlopen(req, timeout=120).read())
    random.seed(11)                       # same sample every run, so re-runs compare
    pages = chars = used = 0
    for a in random.sample(rows, min(sample_size, len(rows))):
        if not a.get("pdf_url_faa"):
            continue
        try:
            raw = urllib.request.urlopen(
                urllib.request.Request(a["pdf_url_faa"],
                                       headers={"User-Agent": "Mozilla/5.0"}), timeout=90).read()
        except Exception:
            continue                      # a single unreachable PDF is not worth failing over
        n = len(re.findall(rb"/Type\s*/Page[^s]", raw))
        c = len(a["pdf_text"] or "")
        if n < 1 or c < 500:
            continue
        pages, chars, used = pages + n, chars + c, used + 1
    if not pages:
        raise SystemExit("could not measure: no PDFs downloaded")
    print(f"  measured {used} ACs, {pages:,} real PDF pages, {chars:,} characters")
    print(f"  -> {chars / pages:,.0f} characters per real page\n")
    return round(chars / pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true",
                    help="re-derive chars-per-page from real AC PDFs (slow, ~2 min)")
    args = ap.parse_args()

    pdf_cpp = PDF_CHARS_PER_PAGE
    if args.measure:
        print("Measuring page density from real FAA PDFs...")
        pdf_cpp = measure_density()

    print(f"Corpus page count -- {pdf_cpp:,} chars/page for PDF-derived, "
          f"{TEXT_CHARS_PER_PAGE:,} for web text\n")
    print(f"  {'source':28}{'items':>9}{'characters':>16}{'pages':>10}")
    print(f"  {'-' * 63}")

    total_items = total_chars = total_pages = 0
    for label, table, expr, kind in SOURCES:
        r = sql(f"select count(*) n, coalesce(sum({expr}), 0) c from {table}")[0]
        n, c = int(r["n"]), int(r["c"])
        p = round(c / (pdf_cpp if kind == "pdf" else TEXT_CHARS_PER_PAGE))
        total_items, total_chars, total_pages = total_items + n, total_chars + c, total_pages + p
        print(f"  {label:28}{n:>9,}{c:>16,}{p:>10,}")

    print(f"  {'-' * 63}")
    print(f"  {'TOTAL':28}{total_items:>9,}{total_chars:>16,}{total_pages:>10,}")

    claim = (total_pages // 5000) * 5000
    print(f"\n  Defensible published claim: {claim:,}+ pages")
    print(f"  (rounded DOWN to the nearest 5,000 -- what goes on the site should")
    print(f"   be a floor the corpus has cleared, not a ceiling it is reaching for)")
    print(f"\n  The site says 45,000+ -- "
          f"{'still true, with room to raise it' if claim >= 45000 else 'NO LONGER TRUE, update it'}.")


if __name__ == "__main__":
    main()
