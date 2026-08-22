-- Adds a reason column to study_facts so a flagged (never-served) row
-- records WHY -- failed grounding/distractor check vs. correctly-accurate-
-- but-trivia (document-metadata/administrative-history questions,
-- 2026-08-22: real production data showed ~1 in 5 authored AC facts hit
-- this despite the authoring prompt already banning it explicitly -- see
-- scripts/author_question_bank.py's VERIFY_SYSTEM, which now checks
-- quality independent of factual accuracy for exactly this reason).
-- Nullable/additive only -- existing flagged rows predate this column and
-- simply have no reason recorded, which is fine, not backfilled.
alter table public.study_facts add column if not exists flag_reason text;
