#!/bin/bash
# FlyRegs 49 CFR sync — NTSB Part 830, TSA Parts 1544/1552, HMR Part 175.
#
# Confirmed a real gap 2026-08-18 (same investigation, same class of gap as
# sync_loi.sh's own header explains): 49 CFR had no scheduled sync of any
# kind since it shipped, despite cfr49_scraper.py and cfr49_citations.py
# both already existing and working when run by hand.
#
# Single-step-plus-citations pipeline, same shape as sync_far.sh (eCFR-
# sourced, always-current "as of" version, no separate incremental-diff
# tracking needed -- see cfr49_scraper.py's own header).
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-cfr49-sync.yml) -- same reasoning as every other
# sync_*.sh: shouldn't depend on any one machine being on. Can still be run
# locally for testing by creating a `.env.scraper` file in this directory
# (SUPABASE_URL + SUPABASE_SERVICE_KEY, gitignored, never commit it) -- same
# file the other sync scripts use.
#
# Usage:
#   ./sync_cfr49.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (SUPABASE_URL + SUPABASE_SERVICE_KEY)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs 49 CFR Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"

echo ""
echo "▶ Step 1/2 — 49 CFR scrape (full: NTSB 830, TSA 1544/1552, HMR 175)"
"$PYTHON3" sync/cfr49_scraper.py --mode full

echo ""
echo "▶ Step 2/2 — MagicLink citation extraction (49 CFR -> AC/AIM/AD/FAR/49 CFR)"
"$PYTHON3" sync/cfr49_citations.py

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  49 CFR sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
