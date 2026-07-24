#!/bin/bash
# FlyRegs AIM sync — scrape + real-page-image backfill, always together.
#
# MUST NOT be split into separate manual steps — see sync/aim_scraper.py's
# _upsert("aim_figures", ...) comment for why: a plain re-scrape rebuilds
# every figure's image_url from the raw FAA HTML source, which is exactly
# the URL sync/backfill_aim_pdf_images.py replaces with a correct, real PDF
# page-image. Running the scraper alone silently reverts that fix. This
# script exists so that never happens again — confirmed live as a real
# incident during initial rollout (252 stale/duplicate-image rows came back
# after one bare `python aim_scraper.py --mode full` run).
#
# Steps:
#   1. Re-download the current AIM PDF from FAA.gov (changes are published
#      as revision PDFs — "Basic w/ Chg 1,2,3" etc. — re-fetching each run
#      keeps the page-image cache current with the latest change).
#   2. Rebuild aim_pdf_pages.json (caption -> PDF page number lookup).
#   3. Run sync/aim_scraper.py --mode full (HTML source -> paragraphs/
#      figures/citations).
#   4. Run sync/backfill_aim_pdf_images.py (re-point every figure to its
#      real cached page image; create rows for tables that don't have one
#      yet; re-apply the small hardcoded set of genuinely uncaptioned
#      figures that can never be found by title match).
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-aim-sync.yml) — same reasoning as sync.sh's own
# header: this no longer depends on any single machine being on. Can still
# be run locally for testing by creating a `.env.scraper` file in this
# directory (SUPABASE_URL + SUPABASE_SERVICE_KEY, gitignored, never commit
# it) — it's the same file sync.sh uses.
#
# Usage:
#   ./sync_aim.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PDF_URL="https://www.faa.gov/air_traffic/publications/media/AIM_Basic_w_Chg_1_and_2_and_3_dtd_7-9-26.pdf"
PDF_PATH="$APP/aim_full.pdf"
PYTHON3="${PYTHON3:-python3}"

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

START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs AIM Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

echo ""
echo "▶ Step 1/4 — Download current AIM PDF"
cd "$APP"
curl -sL -A "Mozilla/5.0" "$PDF_URL" -o "$PDF_PATH.tmp"
if [[ ! -s "$PDF_PATH.tmp" ]] || ! file "$PDF_PATH.tmp" | grep -q "PDF document"; then
  echo "ERROR: downloaded file is not a valid PDF — check PDF_URL (the FAA may have"
  echo "  published a new change with a different filename since this script was"
  echo "  written; check https://www.faa.gov/air_traffic/publications/ for the"
  echo "  current 'AIM Basic w/ Chg...' link and update PDF_URL above)." >&2
  rm -f "$PDF_PATH.tmp"
  exit 1
fi
mv "$PDF_PATH.tmp" "$PDF_PATH"
echo "  OK — $(du -h "$PDF_PATH" | cut -f1)"

echo ""
echo "▶ Step 2/4 — Rebuild PDF caption -> page lookup"
"$PYTHON3" sync/build_aim_pdf_pages.py "$PDF_PATH"

echo ""
echo "▶ Step 3/4 — AIM scrape (full)"
"$PYTHON3" sync/aim_scraper.py --mode full

echo ""
echo "▶ Step 4/4 — Real page-image backfill"
"$PYTHON3" sync/backfill_aim_pdf_images.py --pdf "$PDF_PATH"

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  AIM sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
