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
# duel_push_target_test.py, downgrade_matrix_test.py, duel_stagnation_test.py,
# first_sync_conflict_test.ts, cross_device_parity_test.ts,
# folder_collab_matrix_test.py,
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
# RC, real device (14 CFR 93.123), 2026-08-31: "add a corpus wide search
# for like issues to your task list." Same informational-only convention
# as audit_figure_miss above (always exits 0, never blocks a release) --
# a known backlog of genuinely complex multi-row/merged-header tables
# means this can't be a hard pass/fail gate, but every run still prints
# the full current list so it stays visible rather than silently forgotten.
run_one "audit_table_header_alignment (table header/data column mismatch)" python3 scripts/audit_table_header_alignment.py

# Both of these existed and were re-runnable but had never been wired in, so
# they only ever ran when someone remembered them by hand -- exactly the
# "one-off, easy-to-forget command" this runner's own header says it exists to
# prevent. Adding them 2026-09-02 after running them manually turned up a real
# corpus defect (AIM Appendix 4's TBL 4-2, the ICAO flight-plan equipment
# codes, rendered as one run-on row instead of 19). Same informational-only
# convention as the two above: they surface known-noisy heuristics (an
# "oversized paragraph" is often just a legitimately enormous table -- FAR
# 171.311's 361-row MLS/DME channel grid is correct and will always be
# flagged), so they print and never gate a release.
run_one "audit_corpus_formatting (AC footer bleed + oversized blocks)"       python3 scripts/audit_corpus_formatting.py
run_one "audit_reg_formatting (FAR/AIM/AD/49CFR footer bleed + oversized)"   node scripts/audit_reg_formatting.mjs

# --- Layer 2: security & tier gating ---
# Source-level guard for this codebase's #1 recurring bug class: a supabase
# read that ignores `error` (supabase-js RESOLVES on failure) feeding a
# delete. Fails ONLY on the destructive shape -- read-only ones are counted
# and printed, not chased. Added 2026-09-04 after that exact shape could have
# soft-deleted every collaborator's rows in a shared folder from one flaky
# read; the same defect then turned up independently in aircraftSharing.ts
# and notifications.ts, which is why it is a standing check and not a one-off.
run_one "unchecked_supabase_errors (failed read -> destructive action)" python3 scripts/audit_unchecked_supabase_errors.py
# The B40 "Mark Complied does nothing and the app freezes" class. iOS refuses
# to present a Modal while another is presented and fails SILENTLY -- no
# exception, no Sentry event, just an app that stops responding. Source-level
# because there is nothing to observe at runtime until a user hits it.
run_one "modal_over_modal (a dialog must close before opening another)" python3 scripts/audit_modal_over_modal.py
# RC asked for Back to Top twice -- once corpus-wide, then again after the
# first pass only reached the browse lists. A screen missing one of its three
# pieces still compiles and silently does nothing, so it is checked here.
run_one "back_to_top_audit (every long list can jump back to the top)" python3 scripts/back_to_top_audit.py
# Whole-app static sweep for the defect CLASSES this codebase repeats:
# .catch() on a resolving API, a failed read defaulting to a confident
# answer before a delete, Alert.alert (a no-op on web), dead lib exports.
run_one "sweep_static_defects (repeat defect classes, corpus-wide)" python3 scripts/sweep_static_defects.py
# Every fire-and-forget async call, classified by whether its callee can
# actually reject. Proven to catch a planted bare call to a throwing fn.
run_one "floating_promise_audit (every fire-and-forget call)" python3 scripts/floating_promise_audit.py
run_one "discarded_supabase_result_audit (lazy builder never sent)" python3 scripts/discarded_supabase_result_audit.py
run_one "client_server_reference_audit (tables/rpcs/cols/buckets/fns exist)" python3 scripts/client_server_reference_audit.py
run_one "corpus_parity_audit (does one corpus quietly lack a feature?)" python3 scripts/corpus_parity_audit.py
# A failed READ must never render as "not found" -- that is a false claim
# about the corpus. Checks all four pieces, including that Try Again works.
run_one "load_error_state_audit (failed load != missing document)" python3 scripts/load_error_state_audit.py
# The eas-build-on-success hook that attaches commits to each Sentry release
# -- without it, `Fixes REACT-NATIVE-x` in a commit message resolves nothing.
# Checks it is wired AND that it can never fail a build.
run_one "keyboard_avoidance (no modal hides its own input under the keyboard)" python3 scripts/keyboard_avoidance_audit.py
# The one above proves the CARD moves; this one proves the BUTTON is reachable.
# Both were needed: AdComplianceModal passed the first and still hid its Save.
run_one "modal_primary_action (no modal scrolls its own primary action away)" python3 scripts/modal_primary_action_reachability_audit.py
# And this one proves the modal GOES AWAY when its screen does.
run_one "screen_modal (no modal outlives the screen that opened it)" python3 scripts/screen_modal_audit.py
# RC's Duel Alerts turned themselves off: a BEFORE-UPDATE trigger rewrote his
# stored preference every time the app foregrounded while the entitlement row
# was stale. A permission check may refuse or filter; it may not rewrite what
# the user chose.
run_one "preference_integrity (nothing but the user changes a user setting)" \
  python3 scripts/preference_integrity_audit.py
