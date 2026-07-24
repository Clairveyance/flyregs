#!/usr/bin/env python3
"""
AIM PDF Page-Image Cache
=========================
Locates every "TBL X-X-X <title>" and "FIG X-X-X <title>" caption in the
official AIM PDF and records which PAGE it's on. aim_scraper.py (or a
follow-up backfill pass) uses this to render that whole page as a PNG and
cache it — same proven approach scripts/extract_figures.py already uses
for ACs: render the WHOLE page rather than try to crop to a precise
bounding box. Confirmed live why: bbox-based cropping depends on correctly
detecting a table/figure's exact shape, which is exactly what's been
unreliable (missing headers, misdetected structure); a whole-page render
is a guaranteed-accurate snapshot regardless of what's on it.

Matches by normalized TITLE text (not TBL/FIG number) because the PDF and
HTML editions of the AIM number the same content differently — confirmed
live and repeatedly (HTML's "TBL 2-1-8" is the PDF's "TBL 2-1-1"; HTML's
"FIG 6-2-6a"/b/c/... group is the PDF's individually-numbered FIG 6-2-7
through FIG 6-2-16).

Usage:
  python build_aim_pdf_pages.py <path-to-aim.pdf>
"""
import json
import re
import sys

import fitz  # PyMuPDF

CAPTION_RE = re.compile(r"^(TBL|FIG)\s+([\d\-−]+)\.?\s*(.*)$")


def normalize_title(title: str) -> str:
    # PDF text extraction uses a real minus sign (U+2212) and sometimes
    # en/em-dashes where the HTML source has a plain ASCII hyphen —
    # confirmed live: "FIS-B..." (HTML) vs "FIS−B..." (PDF) failed to
    # match on a silent character difference, dropping otherwise-perfect
    # title matches. Normalizing every dash-like character to a plain "-"
    # before comparing is what makes the match actually reliable.
    t = re.sub(r"[‐‑‒–—−]", "-", title)
    # Same silent-mismatch class as the dash fix above — PDF text uses a
    # curly right-single-quote (U+2019) for possessives ("Signalman's")
    # where the HTML source uses a plain ASCII apostrophe. Confirmed live:
    # "Signalman's Position" never matched despite identical content.
    t = re.sub(r"[‘’‛]", "'", t)
    return re.sub(r"\s+", " ", t.strip().lower())


def _adjacent_caption_candidates(blocks, start_idx, step, label_bbox):
    """Looks for a caption in a block adjacent to a label block that has no
    caption text of its own, skipping up to 3 blank/whitespace-only spacer
    blocks along the way. `step` is +1 to search forward, -1 to search
    backward. Returns cumulative-prefix candidates (see caller), or []."""
    j = start_idx
    skipped = 0
    while 0 <= j < len(blocks) and skipped < 3:
        cand = blocks[j]
        lines = [l.strip() for l in cand[4].split("\n") if l.strip()]
        if not lines:
            j += step
            skipped += 1
            continue
        if CAPTION_RE.match(lines[0]):
            return []
        # Block array order doesn't always track visual/vertical order for
        # diagram-embedded text (confirmed live: AIM FIG 1-1-6's caption
        # block sits spatially BELOW its label but appears BEFORE it in
        # block order) — so check proximity in either spatial direction
        # rather than assuming which side of the label this candidate is on.
        gap_below = cand[1] - label_bbox[3]
        gap_above = label_bbox[1] - cand[3]
        if not (0 <= gap_below <= 15 or 0 <= gap_above <= 15):
            return []
        joined = lines[0]
        out = [joined]
        for line in lines[1:3]:
            joined = f"{joined} {line}".strip()
            out.append(joined)
        return out
    return []


