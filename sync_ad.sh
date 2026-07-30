#!/bin/bash
# FlyRegs AD sync — Airworthiness Directives.
#
# Confirmed a real, live gap on 2026-07-28: ad_scraper.py already had a
# purpose-built `incremental` mode ("what the weekly sync actually uses",
# per its own header) and send-ad-alerts.mjs already existed to notify
# My Aircraft users of newly-touched ADs -- but no schedule of any kind
# ever called either one. AD data and targeted alerts were 100% manual
# since the AD expansion shipped.
#
# Steps:
#   1. sync/ad_scraper.py --mode incremental -- only ADs published since
#      the most recent citation_publish_date already in the DB, writing
#      every touched ad_number to a temp file.
#   2. sync/extract_ad_parts.py --mode full --touched-file -- named-parts
#      extraction (Claude Haiku) scoped to just this run's touched ADs,
#      so it's cheap/safe to run unattended (the one-time full-corpus
#      backfill is separate and needs an explicit human go-ahead first,
#      see that script's own header). Runs BEFORE step 3 on purpose: it
#      populates ad_part_mentions for the ADs this run touched, which
#      send-ad-alerts.mjs's part-keyed matching (added 2026-07-28) then
#      reads in the same run -- so a brand-new part-keyed AD can still
#      alert a tagged owner the same week it's published, not a week late.
#   3. scripts/send-ad-alerts.mjs -- targeted push notifications to
#      My Aircraft users whose saved make/model matches a touched AD, or
#      whose tagged equipment matches a part-keyed AD.
#   4. sync/ad_citations.py -- MagicLink citation extraction (AD ->
#      AC/FAR/AIM mentions), full corpus re-scan. Was written this same
#      week but had never actually been run before 2026-07-28 (see
#      flyregs_gotchas.md) -- wiring it here is what keeps it from
#      silently going stale again the way it already did once.
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-ad-sync.yml) — same reasoning as sync.sh/
# sync_far.sh/sync_aim.sh/sync_pcg.sh: doesn't depend on any one machine
# being on. Can still be run locally for testing by creating a
# `.env.scraper` file in this directory (SUPABASE_URL +
# SUPABASE_SERVICE_KEY, gitignored, never commit it) — same file the
# other sync scripts use.
#
# Usage:
#   ./sync_ad.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"
NODE="${NODE:-node}"
TOUCHED_FILE="$(mktemp -t flyregs-ad-touched.XXXXXX)"

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
echo "  FlyRegs AD Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"

echo ""
echo "▶ Step 1/4 — AD incremental scrape"
"$PYTHON3" sync/ad_scraper.py --mode incremental --touched-out="$TOUCHED_FILE"

echo ""
echo "▶ Step 2/4 — AD parts extraction (ADs touched this run)"
"$PYTHON3" sync/extract_ad_parts.py --mode full --touched-file="$TOUCHED_FILE"

echo ""
echo "▶ Step 3/4 — Targeted My Aircraft alerts (ADs touched this run)"
"$NODE" scripts/send-ad-alerts.mjs --touched-file="$TOUCHED_FILE"

echo ""
echo "▶ Step 4/4 — MagicLink citation extraction (AD -> AC/FAR/AIM)"
"$PYTHON3" sync/ad_citations.py

rm -f "$TOUCHED_FILE"

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  AD sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
