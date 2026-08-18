#!/usr/bin/env bash
# Master post-sync audit gate -- runs after every content-sync pipeline
# finishes, closing the loop RC asked for 2026-08-18: every content type's
# MagicLink-completeness, tier-gating, and formatting-quality checks get
# re-verified automatically any time a reg is ingested or updated, not
# just AC (which was previously the only type with ANY automated quality
# check at all, via sync.sh's own audit-parser.mjs step).
#
# Two tiers, matching the existing manual-triage-vs-hard-gate distinction
# already established for AC (audit-parser.mjs is a hard gate inside
# sync.sh; audit_corpus_formatting.py is a separate manual-triage tool
# deliberately left OUT of run_all_audits.sh):
#
#   1. HARD GATE -- run_all_audits.sh (all 10 Layer 1-2 checks: MagicLink
#      completeness/ownership, citation validation, parser anomalies,
#      tier-gate source audit, live tier_matrix_test.py). A failure here
#      makes this whole run exit non-zero.
#
#   2. NON-BLOCKING REPORTS -- audit_corpus_formatting.py (AC footer-
#      boilerplate / oversized-block worklist) and audit_reg_formatting.mjs
#      (the FAR/AIM/AD/49-CFR equivalent, built 2026-08-18). These never
#      fail the build -- same reasoning run_all_audits.sh already applies
#      to audit_corpus_formatting.py: some flagged docs are genuinely
#      dense, not broken; this is a manual-triage worklist, not a
#      correctness gate. Findings still land in scripts/audit_reports/ and
#      in this run's own log, so a human glancing at a scheduled run sees
#      the current counts even though they don't fail it.
#
# Usage: ./scripts/master_audit.sh [--full]
#   (--full is forwarded straight to run_all_audits.sh -- see its own
#   header for what that adds; the two formatting reports always run)
#
# Runs on GitHub Actions on a weekly schedule (see
# .github/workflows/weekly-master-audit.yml), staggered to 17:00 UTC --
# after all 7 sync pipelines (10:00-16:00 UTC) have had a full hour to
# finish, so this always audits post-sync state, not a stale snapshot.

set -uo pipefail
cd "$(dirname "$0")/.."

REPORT_DIR="scripts/audit_reports"
mkdir -p "$REPORT_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
REPORT="$REPORT_DIR/master_audit_${STAMP}.log"

echo "FlyRegs master post-sync audit -- $(date)" | tee "$REPORT"
echo "" >> "$REPORT"

echo "=== HARD GATE: run_all_audits.sh ${1:-} ===" | tee -a "$REPORT"
./scripts/run_all_audits.sh "${1:-}" 2>&1 | tee -a "$REPORT"
GATE_EXIT=${PIPESTATUS[0]}
echo "" >> "$REPORT"

echo "=== NON-BLOCKING REPORT: audit_corpus_formatting.py (AC) ===" | tee -a "$REPORT"
if python3 scripts/audit_corpus_formatting.py >> "$REPORT" 2>&1; then
  :
else
  echo "  (non-fatal: report script itself errored, see log above)" | tee -a "$REPORT"
fi
echo "" >> "$REPORT"

echo "=== NON-BLOCKING REPORT: audit_reg_formatting.mjs (FAR/AIM/AD/49-CFR) ===" | tee -a "$REPORT"
if node scripts/audit_reg_formatting.mjs >> "$REPORT" 2>&1; then
  :
else
  echo "  (non-fatal: report script itself errored, see log above)" | tee -a "$REPORT"
fi
echo "" >> "$REPORT"

echo "==========================================" | tee -a "$REPORT"
if [[ $GATE_EXIT -eq 0 ]]; then
  echo "MASTER AUDIT: PASS (hard gate clean -- see reports above for non-blocking findings)" | tee -a "$REPORT"
else
  echo "MASTER AUDIT: FAIL (hard gate failed -- see run_all_audits.sh section above)" | tee -a "$REPORT"
fi
echo "Full log: $REPORT"

exit "$GATE_EXIT"
