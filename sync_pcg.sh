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
echo "  FlyRegs P/CG Sync  —  $START_TS"
echo "════════════════════════════════════════════════════"

cd "$APP"
"$PYTHON3" sync/pcg_scraper.py --mode full

# Dead see_refs repair (ICAO-prefix / abbreviation-suffix rewrites, and
# dropping genuinely-unresolvable entries) -- MUST run AFTER the scraper
# step above, every time, not just once. Confirmed live 2026-08-10: this
# script was written and run by hand exactly once, on 2026-08-02, and fixed
# 467 of 1,048 dead see_refs entries (296 rewrites + 171 drops) -- but the
# scraper step re-upserts EVERY column (including see_refs) straight from
# the FAA's raw HTML on every run, so all 467 fixes got silently reset back
# to the original broken text on the very next scheduled sync and stayed
# broken for over a week with no failing job to notice, until this same
# investigation found it again by coincidence while checking see_refs for
# something else entirely. Re-running this script right here, every week,
# closes that gap permanently instead of needing a human to notice and
# re-run it by hand again. Idempotent: a ref that's already correctly
# formed resolves on the very first check and is left untouched.
echo ""
echo "▶ P/CG see_refs dead-link repair (ICAO/abbreviation rewrites + drops)"
"$PYTHON3" sync/fix_pcg_see_refs.py

# MagicLink citation extraction (full corpus re-scan) -- was a total, silent
# gap before 2026-07-28: no script existed for P/CG's own outbound citations
# to AC/FAR/AIM/AD (distinct from see_refs, which covers pcg-to-pcg "See X"
# links and is already populated by pcg_scraper.py itself).
echo ""
echo "▶ MagicLink citation extraction (P/CG -> AC/FAR/AIM/AD)"
"$PYTHON3" sync/pcg_citations.py

# P/CG-mentions-P/CG-by-name see_refs backfill -- MUST run AFTER
# pcg_scraper.py, every time, not just once. Confirmed live 2026-08-10: the
# scraper step above re-upserts every row's see_refs straight from the FAA's
# own HTML on every run (Prefer: resolution=merge-duplicates overwrites the
# whole column), so a term whose FAA source genuinely has no structured
# "See ..." line gets see_refs reset to [] every single week -- silently
# wiping this script's own additions from the previous run if it isn't
# re-run right here, every time, to re-fill the same gap. Safe to re-run:
# only ever touches rows whose see_refs is CURRENTLY empty, so it can never
# clobber a real "See ..." line the FAA source does provide.
echo ""
echo "▶ P/CG see_refs backfill (inline mentions of other P/CG terms by name)"
"$PYTHON3" sync/pcg_see_refs_backfill.py

# NOTE: the OTHER direction (FAR/AIM/AC/AD/LOI -> P/CG, i.e. "which documents
# use this glossary term") is NOT built here. It's sync/pcg_term_links.py, a
# full-corpus phrase scan that must run after every content table is current,
# so it lives at the end of sync_ad.sh -- the last weekly job. See the long
# comment there for the reasoning.

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  P/CG sync complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
