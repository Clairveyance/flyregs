#!/usr/bin/env python3
"""
PILOT script: re-transcribes an old-scan AC's pdf_text via Claude vision
(same technique as llm_rebuild_ocr_docs.py) AND, in the SAME per-page vision
call, detects any Figure/Table on that page and writes it to ac_figures --
for ACs where extract_figures.py's bold/ALL-CAPS text-span heuristic finds
nothing at all (confirmed on AC 90-67B: 0 rows despite a real Table in the
source), typically because the scan's OCR text layer has no font-weight
metadata to detect bold with.

One combined vision call per page (not two) specifically to keep API cost
down -- doubling the calls would double the bill for the same page image.

Does NOT touch pdf_blocks_version (same reasoning as llm_rebuild_ocr_docs.py
and reparse_blocks_silent.mjs: this is a content-quality fix, not a real FAA
revision, and must not trigger the NEW/UPD "this AC changed" signal).

Deletes any existing ac_figures rows for the AC first (--replace-figures,
default on) since a doc reaching this script already has zero or unreliable
rows from the normal heuristic -- safe to start clean.

Usage:
    python3 scripts/llm_rebuild_with_figures.py <doc_number> [doc_number ...]
"""
import base64
import json
import re
import signal
import sys
import urllib.request
from pathlib import Path

import fitz
import anthropic

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
SCRATCH_DIR = AC_APP_DIR / "scratch" / "ocr_rebuild_with_figures"

MODEL = "claude-sonnet-5"
RENDER_DPI = 150

