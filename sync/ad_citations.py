#!/usr/bin/env python3
"""
AD Cross-Reference Citation Extractor
========================================
Scans every airworthiness_directives row's own text (summary,
applicability, unsafe_condition, body_text) for AC/FAR/AIM mentions and
writes them to document_citations with citing_type='ad' — this is what
makes an AC/FAR/AIM page able to show "N ADs reference this" (the reverse-
citation direction explicitly requested alongside AD-to-AC/FAR/AIM inline
linking, which crossRefLinks.ts already handles at render time from the
same AD body text with no DB citations needed for that direction).

Same regex patterns already used for this class of mention elsewhere in
this project (aim_scraper.py's _AC_RE, crossRefLinks.ts's FAR pattern) --
kept consistent rather than reinventing a slightly-different one here.

Delete-then-insert per citing_type, same convention as
aim_scraper.py's delete_citations_for_source()/insert_citations() --
document_citations has no natural per-row unique key (a citing doc can
legitimately cite the same target more than once from different
sections), so a plain re-run without deleting first would duplicate.

Usage:
  python3 ad_citations.py --dry-run
  python3 ad_citations.py
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
from citation_validate import fetch_known_ids, filter_resolved

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}

# AC_RE widened 2026-08-10 (ported from pcg_citations.py's own fix, same
# day): the old pattern couldn't match the FAA's slash-form AC numbering
# ("AC 150/5320-12") or a Unicode hyphen variant seen literally in real
# source prose -- confirmed real live misses in P/CG text; the same
# airport-design AC family is plausibly cited from AD text too.
AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:/\d+)?(?:\.\d+)?[\-‐‑–]\d+[A-Za-z]*(?:[\-‐‑–]\d+)?)\b")
# The FAA also spells this out in full ("Advisory Circular No. 120-12A",
# "Advisory Circular 20-420") instead of abbreviating to "AC" -- confirmed
# live and corpus-wide (RC, real content-correction report): 36 LOIs alone
# use this phrasing with zero overlap with AC_RE, a real silent hole shared
# by every extractor built on this same AC_RE pattern (fixed together in
# ad/ac/aim/cfr49/far/loi/pcg/acs). Matches are whitespace-stripped below
# before use -- the source carries the same "00- 1"-style stray-space
# artifact AD_RE already has to tolerate.
AC_RE_SPELLED = re.compile(r"\bAdvisory\s+Circular\s+(?:No\.?\s*)?(\d+(?:/\d+)?(?:\.\d+)?\s*[\-‐‑–]\s*\d+[A-Za-z]*(?:\s*[\-‐‑–]\s*\d+)?)\b", re.IGNORECASE)
FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")
AIM_PARA_RE = re.compile(r"\bAIM\s+(?:[Pp]ara(?:graph)?\.?\s+)?(\d+-\d+-\d+)\b")

# See pcg_citations.py for why: the FAA's own PDF->HTML extraction is
# inconsistent about which hyphen-like character it uses for the same
# number, so a cited_id has to be ASCII-normalized before comparing against
# a real document_number, or it silently never resolves.
_HYPHEN_VARIANTS_RE = re.compile("[‐‑–]")


def _normalize_hyphens(s: str) -> str:
    return _HYPHEN_VARIANTS_RE.sub("-", s)

# AD -> AD. This was the single largest hole in the whole MagicLink graph:
# measured across the full corpus, 1,454 of 5,023 ADs (29%) name another AD in
# their text and NONE of it was extracted, because this file only ever looked
# for AC/FAR/AIM. ADs supersede and amend each other constantly ("This AD
# replaces AD 2010-26-05"), so the supersedes chain is exactly what an owner
# or mechanic needs to follow -- and it was invisible.
#
# Every ad_number in the table is the 4-digit-year form (verified: 5,023 of
# 5,023), so this pattern doesn't bother with legacy 2-digit forms that don't
# exist here.
#
# It DOES tolerate stray whitespace around the internal hyphens, because the
# AD text carries PDF-extraction artifacts -- AD 2024-25-11 contains the
# literal string "Airworthiness Directive (AD) 2022-19- 02". Measured across
# the corpus, that recovers references in 14 more documents. Matches are
# whitespace-stripped below before use, and any target that isn't a real AD
# is dropped by filter_resolved(), so loosening the pattern can't introduce
# dead links -- only real ones we were previously dropping on the floor.
AD_RE = re.compile(r"\bAD\)?\s*(\d{4}\s*-\s*\d{2}\s*-\s*\d{2})\b")

# Every AD's own standard boilerplate footer cites these same handful of Part
# 39/43/91 administrative sections regardless of the AD's actual subject --
# "(g)/(i) Alternative Methods of Compliance," "Special Flight Permits,"
# "Material Incorporated by Reference," maintenance-record-entry language.
# Confirmed via a live corpus check (task: "999" MagicLink count on FAR
# 39.19's page, RC screenshot 2026-08-07): 39.19 alone had 4,387
# citing_type='ad' rows -- 78% of the entire 5,595-AD corpus literally
# repeats "14 CFR 39.19" in this one boilerplate paragraph. Extracting it as
# a real citation is technically accurate (the text really does say that)
# but semantically useless -- it drowns out every genuinely substantive FAR
# reference in the same AD, on both sides (the FAR section's own MagicLink
# count AND every individual AD's "Related FARs" bar). Verified each of
# these 6 the same way (ad_n/total ratio 80-99.8%, an order-of-magnitude
# jump over the next real FAR citation): 21.197 (451/466), 43.9 (226/276),
# 39.17 (153/155), 91.417 (124/155), 43.7 (94/111).
BOILERPLATE_FAR_EXCLUDE = {"39.19", "21.197", "43.9", "39.17", "91.417", "43.7"}

# Bare "Part N" references (no section number) -- same pattern as
# pcg_citations.py's own FAR_PART_RE. Measured corpus-wide by citing_type
# before adding this anywhere (2026-08-17): AD is the ONE type with a real
# boilerplate problem here -- every AD is issued "under 14 CFR part 39"
# and nearly every AD's own standard footer also cites part 51 (100.0% and
# 86.8% of the 5,610-AD corpus respectively), an order-of-magnitude jump
# over the next-highest bare-Part mention (part 119 at 8.2%) -- the exact
# same shape and evidentiary bar as BOILERPLATE_FAR_EXCLUDE above, just at
# the whole-Part level instead of section level. AC/AIM/FAR measured clean
# (max 29.3%/7.3%/3.4%, smooth distributions with no such outlier) so they
# ship without any exclusion list -- see each of those files' own
# FAR_PART_RE comment.
FAR_PART_RE = re.compile(r"\b(?:14\s*CFR\s*|FAR\s+)?[Pp]art\s+([1-9]\d{0,2})\b(?!\.\d)")
BOILERPLATE_FAR_PART_EXCLUDE = {"39", "51"}


def fetch_all_ads() -> list[dict]:
    out = []
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/airworthiness_directives"
            f"?select=ad_number,summary,applicability,unsafe_condition,body_text"
            f"&limit=1000&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        resp.raise_for_status()
        batch = resp.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def extract_citations(ad: dict) -> list[dict]:
    text = " ".join(filter(None, [ad.get("summary"), ad.get("applicability"), ad.get("unsafe_condition"), ad.get("body_text")]))
    citations = []
    seen = set()  # (cited_type, cited_id) dedup WITHIN one AD's own text — repeating the same AC 3x in one AD isn't 3 separate real citations

    # AD -> AD needs one guard the other patterns here don't: SELF-EXCLUSION.
    # An AD's body restates its own number constantly ("Compliance with this
    # AD 2026-15-16..."), which would otherwise emit a link from the document
    # to itself on essentially every AD in the corpus.
    # Dangling targets (ADs cited but not held -- withdrawn, or a typo in the
    # source) need no handling here: main() already runs every citation
    # through citation_validate.filter_resolved(), whose _TABLE_KEY covers
    # 'ad', so unresolvable ones are dropped before insert.
    for m in AD_RE.finditer(text):
        target = re.sub(r"\s+", "", m.group(1))  # "2022-19- 02" -> "2022-19-02"
        if target == ad["ad_number"]:
            continue
        key = ("ad", target)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "ad", "cited_id": target, "label": None})

    for m in AC_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "ac", "cited_id": cited, "label": None})

    for m in AC_RE_SPELLED.finditer(text):
        cited = _normalize_hyphens(re.sub(r"\s+", "", m.group(1)))
        key = ("ac", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "ac", "cited_id": cited, "label": None})

    for m in FAR_RE.finditer(text):
        if m.group(1) in BOILERPLATE_FAR_EXCLUDE:
            continue
        key = ("far", m.group(1))
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "far", "cited_id": m.group(1), "label": None})

    for m in AIM_PARA_RE.finditer(text):
        cited = _normalize_hyphens(m.group(1))
        key = ("aim", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "aim", "cited_id": cited, "label": None})

    for m in FAR_PART_RE.finditer(text):
        cited = m.group(1)
        if cited in BOILERPLATE_FAR_PART_EXCLUDE:
            continue
        key = ("far_part", cited)
        if key not in seen:
            seen.add(key)
            citations.append({"citing_type": "ad", "citing_id": ad["ad_number"], "cited_type": "far_part", "cited_id": cited, "label": None})

    return citations


def delete_ad_citations() -> None:
    """Clears only the cited_types THIS script produces.

    It used to delete every citing_type='ad' row, which was too broad: it also
    wiped the ~450 ad->pcg rows owned by pcg_term_links.py. That was survivable
    only because the weekly pipeline happens to run this at Step 4 and
    pcg_term_links at Step 6 -- an invisible ordering dependency that silently
    destroyed those links whenever this script was run on its own (confirmed:
    running it manually on 2026-07-30 dropped ad->pcg to zero until
    pcg_term_links was re-run by hand, a ~5-minute full-corpus rebuild).
    Scoping the delete to what this script actually owns makes the two
    independent, so either can run alone in any order.
    """
    resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Prefer": "return=minimal"},
        params={"citing_type": "eq.ad", "cited_type": "in.(ac,far,aim,ad,far_part)"},
        timeout=30,
    )
    resp.raise_for_status()


def insert_citations(rows: list[dict]) -> None:
    if not rows:
        return
    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=rows, timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SUPABASE_URL or not SUPABASE_KEY:
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.")
        return

    ads = fetch_all_ads()
    log.info(f"Scanning {len(ads)} ADs for AC/FAR/AIM/AD mentions...")

    all_citations = []
    for ad in ads:
        all_citations.extend(extract_citations(ad))

    by_type = {}
    for c in all_citations:
        by_type[c["cited_type"]] = by_type.get(c["cited_type"], 0) + 1
    log.info(f"Found {len(all_citations)} citations: {by_type}")

    known = fetch_known_ids()
    all_citations, dropped = filter_resolved(all_citations, known)
    log.info(f"Resolved against real targets: {len(all_citations)} kept, {dropped} dropped (target doesn't exist).")

    if args.dry_run:
        log.info("Dry run — no writes made.")
        for c in all_citations[:20]:
            log.info(f"  AD {c['citing_id']} -> {c['cited_type']} {c['cited_id']}")
        return

    delete_ad_citations()
    insert_citations(all_citations)
    log.info(f"Done. Wrote {len(all_citations)} citation rows.")


if __name__ == "__main__":
    main()
