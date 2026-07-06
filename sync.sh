#!/bin/bash
# FlyRegs weekly sync — FAA AC database maintenance
#
# Runs five stages in order:
#   1. Incremental scrape  — fetches new/updated/cancelled ACs from FAA.gov
#   2. OCR fixes           — cleans word-split artifacts in freshly scraped text
#   3. Parse backfill      — rebuilds pdf_blocks for any ACs with new/changed text
#   4. Parser audit        — checks the FRESHLY BUILT blocks for structural
#                            anomalies (cross-reference collisions, mislabeled
#                            headings, duplicate labels) before the sync is done.
#                            Scoped to only the ACs step 3 actually touched, so a
#                            normal weekly run (a handful of changed ACs) stays
#                            fast — new/updated content gets the same checks a
#                            manual full-catalog sweep would run, automatically,
#                            every week. Findings are logged, not auto-blocking —
#                            if a run reports findings, check the workflow log and
#                            cross-check by hand (scripts/audit-parser.mjs's own
#                            header comment explains what's a real bug vs. an
#                            expected false positive).
#   5. Update alerts       — sends a push notification (Expo Push API) to every
#                            Premium subscriber with "AC Update Alerts" turned
#                            on, for exactly the ACs step 3 touched. No-op if
#                            nothing changed this run.
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-sync.yml) — this no longer depends on any single
# machine being on. It can still be run locally for testing/debugging by
# creating a `.env.scraper` file in this directory (SUPABASE_URL +
# SUPABASE_SERVICE_KEY, gitignored, never commit it).
#
# Usage:
#   ./sync.sh               — standard weekly run
#   ./sync.sh --full        — full scrape (all ACs, use for initial setup or recovery)
#   ./sync.sh --dry-run     — scrape only, no DB writes (smoke-test mode)

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
TOUCHED_FILE="$(mktemp -t flyregs-touched.XXXXXX)"

PYTHON3="${PYTHON3:-python3}"
NODE="${NODE:-node}"

# Always clean up the temp file, even if a later step fails.
trap 'rm -f "$TOUCHED_FILE"' EXIT

# ── Args ──────────────────────────────────────────────────────────────────────
SCRAPE_MODE="incremental"
DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --full)    SCRAPE_MODE="full" ;;
    --dry-run) SCRAPE_MODE="test"; DRY_RUN="--dry-run" ;;
  esac
done

# ── Env validation ────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found (SUPABASE_URL + SUPABASE_SERVICE_KEY)" >&2
  exit 1
fi

# Export env vars for Python (which reads from os.environ, not the file)
set -o allexport
# shellcheck disable=SC1090
source <(grep -v '^\s*#' "$ENV_FILE" | sed 's/^export //')
set +o allexport

# ── Banner ────────────────────────────────────────────────────────────────────
START_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs Weekly Sync  —  $START_TS"
[[ "$SCRAPE_MODE" == "full" ]] && echo "  ⚠  FULL SCRAPE MODE"
[[ -n "$DRY_RUN" ]] && echo "  ⚠  DRY-RUN (smoke test, no writes)"
echo "════════════════════════════════════════════════════"

# ── Step 1: FAA scrape ────────────────────────────────────────────────────────
echo ""
echo "▶ Step 1/5 — FAA $SCRAPE_MODE scrape"
cd "$APP"
"$PYTHON3" sync/faa_scraper.py --mode "$SCRAPE_MODE"

# Stop here in dry-run — scraper test mode makes no DB writes
if [[ -n "$DRY_RUN" ]]; then
  echo ""
  echo "Dry-run complete (scrape only). No OCR fixes, backfill, audit, or alerts run."
  exit 0
fi

# ── Step 2: OCR word-split fixes ──────────────────────────────────────────────
echo ""
echo "▶ Step 2/5 — OCR word-split fixes (new/updated ACs)"
# --new-only skips already-processed ACs; the scraper clears pdf_blocks_version
# on any AC whose pdf_text changes, so this only touches freshly scraped rows.
"$NODE" scripts/apply-ocr-fixes.mjs --new-only

# ── Step 3: Parse backfill ────────────────────────────────────────────────────
echo ""
echo "▶ Step 3/5 — Parse blocks backfill"
"$NODE" scripts/backfill-blocks.mjs --touched-out="$TOUCHED_FILE"

# ── Step 4: Parser audit (new/updated ACs only) ───────────────────────────────
echo ""
echo "▶ Step 4/5 — Parser audit (ACs touched by this sync)"
"$NODE" scripts/audit-parser.mjs --docs-file="$TOUCHED_FILE"

# ── Step 5: Update alerts (Premium push notifications) ───────────────────────
echo ""
echo "▶ Step 5/5 — Update alerts (Premium subscribers, ACs touched by this sync)"
"$NODE" scripts/send-update-alerts.mjs --touched-file="$TOUCHED_FILE"

# ── Summary ───────────────────────────────────────────────────────────────────
END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  Sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
