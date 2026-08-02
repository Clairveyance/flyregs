#!/usr/bin/env python3
"""
Backfills aim_figures with real, cached page-images from the official AIM
PDF — same proven whole-page-render approach as
ac-app/scripts/extract_figures.py uses for ACs (see that file's docstring
for the full reasoning: rendering the whole page is more reliable than
trying to crop to a detected bounding box).

Two things this fixes, both confirmed live and directly reported by the
user:
  1. FIG entries whose HTML-sourced image_url is wrong — the FAA's own
     HTML for AIM 6-2-6 literally repeats the same <img src> across 7
     different captions ("Short Delay", "Drop Message", "Do Not Land
     Here"... all pointing at the same file). Re-pointed to a real,
     individually-correct page render instead.
  2. TBL entries (bare HTML <table> tables, currently only ever rendered
     as flattened pipe-text inside body_text, with no aim_figures row of
     their own at all) now get one, so they're viewable as a real page
     image via the same tap-to-view flow figures already have.

Matches AIM's own figure/table CAPTION text (not the FAA HTML's often-
duplicated LABEL, e.g. all of "FIG 6-2-6a".."FIG 6-2-6q") against
aim_pdf_pages.json's title-keyed lookup (built by build_aim_pdf_pages.py)
to find the right PDF page, independent of the two editions' different
numbering.

Usage:
  python backfill_aim_pdf_images.py --dry-run     # report only, no writes
  python backfill_aim_pdf_images.py                # do it for real
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys

import fitz  # PyMuPDF
import requests

# Same convention as aim_scraper.py: read from the process environment
# rather than parsing .env.scraper directly, so this script works
# identically whether invoked locally (after `source .env.scraper`, same as
# sync_aim.sh does) or from GitHub Actions (where the workflow writes
# .env.scraper from repo secrets and sync_aim.sh sources it the same way).
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

BUCKET = "reg-tf-images"

# A handful of figures have NO usable caption text at all in the FAA's HTML
# source (confirmed live by checking the raw HTML: the <figcaption> is
# empty, or the "caption" is really just the image's own filename) — these
# can never be found via the normal title-lookup pass above, so they're
# hardcoded here instead. Every one was confirmed live against the PDF:
#   - FIG 5-4-9b/c/d: uncaptioned RNAV-approach diagram sub-panels sharing
#     the same PDF page as their captioned sibling FIG 5-4-9a (page 425).
#   - appendix_1 IMG 1-4: fragments of the single-page "Bird/Other Wildlife
#     Strike Report" scanned form (PDF page 720).
#   - appendix_4 IMG 2: the FAA Form 7233-4 continuation page (PDF page
#     750) — its own PDF caption text has no overlap with page 1's, so it
#     can't title-match either.
# Every scraper full-run resets these figures' image_url back to the raw
# (often duplicated/wrong) FAA HTML source, since the scraper has no way to
# know about the PDF page mapping — this pass re-applies the fix every time
# so it can't silently regress the way a one-off manual patch would.
KNOWN_UNCAPTIONED_FIGURES = {
    ("5-4-9", "FIG 5-4-9b"): 425,
    ("5-4-9", "FIG 5-4-9c"): 425,
    ("5-4-9", "FIG 5-4-9d"): 425,
    ("appendix_1", "IMG 1"): 720,
    ("appendix_1", "IMG 2"): 720,
    ("appendix_1", "IMG 3"): 720,
    ("appendix_1", "IMG 4"): 720,
    ("appendix_4", "IMG 2"): 750,
}


def normalize_title(title: str) -> str:
    # See build_aim_pdf_pages.py's identical helper for why — PDF text
    # extraction uses a real minus sign / en-dash where the HTML source
    # has a plain hyphen, and that silent difference broke otherwise
    # perfect title matches.
    t = re.sub(r"[‐‑‒–—−]", "-", title)
    t = re.sub(r"[‘’‛]", "'", t)
    t = re.sub(r"\s+", " ", t.strip().lower())
    # Trailing-period mismatch — see build_aim_pdf_pages.py's identical fix.
    return t.rstrip(".")


def render_page(doc: fitz.Document, page_idx: int) -> bytes:
    page = doc[page_idx]
    pix = page.get_pixmap(dpi=150)
    return pix.tobytes("png")


def upload_png(page_idx: int, png_bytes: bytes) -> str:
    fname = f"aim/page-{page_idx:04d}.png"
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{fname}"
    resp = requests.put(
        url,
        headers={**HEADERS, "Content-Type": "image/png", "x-upsert": "true"},
        data=png_bytes,
        timeout=60,
    )
    resp.raise_for_status()
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{fname}"


def fetch_existing_figures() -> list[dict]:
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/aim_figures?select=id,paragraph_number,label,caption,image_url,sort_order",
        headers=HEADERS,
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


# Group 2 (optional, single lowercase letter with NO space before it) eats
# an already-applied disambiguation suffix from a prior run's body_text
# patch (e.g. "TBL 6-2-6a Coast Guard..."), so re-parsing already-clean text
# doesn't fold that letter into the caption title. A genuinely bare label is
# always followed by a space before its title in real AIM captions, so this
# can't misfire on one.
TBL_RE = re.compile(r"^TBL\s+([\d\-]+)([a-z]?)\.?\s*(.*)$")
REAL_IMAGE_PREFIX = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/"


def rebuild_tbl_figures(existing_tbl_figures: list[dict], pdf_pages: dict) -> dict:
    """Rebuilds EVERY paragraph's TBL-labeled aim_figures rows from current
    aim_paragraphs.body_text truth, replacing the old "only insert what's
    missing, disambiguate the new batch in isolation" approach.

    That old approach had a real, serious bug -- confirmed live 2026-07-24:
    disambiguation (a/b/c... suffixing for tables sharing the same bare HTML
    label within a paragraph, same convention as
    _disambiguate_figure_labels() in aim_scraper.py) only ever considered
    the batch of NEWLY found tables in a given run, blind to whatever
    labels already existed in the DB from a PRIOR run. Every re-run that
    found "new" tables for a paragraph that already had some (e.g. because
    an earlier scraper bug -- since fixed -- caused a table to appear
    multiple times in one paragraph's body_text) appended a FRESH set of
    suffixes on top of the old ones instead of recognizing the paragraph's
    true current state. Paragraph 5-3-1's 23 real CPDLC message tables had
    accumulated 89 rows this way, with suffixes running straight past 'z'
    into unprintable extended-Latin control characters (chr(ord('a')+26)
    and beyond) -- a real, user-visible garbled label ("TBL 5-3-1\\x84").
    Separately, the caption text embedded in body_text (which is what the
    app actually renders as the table's visible header) was NEVER patched
    to match the disambiguated label at all, so even a correctly-labeled
    row still showed a bare, ambiguous "TBL 6-2-6" caption in the UI and
    couldn't be cross-reference-hyperlinked (self-reference resolution
    needs exactly one figure to match).

    This function is the fix: every run, derive the FULL correct set of
    (paragraph, label, caption) triples from body_text alone (the one
    source of truth), for every real table block (has piped data -- a
    block whose first line just MENTIONS a table inline, e.g. "TBL 7-1-10
    contains a comparison of...", is plain prose, not a caption, and must
    NOT become a fake figure row). Delete whatever TBL rows currently exist
    for a paragraph and re-insert the correct set, salvaging any
    already-real (reg-tf-images-hosted) image_url by matching on caption
    text first. Also returns the body_text patches needed so each table's
    embedded caption always matches its final label -- the caller applies
    those to aim_paragraphs directly. Idempotent: a paragraph with no real
    collisions computes the exact same bare labels every run, and a
    paragraph with a genuine content change simply gets a fresh, still-
    consistent set next run instead of layering on top of stale rows."""
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/aim_paragraphs?select=paragraph_number,body_text&body_text=not.is.null",
        headers=HEADERS,
        timeout=60,
    )
    resp.raise_for_status()
    paragraphs = resp.json()

    existing_by_para: dict[str, list[dict]] = {}
    for f in existing_tbl_figures:
        existing_by_para.setdefault(f["paragraph_number"], []).append(f)

    to_delete_ids: list[str] = []
    to_insert: list[dict] = []
    body_text_updates: dict[str, str] = {}  # paragraph_number -> new body_text

    for p in paragraphs:
        para = p["paragraph_number"]
        bt = p["body_text"] or ""
        if "TBL" not in bt:
            continue

        blocks = bt.split("\n\n")
        # All real TBL blocks in true document order (block_i order).
        all_blocks: list[tuple[int, str, str]] = []  # (block_i, bare_label, title)
        for i, block in enumerate(blocks):
            lines = block.split("\n")
            first = lines[0].strip() if lines else ""
            m = TBL_RE.match(first)
            if not m:
                continue
            title = m.group(3).strip()
            if not title:
                continue
            has_piped = any(" | " in l for l in lines)
            if not has_piped:
                continue
            bare_label = f"TBL {m.group(1)}"
            all_blocks.append((i, bare_label, title))

        if not all_blocks:
            continue

        existing = existing_by_para.get(para, [])
        existing_by_caption: dict[str, list[dict]] = {}
        for f in existing:
            existing_by_caption.setdefault(f["caption"], []).append(f)

        # The PDF's own number is the authoritative label whenever a title
        # match is found -- confirmed live as a real, user-caught accuracy
        # issue: the FAA's HTML edition mislabels multiple genuinely
        # distinct tables in one paragraph with the SAME bare label (four
        # different Rescue Coordination Center tables all "TBL 6-2-6" in
        # HTML, when the current AIM PDF itself numbers them 6-2-2 through
        # 6-2-5) -- corpus-wide, 312 of 346 figures/tables were showing a
        # synthetic a/b/c-suffixed label instead of the real, current
        # number. Only fall back to synthetic bare+suffix disambiguation
        # for the (much rarer) case where no PDF match exists at all.
        #
        # pdf_pages[title] is a LIST of every occurrence of that exact
        # caption in the PDF, in page order -- some captions genuinely
        # repeat for multiple distinct real tables/figures (three separate
        # NEXRAD radar diagrams are all captioned just "NEXRAD Coverage" in
        # the real AIM). Consumed positionally: the Nth block in THIS
        # paragraph sharing a given title gets the Nth still-unconsumed PDF
        # occurrence for that title, so distinct real entries don't
        # collapse onto the same page.
        bare_label_counts: dict[str, int] = {}
        for _, bare_label, _ in all_blocks:
            bare_label_counts[bare_label] = bare_label_counts.get(bare_label, 0) + 1
        bare_label_seen: dict[str, int] = {}
        pdf_cursor: dict[str, int] = {}

        tentative: list[tuple[int, str, str]] = []  # (block_i, title, label)
        for block_i, bare_label, title in all_blocks:
            norm = normalize_title(title)
            occurrences = pdf_pages.get(norm, [])
            idx = pdf_cursor.get(norm, 0)
            if idx < len(occurrences):
                label = f"TBL {occurrences[idx]['number']}"
                pdf_cursor[norm] = idx + 1
            else:
                n = bare_label_seen.get(bare_label, 0)
                bare_label_seen[bare_label] = n + 1
                suffixed = bare_label_counts[bare_label] > 1
                label = f"{bare_label}{chr(ord('a') + n)}" if suffixed else bare_label
            tentative.append((block_i, title, label))

        # Safety net for the near-impossible case where two DIFFERENT
        # tables in the same paragraph resolve to the same real PDF number
        # (or one falls back to a synthetic label that collides with
        # another's real one) -- suffix only the colliding subset, in
        # document order, rather than letting a silent duplicate through.
        label_counts: dict[str, int] = {}
        for _, _, label in tentative:
            label_counts[label] = label_counts.get(label, 0) + 1
        occurrence: dict[str, int] = {}
        final: list[tuple[int, str, str]] = []
        for block_i, title, base_label in tentative:
            if label_counts[base_label] > 1:
                n = occurrence.get(base_label, 0)
                occurrence[base_label] = n + 1
                label = f"{base_label}{chr(ord('a') + n)}"
            else:
                label = base_label
            final.append((block_i, title, label))

        new_rows = []
        changed = False
        for block_i, title, correct_label in final:
            candidates = existing_by_caption.get(title, [])
            image_url = None
            for c in candidates:
                if c["image_url"] and c["image_url"].startswith(REAL_IMAGE_PREFIX):
                    image_url = c["image_url"]
                    break
            if image_url is None and candidates:
                image_url = candidates[0]["image_url"]

            new_rows.append({
                "paragraph_number": para,
                "label": correct_label,
                "caption": title,
                "image_url": image_url,
                "sort_order": block_i,
            })

            old_first_line = blocks[block_i].split("\n")[0]
            new_first_line = f"{correct_label} {title}".rstrip()
            if old_first_line.strip() != new_first_line:
                lines = blocks[block_i].split("\n")
                lines[0] = new_first_line
                blocks[block_i] = "\n".join(lines)
                changed = True

        # A no-op rebuild (same labels/captions already present) shouldn't
        # touch the DB at all -- compare against what's already there.
        existing_triples = {(f["paragraph_number"], f["label"], f["caption"]) for f in existing}
        new_triples = {(r["paragraph_number"], r["label"], r["caption"]) for r in new_rows}
        if existing_triples == new_triples and not changed:
            continue

        to_delete_ids.extend(f["id"] for f in existing)
        to_insert.extend(new_rows)
        if changed:
            body_text_updates[para] = "\n\n".join(blocks)

    return {
        "delete_ids": to_delete_ids,
        "insert_rows": to_insert,
        "body_text_updates": body_text_updates,
    }


def apply_tbl_rebuild(plan: dict) -> None:
    if plan["delete_ids"]:
        ids = ",".join(f'"{i}"' for i in plan["delete_ids"])
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/aim_figures?id=in.({ids})",
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
    if plan["insert_rows"]:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/aim_figures",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json=plan["insert_rows"], timeout=30,
        )
        resp.raise_for_status()
    for para, new_bt in plan["body_text_updates"].items():
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/aim_paragraphs?paragraph_number=eq.{para}",
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"body_text": new_bt}, timeout=30,
        )
        resp.raise_for_status()


def update_figure(fig_id: str, **fields) -> None:
    resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/aim_figures?id=eq.{fig_id}",
        headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json=fields,
        timeout=30,
    )
    resp.raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--pdf", default="aim_full.pdf")
    args = ap.parse_args()

    # CWD-relative, not SCRIPT_DIR-relative — matches build_aim_pdf_pages.py,
    # which always writes aim_pdf_pages.json to CWD. sync_aim.sh runs both
    # scripts from the repo root, so this only works when invoked that way
    # (consistent with how sync.sh runs every AC step from the repo root).
    with open("aim_pdf_pages.json") as f:
        pdf_pages: dict = json.load(f)

    pdf_doc = fitz.open(args.pdf)
    page_png_cache: dict[int, bytes] = {}
    page_url_cache: dict[int, str] = {}

    def cached_image_for_page(page_idx: int) -> str:
        if page_idx not in page_url_cache:
            if page_idx not in page_png_cache:
                page_png_cache[page_idx] = render_page(pdf_doc, page_idx)
            page_url_cache[page_idx] = upload_png(page_idx, page_png_cache[page_idx])
        return page_url_cache[page_idx]

    existing = fetch_existing_figures()
    fig_only = [f for f in existing if not (f.get("label") or "").startswith("TBL")]
    tbl_only = [f for f in existing if (f.get("label") or "").startswith("TBL")]

    tbl_plan = rebuild_tbl_figures(tbl_only, pdf_pages)
    print(
        f"TBL rebuild-from-truth: delete={len(tbl_plan['delete_ids'])} "
        f"insert={len(tbl_plan['insert_rows'])} "
        f"body_text_patches={len(tbl_plan['body_text_updates'])} paragraphs"
    )
    if not args.dry_run:
        apply_tbl_rebuild(tbl_plan)
        # Re-fetch so ids/state are accurate for the title-matching pass
        # below — simpler and safer than reconciling in-memory state with
        # what was just deleted/inserted.
        existing = fetch_existing_figures()
    else:
        deleted_ids = set(tbl_plan["delete_ids"])
        existing = fig_only + [f for f in tbl_only if f["id"] not in deleted_ids] + tbl_plan["insert_rows"]

    # FIG labels are computed at scrape time by aim_scraper.py's own
    # _disambiguate_figure_labels(), which has no access to the PDF and so
    # can only produce a synthetic a/b/c-suffixed label when the FAA's HTML
    # mislabels multiple distinct figures with one bare label — confirmed
    # live corpus-wide, the same real-vs-synthetic mismatch TBL entries had
    # (see rebuild_tbl_figures's docstring). Once a real PDF page match
    # exists, its number is authoritative; correct the label here too, not
    # just the image. TBL labels are NOT touched here — rebuild_tbl_figures
    # already gave them their final, PDF-preferring label above.
    #
    # pdf_pages[title] is a list of every real occurrence of that caption —
    # some genuinely repeat for multiple distinct figures (three separate
    # NEXRAD radar diagrams all captioned just "NEXRAD Coverage"). Grouped
    # by (paragraph, caption) and consumed positionally in sort_order, same
    # convention as rebuild_tbl_figures, so each figure gets its own real
    # page instead of every same-captioned figure colliding on the first
    # match — confirmed live as a real crash (409 conflict) before this was
    # paragraph-scoped and collision-checked.
    fig_only_current = [f for f in existing if not (f.get("label") or "").startswith("TBL")]
    fig_by_para: dict[str, list[dict]] = {}
    for f in fig_only_current:
        fig_by_para.setdefault(f["paragraph_number"], []).append(f)

    updated = 0
    relabeled = 0
    unmatched_existing = []
    pending_updates: list[tuple[str, dict, str]] = []  # (fig_id, fields, original_label) — applied after every paragraph is planned
    for para, figs in fig_by_para.items():
        by_caption: dict[str, list[dict]] = {}
        for f in figs:
            by_caption.setdefault(normalize_title(f["caption"] or ""), []).append(f)

        tentative_final: dict[str, str] = {}  # fig id -> final label (changed or not)
        image_url_for: dict[str, str] = {}
        matched_ids: set[str] = set()
        for norm_title, group in by_caption.items():
            # Secondary sort key `f["id"]` -- confirmed live as a real crash
            # (409, 2026-07-27 AIM sync): with only `sort_order`, two rows
            # sharing the same sort_order (a genuine repeated-caption case,
            # e.g. 6 "NEXRAD Coverage" figures in one paragraph) have no
            # stable tiebreak, so which specific row lands at which index
            # can flip between runs depending on fetch_existing_figures()'s
            # row order -- and when it flips, a row that PREVIOUSLY lost the
            # tie (kept its old label) can suddenly win a NEW real-PDF match
            # that collides with the label the OTHER twin already committed
            # in a prior run. `id` never changes, so this makes the winner
            # of every tie permanent and reproducible across runs.
            group.sort(key=lambda f: (f.get("sort_order") or 0, f["id"]))
            occurrences = pdf_pages.get(norm_title, [])
            for idx, f in enumerate(group):
                if idx >= len(occurrences):
                    tentative_final[f["id"]] = f.get("label") or ""
                    continue
                match = occurrences[idx]
                image_url_for[f["id"]] = (
                    f"[dry-run page {match['page']}]" if args.dry_run else cached_image_for_page(match["page"])
                )
                tentative_final[f["id"]] = f"FIG {match['number']}"
                matched_ids.add(f["id"])

        # Collision guard: if two figures in this paragraph would end up
        # with the same final label (a real PDF number collides with
        # another figure's unchanged label, or — vanishingly unlikely — two
        # different captions' real numbers coincide), leave the offending
        # ones at their current label rather than let a DB unique-
        # constraint conflict crash the whole run.
        label_counts: dict[str, int] = {}
        for label in tentative_final.values():
            label_counts[label] = label_counts.get(label, 0) + 1

        for f in figs:
            final_label = tentative_final.get(f["id"], f.get("label") or "")
            is_collision = label_counts.get(final_label, 0) > 1
            if f["id"] not in matched_ids or is_collision:
                unmatched_existing.append(f)
                continue
            fields = {"image_url": image_url_for[f["id"]]}
            current_label = f.get("label") or ""
            if current_label != final_label:
                fields["label"] = final_label
                relabeled += 1
            pending_updates.append((f["id"], fields, current_label))
            updated += 1

    if not args.dry_run:
        # Two-phase apply: two figures in the same paragraph can effectively
        # SWAP labels (A's new label is B's old one, and vice versa) — the
        # final state has no duplicate, but applying PATCHes one row at a
        # time can hit a temporary unique-constraint conflict against the
        # other row's not-yet-updated old label. Move every label-changing
        # row to a guaranteed-unique placeholder first, then apply the real
        # final label — no ordering of the second pass can ever collide,
        # since no row still holds any of the target labels by then.
        #
        # Every update is now individually failable rather than crashing the
        # whole run -- confirmed live as a real incident (2026-07-27 AIM
        # sync): a single unexpected 409 on one row killed the entire job
        # AND left that row stranded on its internal "__tmp_relabel_<id>"
        # placeholder (a broken-looking label, silently user-visible) for a
        # full day until manually fixed, since the crash meant the fallback
        # below never got a chance to run. A row that fails now gets
        # reverted to its pre-run label instead — same net effect as if this
        # row had never been touched this run, and the run itself continues
        # rather than leaving every OTHER already-planned row unapplied too.
        label_changes = [(fid, fields["label"]) for fid, fields, _ in pending_updates if "label" in fields]
        temp_relabeled: set[str] = set()
        for fid, _ in label_changes:
            try:
                update_figure(fid, label=f"__tmp_relabel_{fid}")
                temp_relabeled.add(fid)
            except requests.exceptions.HTTPError as e:
                print(f"  WARNING: temp-relabel failed for {fid}, leaving untouched this run: {e}")

        failures: list[tuple[str, str]] = []  # (fid, original_label)
        for fid, fields, original_label in pending_updates:
            try:
                update_figure(fid, **fields)
            except requests.exceptions.HTTPError as e:
                print(f"  WARNING: final relabel failed for {fid} ({fields}): {e}")
                failures.append((fid, original_label))

        unrecoverable = 0
        for fid, original_label in failures:
            if fid in temp_relabeled:
                # Revert to the label this row had before this run touched
                # it, rather than leaving the internal placeholder string
                # live in the app. Whatever caused the 409 (a genuine data
                # collision the collision guard above didn't catch) gets a
                # clean, visible warning in this run's log instead of a
                # silently broken row — worth investigating if it recurs.
                try:
                    update_figure(fid, label=original_label)
                except requests.exceptions.HTTPError as e:
                    print(f"  ERROR: could not even revert {fid} to '{original_label}' — needs manual fix: {e}")
                    unrecoverable += 1
        if failures:
            print(f"  {len(failures)} figure(s) could not be relabeled this run (see warnings above) — reverted, not left broken.")
        if unrecoverable:
            # A row stuck on its internal placeholder is user-visible and
            # broken-looking -- this must surface as a failed GitHub Actions
            # run (per sync.sh's own alerting convention), not a quiet log
            # line nobody reads.
            print(f"  {unrecoverable} figure(s) could not even be reverted — failing this run so it's visible.")
            sys.exit(1)

    known_fixed = 0
    known_fix_skipped = 0
    for fig in existing:
        page_idx = KNOWN_UNCAPTIONED_FIGURES.get((fig["paragraph_number"], fig["label"]))
        if page_idx is None:
            continue
        # KNOWN_UNCAPTIONED_FIGURES' page numbers were recorded against
        # whichever PDF edition was on hand at the time -- a later run
        # against a different/shorter edition (e.g. "Basic" vs a fully
        # change-integrated PDF) can reference a page past this doc's own
        # length. Confirmed live: page 750 doesn't exist in an otherwise
        # verified-correct 732-page current edition. Skip rather than crash
        # the whole run over 1 of 8 hardcoded entries -- these are a
        # narrow, separately-tracked fixup, not core to the relabel pass
        # that already completed above.
        if page_idx >= pdf_doc.page_count:
            print(f"  SKIPPED hardcoded-fix for {fig['paragraph_number']}/{fig['label']}: "
                  f"page {page_idx} doesn't exist in this {pdf_doc.page_count}-page PDF.")
            known_fix_skipped += 1
            continue
        new_url = f"[dry-run page {page_idx}]" if args.dry_run else cached_image_for_page(page_idx)
        if not args.dry_run:
            update_figure(fig["id"], image_url=new_url)
        known_fixed += 1

    still_unmatched = [
        f for f in unmatched_existing
        if (f["paragraph_number"], f["label"]) not in KNOWN_UNCAPTIONED_FIGURES
    ]
    print(f"Total figures (FIG+TBL): {len(existing)}, matched+re-pointed: {updated}, relabeled: {relabeled}, hardcoded-fix: {known_fixed} (skipped {known_fix_skipped}), unmatched: {len(still_unmatched)}")
    print(f"Distinct PDF pages rendered: {len(page_png_cache)}")
    if still_unmatched:
        print("\nSample unmatched captions:")
        for f in still_unmatched[:10]:
            print(" -", repr(f["caption"]), "|", f["paragraph_number"], "|", f["label"])


if __name__ == "__main__":
    main()
