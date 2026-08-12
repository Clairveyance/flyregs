#!/usr/bin/env bash
# Master runner for every re-runnable, read-only Layer 1-3 audit/eval script
# (see PROJECT_NOTES/flyregs_qa_coverage_framework.md). Chains them into one
# pass/fail report instead of each living as a one-off, easy-to-forget
# command someone has to remember to run.
#
# Deliberately excludes: one-off content-fix scripts (fix_*.mjs, add_*.mjs,
# splice_*.mjs, llm_*.py, ocr_*.py -- these mutate specific historical data
# issues and are not re-runnable diagnostics), and the E2E scripts that spin
# up real disposable test accounts (aircraft_e2e_test.py, duel_e2e_test.py,
# folders_e2e_test.py, game_scenarios_test.py, study_lifecycle_test.py,
# rls_write_path_fuzzer.py) -- those are slower and account-mutating, meant
# to be run deliberately when touching that subsystem (or periodically for
# rls_write_path_fuzzer.py specifically -- see PROJECT_NOTES's 2026-08-11
# app-wide cleanup entry), not as part of every quick health check.
#
# Usage: ./scripts/run_all_audits.sh [--full]
#   (no args)  Layer 1 (data integrity) + Layer 2 (tier gating) only -- fast.
#   --full     Also runs Layer 3 search/filter eval harnesses (slower, hits
#              live search infra repeatedly).

set -uo pipefail
cd "$(dirname "$0")/.."

FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

REPORT_DIR="scripts/audit_reports"
mkdir -p "$REPORT_DIR"
STAMP=$(date +%Y%m%d_%H%M%S)
REPORT="$REPORT_DIR/audit_run_${STAMP}.log"

PASS=0
FAIL=0
declare -a FAILED_NAMES=()

run_one() {
  local name="$1"; shift
  echo "=== $name ===" | tee -a "$REPORT"
  if "$@" >> "$REPORT" 2>&1; then
    echo "  PASS" | tee -a "$REPORT"
    PASS=$((PASS+1))
  else
    echo "  FAIL (exit $?)" | tee -a "$REPORT"
    FAIL=$((FAIL+1))
    FAILED_NAMES+=("$name")
  fi
  echo "" >> "$REPORT"
}

echo "FlyRegs audit run -- $(date)" | tee "$REPORT"
echo "" >> "$REPORT"

# --- Layer 1: corpus/data integrity ---
run_one "audit-full-coverage (AC setup + figure/table gaps)"      node scripts/audit-full-coverage.mjs
run_one "audit-blocks (parser anomalies)"                          node scripts/audit-blocks.mjs
run_one "audit-parser (TOC/heading collisions)"                    node scripts/audit-parser.mjs
run_one "audit_table_group_labels"                                 node scripts/audit_table_group_labels.mjs
run_one "magiclink_audit"                                          python3 scripts/magiclink_audit.py
run_one "magiclink_audit --ownership"                               python3 scripts/magiclink_audit.py --ownership
run_one "citation_validate"                                         python3 sync/citation_validate.py
if [[ -f scripts/audit_figure_miss.py ]]; then
  run_one "audit_figure_miss" python3 scripts/audit_figure_miss.py
fi

# --- Layer 2: security & tier gating ---
run_one "tier_gate_audit (source-level, every gated surface x tier)" node scripts/tier_gate_audit.mjs
run_one "tier_matrix_test (server-side, real accounts)"              python3 scripts/tier_matrix_test.py

# --- Layer 3: functional correctness (slower, --full only) ---
if [[ $FULL -eq 1 ]]; then
  run_one "filter_matrix_test (Study/Flashcard/Duel filters)" python3 scripts/filter_matrix_test.py all
  run_one "search_eval"                                        python3 scripts/search_eval.py
  run_one "semantic_search_breadth_test"                       python3 scripts/semantic_search_breadth_test.py
fi

echo "==========================================" | tee -a "$REPORT"
echo "TOTAL: $PASS passed, $FAIL failed" | tee -a "$REPORT"
if [[ $FAIL -gt 0 ]]; then
  echo "FAILED: ${FAILED_NAMES[*]}" | tee -a "$REPORT"
fi
echo "Full log: $REPORT"

exit $((FAIL > 0 ? 1 : 0))
