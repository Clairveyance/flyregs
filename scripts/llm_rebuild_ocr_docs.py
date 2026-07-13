#!/usr/bin/env python3
"""
Re-transcribes the OCR_SCANNED_ACS corpus (69 docs whose source PDF is an old
scan or a zero-text flattened PDF) using Claude vision instead of the
existing OCR text, and writes the result back to `advisory_circulars.pdf_text`.
Nulls `pdf_blocks_version` so the next `backfill-blocks.mjs` run re-parses
these through the normal parser pipeline exactly like any other content
change.

Does NOT touch ac_figures / ac_formula_refs -- those remain the real
page-image viewers for figures/tables/complex formulas; this script only
replaces body text.

Validated against 3 pilot ACs first (20-30B, 170-6C, 38-1) via
llm_transcribe_pilot.py before this was run against the full 69 -- see
scratch/llm_transcripts/ for that comparison.

SAFETY: current pdf_text/pdf_blocks for all 69 rows must already be backed
up (scratch/ocr69_backup.json) before running this -- it overwrites
production rows with no built-in undo beyond that backup.

Usage:
    python3 scripts/llm_rebuild_ocr_docs.py [doc_number ...]

With no arguments, runs against the full OCR_SCANNED_ACS list (parsed
directly out of src/lib/ocrScannedACs.ts, so this script and the app can
never drift out of sync on which docs are in scope).
"""
import base64
import json
import re
import sys
import urllib.request
from pathlib import Path

import fitz  # PyMuPDF
import anthropic

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
SCRATCH_DIR = AC_APP_DIR / "scratch" / "ocr_rebuild"

MODEL = "claude-sonnet-5"
RENDER_DPI = 150

TRANSCRIBE_PROMPT = """You are transcribing one page of a scanned FAA Advisory Circular -- a regulatory document where exact wording, numbering, and punctuation matter.

Rules:
1. Transcribe the text EXACTLY as it appears. Do not modernize spelling, do not "fix" grammar, do not paraphrase.
2. Preserve the document's own structure markers exactly as printed: section numbers ("1.", "2."), letter items ("a.", "b."), numbered sub-items ("(1)", "(2)"), headings.
3. If the page is (or contains) a figure, chart, diagram, or table: do NOT write a narrative description of the image. Transcribe ONLY the literal printed text that appears on it -- the caption/title, axis labels, column/row headers, and any callout or legend text -- in a natural reading order. Do not describe layout, shapes, lines, or spatial relationships, and do not guess which callout maps to which label if it isn't unambiguous from the text alone.
4. For an equation or formula, transcribe it as accurately as you can, preserving the actual mathematical structure (fractions, roots, exponents, subscripts, Greek letters) using plain-text or LaTeX-like notation as appropriate. Do not simplify or "clean up" the math beyond what's needed to represent it in text.
5. If part of the page is genuinely illegible even to you, write [illegible] at that exact spot rather than guessing at plausible-sounding text. Never silently substitute a guess for text you are not confident about.
6. Output ONLY the transcription itself -- no preamble, no "Here is the transcription", no commentary.
"""


def load_env_file(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
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


def get_supabase_creds():
    env = load_env_file(AC_APP_DIR / ".env.scraper")
    return env["SUPABASE_URL"], env["SUPABASE_SERVICE_KEY"]


def get_anthropic_key():
    return load_env_file(AC_APP_DIR / ".env.anthropic")["ANTHROPIC_API_KEY"]


def get_ocr_scanned_docs() -> list[str]:
    src = (AC_APP_DIR / "src" / "lib" / "ocrScannedACs.ts").read_text()
    # Pull every quoted string inside the OCR_SCANNED_ACS array literal --
    # parses the real source of truth instead of hand-copying the list, so
    # this script can never drift out of sync with the app.
    start = src.index("OCR_SCANNED_ACS")
    array_start = src.index("[", start)
    array_end = src.index("]", array_start)
    array_body = src[array_start:array_end]
    # Strip `//` line comments first -- the array has explanatory comments
    # between entries (e.g. the 38-1 note) that contain real apostrophes
    # ("AC's text)"), which would otherwise pair up with adjacent quotes and
    # corrupt the extraction.
    array_body = re.sub(r"//[^\n]*", "", array_body)
    return re.findall(r"'([^']+)'", array_body)


def fetch_ac_row(supabase_url: str, service_key: str, doc_number: str) -> dict:
    from urllib.parse import quote
    url = f"{supabase_url}/rest/v1/advisory_circulars?document_number=eq.{quote(doc_number)}&select=id,document_number,pdf_url_cached,pdf_url_faa"
    req = urllib.request.Request(url, headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    })
    with urllib.request.urlopen(req) as resp:
        rows = json.load(resp)
    if not rows:
        raise RuntimeError(f"No AC found for document_number={doc_number}")
    return rows[0]


