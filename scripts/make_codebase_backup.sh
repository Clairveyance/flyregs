#!/bin/bash
# Snapshot the ENTIRE FlyRegs project folder -- ac-app (the app itself),
# 01_Website (the live marketing site), the scraper/build pipeline
# (aim_scraper.py, far_scraper.py, pcg_scraper.py, top-level migrations/,
# scripts/, launchd/), PROJECT_NOTES, and everything else at this level --
# into a single timestamped tarball under CODE_BACKUPS.
#
# Widened 2026-08-09 from an ac-app-only backup after RC flagged that scope
# as incomplete for its actual purpose: "the absolute FULL line/line code
# for this entire app... it is what I would give you to rebuild everything
# up to this point." The original ac-app-only version silently missed the
# website source, the entire data-ingestion pipeline, top-level migrations,
# and PROJECT_NOTES -- all irreplaceable, none of it regenerable by
# `npm install`. Run after any large batch of changes, per RC's disaster-
# recovery ask (device crash / hard drive failure).
#
# What's excluded: node_modules, .git (ac-app's full history already lives
# on GitHub), .expo, dist/web-build, scratch/scratchpad, CODE_BACKUPS itself
# (so backups don't recursively swallow earlier backups), .DS_Store -- all
# either regenerable or already backed up elsewhere. Everything else,
# including gitignored .env* files (real API keys/secrets that exist ONLY
# on this machine) and large source assets (e.g. aim_full.pdf, the AIM
# scraper's raw input), is included on purpose.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$(cd "$REPO_DIR/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
BACKUP_ROOT="$PROJECT_DIR/CODE_BACKUPS"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$BACKUP_ROOT/flyregs_full_backup_${STAMP}.tar.gz"

mkdir -p "$BACKUP_ROOT"

tar -czf "$OUT_FILE" \
  -C "$(dirname "$PROJECT_DIR")" \
  --exclude="$PROJECT_NAME/CODE_BACKUPS" \
  --exclude="$PROJECT_NAME/ac-app/node_modules" \
  --exclude="$PROJECT_NAME/ac-app/.git" \
  --exclude="$PROJECT_NAME/ac-app/.expo" \
  --exclude="$PROJECT_NAME/ac-app/dist" \
  --exclude="$PROJECT_NAME/ac-app/web-build" \
  --exclude="$PROJECT_NAME/ac-app/scratch" \
  --exclude="$PROJECT_NAME/ac-app/scratchpad" \
  --exclude=".DS_Store" \
  --exclude="*.tsbuildinfo" \
  "$PROJECT_NAME"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "Backup written: $OUT_FILE ($SIZE)"

# Keep the last 10 snapshots, prune older ones so this doesn't grow unbounded.
# Only prunes this script's own naming scheme -- old ac-app_backup_*.tar.gz
# files from before this widening are left alone, not silently deleted.
cd "$BACKUP_ROOT"
OLD=$(ls -1t flyregs_full_backup_*.tar.gz 2>/dev/null | tail -n +11)
if [ -n "$OLD" ]; then
  echo "$OLD" | while IFS= read -r f; do rm -f -- "$f"; done
fi
