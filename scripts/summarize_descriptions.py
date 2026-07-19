#!/usr/bin/env python3
"""
Shortens an AC's `description` field down to a genuine 1-2 sentence summary,
for ACs where it's currently just a long copy of (or overlaps heavily with)
Section 1's own Purpose text -- confirmed on 2026-07-18: `description` is
scraped verbatim from FAA.gov's own detail page with no summarization at all
(faa_scraper.py's _extract_description, capped at 3000 chars), and 41.4% of
ACs (314/758) have one over 500 characters.

Source text: the AC's own "Purpose" section from pdf_blocks. If that section
is bare (its own body empty, e.g. AC 20-166A's "1. Purpose." heading with the
real content living in the item children below it), gathers those items'
text instead.

Deliberately a plain truncation, not an LLM summary -- explicit user
decision (2026-07-18) after a live pilot on 2 ACs (20-166A, 120-68J) came
back clean without needing anything fancier. Never cuts mid-sentence: an
early version did a hard character cutoff mid-list and it read as broken
("...approval of articles (14 CFR..."), so the first sentence is always kept
whole even if that means slightly exceeding the target length -- multiple
short sentences are what actually gets capped.

Only touches ACs whose CURRENT description exceeds --min-chars (default
400) -- already-short descriptions are left alone rather than being
regenerated for consistency's sake, since the actual complaint was
specifically about the long ones.

Usage:
    python3 scripts/summarize_descriptions.py --dry-run          # report only, no writes
    python3 scripts/summarize_descriptions.py                    # apply corpus-wide
    python3 scripts/summarize_descriptions.py --doc=120-68J       # single AC, applies
    python3 scripts/summarize_descriptions.py --min-chars=300     # change the threshold
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent


def load_env_file(path: Path) -> dict:
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = line.removeprefix("export ")
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env_file(AC_APP_DIR / ".env.scraper")
SUPABASE_URL = ENV["SUPABASE_URL"]
SERVICE_KEY = ENV["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

ABBREV_RE = re.compile(r"\b([A-Z]\.|[Ee]\.[Gg]\.|[Ii]\.[Ee]\.|[Nn]o\.|[Vv]ol\.|[Mm]r\.|[Mm]rs\.|[Dd]r\.)\s")
ITEM_MARKER_RE = re.compile(r"^\(?[a-z0-9]{1,3}[\.\)]\s+")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.?!])\s+(?=[A-Z])")


def block_text(b: dict) -> str:
    if b.get("kind") in ("section", "item"):
        return ((b.get("title") or "") + " " + (b.get("body") or "")).strip()
    return b.get("text", "")


def get_purpose_source(blocks: list) -> str | None:
    idx = next(
        (i for i, b in enumerate(blocks) if b.get("kind") == "section" and re.search(r"purpose", b.get("title", ""), re.I)),
        None,
    )
    if idx is None:
        return None
    purpose = blocks[idx]
    body = (purpose.get("body") or "").strip()
    if body and not body.endswith(":"):
        return body
    # Bare heading, OR a body that's only an incomplete list intro ending in
    # a bare colon with nothing after it ("This AC:", "...following
    # purposes:" -- confirmed on ACs 21-50/90-108/135-16/150/5370-17). Either
    # way, real content follows as item blocks -- but an item's own "a."/"b."
    # label lives in a separate structured field, invisible to block_text(),
    # so a colon-list's first item has no in-text marker to detect and its
    # BODY can run long and even contain mis-parsed fragments of sibling
    # items (confirmed on AC 135-16). For a colon-terminated intro
    # specifically, use just the first following item's TITLE (a short,
    # clean phrase) as the natural completion, not its full body.
    if body:
        first_item = next((b for b in blocks[idx + 1:] if b.get("kind") not in ("section", "chapter")), None)
        if first_item and first_item.get("kind") == "item" and (first_item.get("title") or "").strip():
            return f"{body} {first_item['title'].strip()}"
    collected = [body] if body else []
    for b in blocks[idx + 1:]:
        if b.get("kind") in ("section", "chapter"):
            break
        collected.append(block_text(b))
        if len(" ".join(collected)) > 500:
            break
    return " ".join(collected)


def summarize(source_text: str, target_chars: int = 320, max_sentences: int = 2) -> str | None:
    text = ITEM_MARKER_RE.sub("", source_text.strip())
    if not text:
        return None
    # A colon introducing an enumerated, semicolon-separated list ("This AC
    # also provides: 1. Information...; 2. Guidance...; and 3.
    # Instructions...", or "(1) explains...; (2) describes...", or "•
    # Summarizes...; • Describes...") can't be cleanly reduced by sentence-
    # splitting at all -- semicolons and bullets aren't ".?!", so the whole
    # list is ONE giant "sentence" as far as that split is concerned; capping
    # max_sentences doesn't help (confirmed on ACs 120-100, 91-63D, both
    # still ran away at first). Handle this shape specially: keep the intro
    # up to the colon, then just the FIRST item's own content up to the next
    # ";"/bullet/paren-marker, dropping the rest of the list outright (a
    # single bulleted list is very difficult to compress into 1-2 sentences,
    # so as elsewhere in this script -- 43-210A's colon-list case -- the
    # first fragment stands in for the whole list rather than trying to
    # summarize all of it).
    # Only within the first ~250 chars -- a list buried deep in a long
    # Purpose section (confirmed on AC 120-121: a "categories:" bullet list
    # appears 1000+ chars in, well past several genuinely fine, unrelated
    # sentences at the front) must NOT hijack the whole intro; ordinary
    # sentence-based extraction below already stops after 1-2 sentences long
    # before reaching a list that far in, so this only needs to catch a list
    # that starts at or very near the beginning of the source.
    list_m = re.search(r":\s*(?:\(?(?:1|a)\)?\.?|[••])\s+", text[:250], re.IGNORECASE)
    if list_m:
        intro = text[: list_m.start() + 1].strip()  # up to and including the colon
        rest = text[list_m.end():]
        first_item = re.split(r"[;•]|\(\s*(?:2|b)\s*\)|\b(?:2|b)\.\s", rest, maxsplit=1)[0].strip().rstrip(".,;")
        if first_item:
            return f"{intro} {first_item}."
        return intro or None
    protected = ABBREV_RE.sub(lambda m: m.group(0).replace(" ", "\x00"), text)
    sentences = [s.replace("\x00", " ") for s in SENTENCE_SPLIT_RE.split(protected)]
    if not sentences:
        return None
    # A handful of ACs write their Purpose section in FAQ format ("1. What is
    # the Purpose of this AC? [answer] 2. What regulations does this AC
    # cover? [answer]...") -- confirmed on AC 91-89 and 121-35. A question is
    # never useful summary content on its own (it's the FAQ's rhetorical
    # header, not the actual answer), so skip any sentence ending in "?" when
    # choosing what to keep, on both the first pick and the additional-
    # sentence loop below.
    # Trailing "N." numbering artifact from the same FAQ format -- the
    # sentence-splitter breaks before the capitalized question word ("2.
    # What"), not before the digit, so the real sentence ends up with a
    # dangling "... ventilation. 2." instead of a clean period (confirmed on
    # AC 121-35). Strip it back to the real terminal period.
    sentences = [re.sub(r"(?<=[.?!])\s\d{1,2}\.$", "", s) for s in sentences]
    declarative = [s for s in sentences if not s.rstrip().endswith("?")]
    if not declarative:
        return None
    # Same splitter quirk, different shape: "This AC also provides: 1.
    # Information that can help..." splits before the capitalized list item,
    # leaving "...provides: 1." as its own dangling sentence (confirmed on AC
    # 43-210A) -- a colon introducing a list, cut off right after the first
    # marker with no real content. Drop it entirely rather than keep a
    # sentence that ends mid-list-intro; the sentence(s) already kept still
    # stand on their own.
    declarative = [s for s in declarative if not re.search(r":\s*\d{1,2}\.$", s)]
    if not declarative:
        return None
    out = [declarative[0]]
    total = len(declarative[0])
    # The list ITEMS themselves (not just the colon intro) are also unusable
    # in isolation -- "Information that can help...data; 2." is the first
    # item of that same list, missing its own "1." marker (already stripped)
    # and trailing off mid-list with a dangling "; N." (still AC 43-210A).
    # Never add one of these as the second sentence; the first sentence
    # already stands alone as a complete description on its own.
    declarative = [declarative[0]] + [s for s in declarative[1:] if not re.search(r"[;:]\s*(?:and\s+)?\d{1,2}\.$", s)]
    for s in declarative[1:max_sentences]:
        if total + 1 + len(s) > target_chars:
            break
        out.append(s)
        total += 1 + len(s)
    return " ".join(out).strip()


def fetch_page(offset: int, limit: int) -> list:
    url = (
        f"{SUPABASE_URL}/rest/v1/advisory_circulars"
        f"?select=id,document_number,description,pdf_blocks&order=document_number.asc"
        f"&limit={limit}&offset={offset}"
    )
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def fetch_one(doc_number: str) -> dict | None:
    url = f"{SUPABASE_URL}/rest/v1/advisory_circulars?document_number=eq.{urllib.parse.quote(doc_number)}&select=id,document_number,description,pdf_blocks"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        rows = json.load(resp)
    return rows[0] if rows else None


def update_description(ac_id: str, new_description: str):
    url = f"{SUPABASE_URL}/rest/v1/advisory_circulars?id=eq.{ac_id}"
    body = json.dumps({"description": new_description}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        **HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def process(ac: dict, min_chars: int, dry_run: bool) -> str:
    doc = ac["document_number"]
    desc = ac.get("description") or ""
    if len(desc) < min_chars:
        return "skip (already short)"
    blocks = ac.get("pdf_blocks") or []
    src = get_purpose_source(blocks)
    if not src:
        return "skip (no Purpose section found)"
    new_desc = summarize(src)
    if not new_desc:
        return "skip (summarize produced nothing)"
    if new_desc == desc:
        return "skip (unchanged)"
    if dry_run:
        print(f"{doc}: {len(desc)} -> {len(new_desc)} chars (dry-run, not written)")
        return "would-update"
    update_description(ac["id"], new_desc)
    print(f"{doc}: {len(desc)} -> {len(new_desc)} chars")
    return "updated"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", help="Process a single AC by document_number")
    ap.add_argument("--dry-run", action="store_true", help="Report what would change, write nothing")
    ap.add_argument("--min-chars", type=int, default=400, help="Only touch descriptions at least this long (default 400)")
    args = ap.parse_args()

    if args.doc:
        ac = fetch_one(args.doc)
        if not ac:
            print(f"No AC found for {args.doc}")
            sys.exit(1)
        status = process(ac, args.min_chars, args.dry_run)
        print(f"{args.doc}: {status}")
        return

    counts = {}
    offset = 0
    page_size = 50
    n = 0
    while True:
        rows = fetch_page(offset, page_size)
        if not rows:
            break
        for ac in rows:
            n += 1
            status = process(ac, args.min_chars, args.dry_run)
            counts[status] = counts.get(status, 0) + 1
        offset += page_size
        if len(rows) < page_size:
            break

    print(f"\nChecked {n} ACs.")
    for status, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {status}: {count}")


if __name__ == "__main__":
    main()
