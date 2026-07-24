#!/bin/bash
# FlyRegs P/CG PDF cross-reference audit — NOT a content sync, a periodic
# accuracy check.
#
# pcg_terms is scraped from the FAA's P/CG HTML edition (sync_pcg.sh). This
# cross-references it against the real Pilot/Controller Glossary text in
# the official AIM PDF — the document a pilot would actually go pull up.
# See sync/pcg_pdf_crossref.py's own docstring before acting on its output
# — in particular, this MUST use the full "AIM Basic" edition below, not
# the "Basic w/ Chg N" bundle sync_aim.sh uses, whose glossary section is a
# changes-only reprint missing most letters entirely (confirmed live: using
# it here produced a false "844 terms missing" result).
#
# AIM_BASIC_URL below MUST be bumped by hand whenever the FAA publishes a
# new "AIM Basic" edition (check
# https://www.faa.gov/air_traffic/publications/ for the current "AIM
# Basic dtd ..." link) — there's no automatic way to detect this, same
# caveat as sync_aim.sh's own PDF_URL.
#
# Usage:
#   ./pcg_pdf_audit.sh

set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP/.env.scraper"
PYTHON3="${PYTHON3:-python3}"
AIM_BASIC_URL="https://www.faa.gov/air_traffic/publications/media/AIM_Basic_dtd_2-20-25_post.pdf"

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

cd "$APP"
WORKDIR="$(mktemp -d -t pcg-pdf-audit)"
trap 'rm -rf "$WORKDIR"' EXIT

echo ""
echo "════════════════════════════════════════════════════"
echo "  FlyRegs P/CG PDF Cross-Reference Audit  —  $(date '+%Y-%m-%d %H:%M:%S')"
echo "════════════════════════════════════════════════════"

echo ""
echo "▶ Step 1/2 — Download the full AIM Basic edition"
curl -sL -A "Mozilla/5.0" "$AIM_BASIC_URL" -o "$WORKDIR/aim_basic.pdf"
if ! file "$WORKDIR/aim_basic.pdf" | grep -q "PDF document"; then
  echo "ERROR: download is not a valid PDF — check AIM_BASIC_URL above against" >&2
  echo "  https://www.faa.gov/air_traffic/publications/ (a newer 'AIM Basic' edition" >&2
  echo "  may now exist under a different filename)." >&2
  exit 1
fi
echo "  OK — $(du -h "$WORKDIR/aim_basic.pdf" | cut -f1)"

echo ""
echo "▶ Step 2/2 — Cross-reference against pcg_terms"
"$PYTHON3" sync/pcg_pdf_crossref.py "$WORKDIR/aim_basic.pdf"

END_TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "════════════════════════════════════════════════════"
echo "  P/CG PDF audit complete  —  $END_TS"
echo "════════════════════════════════════════════════════"
echo ""
