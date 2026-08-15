#!/usr/bin/env python3
"""
AIM (Aeronautical Information Manual) Scraper
================================================
Fetches the full AIM from FAA.gov's HTML edition, stores in Supabase.

Source, confirmed live 2026-07-23:
  Index:   https://www.faa.gov/air_traffic/publications/atpubs/aim_html/index.html
           — real nav tree, 12 chapters (0-11), 48 section pages total.
  Section: https://www.faa.gov/.../aim_html/chap{N}_section_{M}.html
           — clean semantic HTML: <h4 class="paragraph-title" id="4-1-1">
           per numbered paragraph, <p class="p"> body text, <aside
           class="reference-box"> for cross-references, <figure class="fig">
           for charts/diagrams (many in color — AIM's richest visual dataset
           of the whole expansion, per explicit product requirement).

Cross-references captured directly from the source, not inferred:
  - AIM-to-AIM: <a class="xref" href="chapN_sectionM.html#X-Y-Z"> — DOM link.
  - AIM-to-AC / AIM-to-P/CG: plain text inside the same reference-box
    ("AC 90-114, ..." / "Pilot/Controller Glossary Term- ...") — regex.
All three feed the new document_citations table (see migration below),
alongside P/CG's already-scraped external_refs (backfilled separately —
see scripts/backfill_pcg_citations.py companion, run once after this).

Figures: captured with their FAA source image URL. Not yet re-hosted to
Supabase Storage in this pass (that mirrors the ac_figures caching pattern
and is the natural fast-follow, same as AC PDF caching itself was added
after the initial AC scraper) — v1 here gets real, viewable figure data
into the app without gating the whole AIM rollout on a storage migration.

Modes:
  test    structure enumeration + one section (chap4_section_1) parse,
          no DB writes
  full    every section page — upserts aim_chapters, aim_paragraphs,
          aim_figures, and document_citations rows

Usage:
  python aim_scraper.py --mode test
  python aim_scraper.py --mode full

Environment variables required for full mode:
  SUPABASE_URL             e.g. https://abcdefg.supabase.co
  SUPABASE_SERVICE_KEY     service_role secret key (not anon key)
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from revision_log import log_revisions  # noqa: E402
from citation_validate import fetch_known_ids, fetch_known_pcg_slugs  # noqa: E402

# ──────────────────────────────────────────────────────────────────────────────
#  Config
# ──────────────────────────────────────────────────────────────────────────────

AIM_BASE = "https://www.faa.gov/air_traffic/publications/atpubs/aim_html/"
AIM_INDEX_URL = AIM_BASE + "index.html"

# See build_aim_pdf_headers.py's module docstring for the full story: the
# FAA's HTML edition genuinely omits header text for some tables (confirmed
# by direct inspection of the raw HTML, the live rendered DOM, and CSS
# ::before injection — nowhere), while their PDF edition has it. This file
# (built once, offline, from that PDF's real text layer — no OCR/Vision
# needed) is a title -> recovered-header lookup this scraper consults
# whenever a table has no <thead> of its own, rather than shipping that
# table with no header at all.
_PDF_HEADERS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "aim_pdf_table_headers.json")
try:
    with open(_PDF_HEADERS_PATH) as _f:
        PDF_TABLE_HEADERS: dict = json.load(_f)
except FileNotFoundError:
    PDF_TABLE_HEADERS = {}


def _normalize_table_title(title: str) -> str:
    # See build_aim_pdf_pages.py's identical helper for why — PDF text
    # extraction uses a real minus sign / en-dash where the HTML source
    # has a plain hyphen, and that silent difference broke otherwise
    # perfect title matches.
    t = re.sub(r"[‐‑‒–—−]", "-", title)
    t = re.sub(r"[‘’‛]", "'", t)
    return re.sub(r"\s+", " ", t.strip().lower())

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

REQUEST_DELAY = 0.5
REQUEST_TIMEOUT = 30

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("aim_scraper")


def make_session() -> requests.Session:
    """faa.gov 403s a bare/default User-Agent — same browser-header
    workaround as faa_scraper.py / pcg_scraper.py."""
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


# ──────────────────────────────────────────────────────────────────────────────
#  Step 1: Enumerate chapters + section pages from the real nav index
# ──────────────────────────────────────────────────────────────────────────────

def fetch_index(session: requests.Session) -> tuple[list[dict], list[dict]]:
    """Returns (chapters, section_pages).
    chapters: [{chapter, title, sort_order}]
    section_pages: [{href, chapter, section_title}] in document order.

    Includes the 5 appendices (appendix_1.html .. appendix_5.html) as
    synthetic chapters "A1".."A5" — confirmed live: a first version of this
    scraper's URL matching only recognized chap{N}_section{M}.html and
    silently skipped every appendix entirely, dropping real substantial
    content (Appendix 3 "Abbreviations/Acronyms" alone is a 500+ entry
    table; Appendix 4 is 20 tables of international-flight-plan field
    definitions). Caught via a direct page-count sanity check, not
    discovered by this code on its own.
    """
    resp = session.get(AIM_INDEX_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    chapters: dict[str, dict] = {}
    section_pages: list[dict] = []
    seen_hrefs = set()

    for a in soup.find_all("a", href=True):
        href = a["href"].lstrip("./")
        text = a.get_text(strip=True)

        m_chap = re.match(r"^chap_(\d+)\.html$", href)
        if m_chap:
            chap_num = m_chap.group(1)
            # Prefer the fuller "Chapter N. Title" text form when seen twice
            # (the nav lists each chapter link more than once with varying
            # link text — short form in the outline, full form elsewhere).
            if chap_num not in chapters or text.lower().startswith("chapter"):
                title = re.sub(r"^Chapter\s+\d+\.\s*", "", text).strip() or text
                chapters[chap_num] = {"chapter": chap_num, "title": title}
            continue

        m_sec = re.match(r"^chap(\d+)_section_(\d+)\.html$", href)
        if m_sec and href not in seen_hrefs:
            seen_hrefs.add(href)
            section_pages.append({
                "href": href,
                "chapter": m_sec.group(1),
                "section_num": m_sec.group(2),
                "section_title": text,
            })
            continue

        m_appx = re.match(r"^appendix_(\d+)\.html$", href)
        if m_appx and href not in seen_hrefs:
            seen_hrefs.add(href)
            appx_num = m_appx.group(1)
            appx_chapter = f"A{appx_num}"
            if appx_chapter not in chapters:
                chapters[appx_chapter] = {"chapter": appx_chapter, "title": f"Appendix {appx_num}"}
            section_pages.append({
                "href": href,
                "chapter": appx_chapter,
                "section_num": "1",
                "section_title": text or f"Appendix {appx_num}",
            })

    # Sort numbered chapters (0-11) before lettered appendices (A1-A5).
    chapter_list = sorted(
        chapters.values(),
        key=lambda c: (1, c["chapter"]) if c["chapter"].startswith("A") else (0, int(c["chapter"])),
    )
    for i, c in enumerate(chapter_list):
        c["sort_order"] = i

    section_pages.sort(
        key=lambda s: (1, s["chapter"]) if s["chapter"].startswith("A") else (0, int(s["chapter"]), int(s["section_num"]))
    )
    return chapter_list, section_pages


# ──────────────────────────────────────────────────────────────────────────────
#  Step 2: Parse one section page → paragraphs + figures + citations
# ──────────────────────────────────────────────────────────────────────────────

# Confirmed live: AC mentions appear both as "AC 90-114" and as
# "FAA Advisory Circular (AC) 90-66" — the latter has ")" between "AC" and
# the number, which the naive "AC\s+" pattern misses entirely.
_AC_RE = re.compile(r"\bAC\)?\s+(\d+(?:\.\d+)?-\d+[A-Za-z]*(?:[\-–]\d+)?)\b")

# Same pattern already proven in ad_citations.py and crossRefLinks.ts's
# render-time linkifier -- kept consistent rather than reinventing one.
_FAR_RE = re.compile(r"(?:§\s*|\bFAR\s+|\b14\s*CFR\s*(?:section\s+|§\s*)?)(\d+\.\d+)\b")


_BR_MARK = "\x00BR\x00"


def _block_text(elem) -> str:
    """get_text(), but a <br> inside the block becomes a real paragraph
    break instead of vanishing into the whitespace collapse below.
    Confirmed live: AIM's <aside class="phraseology-box"> radio-call
    examples are 2-3 separate transmissions inside ONE <p>, separated only
    by <br/> ("FREDERICK UNICOM... FREDERICK.<br/>FREDERICK TRAFFIC...
    FREDERICK.<br/>...") — a naive get_text(separator=" ") joins all of
    them with a single space, which is exactly what made three genuinely
    distinct radio calls read as one unreadable run-on block. The <br>
    must be swapped for a sentinel BEFORE the whitespace-collapse (which
    would otherwise eat a literal "\\n\\n" too) and converted to the real
    paragraph break AFTER it."""
    for br in elem.find_all("br"):
        br.replace_with(_BR_MARK)
    text = " ".join(elem.get_text(separator=" ", strip=True).split())
    return re.sub(rf"\s*{re.escape(_BR_MARK)}\s*", "\n\n", text)


def _text_excluding(elem, tag_names: list[str]) -> str:
    """_block_text(elem) with any nested tags in tag_names stripped out
    first — needed wherever that content is rendered/split out separately
    so it isn't ALSO flattened into the surrounding prose. A first version
    filtered by checking only elem's DIRECT children's tag name ("skip this
    child if it's a table"), which works when the excluded tag IS a direct
    child but silently fails otherwise — confirmed live on AIM 4-3-13's
    light-gun table: it sits inside a <div> inside its <li>, not as a
    direct child of either, so the direct-children check let the div
    through untouched and get_text() on that div still recursed straight
    into the table, duplicating its entire content as a second, flattened
    copy right after the properly rendered one. Cloning via a fresh parse
    and decomposing every matching descendant (at any depth) before reading
    text is the only way to reliably exclude it regardless of nesting.

    "aside" in tag_names means ONLY <aside class="reference-box"> — NOT
    every aside variant. A first version decomposed ALL <aside> tags
    indiscriminately to stop reference-box duplication, which silently
    deleted every <aside class="phraseology-box"> radio-call example from
    body_text entirely (a real production regression, caught before it
    shipped a second time) — phraseology boxes have no separate section of
    their own anywhere in the app, unlike reference boxes, so excluding
    them from body_text doesn't relocate that content, it just destroys
    it.

    "figure" means <figure class="fig"> — figures already get their own
    citation/extraction pass (_figure_record, feeding the Figures & Tables
    strip) exactly like tables and reference boxes do, so leaving them in
    the general text flatten double-counts them too. Confirmed live on AIM
    6-2-6 (17 hand-signal figures nested inside a sub-<ol>): every single
    figure's own caption ("Ground-Air Visual Code for Use by Survivors",
    "Urgent Medical Assistance", ...) was appearing crammed into one
    run-on sentence in body_text, each one ALSO a live "FIG 6-2-6" link —
    a wall of 17 repeated inline links with no line breaks, because
    _extract_list_blocks() (used for this nested-list shape) never knew to
    exclude figures the way the main loop's top-level flatten already did."""
    has_excludable = any(
        elem.find("aside", class_="reference-box") if t == "aside"
        else elem.find("figure", class_="fig") if t == "figure"
        else elem.find(t)
        for t in tag_names
    )
    if not has_excludable:
        return _block_text(elem)
    clone = BeautifulSoup(str(elem), "html.parser")
    for t in tag_names:
        if t == "aside":
            for e in clone.find_all("aside", class_="reference-box"):
                e.decompose()
        elif t == "figure":
            for e in clone.find_all("figure", class_="fig"):
                e.decompose()
        else:
            for e in clone.find_all(t):
                e.decompose()
    for br in clone.find_all("br"):
        br.replace_with(_BR_MARK)
    text = " ".join(clone.get_text(separator=" ", strip=True).split())
    return re.sub(rf"\s*{re.escape(_BR_MARK)}\s*", "\n\n", text)


def _text_excluding_tables(elem) -> str:
    # Excludes reference-box <aside> and <figure class="fig"> content too,
    # not just tables — see _text_excluding()'s docstring for both. Both
    # get their own dedicated extraction already, so leaving them in this
    # general-purpose flatten double-counts them — confirmed live twice
    # now, once for reference boxes ("REFERENCE- AIM, Para 3-5-4..."
    # showing up verbatim mid-paragraph AND again in its own section) and
    # once for figures (AIM 6-2-6's 17 hand-signal captions crammed into
    # one run-on sentence of repeated inline links).
    return _text_excluding(elem, ["table", "aside", "figure"])


def _extract_list_blocks(list_elem) -> list[str]:
    """Splits an <ol>/<ul> into one text block per <li>, RECURSING into any
    sub-list nested inside a <li> rather than stopping at the outer list's
    direct children. Confirmed live on AIM 5-5-16 (RNAV/RNP procedures): the
    entire ~4800-char body was a single top-level <li> ("General.") wrapping
    a SECOND <ol> of 11 real, distinct sub-items — a one-level-deep split
    (walk the outer <ol>'s direct <li>s, done) still produced exactly one
    giant flattened block, because there was only ever one direct <li> to
    split on; the real content was a level deeper. Any <table> nested at
    any depth is rendered as its own block via _render_table(), matching
    the handling already applied to non-nested lists."""
    blocks: list[str] = []
    for li in list_elem.find_all("li", recursive=False):
        nested_lists = li.find_all(["ol", "ul"], recursive=False)
        # Tables that live INSIDE one of this li's own nested sub-lists are
        # deliberately excluded here — they get rendered by the recursive
        # _extract_list_blocks(nl) call below instead. Confirmed live as a
        # real, serious bug: AIM 5-3-1's CPDLC message tables sit 4 <li>
        # levels deep (li > ol > li > ol > li > ol > li > table). Every
        # ancestor li's own find_all("table") search recurses through ALL
        # descendants regardless of depth, so the SAME deeply-nested table
        # got independently rediscovered and re-rendered once per
        # ancestor level — one real table appeared 4 times in body_text,
        # each occurrence colliding on insert once backfilled as a figure.
        nested_table_ids = {id(t) for nl in nested_lists for t in nl.find_all("table")}
        for t in li.find_all("table"):
            if id(t) in nested_table_ids:
                continue
            rendered = _render_table(t)
            if rendered:
                blocks.append(rendered)
        if nested_lists:
            lead = _text_excluding(li, ["table", "ol", "ul", "aside", "figure"])
            if lead:
                blocks.append(lead)
            for nl in nested_lists:
                blocks.extend(_extract_list_blocks(nl))
        else:
            text = _text_excluding_tables(li)
            if text:
                blocks.append(text)
    return blocks


_TABLE_HEADER_MARK = ""  # Unicode Private Use Area — never occurs in real scraped text


def _cell_text(elem) -> str:
    """Like _block_text(), but a <br> inside a table CELL becomes "; "
    instead of a paragraph break. Confirmed live as a real, serious bug:
    AIM's "Coast Guard Rescue Coordination Centers" table has each cell as
    "Alameda, CA<br/>510-437-3701" (city + phone meant to display on two
    lines within ONE cell) — reusing _block_text()'s <br> -> "\\n\\n"
    conversion here meant the rendered table's single "Alameda, CA | ..."
    row string had a "\\n\\n" buried inside it, and body_text's own
    top-level paragraph split (on "\\n\\n") can't tell that apart from a
    real inter-paragraph break — it shredded this ONE table into several
    disconnected fragments, each missing the header the others kept, the
    exact glyph/structure mess a live user report caught. A table cell's
    internal line break should stay inside that cell's own text, never
    escalate to breaking the table itself apart."""
    for br in elem.find_all("br"):
        br.replace_with("; ")
    return " ".join(elem.get_text(separator=" ", strip=True).split())


def _render_table(table_elem) -> str:
    """Flatten a <table> into readable pipe-delimited text — same approach
    as far_scraper.py's _render_table. Confirmed live: AIM Appendix 3
    (Abbreviations/Acronyms, ~500+ entries) and Appendix 4 (international
    flight plan field reference, 20 separate tables) are ENTIRELY table
    content with no numbered-paragraph structure — naive text flattening
    would have interleaved every abbreviation with its meaning into one
    unreadable run-on string instead of preserving the real term/definition
    pairing.

    Includes the table's own <caption> (e.g. "TBL 4-3-13 Airport Traffic
    Control Tower Light Gun Signals") as a leading line when present, so a
    rendered table reads as a titled, self-identifying block of text rather
    than an unlabeled grid of values.

    Rows genuinely inside a <thead> are marked with _TABLE_HEADER_MARK so
    the app can style them as a real header — and, critically, so it does
    NOT invent a fake one when there isn't a <thead> at all. Confirmed live
    as a real, serious bug: AIM's "Runways With/Without Approach Lights"
    tables have NO <thead> and their first two rows are entirely empty
    <td> cells (no header text anywhere in this HTML edition, verified by
    direct inspection — <th>, aria-label, everything checked). The client
    was unconditionally treating the first pipe-delimited line as a header
    regardless, which for this table meant a REAL DATA ROW ("Approach
    Lights (Med. Int.) | 2 | Off | Low | Low | High") got shaded and styled
    as if it were the column labels — actively wrong, not just incomplete,
    and confirmed against the real printed AIM page which has actual column
    headers ("Lighting System", "No. of Int. Steps", "3 Clicks", "5
    Clicks", "7 Clicks") this HTML source simply does not carry as text
    anywhere. Marking real headers explicitly means "no <thead>" now
    correctly renders as an unstyled, honest data grid instead of a
    confidently mislabeled one."""
    lines = []
    caption = table_elem.find("caption")
    if caption:
        cap_text = _block_text(caption)
        if cap_text:
            lines.append(cap_text)

    thead = table_elem.find("thead")
    header_rows = thead.find_all("tr") if thead else []
    body_rows = [r for r in table_elem.find_all("tr") if r not in header_rows]

    header_lines = []
    for row in header_rows:
        cells = [_cell_text(c) for c in row.find_all(["th", "td"])]
        cells = [c for c in cells if c]
        if cells:
            header_lines.append(_TABLE_HEADER_MARK + " | ".join(cells))

    # No real <thead> — try to recover a real header from the PDF-derived
    # lookup (see build_aim_pdf_headers.py) before giving up and rendering
    # this table with no header at all.
    if not header_lines and caption:
        title_span = caption.find("span", class_="tbl-title")
        title = _block_text(title_span) if title_span else None
        if title:
            recovered = PDF_TABLE_HEADERS.get(_normalize_table_title(title))
            if recovered and recovered.get("header"):
                header_lines.append(_TABLE_HEADER_MARK + " | ".join(recovered["header"]))

    lines.extend(header_lines)

    for row in body_rows:
        cells = [_cell_text(c) for c in row.find_all(["th", "td"])]
        cells = [c for c in cells if c]
        if cells:
            lines.append(" | ".join(cells))

    return "\n".join(lines)


def _citations_from_reference_box(box_elem, citing_id: str) -> tuple[str, list[dict]]:
    """Returns (flattened_ref_text, citations) for one <aside class=reference-box>."""
    ref_text = _block_text(box_elem)
    citations: list[dict] = []

    # AIM-internal cross-refs: real <a class="xref" href="...#X-Y-Z"> DOM
    # links. The paragraph number lives in the href's #fragment, not the
    # anchor's visible text -- confirmed live as a real bug: visible text
    # is often free-form phrasing ("see Chapter 5, Section 3", "paragraph
    # j", or occasionally a bare URL), none of which is a real paragraph
    # number, so using get_text() produced 19 dead-end aim->aim citations
    # across the corpus (e.g. "aim:4-1-20 -> aim:Chapter 5"). Falls back to
    # visible text only if the href has no usable fragment, since that's
    # still strictly better than nothing for the rare non-standard link.
    seen_aim_targets: set[str] = set()
    for a in box_elem.find_all("a", class_="xref"):
        href = a.get("href", "")
        frag = href.split("#", 1)[1] if "#" in href else ""
        target_para = frag.strip() or a.get_text(strip=True)
        # Skip self-references. A paragraph's own reference box can link back
        # to itself, which renders as a MagicLink to the page you are already
        # on. Measured: exactly one across the corpus (AIM 5-3-8 -> 5-3-8),
        # so this is cheap insurance rather than a big cleanup.
        #
        # Skip repeats too -- a reference box can carry two <a class="xref">
        # tags pointing at the same paragraph (e.g. the same target named
        # once in prose and once in a "See also" line). Found live via
        # scripts/magiclink_audit.py: 3 duplicate aim->aim rows corpus-wide,
        # all same-box repeats.
        if target_para and target_para != citing_id and target_para not in seen_aim_targets:
            seen_aim_targets.add(target_para)
            citations.append({
                "citing_type": "aim", "citing_id": citing_id,
                "cited_type": "aim", "cited_id": target_para,
                "label": None,
            })

    # AC mentions: plain text, regex-extracted.
    for m in _AC_RE.finditer(ref_text):
        citations.append({
            "citing_type": "aim", "citing_id": citing_id,
            "cited_type": "ac", "cited_id": m.group(1),
            "label": None,
        })

    # FAR section mentions ("§ 91.107", "FAR 91.107", "14 CFR 91.107") --
    # confirmed live as a real gap: this function had zero FAR detection at
    # all, so document_citations had 0 aim->far rows across the entire
    # 438-paragraph corpus despite AIM referencing FARs constantly. Same
    # regex already proven in ad_citations.py and crossRefLinks.ts's
    # render-time linkifier -- kept consistent rather than reinventing one.
    for m in _FAR_RE.finditer(ref_text):
        citations.append({
            "citing_type": "aim", "citing_id": citing_id,
            "cited_type": "far", "cited_id": m.group(1),
            "label": None,
        })

    # aim->pcg is NOT written here. sync/pcg_term_links.py owns every
    # cited_type='pcg' row and rebuilds them corpus-wide with full
    # glossary-phrase matching -- it produces 2,359 aim->pcg links where this
    # "Pilot/Controller Glossary Term- X" pattern caught only the handful of
    # paragraphs that spell that phrase out, and its rows replaced these
    # later the same day regardless. Writing from both places is what forced
    # delete_citations_for_source() to be unscoped, which then wiped
    # pcg_term_links' work -- see that function.

    return ref_text, citations


def _figure_record(fig_elem, paragraph_number: str, href: str, sort_order: int) -> Optional[dict]:
    img = fig_elem.find("img")
    if not img or not img.get("src"):
        return None
    caption = fig_elem.find("figcaption")
    fig_number = fig_title = None
    if caption:
        num_span = caption.find("span", class_="fig-number")
        title_span = caption.find("span", class_="fig-title")
        fig_number = num_span.get_text(strip=True) if num_span else None
        fig_title = title_span.get_text(strip=True) if title_span else None
    return {
        "paragraph_number": paragraph_number,
        "label": fig_number,
        # Coalesced to "" rather than left None -- same reasoning as the
        # bare-<img> fallback path's label fix below: aim_figures' upsert
        # conflict key includes caption, and Postgres never treats two
        # NULLs as equal, so any figure whose <figcaption> has a number but
        # no title span (confirmed live, paragraph 5-4-9: three real,
        # distinct figures share the bare "FIG 5-4-9" label with nothing
        # else to tell them apart) would silently duplicate on every
        # re-scrape instead of upserting in place.
        "caption": fig_title or "",
        "image_url": urljoin(href_to_url(href), img["src"]),
        "sort_order": sort_order,
    }


def _disambiguate_figure_labels(figures: list[dict]) -> list[dict]:
    """Appends a/b/c... to figure labels that collide within the same
    paragraph — confirmed live: the FAA's own AIM HTML gives the exact same
    <span class="fig-number"> text to multiple genuinely distinct images.
    Paragraph 2-1-8 alone has three real, different figures (Runway
    Entrance Lights / Takeoff Hold Lights / Taxiway Lead-On Light
    Configuration) all captioned "FIG 2-1-8" with nothing else in the
    source to tell them apart; 2-1-2 repeats "FIG 2-1-2" eight times. Left
    as-is, every one of those cards in the app (search results, the
    Figures & Tables strip, the viewer's own header) shows the identical,
    useless label — the caption text is the only thing distinguishing them,
    and it's often truncated in a card. Since a user can't act on "FIG
    2-1-8" three times over, suffixing by first-seen order within the
    paragraph (matching sort_order, i.e. source document order) turns it
    into "FIG 2-1-8a" / "FIG 2-1-8b" / "FIG 2-1-8c" — self-identifying
    everywhere at a glance, which the source itself doesn't offer. A
    genuinely one-of-a-kind label in its paragraph is left untouched.

    Also stamps every figure with `occurrence` -- its 0-indexed position
    within this same tied group (0 for anything never tied at all). This is
    the STABLE identity signal aim_figures' upsert on_conflict actually
    needs: (paragraph_number, sort_order, caption) is not quite unique on
    its own -- confirmed live 2026-08-01, three genuinely distinct real
    NEXRAD Coverage figures in paragraph 7-1-11 share an identical
    sort_order (the HTML groups them under one parent, so the scraper's
    fig_sort counter never increments between them) AND an identical
    caption. `occurrence` is exactly the tiebreak already computed here for
    the a/b/c label suffix, just persisted as its own column instead of
    thrown away after building the display string."""
    from collections import defaultdict
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for fig in figures:
        fig["occurrence"] = 0
        groups[(fig["paragraph_number"], fig["label"])].append(fig)
    for (_, label), group in groups.items():
        if label and len(group) > 1:
            group.sort(key=lambda f: f["sort_order"])
            for i, fig in enumerate(group):
                fig["label"] = f"{label}{chr(ord('a') + i)}"
                fig["occurrence"] = i
    return figures


def parse_section_page(html: str, chapter: str, section_title: str, href: str) -> dict:
    """Returns {paragraphs: [...], figures: [...], citations: [...]}.

    Reference boxes and figures are NOT always direct children of the top-
    level content flow — confirmed live: 6 of 10 reference boxes in
    chap4_section_1 are nested inside <li> elements (a sub-item's own
    reference note). A first version that only checked top-level <aside>/
    <figure> tags silently dropped 60% of citations in that section alone.
    Every top-level element is therefore searched for nested reference
    boxes/figures in addition to being checked directly — not just handled
    when it happens to be one itself.
    """
    soup = BeautifulSoup(html, "html.parser")
    body = soup.find("div", class_="body")
    if not body:
        return {"paragraphs": [], "figures": [], "citations": []}

    paragraphs: list[dict] = []
    figures: list[dict] = []
    citations: list[dict] = []
    current: Optional[dict] = None
    fig_sort = 0

    top_level = body.find_all(recursive=False)
    has_numbered_paragraphs = any(
        el.name == "h4" and "paragraph-title" in (el.get("class") or []) for el in top_level
    )
    if not has_numbered_paragraphs:
        # Confirmed live: chap0_section_0.html ("Explanation of Changes")
        # has zero <h4 class="paragraph-title"> — it's front-matter prose
        # (heading + plain <p> paragraphs), not the numbered-paragraph
        # convention used everywhere else in AIM. A first version silently
        # produced zero paragraphs for this page, dropping real content
        # (a real, useful changelog of what's new in this AIM revision).
        # Fall back to treating the whole page as one synthetic paragraph,
        # keyed by its href (guaranteed unique, and visibly distinct from
        # real "X-Y-Z" numbered paragraphs) rather than losing the text.
        synthetic_id = href.replace(".html", "").replace("/", "_")
        # The nav index only gives a generic label ("Appendix 3") for
        # appendix pages — the real descriptive title ("Abbreviations/
        # Acronyms") lives in the page's own leading <strong> text
        # ("Appendix 3. Abbreviations/Acronyms"). Prefer that when present.
        page_title = section_title
        first_strong = body.find("strong")
        if first_strong:
            strong_text = _block_text(first_strong)
            m_title = re.match(r"^Appendix\s+\d+\.\s*(.+)$", strong_text)
            if m_title and m_title.group(1):
                page_title = m_title.group(1)

        current = {
            "paragraph_number": synthetic_id,
            "chapter": chapter,
            "section_title": page_title,
            "title": page_title,
            "body_parts": [],
            "reference_parts": [],
        }
        paragraphs.append(current)
        fig_sort = 0
        for elem in top_level:
            # Bare <img> tags — confirmed live (Appendix 1/2's report-form
            # scans): these pages don't use the <figure class="fig"> wrapper
            # the main chapters use, so the normal figure-detection path
            # (which specifically looks for that wrapper) misses them
            # entirely. Capture each bare image directly, using its alt
            # text as the closest thing to a caption since there's no
            # <figcaption> here.
            #
            # label is a real, non-null synthetic value ("IMG 1", "IMG 2"...)
            # rather than None — confirmed live as a real production bug:
            # aim_figures' UNIQUE constraint included label, and Postgres
            # never treats two NULLs as equal in a unique index, so every
            # repeat full-scrape silently INSERTED a fresh duplicate row for
            # every label-less appendix image instead of upserting over the
            # old one. 14 stale duplicate rows had already piled up in
            # production before this was caught. A real label value closes
            # that gap for good, not just for today's cleanup.
            for img in elem.find_all("img"):
                if img.get("src"):
                    figures.append({
                        "paragraph_number": synthetic_id,
                        "label": f"IMG {fig_sort + 1}",
                        # "" not None -- same NULL-never-dedupes reasoning
                        # as the label fix in this same comment block, now
                        # that caption is also part of the upsert conflict
                        # key (see _figure_record()'s matching fix).
                        "caption": img.get("alt") or "",
                        "image_url": urljoin(href_to_url(href), img["src"]),
                        "sort_order": fig_sort,
                    })
                    fig_sort += 1

            if elem.name == "table":
                rendered = _render_table(elem)
                if rendered:
                    current["body_parts"].append(rendered)
                continue

            # A wrapper element (e.g. a <div>) might itself contain a table
            # rather than being one — render those too rather than letting
            # the generic flatten-everything branch below mash the table
            # into one unreadable run-on line.
            nested_tables = elem.find_all("table") if elem.name != "table" else []
            if nested_tables:
                for t in nested_tables:
                    rendered = _render_table(t)
                    if rendered:
                        current["body_parts"].append(rendered)
                # Still capture any non-table text this element carries.
                text = _text_excluding_tables(elem)
                if text:
                    current["body_parts"].append(text)
                continue

            text = _block_text(elem)
            if text:
                current["body_parts"].append(text)
        current["body_text"] = "\n\n".join(current.pop("body_parts")) or None
        current["reference_text"] = "\n".join(current.pop("reference_parts")) or None
        return {"paragraphs": paragraphs, "figures": _disambiguate_figure_labels(figures), "citations": citations}

    for elem in top_level:
        classes = elem.get("class") or []

        if elem.name == "h4" and "paragraph-title" in classes:
            para_num = elem.get("id")
            full_head = _block_text(elem)
            title = re.sub(rf"^{re.escape(para_num)}\.?\s*", "", full_head) if para_num else full_head
            current = {
                "paragraph_number": para_num,
                "chapter": chapter,
                "section_title": section_title,
                "title": title or None,
                "body_parts": [],
                "reference_parts": [],
            }
            paragraphs.append(current)
            continue

        if current is None:
            continue  # content before the first paragraph heading (rare/none expected)

        # Reference boxes anywhere within this element, top-level or nested
        # (e.g. inside a <li> of an <ol>) — find_all() only searches
        # descendants, so when elem itself IS the <aside> (the common case:
        # a reference box as a direct sibling of the preceding <p>), it has
        # to be included explicitly or it's silently missed.
        is_ref_box = elem.name == "aside" and "reference-box" in classes
        boxes = ([elem] if is_ref_box else []) + elem.find_all("aside", class_="reference-box")
        for box in boxes:
            ref_text, box_citations = _citations_from_reference_box(box, current["paragraph_number"])
            current["reference_parts"].append(ref_text)
            citations.extend(box_citations)

        # Figures anywhere within this element, same reasoning.
        is_figure = elem.name == "figure" and "fig" in classes
        figs = ([elem] if is_figure else []) + elem.find_all("figure", class_="fig")
        for fig in figs:
            rec = _figure_record(fig, current["paragraph_number"], href, fig_sort)
            if rec:
                figures.append(rec)
                fig_sort += 1

        if is_ref_box or is_figure:
            continue  # already handled above; don't also flatten into body text

        # <ol>/<ul> lists and bare <table> elements need dedicated handling,
        # not generic flattening — confirmed live on paragraph 4-3-13 (light
        # gun signals): a single <ol> held 5 distinct <li> items, one of
        # which had a full <table class="table table-scroll"> (real signal-
        # color/meaning data, no associated image — unlike the <figure
        # class="fig"> convention used elsewhere, so it can't become an
        # aim_figures row) nested inside it. A first version's generic
        # _block_text(elem) on the whole <ol> mashed all 5 items and the
        # entire table into one run-on string — unreadable, and the table's
        # own content effectively lost from the app. Walk list items
        # individually (same "search nested, don't just check self"
        # reasoning already applied to reference boxes/figures above) so
        # each becomes its own body_text paragraph, and render any bare
        # table via the same _render_table() helper this file's own
        # appendix-fallback path already uses for identical content.
        if elem.name in ("ol", "ul"):
            current["body_parts"].extend(_extract_list_blocks(elem))
            continue

        if elem.name == "table":
            rendered = _render_table(elem)
            if rendered:
                current["body_parts"].append(rendered)
            continue

        # A wrapper element (e.g. a <div>) might itself contain a table
        # rather than being one — render those too rather than letting the
        # generic flatten-everything branch below mash the table into one
        # unreadable run-on line.
        nested_tables = elem.find_all("table")
        if nested_tables:
            for t in nested_tables:
                rendered = _render_table(t)
                if rendered:
                    current["body_parts"].append(rendered)
            text = _text_excluding_tables(elem)
            if text:
                current["body_parts"].append(text)
            continue

        # Everything else (p, div, etc.) — flatten as body text, excluding
        # any nested reference-box (already captured above into
        # reference_parts, and rendered in its own References section in
        # the app — including it here too duplicated "REFERENCE- AIM, Para
        # 3-5-4..." verbatim in the middle of ordinary prose AND again at
        # the bottom of the page, confirmed live) and any nested figure
        # (already captured above into the figures list — see
        # _text_excluding()'s docstring for the AIM 6-2-6 case this fixes).
        text = _text_excluding(elem, ["aside", "figure"])
        if text:
            current["body_parts"].append(text)

    for p in paragraphs:
        p["body_text"] = "\n\n".join(p.pop("body_parts")) or None
        p["reference_text"] = "\n".join(p.pop("reference_parts")) or None

    return {"paragraphs": paragraphs, "figures": _disambiguate_figure_labels(figures), "citations": citations}


def href_to_url(href: str) -> str:
    return urljoin(AIM_BASE, href)


def fetch_section(session: requests.Session, page: dict, retries: int = 3) -> dict:
    url = href_to_url(page["href"])
    last_exc = None
    for attempt in range(retries):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return parse_section_page(resp.text, page["chapter"], page["section_title"], page["href"])
        except requests.RequestException as e:
            last_exc = e
            if attempt < retries - 1:
                wait = 2 * (attempt + 1)
                log.warning(f"  {page['href']} fetch failed ({e}) — retrying in {wait}s")
                time.sleep(wait)
    raise last_exc


# ──────────────────────────────────────────────────────────────────────────────
#  Supabase — same raw-REST pattern as the other scrapers
# ──────────────────────────────────────────────────────────────────────────────

def _supa_headers(extra: dict = None) -> dict:
    h = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def _upsert(table: str, rows: list[dict], on_conflict: str) -> bool:
    if not rows:
        return True
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would upsert {len(rows)} rows into {table}")
        return True
    # What's Changed timeline logging -- must run BEFORE the upsert below,
    # which is about to overwrite whatever's currently live. Scoped to just
    # aim_paragraphs (the content-bearing table this function also writes
    # aim_figures/document_citations rows through) -- see revision_log.py.
    if table == "aim_paragraphs":
        try:
            n = log_revisions(
                SUPABASE_URL, _supa_headers(), doc_type="aim", table="aim_paragraphs",
                key_field="paragraph_number", text_field="body_text", title_field="title",
                new_rows=rows,
            )
            if n:
                log.info(f"  Logged {n} AIM revision(s) for What's Changed")
        except Exception as e:
            log.warning(f"  revision logging failed (non-fatal): {e}")
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_supa_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            params={"on_conflict": on_conflict},
            json=rows,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  {table} upsert failed: {e}")
        return False


def prune_dead_aim_aim_citations() -> int:
    """Deletes aim->aim citations whose target paragraph doesn't actually
    exist, now that the full run has finished and aim_paragraphs holds the
    complete corpus.

    aim->aim is deliberately left unvalidated during the page loop (see the
    comment at its call site) since a forward reference to a not-yet-
    scraped page would look "dead" against a mid-run snapshot when it's
    perfectly real. That means genuinely-dead targets -- a stale href to a
    paragraph number the FAA renumbered or removed -- were never checked
    against anything. Found live via scripts/magiclink_audit.py: 14 such
    rows corpus-wide. Runs once, after the loop, against the now-complete
    paragraph set."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 0
    known = fetch_known_ids()["aim"]
    cited_ids: set[str] = set()
    offset = 0
    while True:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers=_supa_headers(),
            params={"select": "cited_id", "citing_type": "eq.aim", "cited_type": "eq.aim",
                    "limit": 1000, "offset": offset},
            timeout=30,
        )
        resp.raise_for_status()
        batch = resp.json()
        cited_ids.update(r["cited_id"] for r in batch)
        if len(batch) < 1000:
            break
        offset += 1000
    dead = sorted({c for c in cited_ids if c not in known})
    if not dead:
        return 0
    del_resp = requests.delete(
        f"{SUPABASE_URL}/rest/v1/document_citations",
        headers=_supa_headers({"Prefer": "return=minimal"}),
        params={"citing_type": "eq.aim", "cited_type": "eq.aim", "cited_id": f"in.({','.join(dead)})"},
        timeout=30,
    )
    del_resp.raise_for_status()
    return len(dead)


def delete_citations_for_source(citing_type: str) -> bool:
    """Clears every document_citations row this scraper previously wrote,
    right before a full re-run repopulates them — see insert_citations()'s
    docstring for why a plain insert can't self-dedupe. Confirmed live as a
    real production issue, not a hypothetical: this exact scraper's own
    citations went 115 -> 575 (5x) over one session of manual re-runs
    before this was automated, because "delete first" was a documented but
    manual step that was easy to forget mid-debugging."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would delete citing_type={citing_type} rows")
        return True
    try:
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            # Scoped to the cited_types this scraper writes. Unscoped it also
            # deleted the 2,359 aim->pcg links owned by
            # sync/pcg_term_links.py, which only survived because that script
            # runs later in the week (AD sync, Mon 14:00, vs AIM at 11:00) --
            # so they were missing for three hours weekly, and for a full
            # week whenever the AD sync failed.
            params={"citing_type": f"eq.{citing_type}",
                    "cited_type": "in.(ac,far,aim,ad)"},
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  document_citations delete (citing_type={citing_type}) failed: {e}")
        return False


