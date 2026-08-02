#!/usr/bin/env python3
"""One-time backfill for the wrap-truncated subject_heading bug found live
2026-08-02 (corpus-wide data-integrity sweep): ad_scraper.py's title regex
matched against the raw, un-wrap-collapsed PDF text, so any manufacturer
name too long for one physical PDF line got cut wherever the PDF happened
to line-wrap (always mid-phrase at "(Type..." for the affected rows,
since that's a common wrap point for the "(Type Certificate Previously
Held by ...)" clause many manufacturer names include). Root cause fixed
in ad_scraper.py itself (now matches against the already-collapsed
single_line variable) -- this script only backfills the 406 rows already
corrupted before that fix, using the Federal Register's own public API
(authoritative, not a guess) rather than reconstructing from `make`.

Usage:
  python3 sync/fix_ad_truncated_subject_headings.py --dry-run
  python3 sync/fix_ad_truncated_subject_headings.py
"""
import argparse, json, re, sys, time, urllib.request, os

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
from author_fact_deck import mgmt_sql  # noqa: E402

# Older Federal Register doc IDs use different formats than the modern
# 4-digit-year one: 2-digit year ("00-31451") or an "E"-prefixed scheme
# ("E7-10758") -- found live when 27 of 406 rows failed the narrower
# pattern, all pre-2010.
DOC_ID_RE = re.compile(r"/pdf/([0-9]{2,4}-[0-9]+|E[0-9]-[0-9]+)\.pdf$")


def fr_title(doc_id):
    url = f"https://www.federalregister.gov/api/v1/documents/{doc_id}.json?fields[]=title"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    return data.get("title")


def normalize(title):
    # FR API titles use a mix of ": " and "; " after "Airworthiness
    # Directives" and sometimes a leading date prefix -- normalize to this
    # corpus's own established convention (semicolon, no date prefix),
    # confirmed against already-correct existing rows before this fix.
    title = re.sub(r"^.*?Airworthiness Directives:?;?\s*", "Airworthiness Directives; ", title)
    return title.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = mgmt_sql("""
        select ad_number, subject_heading, pdf_url from airworthiness_directives
        where (length(subject_heading) - length(replace(subject_heading, '(', '')))
            > (length(subject_heading) - length(replace(subject_heading, ')', '')))
    """)
    print(f"{len(rows)} truncated rows to fix.")

    fixed, failed = [], []
    for i, row in enumerate(rows):
        m = DOC_ID_RE.search(row["pdf_url"] or "")
        if not m:
            failed.append((row["ad_number"], "no doc id in pdf_url"))
            continue
        doc_id = m.group(1)
        try:
            title = fr_title(doc_id)
        except Exception as e:
            failed.append((row["ad_number"], str(e)))
            continue
        if not title or "Airworthiness Directives" not in title:
            failed.append((row["ad_number"], f"unexpected FR title: {title!r}"))
            continue
        new_heading = normalize(title)
        fixed.append((row["ad_number"], row["subject_heading"], new_heading))
        if (i + 1) % 25 == 0:
            print(f"  ...{i + 1}/{len(rows)}")
        time.sleep(0.15)  # polite to a public government API, not a rate-limit workaround

    print(f"\n{len(fixed)} resolved via FR API, {len(failed)} failed.")
    if failed:
        print("Failures (left untouched, needs manual follow-up):")
        for ad, reason in failed:
            print(f"  {ad}: {reason}")

    if args.dry_run:
        for ad, old, new in fixed[:10]:
            print(f"  {ad}: {old!r} -> {new!r}")
        return

    for ad, old, new in fixed:
        esc = new.replace("'", "''")
        mgmt_sql(f"update airworthiness_directives set subject_heading = '{esc}' where ad_number = '{ad}'")
    print(f"Updated {len(fixed)} rows.")


if __name__ == "__main__":
    main()