run_one "modal_escape (no modal swallows its own dismiss gesture)" python3 scripts/modal_escape_audit.py
run_one "study_explanation_fallback (every answer says something)" node scripts/study_explanation_fallback_test.cjs
run_one "eas_build_hook_audit (Sentry commit association really fires)" python3 scripts/eas_build_hook_audit.py
run_one "eas_sentry_release_name (the hook names the release the SDK reports)" node scripts/eas_sentry_release_name_test.cjs
# Timers, listeners and rAF loops that outlive the screen that made them.
# Each detector was proven by planting a real leak and watching it get caught.
run_one "sweep_lifecycle_leaks (timers/listeners/rAF)" python3 scripts/sweep_lifecycle_leaks.py
# Orphaned rows, migration-file drift, slow statements, unindexed FKs.
run_one "sweep_data_integrity (orphans, drift, slow queries)" python3 scripts/sweep_data_integrity.py
# Every table, bucket, edge function and writing RPC x six identities.
run_one "access_matrix_sweep (no key/anon/free/plus/pro/premium)" python3 scripts/access_matrix_sweep.py
# Live database posture: RLS, what anon and a brand-new FREE account can
# actually read, writing SECURITY DEFINER RPCs reachable with the public
# key, and whether every cron job's last run really succeeded.
run_one "sweep_db_posture (RLS, anon/free probes, cron health)" python3 scripts/sweep_db_posture.py
# Does the app ever select a column the client has no grant on? That 403s
# at runtime and supabase-js resolves it as empty -- it has shipped twice.
run_one "column_grant_audit (every select vs live column grants)" python3 scripts/column_grant_audit.py
# Show my stats must really hide ratings, coins and streak -- proven with a
# brand-new free account, the way an attacker would.
run_one "profile_privacy_gate (Show my stats actually hides)" python3 scripts/profile_privacy_gate_test.py
# Highlights inside shared folders: RC's read-only vs read/write rule, both
# directions, and access being revoked. Real user JWTs against the live DB.
run_one "shared_folder_highlights (RO sees, RW edits, revoke stops it)" python3 scripts/shared_folder_highlights_e2e_test.py
# The aircraft photo path either side of the native digest call RC hit on B40.
run_one "aircraft_photo_e2e (upload, render, replace, isolation, caps)" python3 scripts/aircraft_photo_e2e_test.py
# The beforeSend hook that recovers a PostgrestError message Sentry would drop.
run_one "sentry_beforesend (db errors stay diagnosable)" node scripts/sentry_beforesend_test.cjs
run_one "tier_gate_audit (source-level, every gated surface x tier)" node scripts/tier_gate_audit.mjs
run_one "tier_matrix_test (server-side, real accounts)"              python3 scripts/tier_matrix_test.py
# Storage RLS, not table RLS -- a separate policy surface that no other
# check here covers. Added 2026-09-04 after finding that the anon key alone
# could LIST the avatars and aircraft-images buckets: folder names are user
# ids, and the objects behind them are people's faces and their aircraft
# (whose tail numbers resolve through the FAA registry to a name and
# address). Sits next to tier_matrix_test because it likewise needs a real
# account -- it also checks the OTHER direction, that a user can still
# delete and replace their own photo, since over-tightening SELECT breaks
# that silently.
run_one "storage_enumeration_test (photo buckets, real account)"     python3 scripts/storage_enumeration_test.py
run_one "stale_question_sweep (questions whose reg text moved)"     python3 scripts/stale_question_sweep.py
# Content QUALITY, not just correctness. RC, 2026-09-04: flashcards "need to
# be real and interactive, simple, relevant test-style Q/As, not obscure junk
# we've had in the past." Both walk the REAL user path -- get_study_queue and
# the study_facts overlay, and get_study_pool_count -- rather than reading the
# tables, because the tables still hold plenty a user never sees.
run_one "study_card_quality (are the cards worth studying?)"        python3 scripts/study_card_quality_audit.py --decks 4
run_one "filter_box_audit (do the level filters really carve up the bank?)" python3 scripts/filter_box_audit.py
# 2026-09-10: the gate here used to be `study_topic_map.py --score`, which
# scored a PART-grain derivation against the hand-assigned categories. Once
# authoring covered every FAR section the oracle grew from 355 items to 4,472
# and the derivation disagreed on 2,552 -- not a regression, a design limit: a
# part is not a topic, and the derivation never reads the section text. The
# axis is now materialized in study_item_topics (human label wins, derivation
# fills the rest) and the audit guards that instead. The e2e test drives the
# three RPCs as a real signed-in user, because they are SECURITY DEFINER and
# return 0 for everything under the service key.
run_one "study_topic_axis (topics complete, reachable, human-labelled)" \
  python3 scripts/study_topic_axis_audit.py
