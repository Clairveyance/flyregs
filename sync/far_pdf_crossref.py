"""Cross-references every far_sections row (scraped from eCFR, which
updates daily) against the real, official Title 14 CFR PDF (govinfo.gov's
annual edition, which lags by months and has no 2026 edition published
yet). Not a "PDF wins" check -- eCFR is routinely MORE current. This
reports the shape of every difference so a human can tell "genuine
regulatory update since the PDF's Jan 1 2025 baseline" (expected, common,
not an error) apart from "something's actually wrong" (rare, worth a
closer look).

Classification:
  - MISSING_FROM_PDF: section in DB, no matching number in the PDF at all
    within Chapter I's own Part range -- either a section added since the
    PDF's baseline, or a scraper artifact. Sample a few by hand to tell
    which.
  - MISSING_FROM_DB: opposite direction -- the PDF has this section (within
    Chapter I's Part range) but the scraper never captured it. This one IS
    worth treating as a real gap to investigate, not just "eCFR is ahead."
  - LOW_SIMILARITY: section exists in both, but word-overlap similarity is
    low -- could be a genuine amendment, could be an extraction/parsing
    issue on either side. Needs eyeballing, not auto-trusted either way.
  - OK: high similarity, nothing to look at.

Usage: python3 far_pdf_crossref.py
"""
import json
import os
import re

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

WORD_RE = re.compile(r"[a-z0-9]+")


def normalize_words(text: str) -> set:
    return set(WORD_RE.findall(text.lower()))


def similarity(a: str, b: str) -> float:
    wa, wb = normalize_words(a), normalize_words(b)
    if not wa or not wb:
        return 0.0
    return len(wa & wb) / len(wa | wb)


def fetch_all_far_sections() -> list[dict]:
    out = []
    offset = 0
    while True:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/far_sections?select=section_number,part,title,body_text&limit=1000&offset={offset}",
            headers=HEADERS, timeout=60,
        )
        r.raise_for_status()
        batch = r.json()
        out.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return out


def main():
    with open("far_pdf_sections.json") as f:
        pdf_sections: dict = json.load(f)

    db_sections = fetch_all_far_sections()
    db_parts = {row["part"] for row in db_sections}
    print(f"DB: {len(db_sections)} sections across {len(db_parts)} Chapter I parts")

    # Only compare against PDF sections whose Part is actually in Chapter I's
    # scope -- the PDF volumes cover ALL of Title 14 (other agencies too),
    # comparing against those would just be noise.
    pdf_in_scope = {num: text for num, text in pdf_sections.items() if num.split(".")[0] in db_parts}
    print(f"PDF: {len(pdf_in_scope)} sections in Chapter I's Part range (of {len(pdf_sections)} total in Title 14)")

    db_by_number = {row["section_number"]: row for row in db_sections}

    missing_from_pdf = []
    missing_from_db = []
    low_similarity = []
    ok_count = 0

    # [Reserved] sections are structural placeholders (a number range with
    # no substantive content, or content removed/renumbered) -- confirmed
    # live as the overwhelming majority of every category below (104 of 106
    # null-body_text rows, most of the low-similarity set) and NOT a real
    # accuracy concern. The PDF often prints a whole reserved RANGE as one
    # block ("§§ 121.1200-121.1399 [Reserved]") that doesn't line up 1:1
    # with individual section numbers either, which is exactly why they'd
    # otherwise dominate MISSING_FROM_PDF too. Filtered out of the "real"
    # counts so the signal isn't buried in structural noise; still counted
    # separately for completeness.
    reserved_skipped_missing = 0
    reserved_skipped_low_sim = 0

    for num, row in db_by_number.items():
        is_reserved = "Reserved" in (row["title"] or "")
        pdf_entry = pdf_in_scope.get(num)
        if not pdf_entry:
            if is_reserved:
                reserved_skipped_missing += 1
            else:
                missing_from_pdf.append(num)
            continue
        sim = similarity(row["body_text"] or "", pdf_entry["text"])
        if sim < 0.5:
            if is_reserved:
                reserved_skipped_low_sim += 1
            else:
                low_similarity.append((num, sim, row["title"]))
        else:
            ok_count += 1

    for num in pdf_in_scope:
        if num not in db_by_number:
            missing_from_db.append(num)

    print(f"\nOK (similarity >= 0.5): {ok_count}")
    print(f"MISSING_FROM_PDF, real content (in DB, not in PDF's Chapter I range): {len(missing_from_pdf)}"
          f"  [+{reserved_skipped_missing} [Reserved], not shown]")
    print(f"MISSING_FROM_DB (in PDF's Chapter I range, not scraped): {len(missing_from_db)}")
    print(f"LOW_SIMILARITY, real content (in both, <0.5 word overlap): {len(low_similarity)}"
          f"  [+{reserved_skipped_low_sim} [Reserved], not shown]")
    print(
        "\nRemember: eCFR updates daily, the PDF is an annual snapshot published ~6 months "
        "after its own \"as of\" date (no 2026 edition exists yet as of this writing) -- most "
        "real findings below are expected \"eCFR is ahead of the PDF\" cases, not errors. A "
        "genuinely NEW section number in eCFR with no PDF counterpart at all is the clearest "
        "signal of a real regulatory update since the PDF's baseline; spot-check a few against "
        "https://www.ecfr.gov/api/versioner/v1/full/<today>/title-14.xml?part=<N> directly."
    )

    print("\n--- MISSING_FROM_PDF, real content (up to 30) ---")
    for num in sorted(missing_from_pdf)[:30]:
        print(" ", num, "|", db_by_number[num]["title"])

    print("\n--- MISSING_FROM_DB (up to 20) ---")
    for num in sorted(missing_from_db)[:20]:
        print(" ", num)

    print("\n--- LOW_SIMILARITY, real content (up to 30, sorted lowest first) ---")
    for num, sim, title in sorted(low_similarity, key=lambda x: x[1])[:30]:
        print(f"  {num} (sim={sim:.2f}) | {title}")

    with open("far_pdf_crossref_report.json", "w") as f:
        json.dump({
            "missing_from_pdf": sorted(missing_from_pdf),
            "missing_from_db": sorted(missing_from_db),
            "low_similarity": sorted(low_similarity, key=lambda x: x[1]),
            "reserved_skipped_missing": reserved_skipped_missing,
            "reserved_skipped_low_sim": reserved_skipped_low_sim,
        }, f, indent=1)
    print("\nWrote far_pdf_crossref_report.json")


if __name__ == "__main__":
    main()
