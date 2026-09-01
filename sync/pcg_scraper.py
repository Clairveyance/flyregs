#!/usr/bin/env python3
"""
FAA Pilot/Controller Glossary Scraper
=======================================
Fetches all P/CG terms from FAA.gov's HTML edition, stores in Supabase.

The P/CG HTML edition is one page per letter (glossary-a.html .. glossary-w.html),
with clean semantic markup: each term is a <p class="glossary-term-definition">
containing a <dfn class="term-name">, followed by optional cross-reference <p>
tags — "See OTHER_TERM" (another P/CG term) or "Refer to AIM" (an external
document). Both cross-reference kinds are captured directly from the FAA's own
markup rather than inferred.

Modes:
  test    first N terms from letter A only, no DB writes — verify parsing
  full    all 23 letter pages, all terms — safe to re-run on a schedule
          (the corpus is small enough that "full" doubles as "incremental";
          there's no separate incremental mode, matching the P/CG section's
          update-cadence note in the expansion plan)

Usage:
  python pcg_scraper.py --mode test
  python pcg_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import io
import logging
import os
import re
import string
import sys
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revision_log import log_revisions  # noqa: E402

# ──────────────────────────────────────────────────────────────────────────────
#  Config
# ──────────────────────────────────────────────────────────────────────────────

PCG_BASE = "https://www.faa.gov/air_traffic/publications/atpubs/pcg_html/"
PCG_INDEX_URL = PCG_BASE + "glossary.html"
# Confirmed live 2026-07-23: pages exist for A-W (no glossary terms start with X/Y/Z).
PCG_LETTERS = [c for c in string.ascii_uppercase if c != "X" and c != "Y" and c != "Z"]

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

REQUEST_DELAY = 0.75
REQUEST_TIMEOUT = 30

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("pcg_scraper")


# ──────────────────────────────────────────────────────────────────────────────
#  HTTP session — faa.gov 403s a bare/default User-Agent, so this matches
#  faa_scraper.py's browser-like headers exactly.
# ──────────────────────────────────────────────────────────────────────────────

def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    })
    return s


# ──────────────────────────────────────────────────────────────────────────────
#  Parsing — one letter page → list of term records
# ──────────────────────────────────────────────────────────────────────────────

def _slugify_term(term: str) -> str:
    """Stable identity key across reruns — used as the upsert conflict key."""
    return re.sub(r"[^A-Z0-9]+", "_", term.upper()).strip("_")


def _append_sub_list(current: dict, ol) -> None:
    r"""
    Fold one <ol class="glossary-sub-list"> into the term's definition.

    Reported by a beta tester 2026-08-22, on a P/CG Study Mode card: "The
    answer says any of the following and there's nothing following." She was
    exactly right, and it was not a one-off. The FAA marks a definition's
    continuation list up as a SIBLING <ol> after the term's <p>, e.g.:

        <p class="...glossary-term-definition..." id="FERRY_FLIGHT">
          <dfn class="term-name">FERRY FLIGHT</dfn>- A flight for the purpose of:
        </p>
        <ol type="a" class="glossary-sub-list">
          <li>Returning an aircraft to base.</li>
          ...

    parse_letter_page only ever walked <p> children, so every one of those
    lists was dropped on the floor. Measured against all 23 live letter
    pages: 99 terms lost 378 list items, and for 48 of them the stored
    definition is nothing BUT the lead-in ("Any of the following:", "A
    flight for the purpose of:", "In radar:") -- a card, a search result and
    a detail screen that promise a list and then show nothing at all.

    Items are appended as their own paragraphs (\n\n-joined), which is what
    the app's splitIntoParagraphs already renders as separate blocks.

    Deliberately NO synthesized "a."/"b." prefixes. The enumeration exists
    only as an <ol type="a"> markup attribute, and regTextFormat.ts's
    contract for this corpus is explicit that stored source text stays
    byte-for-byte intact -- formatting may decide WHERE to break, never what
    the words say. Inventing list markers would also actively misinform on
    the ~9 terms whose one logical list is split across several <ol>s, since
    none of them carry a `start` attribute and each would restart at "a."
    """
    items = [
        li.get_text(separator=" ", strip=True)
        for li in ol.find_all("li", recursive=False)
    ]
    # The FAA ships the occasional empty <li></li> (AIRPORT MARKING AIDS has
    # one where "Visual." plainly belongs) -- carry the real items, don't
    # manufacture a blank paragraph out of a hole in the source.
    items = [i for i in items if i]
    if not items:
        return
    body = "\n\n".join(items)
    current["definition"] = f"{current['definition']}\n\n{body}" if current["definition"] else body


def parse_letter_page(html: str, letter: str) -> list[dict]:
    """
    Parse one glossary-{letter}.html page into term records.

    Cross-reference <p> tags immediately follow the term <p> they belong to,
    so we walk the article's direct children in document order and attach
    each cross-reference to the most recently seen term.

    The walk covers <ol> as well as <p>. A definition that continues into a
    lettered list ("FERRY FLIGHT- A flight for the purpose of:" + a. b. c.)
    puts that list in a SIBLING <ol class="glossary-sub-list">, not inside
    the term's own <p> -- so a p-only walk silently dropped every one of
    them. See _append_sub_list below for the full damage assessment.
    """
    soup = BeautifulSoup(html, "html.parser")
    article = soup.find("article", class_="pcg-content")
    if not article:
        log.warning(f"  No <article class=pcg-content> found on letter {letter} page")
        return []

    terms: list[dict] = []
    current: Optional[dict] = None

    for p in article.find_all(["p", "ol"], recursive=False):
        classes = p.get("class") or []

        # A definition's continuation list. Belongs to the most recently seen
        # term, exactly like the cross-reference <p>s below -- and genuinely
        # interleaves with them (ATCSCC's single a./b./c./d. list is split
        # across four <ol>s with "See"/"Refer to" <p>s in between), so this
        # deliberately does NOT require the <ol> to sit adjacent to the term.
        if p.name == "ol":
            if "glossary-sub-list" in classes and current is not None:
                _append_sub_list(current, p)
            continue

        # "glossary-term-entry", not "glossary-term-definition": 52 real
        # terms -- AIRMET, HAZMAT, VFR-ON-TOP, PILOT'S DISCRETION, "HOW DO
        # YOU HEAR ME?", and ~45 [ICAO] variants -- carry only the former
        # class and were skipped outright, never reaching pcg_terms at all
        # (1,342 rows stored vs 1,394 terms actually on the FAA's pages).
        # Verified across all 23 letter pages: every <p> carrying
        # glossary-term-definition also carries glossary-term-entry, so this
        # is a strict superset -- it cannot drop a term the old test kept.
        # The `dfn` guard below is what actually decides "is this a term."
        if "glossary-term-entry" in classes:
            dfn = p.find("dfn", class_="term-name")
            if not dfn:
                # A third markup shape: the term label is bare text with no
                # <dfn> wrapper at all ("GRAPHICAL AIRMEN'S METEOROLOGICAL
                # INFORMATION- A graphical depiction of..."). 165 paragraphs
                # across the 23 pages look like this and are all invisible to
                # this parser -- a real, SEPARATE content gap (TFR, LSA,
                # sUAS, MOUNTAIN WAVE, POWERED-LIFT, CLIMB VIA/DESCEND VIA,
                # WAAS and ~150 more). Some of them do still exist in
                # pcg_terms from older syncs that predate the FAA's markup
                # change, which means they are now silently frozen -- never
                # updated again. Recovering them needs its own pass: without
                # a <dfn> boundary the term/definition split has to be
                # inferred, and the same 165 include genuine fragments
                # ("CHA", "MRP", "Types of icing are:") that are not clean
                # standalone terms. Deliberately not guessed at here.
                #
                # What DOES matter for this parser's correctness: drop
                # `current`, so a <ol class="glossary-sub-list"> belonging to
                # one of these unparsed terms can never silently land on the
                # last term we happened to parse. Caught exactly that way --
                # G-AIRMET's 7-item weather list attaching itself to the
                # unrelated "GPS" see-ref stub two entries earlier.
                current = None
                continue
            raw_term = dfn.get_text(strip=True).rstrip("-").strip()
            if not raw_term:
                # Same reasoning as the no-<dfn> branch above: this <p> was a
                # term we failed to read, so nothing after it belongs to the
                # previous term any more.
                current = None
                continue

            # Definition is everything in the <p> after the <dfn> tag --
            # except the FAA's own source HTML is inconsistent about where
            # the </dfn> boundary actually falls relative to the visible
            # term label. Confirmed live 2026-08-12 by fetching the real
            # glossary-a.html/glossary-g.html pages and reading the raw
            # markup directly: most terms wrap their ENTIRE label,
            # including any trailing parenthetical acronym expansion, in
            # <dfn> (e.g. "<dfn>AUTOMATIC DEPENDENT SURVEILLANCE-CONTRACT
            # (ADS-C)</dfn>- A data link..."), but a few close </dfn> mid-
            # parenthetical instead, e.g.:
            #   <dfn>AUTOMATIC DEPENDENT SURVEILLANCE-BROADCAST IN (ADS</dfn>-B In)- Aircraft avionics...
            #   <dfn>GROUND-BASED INTERVAL MANAGEMENT-SPACING (GIM</dfn>-S), SPEED ADVISORY- A calculated speed...
            # The old code sliced full_text at exactly len(dfn_text), so on
            # these terms the leftover label fragment ("B In)-", "S),
            # SPEED ADVISORY-") got glued onto the front of the stored
            # definition instead of being recognized as still part of the
            # term -- confirmed as the root cause of 3 false-positive
            # "revision" rows purged from content_revisions the same day
            # (sync/migrations_purge_content_revisions_false_positives.sql)
            # and, live in pcg_terms right now, a 4th term (AUTOMATIC
            # DEPENDENT SURVEILLANCE, the base ADS-B entry) whose
            # definition has apparently been corrupted this way since it
            # was first scraped -- it never showed up as a "revision"
            # because there was never a clean version to diff against.
            #
            # This isn't actually run-to-run non-determinism (the same
            # fixed HTML re-parsed with the same code always produces the
            # same, consistently wrong, result) -- it just looked that way
            # in content_revisions because the OLD stored value predated
            # whatever last touched this parsing path, and diffed clean
            # against a freshly-broken re-scrape.
            #
            # Fix: don't trust the <dfn> boundary as the real split point.
            # Every case checked -- both the broken-boundary terms above
            # and the hundreds of normal ones -- is consistent about ONE
            # thing: the actual definition prose always starts right after
            # the FIRST literal "-" + whitespace that appears at or after
            # the <dfn> boundary. That's the FAA's own term/definition
            # separator, present whether or not <dfn> already swallowed
            # the whole label, and it reliably survives being searched for
            # instead of assumed. Verified against the full live corpus
            # (all 23 letter pages, 1,332 terms fetched fresh and re-
            # parsed): only these same 4 terms' definitions change versus
            # the old slice-based logic, zero regressions elsewhere.
            full_text = p.get_text(separator=" ", strip=True)
            dfn_text = dfn.get_text(strip=True)
            remainder = full_text[len(dfn_text):]
            sep_match = re.search(r"-\s", remainder)
            if sep_match:
                definition = remainder[sep_match.end():].strip()
            else:
                # No "-<whitespace>" separator found at all (e.g. a term
                # with no definition of its own, only cross-references) --
                # fall back to the old lstrip behavior rather than assume.
                definition = remainder.lstrip("- ").strip()

            current = {
                "term": raw_term,
                "slug": _slugify_term(raw_term),
                "letter": letter,
                "definition": definition or None,
                "frequently_used": "frequently-used" in (dfn.get("class") or []),
                "see_refs": [],       # other P/CG terms ("See X")
                "external_refs": [],  # cross-document refs ("Refer to AIM")
            }
            terms.append(current)
            continue

        if "glossary-cross-reference" in classes and current is not None:
            if "has-see-ref" in classes:
                # Either a plain <span class="cross-ref-term"> or a linked
                # <a class="cross-ref-link" data-term="..."> — capture both.
                for el in p.find_all(class_="cross-ref-term"):
                    ref_term = el.get_text(strip=True)
                    if ref_term and ref_term not in current["see_refs"]:
                        current["see_refs"].append(ref_term)
                for a in p.find_all("a", class_="cross-ref-link"):
                    # Prefer the anchor's VISIBLE TEXT over data-term. data-term is
                    # the FAA's own internal element id with punctuation stripped,
                    # so "RUNWAY IN USE/ACTIVE RUNWAY/DUTY RUNWAY" arrives as
                    # data-term="RUNWAY_IN_USEACTIVE_RUNWAYDUTY_RUNWAY" -> the old
                    # underscore swap produced "RUNWAY IN USEACTIVE RUNWAYDUTY
                    # RUNWAY", with the slashes eaten and words fused. That is both
                    # unreadable if it is ever shown to a user, and unresolvable:
                    # our own slug for that term is RUNWAY_IN_USE_ACTIVE_RUNWAY_
                    # DUTY_RUNWAY, which the fused id can never match. The link text
                    # is the FAA's real printed label and slugifies correctly.
                    ref_term = a.get_text(" ", strip=True) or (a.get("data-term") or "").replace("_", " ")
                    if ref_term and ref_term not in current["see_refs"]:
                        current["see_refs"].append(ref_term)

            if "has-refer-ref" in classes:
                for a in p.find_all("a", class_="external-ref-link"):
                    # Drop the sr-only "(opens in new tab)" accessibility text
                    # and the visual arrow glyph — keep just the doc label.
                    for sr in a.find_all(class_="sr-only"):
                        sr.decompose()
                    label = a.get_text(strip=True).rstrip("↗").strip()
                    href = a.get("href", "")
                    if not href:
                        continue
                    # Proper relative resolution — "../aim_html/" is a SIBLING
                    # of pcg_html/, not a child. String concatenation got this
                    # wrong in initial testing (produced a nonexistent
                    # .../pcg_html/aim_html/ URL); urljoin resolves it correctly.
                    absolute = urljoin(PCG_BASE, href)
                    current["external_refs"].append({"label": label, "url": absolute})
            continue

        # A FOURTH cross-reference shape -- caught 2026-08-28 investigating
        # why 394 real pcg_terms rows had a NULL definition. Most of those
        # turned out fine (a term's real content legitimately lives on its
        # see_refs target, not its own definition -- e.g. ACTIVE RUNWAY/DUTY
        # RUNWAY both point at the combined "RUNWAY IN USE/ACTIVE RUNWAY/
        # DUTY RUNWAY" entry) and just needed a re-scrape to pick up an
        # already-fixed parser. But COPTER, spot-checked as one of the 48
        # rows with NEITHER a definition NOR any see_refs at all, turned out
        # to be a genuinely new gap: the FAA marks its "(See HELICOPTER.)"
        # cross-reference as a bare, unclassed <p> -- no
        # "glossary-cross-reference" class at all, so it fell through every
        # branch above and was silently dropped. Confirmed corpus-wide, all
        # 23 letter pages: exactly 9 real terms use this shape (COPTER,
        # UNCONTROLLED AIRSPACE's own reverse ref, LAANC, LAHSO, a NAV SPEC
        # [ICAO] ref, PAO, RADIO-CONTROLLED, AWNM, and UTM) -- small and
        # fully enumerated, not a guess.
        elif current is not None:
            text = p.get_text(strip=True)
            m = re.match(r"^\(?\s*See\s+(.+?)\s*\.?\s*\)?$", text, re.I)
            if m:
                ref_term = m.group(1).strip()
                if ref_term and ref_term not in current["see_refs"]:
                    current["see_refs"].append(ref_term)

    return terms


# ──────────────────────────────────────────────────────────────────────────────
#  Fetch all letters
# ──────────────────────────────────────────────────────────────────────────────

def _dedupe_slugs(terms: list[dict]) -> list[dict]:
    """
    The FAA's own source HTML occasionally reuses the same literal id/term
    for two genuinely distinct entries (confirmed live: COMMON_ROUTE and
    OUTER_FIX each appear twice, with different real definitions, and the
    FAA's own markup doesn't disambiguate them either — both <p> tags carry
    the identical id). Dropping either would silently lose a real published
    definition, so on collision we keep every entry and append a stable
    numeric suffix (_2, _3, ...) to the slug in document order.
    """
    seen: dict[str, int] = {}
    for t in terms:
        base_slug = t["slug"]
        seen[base_slug] = seen.get(base_slug, 0) + 1
        if seen[base_slug] > 1:
            new_slug = f"{base_slug}_{seen[base_slug]}"
            log.warning(
                f"  Duplicate slug '{base_slug}' (term={t['term']!r}) — "
                f"FAA source reuses this id for a distinct entry; disambiguating as '{new_slug}'"
            )
            t["slug"] = new_slug
    return terms


def fetch_all_terms(session: requests.Session) -> list[dict]:
    all_terms: list[dict] = []
    for letter in PCG_LETTERS:
        url = f"{PCG_BASE}glossary-{letter.lower()}.html"
        log.info(f"Fetching letter {letter} …")
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except requests.RequestException as e:
            log.error(f"  ✗ Failed to fetch letter {letter}: {e}")
            continue

        terms = parse_letter_page(resp.text, letter)
        log.info(f"  → {len(terms)} terms")
        all_terms.extend(terms)
        time.sleep(REQUEST_DELAY)

    return _dedupe_slugs(all_terms)


# ──────────────────────────────────────────────────────────────────────────────
#  Supabase — same raw-REST pattern as faa_scraper.py (no supabase-py client)
# ──────────────────────────────────────────────────────────────────────────────

def _supa_headers(extra: dict = None) -> dict:
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def upsert_term(record: dict) -> bool:
    """
    Upsert one P/CG term into Supabase, keyed on `slug` (stable across
    reruns even if the FAA's own display casing/whitespace shifts slightly).

    NOTE: the `pcg_terms` table does not exist yet — this function is wired
    up and ready, but running --mode full against real Supabase credentials
    will fail with a 404/undefined-table error until the migration is
    applied. That's deliberate: table creation is flagged separately as the
    next production-touching step, not bundled into this script.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {record['term']}")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/pcg_terms",
            headers=_supa_headers({
                "Prefer": "resolution=merge-duplicates,return=minimal",
            }),
            params={"on_conflict": "slug"},
            json=record,
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  Supabase upsert failed ({record.get('term')}): {e}")
        return False


def log_scraper_run(run: dict) -> None:
    """Write a scraper_runs record — same shared table faa_scraper.py logs to.

    Was a bare `except: pass` -- confirmed live, 2026-08-09: this run_record's
    own field names (pcg_total, pcg_upserted, pcg_errors) had NEVER matched
    any real column on the shared scraper_runs table (which only ever had
    faa_scraper.py's AC-specific columns) -- every single P/CG sync run had
    been silently failing to log here, this whole time, with the swallowed
    exception hiding it completely. Columns added back
    (sync/migrations_scraper_runs_far_aim_pcg_columns.sql); this log line
    stays so any FUTURE drift shows up in the run's own log instead of
    vanishing the same way again.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            json=run,
            timeout=10,
        )
        if not r.ok:
            log.error(f"log_scraper_run: insert failed ({r.status_code}): {r.text[:500]}")
        else:
            # A silently-dropped row despite a success POST and zero
            # exceptions is what ad_scraper.py hit on a real 2026-08-10
            # scheduled run -- this confirms the POST itself succeeded, so
            # a repeat of that shape points downstream of this call, not at
            # a swallowed client exception. See ad_scraper.py's own
            # log_scraper_run() for the full incident.
            log.info(f"log_scraper_run: inserted ({r.status_code})")
    except Exception as e:
        log.error(f"log_scraper_run: insert raised: {e}")


# ──────────────────────────────────────────────────────────────────────────────
#  Run modes
# ──────────────────────────────────────────────────────────────────────────────

def run_test(session: requests.Session, n: int = 10):
    """Smoke test — letter A only, print first n terms, no DB writes."""
    log.info(f"TEST MODE — letter A only, first {n} terms (no DB writes)")
    url = f"{PCG_BASE}glossary-a.html"
    resp = session.get(url, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    terms = parse_letter_page(resp.text, "A")
    log.info(f"Parsed {len(terms)} total terms on letter A")

    for t in terms[:n]:
        log.info(f"\n{'─'*50}")
        log.info(f"Term:            {t['term']}")
        log.info(f"Slug:            {t['slug']}")
        log.info(f"Frequently used: {t['frequently_used']}")
        log.info(f"Definition:      {(t['definition'] or '(see-ref only, no own definition)')[:160]}")
        if t["see_refs"]:
            log.info(f"See also:        {t['see_refs']}")
        if t["external_refs"]:
            log.info(f"External refs:   {t['external_refs']}")


def run_full(session: requests.Session):
    """Full scrape — all 23 letter pages, upsert every term."""
    log.info("=" * 60)
    log.info("FULL SCRAPE — P/CG, all letters")
    log.info("=" * 60)

    run_record = {
        "mode": "full",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }

    terms = fetch_all_terms(session)
    total = len(terms)
    added = errors = 0
    error_details = []

    # What's Changed timeline logging -- one batch call for the whole
    # catalog rather than per-term (upsert_term runs one row at a time
    # below, but re-fetching "old text" per term would be 1,300+ separate
    # HTTP calls). Must run BEFORE the per-term upsert loop overwrites
    # what's currently live. See revision_log.py.
    # last_amended (task #300): P/CG has no FAA-published version history
    # anywhere, so this same paragraph-level diff is the only real signal
    # available for "did this term actually change" -- reusing it here
    # rather than a separate hash check means the existing TBL/FIG-renumber
    # noise filter (see revision_log.py) also protects last_amended, not
    # just the What's Changed timeline.
    changed_slugs: set = set()
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            n = log_revisions(
                SUPABASE_URL, _supa_headers(), doc_type="pcg", table="pcg_terms",
                key_field="slug", text_field="definition", title_field="term",
                new_rows=terms, changed_keys=changed_slugs,
            )
            if n:
                log.info(f"Logged {n} P/CG revision(s) for What's Changed ({len(changed_slugs)} term(s) get a new last_amended)")
        except Exception as e:
            log.warning(f"revision logging failed (non-fatal): {e}")

    now = datetime.now(timezone.utc).isoformat()
    today = now[:10]
    for i, t in enumerate(terms, 1):
        record = {**t, "updated_at": now}
        if t["slug"] in changed_slugs:
            record["last_amended"] = today
        log.info(f"[{i}/{total}] {t['term']}")
        if upsert_term(record):
            added += 1
        else:
            errors += 1
            error_details.append({"term": t["term"], "error": "upsert failed"})

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 else "partial",
        "pcg_total": total,
        "pcg_upserted": added,
        "pcg_errors": errors,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Upserted={added} Errors={errors}/{total}")
    return errors


# ──────────────────────────────────────────────────────────────────────────────
#  CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="FAA Pilot/Controller Glossary Scraper")
    parser.add_argument(
        "--mode",
        choices=["test", "full"],
        default="test",
        help="test=smoke test on letter A (no writes), full=all letters, upsert every term",
    )
    parser.add_argument(
        "--test-count",
        type=int,
        default=10,
        help="Number of terms to print in test mode (default: 10)",
    )
    parser.add_argument(
        "--no-revision-log", action="store_true",
        help=(
            "Skip content_revisions logging for this run (sets SKIP_REVISION_LOG=1, "
            "read by revision_log.log_revisions()). Use for a manual backfill/repair "
            "run over already-known data, so it can't log bogus What's Changed "
            "entries. Leave unset for the real scheduled cron sync."
        ),
    )
    args = parser.parse_args()
    if args.no_revision_log:
        os.environ["SKIP_REVISION_LOG"] = "1"

    if args.mode == "full" and (not SUPABASE_URL or not SUPABASE_KEY):
        log.error(
            "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.\n"
            "Use --mode test to verify parsing without DB credentials."
        )
        sys.exit(1)

    session = make_session()

    if args.mode == "test":
        run_test(session, n=args.test_count)
    elif args.mode == "full":
        # A logged status="partial" run used to exit 0 unconditionally --
        # see far_scraper.py's identical comment for the real live incident
        # (cfr49_scraper.py's Part 830 eCFR timeout) that motivated this.
        errors = run_full(session)
        if errors:
            sys.exit(1)


if __name__ == "__main__":
    main()
