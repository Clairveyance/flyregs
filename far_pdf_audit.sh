#!/bin/bash
# FlyRegs FAR PDF cross-reference audit — NOT a content sync, a periodic
# accuracy check.
#
# far_sections is scraped from eCFR (sync_far.sh, daily-current, but not
# itself an "official legal edition"). This script cross-references it
# against the real, official Title 14 CFR annual-edition PDF from
# govinfo.gov — the document a pilot would actually go pull up. See the
# 2026-07-24 gotchas entry ("Everything... has to be checked against the
# actual PDF documents") for why this exists.
#
# IMPORTANT — this is NOT "PDF wins": the annual PDF is published roughly
# 6 months after its own "as of" date, and as of this writing there is no
# 2026 edition at all yet. eCFR is routinely MORE current than the PDF, not
# less. A real content difference (especially a section that exists in
# eCFR with no PDF counterpart at all) is usually evidence of a genuine
# regulatory update since the PDF's baseline, not an eCFR error — read
# sync/far_pdf_crossref.py's own docstring before acting on its output.
#
# CFR_YEAR below MUST be bumped by hand when govinfo.gov publishes a newer
# edition (check https://www.govinfo.gov/app/collection/cfr/<year>/title14
# — Title 14 is in the "revised as of January 1" group, but isn't actually
# published until mid-year; there is no automatic way to detect this).
#
# Chapter I (FAA) only spans Parts 1-198 as of this writing, entirely
# within volumes 1-3 (Parts 1-59 / 60-109 / 110-199) — volumes 4-5 cover
# other Title 14 chapters (NASA, Commercial Space Transportation, etc.) and
# are deliberately not downloaded.
#
# Usage:
#   ./far_pdf_audit.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"
CFR_YEAR="2025"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (SUPABASE_URL + SUPABASE_SERVICE_KEY)" >&2
  exit 1
fi

# ENV_FILE already has real "export VAR=..." lines -- source it directly
# (no process substitution) for portability across shells/sandboxes;
# confirmed live that piping through <(...) is unreliable in some
# execution environments even with the vars right there in the file.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

cd "$APP"
WORKDIR="$(mktemp -d -t far-pdf-audit)"
trap 'rm -rf "$WORKDIR"' EXIT

echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs FAR PDF Cross-Reference Audit  —  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════"

echo ""
echo "▶ Step 1/3 — Download Title $CFR_YEAR CFR Title 14 volumes 1-3 (Parts 1-199)"
for vol in 1 2 3; do
  url="https://www.govinfo.gov/content/pkg/CFR-${CFR_YEAR}-title14-vol${vol}/pdf/CFR-${CFR_YEAR}-title14-vol${vol}.pdf"
  curl -sL -A "Mozilla/5.0" "$url" -o "$WORKDIR/vol${vol}.pdf"
  if ! file "$WORKDIR/vol${vol}.pdf" | grep -q "PDF document"; then
    echo "ERROR: vol${vol} download is not a valid PDF — check CFR_YEAR above against" >&2
    echo "  https://www.govinfo.gov/app/collection/cfr/${CFR_YEAR}/title14 (a newer edition" >&2
    echo "  may now exist, or this year's hasn't been published yet)." >&2
    exit 1
  fi
  echo "  vol${vol}: OK — $(du -h "$WORKDIR/vol${vol}.pdf" | cut -f1)"
done

echo ""
echo "▶ Step 2/3 — Extract every section's text from the PDF"
(cd "$WORKDIR" && "$PYTHON3" "$APP/sync/build_far_pdf_sections.py" vol1.pdf vol2.pdf vol3.pdf)

echo ""
echo "▶ Step 3/3 — Cross-reference against far_sections"
cp "$WORKDIR/far_pdf_sections.json" "$APP/far_pdf_sections.json"
"$PYTHON3" sync/far_pdf_crossref.py
rm -f "$APP/far_pdf_sections.json"

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FAR PDF audit complete  —  $END_TS"
echo "  Full report: far_pdf_crossref_report.json"
echo "════════════════════════════════════════════════════"
echo ""
