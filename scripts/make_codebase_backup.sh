#!/bin/bash
# Snapshot the entire ac-app codebase (source, config, .env secrets, PROJECT_NOTES,
# migrations -- everything not regenerable by `npm install`) into a single timestamped
# tarball under CODE_BACKUPS, one directory up from this repo. Run after any large
# batch of changes, per RC's disaster-recovery ask (device crash / hard drive failure).
#
# What's excluded: node_modules, .expo, .git (full history already lives on GitHub),
# dist/web-build, scratch/, .DS_Store -- all either regenerable or already backed up
# elsewhere. Everything else, including gitignored .env* files (real API keys/secrets
# that exist ONLY on this machine), is included on purpose.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="$(cd "$REPO_DIR/.." && pwd)/CODE_BACKUPS"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="$BACKUP_ROOT/ac-app_backup_${STAMP}.tar.gz"

mkdir -p "$BACKUP_ROOT"

tar -czf "$OUT_FILE" \
  -C "$(dirname "$REPO_DIR")" \
  --exclude="ac-app/node_modules" \
  --exclude="ac-app/.expo" \
  --exclude="ac-app/.git" \
  --exclude="ac-app/dist" \
  --exclude="ac-app/web-build" \
  --exclude="ac-app/scratch" \
  --exclude="ac-app/scratchpad" \
  --exclude=".DS_Store" \
  --exclude="*.tsbuildinfo" \
  "ac-app"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "Backup written: $OUT_FILE ($SIZE)"

# Keep the last 10 snapshots, prune older ones so this doesn't grow unbounded.
cd "$BACKUP_ROOT"
OLD=$(ls -1t ac-app_backup_*.tar.gz 2>/dev/null | tail -n +11)
if [ -n "$OLD" ]; then
  echo "$OLD" | while IFS= read -r f; do rm -f -- "$f"; done
fi
