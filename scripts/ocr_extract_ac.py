#!/usr/bin/env python3
"""OCR-extract text for an AC whose source PDF has zero native text (a
different, more severe problem than the 68 ACs in OCR_SCANNED_ACS, which at
least have a bad embedded scan-OCR layer to work with). Renders each page to
an image via PyMuPDF and reads it with easyocr.

Only safe for SINGLE-COLUMN documents -- easyocr's line order follows simple
top-to-bottom position, which breaks down on two-column layouts (verified on
AC 60-22: column text interleaves mid-sentence). Check the PDF's layout
before running this on a new AC; a two-column doc needs column-aware
splitting (crop each page into left/right halves by x-coordinate and OCR them
separately) which this script does not yet do.

Usage:
  pip3 install easyocr   # first time only; downloads ~65MB of models on first run
  python3 scripts/ocr_extract_ac.py <document_number> <path_to_pdf> <output.txt>

After reviewing the output quality, write it to production with a small
one-off script that: transpiles acFormat.ts, calls parseAC(text, docNumber),
and PATCHes pdf_text/pdf_blocks/pdf_blocks_version for that document_number.
Then add the document to OCR_SCANNED_ACS in src/lib/ocrScannedACs.ts (for the
disclaimer banner) AND to NO_ARTIFACT_REPAIR_ACS in the same file if the OCR
output doesn't have the old embedded-scan letter-splitting pattern -- applying
that repair to fresh OCR text can squish real words together (confirmed on
AC 38-1: "weight/s ranges" became "weight/sranges" when the repair was left
enabled for it).
"""
import sys
import fitz
import easyocr

if len(sys.argv) != 4:
    print(__doc__)
    sys.exit(1)

doc_number, pdf_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]

reader = easyocr.Reader(['en'], gpu=False)
doc = fitz.open(pdf_path)
print(f"{doc_number}: {len(doc)} pages", file=sys.stderr)

all_text = []
for i, page in enumerate(doc):
    pix = page.get_pixmap(dpi=200)
    img_path = f"/tmp/_ocr_page_{i}.png"
    pix.save(img_path)
    lines = reader.readtext(img_path, detail=0, paragraph=False)
    all_text.append('\n'.join(lines))
    print(f"  page {i+1}/{len(doc)} done ({len(lines)} lines)", file=sys.stderr)

with open(out_path, 'w') as f:
    f.write('\n'.join(all_text))
print(f"Wrote {out_path}", file=sys.stderr)
