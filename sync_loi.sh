#!/bin/bash
# FlyRegs LOI sync — FAA Legal Interpretations (Chief Counsel opinion letters).
#
# Confirmed a real gap 2026-08-18 while responding to RC's "make sure this
# [formatting/quality/MagicLink correctness] is locked in and secure, in
# place to be done automatically any time a new reg is ingested, updated":
# LOI had NO scheduled sync of any kind, ever, despite AC/AD/AIM/FAR/P-CG
# all having one since 2026-07-24 to -28. loi_scraper.py, loi_ac_citations.py,
# loi_far_part_citations.py, and loi_loi_citations.py all already existed,
# purpose-built for exactly this, but nothing had ever actually called any
# of them on a recurring basis -- the exact same shape of gap
# flyregs_gotchas.md already documented for AD before its own sync was built.
#
# Steps:
#   1. Scrape (--mode full)  -- loi_scraper.py re-fetches every LOI from DRS
#                               and upserts. Also runs its OWN inline
#                               loi->far citation extraction
#                               (extract_far_citations/write_citations) for
#                               every row it touches -- so a normal weekly
#                               run keeps loi->far citations fresh for free,
#                               without needing loi_far_citations_backfill.py
#                               (that script exists for a DIFFERENT need: a
#                               one-time catch-up when the extraction regex
#                               itself improves and already-scraped LOIs
#                               need re-processing without a real content
#                               change to trigger it -- not part of this
#                               routine weekly pipeline).
#   2. loi->AC citations      -- loi_ac_citations.py (separate owner, not
#                               called by the scraper itself).
#   3. loi->far_part citations -- loi_far_part_citations.py (separate
#                               owner; uses DRS's own cfr_part_reference
#                               metadata field, not text regex -- see that
#                               script's own header for why that's safer
#                               than scanning LOI body text for "Part N").
#   4. loi->loi citations     -- loi_loi_citations.py (separate owner;
#                               explicit inline "Name (year)"-style
#                               citations between opinion letters).
#
# Steps 2-3 (loi_ac_citations.py, loi_far_part_citations.py) ALSO already
# run inside sync_ad.sh (added there opportunistically on 2026-07-31,
# before this dedicated pipeline existed) -- deliberately left in place
# there too rather than removed, since both are idempotent (delete-then-
# insert scoped to exactly what each owns, per magiclink_audit.py's
# OWNERSHIP manifest) and duplicate runs across two schedules are harmless.
# This pipeline is now LOI's own real home for them, not dependent on the
# AD pipeline staying healthy. Step 4 (loi_loi_citations.py) runs from
# NOWHERE else -- this is its first scheduled home.
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-loi-sync.yml) -- same reasoning as every other
# sync_*.sh: shouldn't depend on any one machine being on. Can still be run
# locally for testing by creating a `.env.scraper` file in this directory
# (SUPABASE_URL + SUPABASE_SERVICE_KEY, gitignored, never commit it) -- same
# file the other sync scripts use.
#
# Usage:
#   ./sync_loi.sh

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
echo "  FlyRegs LOI Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"

echo ""
echo "▶ Step 1/4 — LOI scrape (full, incl. inline LOI->FAR citations)"
"$PYTHON3" sync/loi_scraper.py --mode full

echo ""
echo "▶ Step 2/4 — MagicLink citation extraction (LOI -> AC)"
"$PYTHON3" sync/loi_ac_citations.py

echo ""
echo "▶ Step 3/4 — MagicLink citation extraction (LOI -> FAR Part)"
"$PYTHON3" sync/loi_far_part_citations.py

echo ""
echo "▶ Step 4/4 — MagicLink citation extraction (LOI -> LOI)"
"$PYTHON3" sync/loi_loi_citations.py

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  LOI sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
