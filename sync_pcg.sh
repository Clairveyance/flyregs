#!/bin/bash
# FlyRegs P/CG sync — Pilot/Controller Glossary.
#
# Single-step pipeline: sync/pcg_scraper.py --mode full pulls the current
# P/CG source and upserts its terms/entries. Safe to re-run on a schedule —
# see pcg_scraper.py's own header for why.
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-pcg-sync.yml) — same reasoning as sync.sh/
# sync_aim.sh: doesn't depend on any one machine being on. Can still be run
# locally for testing by creating a `.env.scraper` file in this directory
# (SUPABASE_URL + SUPABASE_SERVICE_KEY, gitignored, never commit it) — same
# file the other sync scripts use.
#
# Usage:
#   ./sync_pcg.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (SUPABASE_URL + SUPABASE_SERVICE_KEY)" >&2
  exit 1
fi

set -o allexport
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$ENV_FILE" | sed 's/^export //')
set +o allexport

START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs P/CG Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"
"$PYTHON3" sync/pcg_scraper.py --mode full

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  P/CG sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
