#!/usr/bin/env python3
"""Re-scrape the ACs that the old 500,000-character cap truncated.

RC, 2026-09-02: "all regs should be fixed, perfectly readable, all cross-refd
etc. We spent too much time on this to regress now to all the missing/broken
stuff. Fix it."

BACKGROUND. sync/faa_scraper.py capped extracted PDF text at 500,000
characters with a raw slice, at five call sites, with no page awareness and no
log line. It has been there since the original build (commit a00bcfd,
2026-07-05) -- this is NOT a recent regression, it is an original defect that
was invisible until the corpus was first diffed against the FAA source. 19 ACs
sit within 50K of that ceiling and end mid-WORD; AC 43.13-1B, the general
aviation maintenance reference, is missing Chapters 5 through 13 entirely.

The cap is now 4,000,000 and the cut is page-aligned, and ACBody mounts in
400-block chunks so the full documents can actually render. This script
re-fetches and re-writes only the affected documents, rather than re-running
the whole 786-AC sync.

No What's New risk, and it is worth being precise about WHY rather than
assuming: faa_scraper.py does not call log_revisions at all -- only the AD,
LOI, FAR, AIM and CFR49 scrapers do. So re-extracting an AC cannot create a
false "changed" entry the way the AD email-placeholder re-scrape did. The
SKIP_REVISION_LOG default below is belt-and-braces in case that ever changes,
not the thing currently protecting us.

Usage:
  python3 scripts/rescrape_truncated_acs.py --dry-run   # report only
  python3 scripts/rescrape_truncated_acs.py             # fetch + write
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sync"))
os.environ.setdefault("SKIP_REVISION_LOG", "1")

import requests  # noqa: E402
import faa_scraper as F  # noqa: E402

# Every AC within 50K of the old 500,000 ceiling, i.e. every document that
# ceiling could plausibly have cut. Measured from the live table.
TARGETS = [
    # RECOVERY FIRST. These three were emptied on 2026-09-02 by the very bug
    # the shrink guard below now prevents: faa.gov timed out, extraction
    # returned nothing, and the upsert merged that NULL over ~494,000
    # characters each. Their pdf_blocks survived (so the reader still shows
    # content) but pdf_text -- what full-text search reads -- went to zero.
    # Ordered first so a partial run repairs the damage before anything else.
    "43.13-1B", "43-206", "29-2C",
    # Then the rest of the originally-truncated set.
    "25-7D", "120-29A", "20-138D", "25-17A",
    "150/5370-10H", "150/5200-31C", "150/5320-5D", "150/5300-18B",
    "150/5300-13B", "23-8C", "25-22", "150/5340-30J", "23-17C", "36-4D",
    "27-1B", "20-73A",
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    session = requests.Session()
    session.headers["User-Agent"] = F.UA if hasattr(F, "UA") else "Mozilla/5.0 FlyRegs/1.0"

    rows = {r.get("DOCUMENTNUMBER", "").strip(): r for r in F.fetch_csv(session)}
    F.log.info(f"FAA CSV: {len(rows)} rows; {len(TARGETS)} targets")

    before = {}
    for doc in TARGETS:
        try:
            resp = requests.get(
                f"{F.SUPABASE_URL}/rest/v1/advisory_circulars",
                headers=F._supa_headers(),
                params={"select": "document_number,pdf_text", "document_number": f"eq.{doc}"},
                timeout=60,
            )
            data = resp.json()
            before[doc] = len(data[0].get("pdf_text") or "") if data else 0
        except Exception:
            before[doc] = 0

    ok = fail = 0
    for i, doc in enumerate(TARGETS, 1):
        row = rows.get(doc)
        if not row:
            F.log.warning(f"[{i}/{len(TARGETS)}] {doc}: NOT in the FAA CSV — skipping")
            fail += 1
            continue
        F.log.info(f"[{i}/{len(TARGETS)}] {doc}  (stored {before.get(doc, 0):,} chars)")
        try:
            rec = F.process_ac(row, session, fetch_detail_page=True, download_pdfs=True)
            if not rec:
                F.log.warning(f"    {doc}: process_ac returned nothing")
                fail += 1
                continue
            n = len(rec.get("pdf_text") or "")
            gained = n - before.get(doc, 0)
            F.log.info(f"    extracted {n:,} chars  ({gained:+,})")

            # NEVER write a SHORTER extraction over a longer stored one.
            # Learned the hard way 2026-09-02: faa.gov timed out on several
            # documents, process_ac returned a record with pdf_text=None, the
            # upsert merged that NULL over the real text, and three ACs --
            # 43.13-1B among them -- went from ~494,000 characters to ZERO.
            # A failed fetch must be a no-op, never a deletion. This whole
            # script exists to ADD text back; it must never be able to remove
            # any.
            if n <= before.get(doc, 0):
                F.log.warning(
                    f"    {doc}: extraction ({n:,}) is not longer than what is "
                    f"stored ({before.get(doc, 0):,}) — SKIPPING the write"
                )
                fail += 1
                continue
            if args.dry_run:
                continue
            if F.upsert_ac(rec):
                ok += 1
            else:
                fail += 1
        except Exception as e:
            F.log.error(f"    {doc}: {e}")
            fail += 1

    F.log.info(f"done — {ok} written, {fail} failed" + ("  [DRY-RUN]" if args.dry_run else ""))


if __name__ == "__main__":
    main()
