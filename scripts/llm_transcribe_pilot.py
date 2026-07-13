#!/usr/bin/env python3
"""
Pilot: re-transcribe a handful of ACs with Claude vision instead of the
current OCR pipeline, to validate quality before committing to the full
69-doc OCR-scanned rebuild (and, if that goes well, the full 780-AC
corpus QC pass). Does NOT write anything back to the database -- output
goes to local files for side-by-side review against the currently stored
pdf_text.

Usage:
    source .env.scraper .env.anthropic  # or just let the script source them
    python3 scripts/llm_transcribe_pilot.py [doc_number ...]

With no arguments, runs the default pilot set (one typical OCR-scanned doc,
one known-worst-case garbled scan, one zero-text doc previously recovered
via EasyOCR -- see ocrScannedACs.ts for why each was picked).
"""
import os
import re
import sys
import subprocess
import urllib.request
from pathlib import Path

import fitz  # PyMuPDF
import anthropic

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
OUT_DIR = AC_APP_DIR / "scratch" / "llm_transcripts"

DEFAULT_PILOT_DOCS = ["20-30B", "170-6C", "38-1"]

MODEL = "claude-sonnet-5"
RENDER_DPI = 150  # matches the resolution already validated by hand for 20-30B

TRANSCRIBE_PROMPT = """You are transcribing one page of a scanned FAA Advisory Circular -- a regulatory document where exact wording, numbering, and punctuation matter.

Rules:
1. Transcribe the text EXACTLY as it appears. Do not modernize spelling, do not "fix" grammar, do not paraphrase.
2. Preserve the document's own structure markers exactly as printed: section numbers ("1.", "2."), letter items ("a.", "b."), numbered sub-items ("(1)", "(2)"), headings, and any underlining/emphasis (note it as [underlined] if it matters).
3. For a page that is a figure, chart, or diagram: describe the layout briefly, then transcribe every visible label, callout, number, and axis value exactly as shown. Do not invent data points, curves, or values you cannot actually see.
4. If part of the page is genuinely illegible even to you, write [illegible] at that exact spot rather than guessing at plausible-sounding text. Never silently substitute a guess for text you are not confident about.
5. Preserve special characters, symbols, and any Greek letters or mathematical notation exactly as printed.
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
    env = load_env_file(AC_APP_DIR / ".env.anthropic")
    return env["ANTHROPIC_API_KEY"]


def fetch_ac_row(supabase_url: str, service_key: str, doc_number: str) -> dict:
    import json
    url = f"{supabase_url}/rest/v1/advisory_circulars?document_number=eq.{doc_number}&select=id,document_number,pdf_url_cached,pdf_url_faa,pdf_text"
    req = urllib.request.Request(url, headers={
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    })
    with urllib.request.urlopen(req) as resp:
        rows = json.load(resp)
    if not rows:
        raise RuntimeError(f"No AC found for document_number={doc_number}")
    return rows[0]


def download_pdf(url: str, dest: Path):
    urllib.request.urlretrieve(url, dest)


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
    image_data = image_path.read_bytes()
    import base64
    b64 = base64.standard_b64encode(image_data).decode("utf-8")
    message = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": "image/png", "data": b64},
                    },
                    {"type": "text", "text": f"{TRANSCRIBE_PROMPT}\n\n(This is page {page_num} of {total_pages}.)"},
                ],
            }
        ],
    )
    return "".join(block.text for block in message.content if block.type == "text")


def run_pilot(doc_number: str, supabase_url: str, service_key: str, client: anthropic.Anthropic):
    print(f"\n=== {doc_number} ===")
    row = fetch_ac_row(supabase_url, service_key, doc_number)
    pdf_url = row.get("pdf_url_cached") or row["pdf_url_faa"]
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", doc_number)

    work_dir = OUT_DIR / safe_name
    work_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = work_dir / f"{safe_name}.pdf"
    print(f"Downloading {pdf_url} ...")
    download_pdf(pdf_url, pdf_path)

    print("Rendering pages ...")
    page_images = render_pages(pdf_path, work_dir / "pages")
    print(f"{len(page_images)} pages")

    transcripts = []
    for i, img_path in enumerate(page_images, start=1):
        print(f"  transcribing page {i}/{len(page_images)} ...")
        text = transcribe_page(client, img_path, i, len(page_images))
        transcripts.append(f"--- PAGE {i} ---\n{text}")

    llm_text = "\n\n".join(transcripts)
    (work_dir / "llm_transcript.txt").write_text(llm_text)
    (work_dir / "current_pdf_text.txt").write_text(row.get("pdf_text") or "")

    print(f"Wrote {work_dir / 'llm_transcript.txt'}")
    print(f"Wrote {work_dir / 'current_pdf_text.txt'} (current stored text, for comparison)")


def main():
    docs = sys.argv[1:] or DEFAULT_PILOT_DOCS
    supabase_url, service_key = get_supabase_creds()
    anthropic_key = get_anthropic_key()
    client = anthropic.Anthropic(api_key=anthropic_key)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for doc_number in docs:
        run_pilot(doc_number, supabase_url, service_key, client)

    print("\nDone. Review each doc's llm_transcript.txt vs current_pdf_text.txt under:")
    print(f"  {OUT_DIR}")


if __name__ == "__main__":
    main()