run_one "study_topic_filter_e2e (topic filter, as a real signed-in user)" python3 scripts/study_topic_filter_test.py
# Reports any inane question that has become live since the last sweep. The DB
# trigger blocks six classes on the way in; this is the other three, plus the
# standing check that the trigger is still doing its job.
run_one "inane_question_sweep (nothing inane is being served)" \
  python3 scripts/inane_question_sweep.py --fail-on-hits

# 2026-09-09: filter_box_audit reported a FAIL purely because an authoring batch
# was writing while it ran -- its count arithmetic spans several queries. It now
# reports INCONCLUSIVE instead. This proves that branch is live AND that a real
# defect on a stable bank still fails.
run_one "filter_box_audit_concurrency (a write mid-run != a filter defect)" \
  python3 scripts/filter_box_audit_concurrency_test.py

# 2026-09-09: a CJK character I mistyped reached a live 65.47 distractor, and
# sweeping the corpus found 12 more rows with mojibake and invisible artifacts.
# Authoring is now guarded at insert; this catches anything arriving by any
# other path.
run_one "stray_character_sweep (no card renders as broken text)" \
  python3 scripts/stray_character_sweep.py
# The grounding gate only asks whether source_quote APPEARS in the reg text, not
# whether it appears at word boundaries -- so quotes built from truncated text
# dumps went live reading "...cause premature dis". 81 found corpus-wide
# 2026-09-09; repair_truncated_source_quotes.py extends them back out.
run_one "source_quote_truncation (no card quotes the reg mid-word)" \
  python3 scripts/source_quote_truncation_audit.py

# 2026-09-10: acs_task_reg_links had its RLS policy but NO grant, so every real
# user got a 403 and the client silently fell back to keyword search -- the
# curated-links feature was dead in the app while every audit passed, because
# they all query as service_role. This checks the pairing corpus-wide.
run_one "rls_grant_pairing (every table the client reads, it can actually read)" \
  python3 scripts/rls_grant_pairing_audit.py
run_one "acs_reg_links (ACS tasks link only to genuinely relevant regs)" \
  python3 scripts/acs_reg_link_audit.py
# RC, via the in-app bug report: "the reg identifier was listed twice." This
# runs the REAL composition functions over the REAL corpus, so it measures
# what a user would read rather than re-stating the rule in a second place.
run_one "reg_badge_composition (no result row says its type or number twice)" \
  python3 scripts/reg_badge_composition_audit.py
# Ask FlyRegs must survive a typo in the one word that matters, and must not
# bend a real word into an anchor. Second half is the one that matters: it is
# what keeps the fuzzy pass from ever changing a query that already worked.
run_one "afr_typo_tolerance (AFR survives a typo, nothing correct regresses)" \
  python3 scripts/afr_typo_tolerance_test.py
# 2026-09-10: scraper_freshness_check detects the ABSENCE of scraper evidence
# in the database, which says nothing about a push sender or the master audit
# itself. "Daily Reminder Alerts" -- maintenance and AD-due notifications to
# real users -- had been failing for two days and nothing here noticed, because
# nothing here looked at CI at all.
run_one "workflow_health (no scheduled GitHub job is sitting red)" \
  python3 scripts/workflow_health_audit.py
run_one "scraper_freshness_check (weekly sync actually ran)"        python3 scripts/scraper_freshness_check.py

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
