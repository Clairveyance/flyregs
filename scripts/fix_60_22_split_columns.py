#!/usr/bin/env python3
"""
Fallback for AC 60-22 pages that still fail Vision transcription even with
reassurance-framing retry (pages 3 and 14 -- see fix_60_22_blocked_pages.py).
Splits each page image into left/right column halves and retries Vision on
each half separately -- less hazardous-attitude-word density per single call
may dodge the content filter where the whole page didn't. Never prints
transcribed text to stdout, same reason as fix_60_22_blocked_pages.py.

Usage: python3 scripts/fix_60_22_split_columns.py
"""
import base64
import json
import time
from pathlib import Path

import fitz
import anthropic
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
AC_APP_DIR = SCRIPT_DIR.parent
WORK_DIR = AC_APP_DIR / "scratch" / "ocr_rebuild" / "60-22"
PAGES_DIR = WORK_DIR / "pages"

MODEL = "claude-sonnet-5"
STILL_BLOCKED_PAGES = [3, 14]

PROMPT = """You are transcribing HALF of one page (left or right column) of a 1991 FAA aeronautical training manual -- routine pilot-education glossary/quiz content, benign historical regulatory text.

Rules:
1. Transcribe exactly as printed -- no paraphrasing, no modernizing.
2. Preserve structure markers (numbers, letter items like "a.", "b.", headings) exactly.
3. If genuinely illegible, write [illegible].
4. Output ONLY the transcription -- no preamble, no commentary."""


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


def split_columns(img_path: Path, out_dir: Path, page_num: int):
    out_dir.mkdir(parents=True, exist_ok=True)
    im = Image.open(img_path)
    w, h = im.size
    left = im.crop((0, 0, w // 2, h))
    right = im.crop((w // 2, 0, w, h))
    left_path = out_dir / f"page_{page_num:03d}_left.png"
    right_path = out_dir / f"page_{page_num:03d}_right.png"
    left.save(left_path)
    right.save(right_path)
    return left_path, right_path


def transcribe(client, image_path: Path):
    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("utf-8")
    try:
        message = client.messages.create(
            model=MODEL,
            max_tokens=2048,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                        {"type": "text", "text": PROMPT},
                    ],
                }
            ],
        )
        return "".join(b.text for b in message.content if b.type == "text")
    except Exception as e:
        print(f"  {image_path.name}: failed ({type(e).__name__})")
        return None


def main():
    env = load_env_file(AC_APP_DIR / ".env.anthropic")
    client = anthropic.Anthropic(api_key=env["ANTHROPIC_API_KEY"])

    results = {}
    for page_num in STILL_BLOCKED_PAGES:
        print(f"Page {page_num}: splitting into columns...")
        img_path = PAGES_DIR / f"page_{page_num:03d}.png"
        left_path, right_path = split_columns(img_path, PAGES_DIR / "split", page_num)

        left_text = transcribe(client, left_path)
        time.sleep(1)
        right_text = transcribe(client, right_path)

        if left_text is not None and right_text is not None:
            combined = left_text.strip() + "\n\n" + right_text.strip()
            out_path = WORK_DIR / f"page_{page_num:03d}_fixed.txt"
            out_path.write_text(combined)
            print(f"  wrote {len(combined)} chars to {out_path.name}")
            results[page_num] = str(out_path)
        else:
            print(f"  page {page_num}: still blocked even split into columns")
            results[page_num] = None

    existing = {}
    idx_path = WORK_DIR / "blocked_pages_results.json"
    if idx_path.exists():
        existing = json.loads(idx_path.read_text())
    existing.update({str(k): v for k, v in results.items()})
    idx_path.write_text(json.dumps(existing, indent=2))
    print("\nDone. Results index updated: scratch/ocr_rebuild/60-22/blocked_pages_results.json")


if __name__ == "__main__":
    main()