def insert_citations(rows: list[dict]) -> bool:
    """Plain insert, not upsert — document_citations has no natural single-row
    unique key (a citing doc can legitimately cite the same target more than
    once from different paragraphs), so re-running a full scrape appends.
    Callers doing a full re-sync MUST call delete_citations_for_source()
    first — run_full() below does this automatically."""
    if not rows:
        return True
    if not SUPABASE_URL or not SUPABASE_KEY:
        log.debug(f"  [DRY-RUN] would insert {len(rows)} citation rows")
        return True
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/document_citations",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            json=rows,
            timeout=30,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        log.error(f"  document_citations insert failed: {e}")
        return False


def log_scraper_run(run: dict) -> None:
    # Was a bare `except: pass` -- confirmed live, 2026-08-09: this run_record's
    # own field names (aim_paragraphs_total, aim_figures_total,
    # aim_citations_total, aim_errors, aim_upsert_failures) had NEVER matched
    # any real column on the shared scraper_runs table (which only ever had
    # faa_scraper.py's AC-specific columns) -- every single AIM sync run had
    # been silently failing to log here, this whole time, with the swallowed
    # exception hiding it completely. Columns added back
    # (sync/migrations_scraper_runs_far_aim_pcg_columns.sql); this log line
    # stays so any FUTURE drift shows up in the run's own log instead of
    # vanishing the same way again.
    if not SUPABASE_URL or not SUPABASE_KEY:
        return
    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/scraper_runs",
            headers=_supa_headers({"Prefer": "return=minimal"}),
            json=run, timeout=10,
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

