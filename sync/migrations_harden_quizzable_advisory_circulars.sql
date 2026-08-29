-- 2026-08-29, full-sweep pass 9 (dedicated exhaustive grant/RLS audit).
-- Defense-in-depth, not a live leak: this pass confirmed NO current
-- exploit exists on any quizzable_* view (all six independently curl-
-- tested, all correctly return 42501 with no anon/authenticated grant).
-- But quizzable_advisory_circulars carries pdf_text/pdf_url_cached/
-- pdf_blocks/changed_block_indices -- the same Plus-gated columns
-- advisory_circulars_gated exists to redact -- with NO internal CASE
-- guard of its own, relying entirely on the absent grant. If a future
-- feature ever adds `GRANT SELECT ... TO authenticated` on this view (a
-- client-side quiz-authoring screen, an analytics export, anything), it
-- becomes a live leak instantly, with no second line of defense.
--
-- Confirmed safe to redact: read create_challenge()'s live body first
-- (the ONLY consumer of this view) -- it selects exclusively
-- document_number, subject_series, and title from quizzable_advisory_
-- circulars for pool-building; pdf_text/pdf_url_cached/pdf_blocks/
-- changed_block_indices/search_vector are never referenced anywhere in
-- that function. Nulling/omitting them here has zero effect on the real
-- Duels feature. search_vector is dropped from the column list entirely
-- (not just redacted-to-null) rather than left as a plain passthrough --
-- matching advisory_circulars_gated's own sibling pattern, which omits it
-- as a column altogether: a tsvector carries stemmed lexemes with
-- positions, reconstructable enough to partially undo withholding the
-- real text (see gotcha_rls_does_not_gate_columns.md's own "search_vector
-- counts as content" note).
--
-- Deliberately NOT touching quizzable_dictionary_terms in this same pass,
-- despite carrying a similar-looking gap (quiz_prompt is derived straight
-- from the Pro-gated dictionary_terms.senses definition) -- traced it
-- further and confirmed it's a different, already-safe shape: the real
-- access gate for dictionary content lives in get_next_challenge_
-- question() at SERVING time (`case when has_pro_access() then
-- quiz_prompt_condense(...) else d.term end`), not in this view --
-- create_challenge() only ever uses quiz_prompt internally to de-
-- duplicate distractor choices, never returns it to any client. Adding a
-- CASE guard here would NULL out quiz_prompt for every non-Pro-eligible
-- row, breaking that uniqueness check's own semantics (many rows would
-- collapse to the same NULL "prompt") for no real security gain, since
-- the actual content is already correctly gated one layer downstream.
-- Left as a genuinely-safe-by-design pattern, not an oversight.
-- CREATE OR REPLACE VIEW refuses this (42P16 "cannot drop columns from
-- view") since search_vector is being removed from the column list
-- entirely, not just recomputed -- confirmed live no other view/function
-- depends on this one (pg_depend query, empty result) before dropping it.
-- Only postgres/service_role have any grant on it today (confirmed live,
-- no anon/authenticated grant to preserve or lose), and both are the
-- schema-wide default every new table/view already gets automatically.
drop view public.quizzable_advisory_circulars;

-- IMPORTANT, found live while applying this exact migration: this
-- project's public schema has a DEFAULT PRIVILEGE rule (pg_default_acl,
-- role supabase_admin, objtype 'r') that grants FULL read+write to
-- anon/authenticated on every NEW table/view automatically, the moment
-- it's created -- confirmed live: this CREATE VIEW alone (no GRANT
-- statement anywhere in this file) came back with anon/authenticated
-- SELECT already present. This is almost certainly the real root cause
-- behind every one of tonight's grant-leak findings (CFR49, synced_
-- bookmarks, quizzable_cfr49_sections) -- they likely weren't each a
-- one-off copy-paste mistake so much as the default schema behavior doing
-- exactly what it's configured to do, with the required explicit REVOKE
-- simply forgotten each time. Flagged prominently to RC in the same
-- session this was found (see PROJECT_NOTES/flyregs_gotchas.md) --
-- changing the default itself is a bigger, schema-wide call deliberately
-- left for RC's own decision, not applied here. This migration's own
-- explicit revoke below is what every other gated object in this schema
-- already has to do for the exact same reason.
create view public.quizzable_advisory_circulars as
select id, document_number, title, date_issued, office, change_number, status,
  subject_series, description, document_id, cancels, pdf_url_faa,
  null::text as pdf_url_cached,
  null::text as pdf_text,
  pdf_size_bytes,
  last_scraped_at, created_at, updated_at,
  null::jsonb as pdf_blocks,
  pdf_blocks_version,
  null::integer[] as changed_block_indices,
  quiz_prompt, prompt_uses
from (
  select c0.id, c0.document_number, c0.title, c0.date_issued, c0.office, c0.change_number, c0.status,
    c0.subject_series, c0.description, c0.document_id, c0.cancels, c0.pdf_url_faa, c0.pdf_url_cached,
    c0.pdf_size_bytes, c0.pdf_text, c0.last_scraped_at, c0.created_at, c0.updated_at, c0.pdf_blocks,
    c0.pdf_blocks_version, c0.changed_block_indices,
    c0.title as quiz_prompt,
    count(*) over (partition by c0.title) as prompt_uses
  from advisory_circulars c0
  where c0.status = 'active' and c0.title is not null and c0.title <> ''
    and c0.description is not null and c0.description <> ''
) c
where position(lower(document_number) in lower(title)) = 0;

revoke all on public.quizzable_advisory_circulars from anon, authenticated;