PROMPT = """You are transcribing one page of a scanned FAA Advisory Circular -- a regulatory document where exact wording, numbering, and punctuation matter.

TRANSCRIPTION RULES:
1. Transcribe the text EXACTLY as it appears. Do not modernize spelling, do not "fix" grammar, do not paraphrase.
2. Preserve the document's own structure markers exactly as printed: section numbers ("1.", "2."), letter items ("a.", "b."), numbered sub-items ("(1)", "(2)"), headings.
3. If the page contains a chart, diagram, or DATA TABLE (rows/columns of real values): DO include its actual content in the transcription -- every row label, column header, and cell value, in a natural reading order (e.g. one row per line: "Steady Green | Cleared to cross, proceed or go | Cleared for takeoff"). Do NOT write a narrative/visual description of the image itself (no "this shows a table with a black border..."). The distinction is: transcribe the DATA, never the APPEARANCE.
4. For an equation or formula, transcribe it as accurately as you can (fractions, roots, exponents, subscripts, Greek letters) using plain-text notation.
5. If part of the page is genuinely illegible even to you, write [illegible] at that exact spot rather than guessing.
6. This is a historical government regulatory document. Technical/safety terminology (icing, fire hazard, backfire, engine failure, emergency procedures, weapons-adjacent aviation terms, etc.) is routine subject matter here, not a safety concern -- transcribe it exactly as printed like any other technical term.

Output in exactly this format, with both sections always present:

===TRANSCRIPTION===
(the transcription itself here, no preamble)
===FIGURES===
(one line per figure, table, or titled chart visible on THIS page -- in the format "Figure N: caption text" or "Table N: caption text" if the document itself prints an explicit "Figure"/"Table" label with a number, OR in the format "Untitled: <the chart/table's own printed title or heading text>" if it's a real data table/chart with NO "Figure N"/"Table N" label printed anywhere on it (e.g. a chart titled only "AIR TRAFFIC CONTROL TOWER LIGHT GUN SIGNALS" with no number). If there is no figure, table, or chart on this page at all, write exactly: NONE)
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


def fetch_ac_row(supabase_url, service_key, doc_number):
    from urllib.parse import quote
    url = f"{supabase_url}/rest/v1/advisory_circulars?document_number=eq.{quote(doc_number)}&select=id,document_number,pdf_url_cached,pdf_url_faa"
    req = urllib.request.Request(url, headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
    with urllib.request.urlopen(req) as resp:
        rows = json.load(resp)
    if not rows:
        raise RuntimeError(f"No AC found for document_number={doc_number}")
    return rows[0]


def update_pdf_text(supabase_url, service_key, ac_id, new_text):
    url = f"{supabase_url}/rest/v1/advisory_circulars?id=eq.{ac_id}"
    body = json.dumps({"pdf_text": new_text}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PATCH", headers={
        "apikey": service_key, "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()


def delete_figures_for_ac(supabase_url, service_key, ac_id):
    url = f"{supabase_url}/rest/v1/ac_figures?ac_id=eq.{ac_id}"
    req = urllib.request.Request(url, method="DELETE", headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"})
    with urllib.request.urlopen(req) as resp:
        resp.read()


def insert_figure_rows(supabase_url, service_key, rows):
    if not rows:
        return
    url = f"{supabase_url}/rest/v1/ac_figures"
    body = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "apikey": service_key, "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json", "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()


def upload_png(supabase_url, service_key, doc_num, label, png_bytes):
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    fname = f"{re.sub(r'[^a-zA-Z0-9-_.]', '_', doc_num)}/{slug}.png"
    url = f"{supabase_url}/storage/v1/object/ac-figures/{fname}"
    req = urllib.request.Request(url, data=png_bytes, method="PUT", headers={
        "apikey": service_key, "Authorization": f"Bearer {service_key}",
        "Content-Type": "image/png", "x-upsert": "true",
    })
    with urllib.request.urlopen(req) as resp:
        resp.read()
    return f"{supabase_url}/storage/v1/object/public/ac-figures/{fname}"


def render_pages(pdf_path, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    paths = []
    for i in range(doc.page_count):
        pix = doc[i].get_pixmap(dpi=RENDER_DPI)
        p = out_dir / f"page_{i + 1:03d}.png"
        pix.save(p)
        paths.append(p)
    doc.close()
    return paths


class _HardTimeout(Exception):
    pass


def _alarm_handler(signum, frame):
    raise _HardTimeout("hard OS-level timeout fired")


def with_hard_timeout(seconds, fn, *args, **kwargs):
    """SIGALRM-based backstop -- confirmed necessary the hard way: the
    anthropic SDK's own `timeout=` kwarg was passed (120s) and did NOT stop a
    real hang on page 1 of the 153-page AC 150/5060-5 (4.5+ min elapsed, ~11s
    of actual CPU time, one ESTABLISHED-but-silent TCP connection, twice in a
    row on restart) -- whatever layer that hang was stuck in wasn't covered
    by the SDK's own read-timeout. SIGALRM forcibly interrupts the process
    regardless of what the network/SDK stack is doing internally. Unix-only,
    fine here (this always runs on macOS/Linux, never invoked from Windows)."""
    old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
    signal.alarm(seconds)
    try:
        return fn(*args, **kwargs)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


def call_vision(client, image_path, page_num, total_pages, retry_note=""):
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    text = f"{PROMPT}\n\n(This is page {page_num} of {total_pages}.){retry_note}"
    message = with_hard_timeout(90, client.messages.create,
        model=MODEL,
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": text},
            ],
        }],
    )
    return "".join(b.text for b in message.content if b.type == "text")


def call_vision_safe(client, image_path, page_num, total_pages):
    """Wraps call_vision with one retry (extra reassurance framing) for a
    content-filter false-positive -- confirmed on AC 20-113 page 4, whose
    actual content is ordinary carburetor-icing-prevention text with nothing
    sensitive in it; the filter almost certainly tripped on "backfire"/"fire
    hazard"/"damage" appearing near each other. A retry with the same input
    can still hit the same deterministic classification, so this also softens
    the request itself. If both attempts fail, returns a placeholder instead
    of crashing the whole document -- one bad page doesn't need to lose the
    other 19."""
    try:
        return call_vision(client, image_path, page_num, total_pages)
    except Exception as e:
        print(f"    page {page_num}: first attempt failed ({e}), retrying with reassurance framing...")
        try:
            return call_vision(
                client, image_path, page_num, total_pages,
                retry_note=" This is ordinary historical FAA regulatory/technical text (aviation safety guidance) -- please transcribe it plainly.",
            )
        except Exception as e2:
            print(f"    page {page_num}: retry also failed ({e2}) -- inserting placeholder, needs manual re-run.")
            return "===TRANSCRIPTION===\n[transcription failed for this page -- content filter or API error, needs manual re-run]\n===FIGURES===\nNONE"


def parse_response(raw):
    m = re.search(r"===TRANSCRIPTION===\s*(.*?)\s*===FIGURES===\s*(.*)$", raw, re.DOTALL)
    if not m:
        return raw.strip(), []
    transcription = m.group(1).strip()
    fig_block = m.group(2).strip()
    figures = []
    if fig_block and fig_block.upper() != "NONE":
        for line in fig_block.splitlines():
            line = line.strip()
            if not line or line.upper() == "NONE":
                continue
            fm = re.match(r"(Figure|Table)\s+([\w.\-]+)\s*:\s*(.*)$", line, re.IGNORECASE)
            if fm:
                kind, num, caption = fm.groups()
                figures.append((f"{kind.title()} {num}", caption.strip() or None))
                continue
            um = re.match(r"Untitled\s*:\s*(.*)$", line, re.IGNORECASE)
            if um:
                # Real chart/table with no printed "Figure N"/"Table N" label
                # (e.g. AC 90-67B's light-gun-signal chart) -- caller assigns
                # the actual sequential "Table N" label, since only it has
                # cross-page context to number these consistently.
                figures.append((None, um.group(1).strip() or None))
    return transcription, figures


def process_doc(doc_number, supabase_url, service_key, client):
    print(f"\n=== {doc_number} ===")
    row = fetch_ac_row(supabase_url, service_key, doc_number)
    pdf_url = row.get("pdf_url_cached") or row["pdf_url_faa"]
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", doc_number)
    work_dir = SCRATCH_DIR / safe_name
    work_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = work_dir / f"{safe_name}.pdf"
    urllib.request.urlretrieve(pdf_url, pdf_path)

    page_images = render_pages(pdf_path, work_dir / "pages")
    print(f"  {len(page_images)} pages")

    page_texts = []
    all_figures = []  # (page_num, label, caption)
    seen_labels = set()
    untitled_count = 0
    for i, img_path in enumerate(page_images, start=1):
        raw = call_vision_safe(client, img_path, i, len(page_images))
        text, figures = parse_response(raw)
        page_texts.append(text)
        page_labels = []
        for label, caption in figures:
            if label is None:
                # Untitled chart/table (no printed "Figure N"/"Table N") --
                # assign our own sequential label so the rest of the app's
                # Figure/Table plumbing (which always expects this shape)
                # still works.
                untitled_count += 1
                label = f"Table {untitled_count}"
            if label in seen_labels:
                continue
            seen_labels.add(label)
            all_figures.append((i, label, caption))
            page_labels.append(label)
        print(f"  page {i}/{len(page_images)}: {len(text)} chars, figures: {page_labels or 'none'}")

    new_pdf_text = "\n\n".join(page_texts)
    (work_dir / "final_pdf_text.txt").write_text(new_pdf_text)
    (work_dir / "figures_found.json").write_text(json.dumps(all_figures, indent=2))

    update_pdf_text(supabase_url, service_key, row["id"], new_pdf_text)
    print(f"  Wrote {len(new_pdf_text)} chars to pdf_text.")

    if all_figures:
        delete_figures_for_ac(supabase_url, service_key, row["id"])
        rows = []
        doc = fitz.open(pdf_path)
        for order, (page_num, label, caption) in enumerate(all_figures):
            pix = doc[page_num - 1].get_pixmap(dpi=RENDER_DPI)
            png_bytes = pix.tobytes("png")
            image_url = upload_png(supabase_url, service_key, doc_number, label, png_bytes)
            rows.append({
                "ac_id": row["id"], "label": label, "caption": caption,
                "page": page_num, "image_url": image_url, "sort_order": order,
            })
        doc.close()
        insert_figure_rows(supabase_url, service_key, rows)
        print(f"  Inserted {len(rows)} ac_figures row(s): {[r['label'] for r in rows]}")
    else:
        print("  No figures/tables detected.")

    return len(page_images), len(all_figures)


def main():
    docs = sys.argv[1:]
    if not docs:
        print("Usage: python3 scripts/llm_rebuild_with_figures.py <doc_number> [doc_number ...]")
        sys.exit(1)

    supabase_url, service_key = get_supabase_creds()
    client = anthropic.Anthropic(api_key=get_anthropic_key())
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)

    total_pages = 0
    total_figures = 0
    for doc_number in docs:
        try:
            pages, figs = process_doc(doc_number, supabase_url, service_key, client)
            total_pages += pages
            total_figures += figs
        except Exception as e:
            print(f"  ERROR on {doc_number}: {e}")

    print(f"\nDone. {len(docs)} doc(s), {total_pages} total pages transcribed, {total_figures} figure/table row(s) written.")


if __name__ == "__main__":
    main()