def update_pdf_text(supabase_url: str, service_key: str, ac_id: str, new_text: str):
    # Deliberately does NOT touch pdf_blocks_version or changed_block_indices.
    # backfill-blocks.mjs treats pdf_blocks_version === null as "the FAA
    # published a real revision" and computes a content diff to drive the
    # NEW/UPD badge, the in-doc "this AC was updated" banner, and push
    # notifications. This rebuild is an internal transcription-quality fix,
    # not a real FAA revision -- setting pdf_blocks_version to null here
    # would falsely flag every rebuilt AC as recently revised (confirmed:
    # this exact mistake happened for 20-30B before this fix landed, and had
    # to be manually corrected). pdf_blocks itself is regenerated separately,
    # after the full batch, via the same silent-reparse approach already
    # proven in scripts/reparse_blocks_silent.mjs.
    url = f"{supabase_url}/rest/v1/advisory_circulars?id=eq.{ac_id}"
    body = json.dumps({"pdf_text": new_text}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()


def render_pages(pdf_path: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    paths = []
    for i in range(doc.page_count):
        page = doc[i]
        pix = page.get_pixmap(dpi=RENDER_DPI)
        p = out_dir / f"page_{i + 1:03d}.png"
        pix.save(p)
        paths.append(p)
    return paths


def transcribe_page(client: anthropic.Anthropic, image_path: Path, page_num: int, total_pages: int) -> str:
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    message = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": f"{TRANSCRIBE_PROMPT}\n\n(This is page {page_num} of {total_pages}.)"},
                ],
            }
        ],
    )
    return "".join(block.text for block in message.content if block.type == "text")


def process_doc(doc_number: str, supabase_url: str, service_key: str, client: anthropic.Anthropic) -> bool:
    print(f"\n=== {doc_number} ===")
    row = fetch_ac_row(supabase_url, service_key, doc_number)
    pdf_url = row.get("pdf_url_cached") or row["pdf_url_faa"]
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", doc_number)
    work_dir = SCRATCH_DIR / safe_name
    work_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = work_dir / f"{safe_name}.pdf"

    try:
        urllib.request.urlretrieve(pdf_url, pdf_path)
    except Exception as e:
        print(f"  SKIP -- could not download PDF: {e}")
        return False

    page_images = render_pages(pdf_path, work_dir / "pages")
    print(f"  {len(page_images)} pages")

    page_texts = []
    for i, img_path in enumerate(page_images, start=1):
        try:
            text = transcribe_page(client, img_path, i, len(page_images))
        except Exception as e:
            print(f"  page {i}: ERROR ({e}) -- inserting placeholder, will need manual re-run")
            text = "[transcription failed for this page]"
        page_texts.append(text)
        print(f"  page {i}/{len(page_images)} done ({len(text)} chars)")

    new_pdf_text = "\n\n".join(page_texts)
    (work_dir / "final_pdf_text.txt").write_text(new_pdf_text)

    update_pdf_text(supabase_url, service_key, row["id"], new_pdf_text)
    print(f"  Wrote {len(new_pdf_text)} chars to DB, pdf_blocks_version reset to null")
    return True


def main():
    docs = sys.argv[1:] or get_ocr_scanned_docs()
    print(f"Processing {len(docs)} documents")

    supabase_url, service_key = get_supabase_creds()
    anthropic_key = get_anthropic_key()
    client = anthropic.Anthropic(api_key=anthropic_key)

    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)

    succeeded, failed = [], []
    for doc_number in docs:
        try:
            ok = process_doc(doc_number, supabase_url, service_key, client)
            (succeeded if ok else failed).append(doc_number)
        except Exception as e:
            print(f"  FAILED entirely: {e}")
            failed.append(doc_number)

    print(f"\n{'='*60}")
    print(f"Succeeded: {len(succeeded)}")
    print(f"Failed: {len(failed)}")
    if failed:
        print("Failed docs:", failed)


if __name__ == "__main__":
    main()