def run_test(session: requests.Session):
    log.info("TEST MODE — index enumeration + chap4_section_1 only (no DB writes)")
    chapters, pages = fetch_index(session)
    log.info(f"Chapters: {len(chapters)}  Section pages: {len(pages)}")
    for c in chapters[:4]:
        log.info(f"  Chapter {c['chapter']}: {c['title']}")

    page = next(p for p in pages if p["href"] == "chap4_section_1.html")
    result = fetch_section(session, page)
    log.info(f"\nParsed {len(result['paragraphs'])} paragraphs, "
              f"{len(result['figures'])} figures, {len(result['citations'])} citations")

    for p in result["paragraphs"][:3]:
        log.info(f"\n{'─'*50}")
        log.info(f"{p['paragraph_number']}  {p['title']}")
        log.info(f"Body: {(p['body_text'] or '')[:150]}")
        if p["reference_text"]:
            log.info(f"Refs: {p['reference_text'][:150]}")

    for c in result["citations"][:5]:
        log.info(f"Citation: {c}")


def run_full(session: requests.Session):
    log.info("=" * 60)
    log.info("FULL SCRAPE — AIM")
    log.info("=" * 60)

    run_record = {"mode": "full", "started_at": datetime.now(timezone.utc).isoformat(), "status": "running"}

    chapters, pages = fetch_index(session)
    log.info(f"Chapters: {len(chapters)}  Section pages: {len(pages)}")
    _upsert("aim_chapters", chapters, "chapter")

    # See delete_citations_for_source()'s docstring — without this, every
    # repeat full-run appends a fresh copy of every citation on top of the
    # last one instead of replacing it.
    delete_citations_for_source("aim")

    # Validate aim->ac and aim->pcg citations against the real, already-
    # scraped AC/P-CG corpora before writing -- confirmed live as a real
    # gap (12 dead aim->ac + 3 dead aim->pcg citations from AC numbers/PCG
    # terms this regex matched that don't actually exist in our tables).
    # aim->aim is deliberately NOT filtered here: this loop is still
    # populating aim_paragraphs page by page, so a forward reference to a
    # not-yet-scraped page would look "unresolved" against a snapshot taken
    # now even though it's perfectly real -- see citation_validate.py.
    known_ac_ids = fetch_known_ids()["ac"]
    known_pcg_ids = fetch_known_pcg_slugs()

    total_paragraphs = total_figures = total_citations = 0
    errors = 0
    error_details = []
    # _upsert() catches its own HTTP errors and logs them rather than
    # raising, so a broken conflict key (or any other write failure) was
    # invisible to this function's error accounting entirely -- confirmed
    # live 2026-08-02: a stale on_conflict target after a schema change made
    # every single aim_figures upsert this run fail with a logged 400, yet
    # the run still finished, reported "Errors=0/53", and exited 0. The
    # header comment above claims `set -euo pipefail` makes any failing
    # step show red in Actions -- true only for exceptions that actually
    # propagate, which these never did. Counted separately from `errors`
    # (page-fetch failures) since a write failure is a different, arguably
    # worse class of problem: the page parsed fine, we just silently didn't
    # save any of it.
    upsert_failures = 0

    for i, page in enumerate(pages, 1):
        log.info(f"[{i}/{len(pages)}] {page['href']} — {page['section_title']}")
        try:
            result = fetch_section(session, page)
            now = datetime.now(timezone.utc).isoformat()
            for p in result["paragraphs"]:
                p["updated_at"] = now
            if result["paragraphs"]:
                # Only counted on real success -- same fix as aim_figures
                # below, applied here too rather than leaving this sibling
                # block with the identical gap.
                if _upsert("aim_paragraphs", result["paragraphs"], "paragraph_number"):
                    total_paragraphs += len(result["paragraphs"])
                else:
                    upsert_failures += 1
            if result["figures"]:
                # Conflict key is (paragraph_number, sort_order, caption,
                # occurrence) — NOT label, and NOT image_url.
                #
                # image_url was excluded first (confirmed live, past
                # incident): with image_url in the key, a plain re-scrape
                # couldn't recognize "this is the same figure whose image
                # was later upgraded by backfill_aim_pdf_images.py"
                # (different image_url = no conflict detected = a fresh
                # duplicate row inserted alongside the good one), silently
                # doubling aim_figures and resurrecting 252 rows' worth of
                # the exact wrong/duplicate-image FAA URLs that backfill had
                # already fixed.
                #
                # label was ALSO in the key after that fix, on the
                # reasoning that _disambiguate_figure_labels() makes it
                # unique per paragraph -- true only WITHIN one run's output,
                # not across runs. Confirmed live as a second, structurally
                # identical incident (2026-08-02, 239 duplicate rows found
                # corpus-wide): backfill_aim_pdf_images.py's entire job is
                # to CHANGE a row's label from a synthetic placeholder to
                # the real PDF-matched number. The next week's scrape
                # recomputes that same OLD synthetic label from the FAA's
                # HTML (which knows nothing about backfill's relabeling),
                # that no longer matches the row's now-different real
                # label, and PostgREST inserts a fresh duplicate instead of
                # updating in place. Every week, forever.
                #
                # (paragraph_number, sort_order, caption) is the actual
                # stable identity — a figure's position and caption text in
                # the FAA's HTML don't change just because backfill
                # relabeled it. The 4th column, occurrence, exists only for
                # the rare case where sort_order doesn't even advance
                # between genuinely distinct figures sharing one caption
                # (three separate real NEXRAD Coverage diagrams in one
                # paragraph, confirmed live) — see
                # _disambiguate_figure_labels()'s docstring above, which
                # computes this same tiebreak for the a/b/c display suffix.
                #
                # Re-running this scraper alone WILL overwrite a backfilled
                # image_url back to the raw FAA source URL for any figure it
                # re-touches — see sync_aim.sh, which always runs the PDF
                # backfill immediately afterward to restore it. Never run
                # this scraper's full mode without that following step.
                #
                # Deduped on that exact conflict key immediately before
                # upsert -- confirmed live 2026-08-11 while investigating a
                # scraper_runs log showing aim_figures_total=252 against
                # only 246 distinct FIG rows actually in the table.
                # _disambiguate_figure_labels() only defends against a
                # same-(paragraph, LABEL) collision; it doesn't catch two
                # figures landing on the same (sort_order, caption) with
                # DIFFERENT labels (e.g. one missing its <figcaption> number
                # where a sibling has one) -- a case PostgREST's own upsert
                # already silently collapses to one row (same semantics as
                # a literal SQL multi-row INSERT...ON CONFLICT). Without
                # this, total_figures -- summed from the pre-upsert list
                # length -- reports every attempted row as if it landed,
                # even the ones a same-batch collision just quietly dropped.
                figures_by_key: dict[tuple, dict] = {}
                for fig in result["figures"]:
                    key = (fig["paragraph_number"], fig["sort_order"], fig["caption"], fig["occurrence"])
                    figures_by_key[key] = fig
                deduped_figures = list(figures_by_key.values())
                if len(deduped_figures) != len(result["figures"]):
                    log.info(f"  {len(result['figures'])} figures parsed, {len(deduped_figures)} distinct "
                             f"after on-conflict-key dedup — keeping the later one per collision")
                # Only counted on real success -- this used to add
                # len(result["figures"]) unconditionally, so a page whose
                # upsert genuinely failed (network error, timeout) still had
                # its figures counted into the run's final total as if they
                # were written, the same "reported success the DB doesn't
                # back up" shape as ad_scraper.py's pre-fix silent-failure
                # gap. Didn't cause the specific 252-vs-246 incident above
                # (that run logged zero upsert failures) but is a real,
                # separate, still-live gap worth closing regardless.
                if _upsert("aim_figures", deduped_figures, "paragraph_number,sort_order,caption,occurrence"):
                    total_figures += len(deduped_figures)
                else:
                    upsert_failures += 1
            if result["citations"]:
                resolved_citations = [
                    c for c in result["citations"]
                    if not (c["cited_type"] == "ac" and c["cited_id"] not in known_ac_ids)
                    and not (c["cited_type"] == "pcg" and c["cited_id"] not in known_pcg_ids)
                ]
                if resolved_citations:
                    # Same fix as the two blocks above -- insert_citations()
                    # already returns a real success/failure bool, it just
                    # wasn't being checked here.
                    if insert_citations(resolved_citations):
                        total_citations += len(resolved_citations)
                    else:
                        upsert_failures += 1
            log.info(f"  → {len(result['paragraphs'])} paragraphs, "
                     f"{len(result['figures'])} figures, {len(result['citations'])} citations")
        except Exception as e:
            log.error(f"  ✗ {page['href']} failed: {e}")
            errors += 1
            error_details.append({"page": page["href"], "error": str(e)})
        time.sleep(REQUEST_DELAY)

    pruned_dead_aim = prune_dead_aim_aim_citations()
    if pruned_dead_aim:
        log.info(f"Pruned {pruned_dead_aim} aim->aim citation(s) whose target paragraph doesn't exist.")

    run_record.update({
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "status": "success" if errors == 0 and upsert_failures == 0 else "partial",
        "aim_paragraphs_total": total_paragraphs,
        "aim_figures_total": total_figures,
        "aim_citations_total": total_citations,
        "aim_errors": errors,
        "aim_upsert_failures": upsert_failures,
        "error_details": error_details,
    })
    log_scraper_run(run_record)
    log.info(f"\nDone. Paragraphs={total_paragraphs} Figures={total_figures} "
             f"Citations={total_citations} Errors={errors}/{len(pages)} "
             f"UpsertFailures={upsert_failures}")
    if upsert_failures:
        log.error(f"{upsert_failures} batch(es) failed to write to the database this run "
                  f"(see 'upsert failed' lines above) -- failing so this shows red in Actions "
                  f"instead of silently writing nothing.")
        sys.exit(1)


# ──────────────────────────────────────────────────────────────────────────────
#  CLI entry point
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AIM Scraper")
    parser.add_argument("--mode", choices=["test", "full"], default="test")
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
        log.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set for full mode.")
        sys.exit(1)

    session = make_session()
    if args.mode == "test":
        run_test(session)
    elif args.mode == "full":
        run_full(session)


if __name__ == "__main__":
    main()
