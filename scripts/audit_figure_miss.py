#!/usr/bin/env python3
"""
DRY RUN ONLY — re-runs the improved find_captions() (bold OR all-caps signal,
OCR-punctuation-tolerant) against every AC that currently has ZERO rows in
ac_figures, to measure how many were missed by the original bold-only
detector versus genuinely having no figures/tables at all. Writes samples
for manual false-positive review before any real re-extraction is run.

Usage:
  python3 scripts/audit_figure_miss.py
"""
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from extract_figures import find_captions  # noqa: E402

SCRAPER_ENV = os.path.join(os.path.dirname(__file__), "..", ".env.scraper")


def load_env(path: str) -> dict:
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            line = line.removeprefix("export ")
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


ENV = load_env(SCRAPER_ENV)
SUPABASE_URL = ENV["SUPABASE_URL"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}


def fetch_all(table, select, extra=""):
    rows = []
    offset = 0
    page = 1000
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}?select={select}{extra}&limit={page}&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        offset += page
        if len(batch) < page:
            break
    return rows


def main():
    acs = fetch_all("advisory_circulars", "id,document_number,pdf_url_cached", "&pdf_url_cached=not.is.null")
    figs = fetch_all("ac_figures", "ac_id")
    has_figs = set(f["ac_id"] for f in figs)
    zero = [a for a in acs if a["id"] not in has_figs]

    # INCREMENTAL, added 2026-09-04. This script downloads a full PDF per AC,
    # and with ~396 zero-figure ACs that was 505 SECONDS -- more than every
    # other audit in run_all_audits.sh combined, over half the whole suite --
    # to print the same answer every time: "0 ACs would gain figures".
    #
    # RC: "make sure that AC audit process works, solidly, and fast. no
    # extraneous junk in the code to slow it down."
    #
    # Deleting it from the suite was the tempting fix and the wrong one: it
    # still has real regression value. If the scraper ever stops extracting
    # figures, the affected ACs land in exactly this zero-figure set and this
    # is what would notice. So keep the check, drop the repetition -- an AC
    # already scanned and confirmed genuinely-zero AT THIS PDF URL cannot have
    # changed its answer unless its PDF changed. Key on the URL, not the id,
    # so a re-scraped AC is correctly re-examined.
    settled_path = os.path.join(os.path.dirname(__file__), "..", "figure_miss_settled.json")
    settled = {}
    if "--full" not in sys.argv:
        try:
            with open(settled_path) as f:
                settled = json.load(f)
        except Exception:
            settled = {}
    skipped = [a for a in zero if settled.get(a["id"]) == a["pdf_url_cached"]]
    zero = [a for a in zero if settled.get(a["id"]) != a["pdf_url_cached"]]
    if skipped:
        print(f"{len(skipped)} ACs already confirmed genuinely-zero at this PDF (skipping; "
              f"--full re-scans everything)")
    print(f"{len(zero)} ACs to scan with the improved detector...")

    gained = []
    still_zero = []
    for n, ac in enumerate(zero):
        try:
            # advisory-circulars went private (2026-08-11, Storage bucket
            # gating) -- the stored pdf_url_cached is still the old
            # /object/public/ string (unchanged, it's just an identifier
            # now, see gatedStorage.ts), which 404s on a plain GET
            # regardless of headers. /object/authenticated/ is Storage's
            # direct-fetch counterpart for a private object, checked
            # against RLS -- the service key bypasses that RLS entirely,
            # same as this script's other table reads already do via
            # HEADERS.
            fetch_url = ac["pdf_url_cached"].replace("/object/public/", "/object/authenticated/", 1)
            pdf_bytes = requests.get(fetch_url, headers=HEADERS, timeout=60).content
            captions = list(find_captions(pdf_bytes))
        except Exception as e:
            print(f"[{n}] {ac['document_number']}: ERROR {e}")
            continue
        if captions:
            gained.append({
                "document_number": ac["document_number"],
                "count": len(captions),
                "samples": [{"page": p, "label": l, "caption": c} for p, l, c in captions[:3]],
            })
        else:
            still_zero.append(ac["document_number"])
        if n % 50 == 0:
            print(f"  ...{n}/{len(zero)} scanned, {len(gained)} would gain figures so far")

    # Remember what was settled THIS run, keyed by the PDF that produced the
    # answer, so a re-scraped AC comes back for a fresh look automatically.
    for ac in zero:
        if ac["document_number"] in still_zero:
            settled[ac["id"]] = ac["pdf_url_cached"]
    try:
        with open(settled_path, "w") as f:
            json.dump(settled, f, indent=2)
    except Exception as e:
        print(f"  (could not persist the settled list: {e} -- next run just re-scans)")

    report = {
        "skipped_settled": len(skipped),
        "zero_count": len(zero) + len(skipped),
        "would_gain_count": len(gained),
        "still_zero_count": len(still_zero),
        "gained": gained,
        "still_zero": still_zero,
    }
    out_path = os.path.join(os.path.dirname(__file__), "..", "figure_miss_audit.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nDone. {len(gained)} ACs would gain figures, "
          f"{len(still_zero) + len(skipped)} remain genuinely zero "
          f"({len(skipped)} skipped as already settled).")
    print(f"Report written to {out_path}")


if __name__ == "__main__":
    main()
