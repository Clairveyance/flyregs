#!/bin/bash
# FlyRegs FAR sync — 14 CFR Chapter I (Federal Aviation Administration).
#
# Single-step pipeline: sync/far_scraper.py --mode full pulls the current
# eCFR "as of" version and upserts far_parts/far_sections. Safe to re-run on
# a schedule — see far_scraper.py's own header for why (eCFR always serves
# the current version, no separate "what changed" tracking needed the way
# faa.gov's per-AC pages require).
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-far-sync.yml) — same reasoning as sync.sh/
# sync_aim.sh: doesn't depend on any one machine being on. Can still be run
# locally for testing by creating a `.env.scraper` file in this directory
# (SUPABASE_URL + SUPABASE_SERVICE_KEY, gitignored, never commit it) — same
# file the other sync scripts use.
#
# Usage:
#   ./sync_far.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
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
echo "  FlyRegs FAR Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"
"$PYTHON3" sync/far_scraper.py --mode full

# MagicLink citation extraction (full corpus re-scan) -- was a total, silent
# gap before 2026-07-28: no script existed for FAR's own outbound citations
# at all. Cheap (a few seconds against ~4,300 sections); delete-then-insert
# per citing_type makes re-running always safe.
echo ""
echo "▶ MagicLink citation extraction (FAR -> AC/AIM/P-CG/AD/FAR)"
"$PYTHON3" sync/far_citations.py

echo ""
echo "▶ Refresh study_far_sections (within-part-unique FAR titles for Study Mode)"
# Materialized: the membership only changes when far_sections changes, and
# computing it live inside get_study_queue measured a statement timeout.
# See sync/migrations_study_far_dupes.sql.
curl -sf -X POST "$SUPABASE_URL/rest/v1/rpc/refresh_study_far_sections" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" -d '{}' > /dev/null
echo "  refreshed."

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FAR sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