def main():
    if len(sys.argv) < 2:
        print("Usage: python build_aim_pdf_pages.py <path-to-aim.pdf>")
        sys.exit(1)

    doc = fitz.open(sys.argv[1])
    lookup: dict[str, dict] = {}

    for page_idx in range(doc.page_count):
        page = doc[page_idx]
        blocks = page.get_text("blocks")
        for i, b in enumerate(blocks):
            raw_lines = [l.strip() for l in b[4].split("\n") if l.strip()]
            if not raw_lines:
                continue
            m = CAPTION_RE.match(raw_lines[0])
            if not m:
                continue
            kind, number, first_line_rest = m.groups()
            continuation_lines = list(raw_lines[1:3])
            # A caption occasionally wraps onto 1-2 more lines within the
            # SAME block — confirmed live: AIM TBL 6-2-3's "Air Force
            # Rescue Coordination Center" / "48 Contiguous States" and
            # TBL 4-6-2's long "Contingency Actions: ... Occur After Entry
            # into RVSM" / "Airspace". But greedily assuming ALL of those
            # extra lines belong to the caption is wrong just as often —
            # confirmed live: TBL 1-1-4's block is "...for ILS" / "Localizer
            # MHz" / "Glide Slope", where line 2 is actually the table's own
            # column header, not caption continuation, and blindly
            # appending it corrupts an otherwise-exact match.
            #
            # Rather than guess which is right, register EVERY cumulative
            # prefix (line 1 alone, line 1+2, line 1+2+3) as its own lookup
            # key for this same page. Whichever length the HTML-sourced
            # caption actually turns out to be, normalize_title() will land
            # on one of these keys; the "too greedy" variants simply never
            # get looked up by anything, so carrying them costs nothing.
            candidates = []
            if first_line_rest:
                candidates.append(first_line_rest)
            joined = first_line_rest
            for line in continuation_lines:
                if CAPTION_RE.match(line):
                    break
                joined = f"{joined} {line}".strip()
                candidates.append(joined)
            if not candidates:
                # The label sometimes sits alone in its own block, with the
                # actual caption text in an ADJACENT block instead of on a
                # second line of the same block. Confirmed live in two
                # shapes: (a) AIM FIG 4-3-13's "All Clear (O.K.)" caption is
                # a separate block immediately below the "FIG 4-3-13" label
                # block, with a blank spacer block sometimes sitting between
                # them (FIG 6-2-17); (b) AIM FIG 1-1-6's caption "Limits of
                # Localizer Coverage" is a separate block ABOVE the label,
                # appearing BEFORE it in block reading order (a diagram
                # caption placed over its own label). Search forward, then
                # backward, skipping blank spacer blocks, for a plausible
                # adjacent caption block.
                candidates = _adjacent_caption_candidates(
                    blocks, i + 1, 1, b
                ) or _adjacent_caption_candidates(blocks, i - 1, -1, b)
            # A handful of appendix captions (the two flight-plan-form
            # figures) are unique in that their HTML-sourced caption text
            # redundantly repeats the label itself — e.g. DB caption "FIG
            # 4-1 FAA Form 7233-4, Pre-Flight Pilot Checklist and
            # International Flight Plan" starts with "FIG 4-1", confirmed
            # live by checking the PDF's own "FIG 4−1" label text. Register
            # a label-prefixed variant of every candidate too so that case
            # matches without needing to guess which captions do this.
            prefixed = [f"{kind} {number} {c}".strip() for c in candidates]
            # First occurrence wins — a title could theoretically be
            # mentioned again later (e.g. a "see also" back-reference),
            # but every real case checked so far is a genuine duplicate
            # definition only when the SAME content legitimately repeats
            # (rare) — keeping the first is the safer default.
            for cand in candidates + prefixed:
                title = normalize_title(cand)
                if title and title not in lookup:
                    lookup[title] = {"kind": kind, "page": page_idx}

        if page_idx % 150 == 0:
            print(f"  ...page {page_idx}/{doc.page_count}, {len(lookup)} captions found so far")

    print(f"Done. {len(lookup)} distinct TBL/FIG captions located.")
    with open("aim_pdf_pages.json", "w") as f:
        json.dump(lookup, f, indent=1)
    print("Wrote aim_pdf_pages.json")


if __name__ == "__main__":
    main()
